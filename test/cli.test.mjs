import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const CLI = join(process.cwd(), "bin", "skillhub");

function run(home, args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, SKILL_HUB_HOME: home, SKILL_HUB_NO_OPEN: "1" },
  });
}

function makeHome(t, skills) {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-cli-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  for (const [name, description] of Object.entries(skills)) {
    const dir = join(tmp, ".agents", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
  }
  return tmp;
}

test("compact scan keeps what a caller decides with and drops the rest", (t) => {
  const home = makeHome(t, {
    alpha: "Browser automation helper for scripted page interaction.",
    beta: "Writes release notes from a commit range.",
  });

  const full = JSON.parse(run(home, ["scan", "--json"]));
  const compact = JSON.parse(run(home, ["scan", "--json", "--compact"]));

  assert.equal(compact.total, 2);
  assert.deepEqual(Object.keys(compact.skills).sort(), ["alpha", "beta"]);
  assert.ok(Array.isArray(compact.knownCategories) && compact.knownCategories.length > 0);

  const entry = compact.skills.alpha;
  assert.deepEqual(
    Object.keys(entry).sort(),
    ["agents", "category", "description", "hasBlurb", "type"],
    "compact entries carry exactly the fields a caller acts on"
  );
  assert.ok(Array.isArray(entry.agents), "agents is the list that can see it, not a map of every Agent");
  assert.equal(entry.description, full.skills.alpha.description);
  assert.equal(entry.category, full.skills.alpha.category);

  // The full payload runs to roughly 95k tokens on a real library; the point of
  // the compact form is that Step 1 of the Skill no longer crowds out the task.
  const fullBytes = run(home, ["scan", "--json"]).length;
  const compactBytes = run(home, ["scan", "--json", "--compact"]).length;
  assert.ok(compactBytes * 2 < fullBytes, `compact should be far smaller (${compactBytes} vs ${fullBytes})`);
});

test("a hand-written blurb travels through compact scan, a derived one does not", (t) => {
  const home = makeHome(t, {
    alpha: "An english description that no Chinese blurb was derived from.",
    gamma: "这条描述本来就是中文，中文介绍只是它的截断副本。",
  });

  run(home, ["describe", "alpha", "浏览器自动化助手"]);
  const compact = JSON.parse(run(home, ["scan", "--json", "--compact"]));

  assert.equal(compact.skills.alpha.zh, "浏览器自动化助手");
  assert.equal(compact.skills.alpha.hasBlurb, true);

  assert.equal(compact.skills.gamma.zh, undefined, "a blurb that just repeats the description is not sent twice");
  assert.equal(compact.skills.gamma.hasBlurb, true, "but the caller is still told one exists");
});

test("describe writes a blurb and an empty one erases it", (t) => {
  const home = makeHome(t, { alpha: "An english description." });

  run(home, ["describe", "alpha", "第一版介绍"]);
  assert.equal(JSON.parse(run(home, ["scan", "--json"])).skills.alpha.zh, "第一版介绍");

  run(home, ["describe", "alpha", ""]);
  assert.equal(
    JSON.parse(run(home, ["scan", "--json"])).skills.alpha.zh,
    "",
    "the command reported success, so the blurb has to actually be gone"
  );
});

test("version prints the package version and nothing else", (t) => {
  const home = makeHome(t, {});
  const printed = run(home, ["--version"]).trim();
  assert.match(printed, /^\d+\.\d+\.\d+$/);
});
