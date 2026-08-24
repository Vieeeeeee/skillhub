import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getPaths, getAgentDirs } from "../src/core/paths.mjs";
import { buildRegistry } from "../src/core/registry.mjs";
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
    const agentMeta = Object.fromEntries(
      Object.entries(getAgentDirs(customHome)).map(([key, cfg]) => [key, {
        name: cfg.name || key,
        type: cfg.type || "symlink",
        path: cfg.absPath,
        status: cfg.status || "",
      }])
    );
    return { ...registry, agentMeta };
  }

  // Security Middleware
  app.use("/api/*", createSecurityMiddleware(customHome));

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

  app.post("/api/update-all", (c) => {
    try {
      const reg = buildRegistry(customHome);
      const results = [];
      const updatedSources = new Set();
      for (const [name, s] of Object.entries(reg.skills || {})) {
        if (s.type === "git" || s.type === "bundle-symlink") {
          const sourceKey = s.bundle ? `bundle:${s.bundle}` : `skill:${name}`;
          if (updatedSources.has(sourceKey)) continue;
          updatedSources.add(sourceKey);
          try {
            const r = ops.updateSkill(name, customHome);
            results.push({ name, bundle: s.bundle || "", ok: true, ...r });
          } catch (e) {
            results.push({ name, bundle: s.bundle || "", ok: false, error: e.message });
          }
        }
      }
      buildRegistry(customHome);
      const failed = results.filter((r) => !r.ok);
      return c.json({
        ok: failed.length === 0,
        partial: failed.length > 0 && failed.length < results.length,
        attempted: results.length,
        succeeded: results.length - failed.length,
        failed: failed.length,
        results,
        error: failed.length ? `${failed.length} update(s) failed` : undefined,
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
    const deleteData = url.searchParams.get("deleteData") === "true";

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
        result = ops.removeSkill(name, { deleteData }, customHome);
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
      if (!existsSync(skillMd)) return c.json({ error: "no SKILL.md" }, 404);
      return c.json({ content: readFileSync(skillMd, "utf-8") });
    } catch (e) {
      return c.json({ error: e.message }, 400);
    }
  });

  /* ---------- Static files ---------- */
  app.use("/*", serveStatic({ root: WEB_ROOT, rewriteRequestPath: (p) => (p === "/" ? "/index.html" : p) }));

  return app;
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

  return serve({ fetch: app.fetch, port, hostname: bindHost }, (info) => {
    const displayHost = bindHost === "::1" ? "[::1]" : bindHost;
    const url = `http://${displayHost}:${info.port}`;
    console.log(`\n🎨 SkillHub running at ${url}`);
    console.log("   Bound to this computer only.\n");

    if (autoOpen && !process.env.SKILL_HUB_NO_OPEN) {
      if (process.platform === "darwin") {
        spawnSync("open", [url]);
      } else if (process.platform === "win32") {
        spawnSync("cmd", ["/c", "start", url]);
      } else {
        spawnSync("xdg-open", [url]);
      }
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
