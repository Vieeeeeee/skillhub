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

function runFailing(home, args) {
  try {
    execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SKILL_HUB_HOME: home, SKILL_HUB_NO_OPEN: "1" },
    });
    throw new Error("expected the command to fail");
  } catch (error) {
    if (error.status === undefined) throw error;
    return `${error.stdout || ""}${error.stderr || ""}`;
  }
}

test("a positional argument may start with a dash", (t) => {
  const home = makeHome(t, { alpha: "An english description." });

  // These are user-written text, not options. Scanning every argv token for a
  // leading dash rejected them with a usage dump.
  run(home, ["categorize", "alpha", "-实验"]);
  run(home, ["describe", "alpha", "--这条介绍以横线开头"]);

  const skill = JSON.parse(run(home, ["scan", "--json"])).skills.alpha;
  assert.equal(skill.category, "-实验");
  assert.equal(skill.zh, "--这条介绍以横线开头");

  // A genuine unknown option still has to be refused.
  assert.match(runFailing(home, ["scan", "--bogus"]), /Unknown option/);
});

test("--port refuses a missing or unusable value instead of silently ignoring it", (t) => {
  const home = makeHome(t, {});
  for (const args of [["open", "--port"], ["open", "--port", "abc"], ["open", "--port", "99999"]]) {
    assert.match(runFailing(home, args), /--port needs a number between 1 and 65535/);
  }
});

test("undo with nothing recorded is not reported as a failure", (t) => {
  const home = makeHome(t, {});
  const out = run(home, ["undo"]);
  assert.match(out, /没有需要撤销的操作/);
  assert.doesNotMatch(out, /failed/i);
});

test("pending offers every category the rules can produce", (t) => {
  const home = makeHome(t, { alpha: "An english description with no category match at all." });
  const pending = JSON.parse(run(home, ["pending", "--json"]));

  // Handing back only the categories that already have members meant an empty
  // one could never be chosen, so nothing was ever filed under it.
  const scan = JSON.parse(run(home, ["scan", "--json"]));
  for (const known of scan.knownCategories) {
    assert.ok(pending.categories.includes(known), `${known} must be offered`);
  }
});

test("a blurb has a length limit", (t) => {
  const home = makeHome(t, { alpha: "An english description." });
  const out = runFailing(home, ["describe", "alpha", "长".repeat(5000)]);
  assert.match(out, /too long/);
});
