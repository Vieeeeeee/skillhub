import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getPaths, getAgentDirs, isAgentVisible } from "../src/core/paths.mjs";
import { buildRegistry, loadUserOverrides } from "../src/core/registry.mjs";
import { buildSyncPlan, applySyncPlan } from "../src/core/sync.mjs";
import { runDoctor } from "../src/core/doctor/index.mjs";
import { undoLastBackup } from "../src/core/backup.mjs";
import * as ops from "../src/core/ops.mjs";
import * as hot from "./hot.mjs";
import { checkSelfUpdate } from "../src/core/update-check.mjs";
import { getOrCreateSessionToken, createSecurityMiddleware } from "./session.mjs";
import { assertSafeName } from "../src/core/guard.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = join(__dirname, "..", "web");

export const PORT = Number(process.env.SKILL_HUB_PORT || 7777);
export const HOST = process.env.SKILL_HUB_HOST || "127.0.0.1";

export function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}

export function createApp(customHome = null) {
  const app = new Hono();
  const paths = getPaths(customHome);
  const token = getOrCreateSessionToken(customHome);

  app.onError((error, c) => {
    if (error instanceof SyntaxError) {
      return c.json({ ok: false, error: "Invalid JSON request body" }, 400);
    }
    console.error("SkillHub request failed:", error);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  });

  function withAgentMetadata(registry) {
    const overrides = loadUserOverrides(getPaths(customHome).OVERRIDES_FILE);
    const agentMeta = Object.fromEntries(
      Object.entries(getAgentDirs(customHome)).map(([key, cfg]) => [key, {
        name: cfg.name || key,
        type: cfg.type || "symlink",
        path: cfg.absPath,
        status: cfg.status || "",
        available: Boolean(cfg.available),
        visible: isAgentVisible(cfg, key, overrides),
      }])
    );
    return { ...registry, agentMeta };
  }

  // The shipped page is entirely self-contained — no CDN, no remote font, no
  // external image — so it can be locked down completely. A good part of what it
  // renders comes out of third-party SKILL.md files, and escapeHtml in the
  // browser is the only other thing standing between that text and the DOM.
  app.use("/*", async (c, next) => {
    await next();
    // /preview is the local design workspace; it is not part of the published
    // package, so this branch never fires for an installed copy.
    const isPreview = c.req.path.startsWith("/preview");
    c.header(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${isPreview ? "'self'" : "'none'"}`
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  });

  // Security Middleware
  app.use("/api/*", createSecurityMiddleware(customHome));

  // Nothing this API accepts is large. Without a ceiling a single request could
  // push an arbitrary amount of text into the override file, which is then read
  // back into memory on every scan.
  const MAX_BODY_BYTES = 64 * 1024;
  app.use("/api/*", async (c, next) => {
    // A chunked request declares no length, so checking the header alone let an
    // arbitrarily large body straight through the ceiling this middleware
    // exists to impose. Nothing here needs streaming — every client is fetch()
    // with a string body — so a request that refuses to say its size is
    // refused rather than measured. A POST with no body at all has neither
    // header and is unaffected.
    if (c.req.header("transfer-encoding") !== undefined) {
      return c.json({ ok: false, error: "Request body must declare Content-Length" }, 411);
    }
    const declared = Number(c.req.header("content-length") || 0);
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
      return c.json({ ok: false, error: `Request body is too large (limit ${MAX_BODY_BYTES} bytes)` }, 413);
    }
    await next();
  });

  function isRegistryStale() {
    if (!existsSync(paths.REGISTRY_FILE)) return true;
    try {
      if (!existsSync(paths.SSOT)) return false;
      const registryMtime = statSync(paths.REGISTRY_FILE).mtimeMs;
      if (statSync(paths.SSOT).mtimeMs > registryMtime) return true;
      // Directory mtimes do not change when an existing SKILL.md is edited.
      // Check each current entry so dashboard reads cannot silently stay stale.
      for (const entry of readdirSync(paths.SSOT, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        const skillMd = join(paths.SSOT, entry.name, "SKILL.md");
        if (existsSync(skillMd) && statSync(skillMd).mtimeMs > registryMtime) return true;
      }
      // A link made outside SkillHub — `ln -s` in a terminal, or an Agent
      // writing its own directory — changes nothing in the SSOT, so the
      // "which Agents can see it" columns stayed on their old values until
      // someone happened to hit 重新扫描.
      for (const cfg of Object.values(getAgentDirs(customHome))) {
        if (!cfg.absPath || !existsSync(cfg.absPath)) continue;
        if (statSync(cfg.absPath).mtimeMs > registryMtime) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  /* ---------- API Routes ---------- */

  app.get("/api/session", (c) => {
    return c.json({ ok: true, token });
  });

  app.get("/api/registry", (c) => {
    try {
      if (isRegistryStale()) {
        buildRegistry(customHome);
      }
      const reg = JSON.parse(readFileSync(paths.REGISTRY_FILE, "utf-8"));
      return c.json(withAgentMetadata(reg));
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.post("/api/refresh", (c) => {
    try {
      const reg = buildRegistry(customHome);
      return c.json({ ok: true, skillsCount: Object.keys(reg.skills || {}).length });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.post("/api/agents/visibility", async (c) => {
    const { agent, visible } = await c.req.json();
    try {
      const result = ops.setAgentVisibility(agent, visible, customHome);
      buildRegistry(customHome);
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  app.post("/api/toggle", async (c) => {
    const { name, agent, enabled } = await c.req.json();
    try {
      const result = ops.toggleAgent(name, agent, Boolean(enabled), customHome);
      buildRegistry(customHome);
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  app.post("/api/add", async (c) => {
    const { gitUrl, name } = await c.req.json();
    try {
      const result = ops.addSkillFromGit(gitUrl, { name }, customHome);
      buildRegistry(customHome);
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  app.post("/api/update/:name", (c) => {
    const name = c.req.param("name");
    try {
      const result = ops.updateSkill(name, customHome);
      buildRegistry(customHome);
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  // Every pull here is a synchronous git call with a 30s timeout, on the one
  // thread that also answers the dashboard. Without a ceiling, a handful of
  // unreachable remotes froze the whole page for minutes with no way to stop
  // it. Stop at the budget and hand back what is left to do.
  const UPDATE_ALL_BUDGET_MS = 90_000;

  app.post("/api/update-all", (c) => {
    try {
      const reg = buildRegistry(customHome);
      const results = [];
      const updatedSources = new Set();
      const remaining = [];
      const deadline = Date.now() + UPDATE_ALL_BUDGET_MS;

      for (const [name, s] of Object.entries(reg.skills || {})) {
        if (s.type !== "git" && s.type !== "bundle-symlink") continue;
        const sourceKey = s.bundle ? `bundle:${s.bundle}` : `skill:${name}`;
        if (updatedSources.has(sourceKey)) continue;
        updatedSources.add(sourceKey);

        if (Date.now() >= deadline) {
          remaining.push(s.bundle || name);
          continue;
        }
        try {
          const r = ops.updateSkill(name, customHome);
          results.push({ name, bundle: s.bundle || "", ok: true, ...r });
        } catch (e) {
          results.push({ name, bundle: s.bundle || "", ok: false, error: e.message });
        }
      }
      buildRegistry(customHome);
      const failed = results.filter((r) => !r.ok);
      return c.json({
        ok: failed.length === 0 && remaining.length === 0,
        partial: (failed.length > 0 || remaining.length > 0) && results.length > 0,
        attempted: results.length,
        succeeded: results.length - failed.length,
        failed: failed.length,
        remaining,
        results,
        error: remaining.length
          ? `${failed.length ? `${failed.length} 项失败；` : ""}还有 ${remaining.length} 项没跑到，再点一次继续`
          : failed.length
            ? `${failed.length} update(s) failed`
            : undefined,
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.post("/api/skill/:name/meta", async (c) => {
    const name = c.req.param("name");
    const { zh, notes, category } = await c.req.json();
    try {
      const result = ops.setMetadataOverride(name, { zh, notes, category }, customHome);
      buildRegistry(customHome);
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  app.delete("/api/skill/:name", async (c) => {
    const name = c.req.param("name");
    const url = new URL(c.req.url);
    const wholeBundle = url.searchParams.get("wholeBundle") === "true";

    try {
      let result;
      if (wholeBundle) {
        const reg = JSON.parse(readFileSync(paths.REGISTRY_FILE, "utf-8"));
        const bundle = reg.skills[name]?.bundle;
        if (!bundle) {
          return c.json({ ok: false, error: `${name} is not part of a bundle` }, 400);
        }
        result = ops.removeBundle(bundle, customHome);
      } else {
        result = ops.removeSkill(name, {}, customHome);
      }
      buildRegistry(customHome);
      return c.json({ ok: true, ...result });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  app.get("/api/hot", async (c) => {
    try {
      const force = new URL(c.req.url).searchParams.get("force") === "1";
      return c.json({ ok: true, ...(await hot.getHot({ force, customHome })) });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.get("/api/trash", (c) => {
    try {
      return c.json({ ok: true, items: ops.listTrash(customHome) });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.post("/api/trash/restore", async (c) => {
    const { entry } = await c.req.json();
    if (!entry) return c.json({ ok: false, error: "entry required" }, 400);
    try {
      const r = ops.restoreTrash(entry, customHome);
      buildRegistry(customHome);
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  app.get("/api/sync/plan", (c) => {
    try {
      return c.json({ ok: true, actions: buildSyncPlan(customHome) });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.post("/api/sync/apply", async (c) => {
    try {
      const body = await c.req.json();
      const requestedKinds = Array.isArray(body.kinds) ? body.kinds : [];
      const allowedKinds = new Set(["link", "fix-broken-link"]);
      if (
        requestedKinds.length === 0 ||
        requestedKinds.length > allowedKinds.size ||
        requestedKinds.some((kind) => !allowedKinds.has(kind))
      ) {
        return c.json({ ok: false, error: "kinds must contain link and/or fix-broken-link" }, 400);
      }

      // Never trust client-supplied paths or action objects. Rebuild from the
      // current filesystem state, then apply only the explicitly allowed kind.
      const actions = buildSyncPlan(customHome).filter((action) => requestedKinds.includes(action.kind));
      const applyResult = actions.length
        ? applySyncPlan(actions, customHome)
        : { sessionId: null, applied: [] };
      if (actions.length) buildRegistry(customHome);
      const results = applyResult.applied || [];
      const failed = results.filter((result) => !result.ok);
      return c.json({
        ok: failed.length === 0,
        partial: failed.length > 0 && failed.length < results.length,
        sessionId: applyResult.sessionId,
        attempted: results.length,
        succeeded: results.length - failed.length,
        failed: failed.length,
        results,
        error: failed.length ? `${failed.length} sync action(s) failed` : undefined,
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.get("/api/health", (c) => {
    try {
      const reg = isRegistryStale() ? buildRegistry(customHome) : JSON.parse(readFileSync(paths.REGISTRY_FILE, "utf-8"));
      const issues = runDoctor(reg, customHome);
      return c.json({ ok: true, issues });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.get("/api/self-update", async (c) => {
    try {
      const force = new URL(c.req.url).searchParams.get("force") === "1";
      const info = await checkSelfUpdate({ force, customHome });
      return c.json({ ok: true, ...info });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.post("/api/undo", (c) => {
    try {
      const result = undoLastBackup(paths.BACKUPS_DIR);
      buildRegistry(customHome);
      return c.json(result);
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.get("/api/skill/:name/readme", (c) => {
    const name = c.req.param("name");
    try {
      assertSafeName(name, "skill name");
      let dir = join(paths.SSOT, name);
      if (existsSync(paths.REGISTRY_FILE)) {
        const reg = JSON.parse(readFileSync(paths.REGISTRY_FILE, "utf-8"));
        if (reg.skills[name]?.path) dir = reg.skills[name].path;
      }
      const skillMd = join(dir, "SKILL.md");
      if (!existsSync(skillMd)) return c.json({ ok: false, error: "no SKILL.md" }, 404);
      return c.json({ ok: true, content: readFileSync(skillMd, "utf-8") });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  /* ---------- Static files ---------- */
  app.use("/*", serveStatic({ root: WEB_ROOT, rewriteRequestPath: (p) => (p === "/" ? "/index.html" : p) }));

  return app;
}

/**
 * Asks whoever holds the port whether they are SkillHub, and which Skills
 * folder they serve. Returns null for anything that does not answer like us.
 */
async function probeSkillHub(url) {
  try {
    const res = await fetch(`${url}/api/registry`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.ssot === "string" && data.version ? { ssot: data.ssot } : null;
  } catch {
    return null;
  }
}

export function startServer({ port = PORT, host = HOST, customHome = null, autoOpen = true } = {}) {
  const bindHost = String(host || "").trim();
  if (!isLoopbackHost(bindHost)) {
    throw new Error(`Refusing to expose SkillHub on non-loopback host: ${host}`);
  }
  if (!isValidPort(port)) {
    throw new Error(`Invalid SkillHub port: ${port}`);
  }
  const app = createApp(customHome);

  // Bootstrapping registry scan
  buildRegistry(customHome);

  const displayHost = bindHost === "::1" ? "[::1]" : bindHost;
  const url = `http://${displayHost}:${port}`;

  const openBrowser = () => {
    if (!autoOpen || process.env.SKILL_HUB_NO_OPEN) return;
    if (process.platform === "darwin") {
      spawnSync("open", [url]);
    } else if (process.platform === "win32") {
      spawnSync("cmd", ["/c", "start", "", url]);
    } else {
      spawnSync("xdg-open", [url]);
    }
  };

  const server = serve({ fetch: app.fetch, port, hostname: bindHost }, (info) => {
    console.log(`\n🎨 SkillHub running at http://${displayHost}:${info.port}`);
    console.log("   Bound to this computer only.\n");
    openBrowser();
  });

  // The usual reason this port is taken is that SkillHub is already running,
  // which is not an error worth a stack trace: open the page that is there.
  // But only after asking it — the port could belong to anything, and sending
  // the user to a stranger's page while calling it SkillHub is worse than a
  // stack trace. A second SkillHub serving a different home counts as a
  // stranger too, so the answer has to include which home it serves.
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      void (async () => {
        const other = await probeSkillHub(url);
        if (!other) {
          console.error(`\nPort ${port} is in use by something that is not SkillHub.`);
          console.error(`Start on another port with: skillhub open --port ${port + 1}\n`);
          process.exitCode = 1;
          return;
        }
        console.log(`\n🎨 SkillHub is already running at ${url}`);
        console.log(`   Serving ${other.ssot}`);
        if (other.ssot !== getPaths(customHome).SSOT) {
          console.log(`   Note: that is a different Skills folder than this command would serve.`);
        }
        console.log("   Opening that page instead. Use --port to start a second one.\n");
        openBrowser();
        process.exitCode = 0;
      })();
      return;
    }
    console.error(`\nCould not start SkillHub: ${err?.message || err}\n`);
    process.exitCode = 1;
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
