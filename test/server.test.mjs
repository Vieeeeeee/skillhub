import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/server.mjs";
import { getOrCreateSessionToken } from "../server/session.mjs";

function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), "skillhub-server-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("static web UI is served from the package directory, independent of cwd", async (t) => {
  const previousCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "skillhub-server-test-"));
  process.chdir(home);
  t.after(() => {
    process.chdir(previousCwd);
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const response = await createApp(home).request("http://127.0.0.1:7777/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>SkillHub[^<]*<\/title>/);
});

test("sync apply rebuilds its plan and rejects client action objects", async (t) => {
  const home = makeHome(t);
  const token = getOrCreateSessionToken(home);
  const outside = join(home, "outside-skill");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "SKILL.md"), "---\nname: outside-skill\ndescription: fixture\n---\n");

  const response = await createApp(home).request("http://127.0.0.1:7777/api/sync/apply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SkillHub-Token": token,
      Origin: "http://127.0.0.1:7777",
    },
    body: JSON.stringify({
      actions: [{ kind: "harvest", path: outside, skill: "outside-skill", relink: [] }],
    }),
  });

  assert.equal(response.status, 400);
  assert.match(readFileSync(join(outside, "SKILL.md"), "utf8"), /outside-skill/);
});

test("registry refreshes when an existing SKILL.md changes", async (t) => {
  const home = makeHome(t);
  const skillDir = join(home, ".agents", "skills", "demo");
  const skillMd = join(skillDir, "SKILL.md");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillMd, "---\nname: demo\ndescription: first description\n---\n");
  const app = createApp(home);

  const first = await app.request("http://127.0.0.1:7777/api/registry");
  const firstData = await first.json();
  assert.equal(firstData.skills.demo.description, "first description");
  assert.equal(firstData.agentMeta.codex.type, "native");
  assert.equal(firstData.agentMeta.cursor.status, "experimental");

  writeFileSync(skillMd, "---\nname: demo\ndescription: changed description\n---\n");
  const future = new Date(Date.now() + 2_000);
  utimesSync(skillMd, future, future);

  const second = await app.request("http://127.0.0.1:7777/api/registry");
  assert.equal((await second.json()).skills.demo.description, "changed description");
});

test("update-all attempts a shared bundle only once and reports failure counts", async (t) => {
  const home = makeHome(t);
  const bundle = join(home, ".agents", "_repos", "fixture-bundle");
  const ssot = join(home, ".agents", "skills");
  mkdirSync(join(bundle, "skills", "one"), { recursive: true });
  mkdirSync(join(bundle, "skills", "two"), { recursive: true });
  mkdirSync(ssot, { recursive: true });
  writeFileSync(join(bundle, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: one\n---\n");
  writeFileSync(join(bundle, "skills", "two", "SKILL.md"), "---\nname: two\ndescription: two\n---\n");
  execFileSync("git", ["init", bundle], { stdio: "ignore" });
  symlinkSync(join(bundle, "skills", "one"), join(ssot, "one"), process.platform === "win32" ? "junction" : "dir");
  symlinkSync(join(bundle, "skills", "two"), join(ssot, "two"), process.platform === "win32" ? "junction" : "dir");

  const token = getOrCreateSessionToken(home);
  const response = await createApp(home).request("http://127.0.0.1:7777/api/update-all", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SkillHub-Token": token,
      Origin: "http://127.0.0.1:7777",
    },
    body: "{}",
  });
  const data = await response.json();

  assert.equal(data.ok, false);
  assert.equal(data.attempted, 1);
  assert.equal(data.failed, 1);
  assert.equal(data.results[0].bundle, "fixture-bundle");
});
