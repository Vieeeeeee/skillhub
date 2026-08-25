import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "../src/core/registry.mjs";
import { execFileSync } from "node:child_process";
import { runDoctor, isDefaultReportItem } from "../src/core/doctor/index.mjs";

test("doctor flags missing fields, secrets, and long descriptions", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-doctor-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ssot = join(tmp, ".agents", "skills");
  mkdirSync(ssot, { recursive: true });

  // 1. Skill with missing name and secret in .env
  const badSkill = join(ssot, "bad-skill");
  mkdirSync(badSkill, { recursive: true });
  writeFileSync(join(badSkill, "SKILL.md"), "---\ndescription: only desc\n---\n");
  const fakeGoogleKey = "AIza" + "SyA12345678901234567890123456789012";
  writeFileSync(join(badSkill, ".env"), `API_KEY=${fakeGoogleKey}\n`);
  const nested = join(badSkill, "references", "private");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, ".env.production"), "DATABASE_URL=postgres://example.invalid\n");
  writeFileSync(join(nested, "config.ts"), `export const key = "sk-proj-${"A".repeat(32)}";\n`);

  // 2. Skill with long description (>200 chars)
  const longSkill = join(ssot, "long-skill");
  mkdirSync(longSkill, { recursive: true });
  const longDesc = "A".repeat(250);
  writeFileSync(join(longSkill, "SKILL.md"), `---\nname: long-skill\ndescription: ${longDesc}\n---\n`);

  const reg = buildRegistry(tmp);
  const issues = runDoctor(reg, tmp);

  assert.ok(issues.some((i) => i.id === "missing-name" && i.skill === "bad-skill"));
  assert.ok(issues.some((i) => i.id === "secret-detected" && i.skill === "bad-skill" && i.path.endsWith(".env.production")));
  assert.ok(issues.some((i) => i.id === "secret-detected" && i.title.includes("OpenAI")));
  assert.ok(issues.some((i) => i.id === "long-description" && i.skill === "long-skill"));
});

test("doctor bounds large-file scanning and reports incomplete coverage", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-doctor-limit-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const skill = join(tmp, ".agents", "skills", "large-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: large-skill\ndescription: safe\n---\n");
  writeFileSync(join(skill, "large.txt"), "x".repeat(512 * 1024 + 1));

  const issues = runDoctor(buildRegistry(tmp), tmp);
  const coverage = issues.find((issue) => issue.id === "security-scan-incomplete");
  assert.ok(coverage);
  assert.match(coverage.reason, /512 KB/);
});

test("doctor inspects Skills that live in an Agent directory without touching them", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-doctor-agent-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // A brand-new user has no SSOT at all: every Skill is a real directory
  // inside the Agent folder. The report must still cover those Skills.
  const claudeSkills = join(tmp, ".claude", "skills");
  const leaky = join(claudeSkills, "leaky");
  mkdirSync(leaky, { recursive: true });
  writeFileSync(
    join(leaky, "SKILL.md"),
    `---\nname: not-leaky\ndescription: image helper\n---\nkey sk-proj-${"B".repeat(32)}\n`,
  );

  const nameless = join(claudeSkills, "nameless");
  mkdirSync(nameless, { recursive: true });
  writeFileSync(join(nameless, "SKILL.md"), "# no frontmatter at all\n");

  const reg = buildRegistry(tmp);
  // Nothing is in the managed folder, but the inventory still lists both — a
  // Skill that only one Agent can read is still a Skill the user owns. They are
  // marked for what they are, and nothing here writes to them.
  assert.deepEqual(Object.keys(reg.skills).sort(), ["leaky", "nameless"]);
  assert.equal(reg.skills.leaky.type, "agent-only");
  assert.equal(reg.skills.leaky.agentOnly, "claude");
  // Only Agents in use appear, and exactly one of them can read this.
  assert.deepEqual(reg.skills.leaky.agents, { claude: true });

  const issues = runDoctor(reg, tmp);

  const secret = issues.find((i) => i.id === "secret-detected" && i.skill === "leaky");
  assert.ok(secret, "a leaked key inside an Agent directory is reported");
  assert.equal(secret.location, "claude 目录", "the report says where the Skill actually lives");

  assert.ok(issues.some((i) => i.id === "name-mismatch" && i.skill === "leaky"));
  assert.ok(issues.some((i) => i.id === "missing-name" && i.skill === "nameless"));
  assert.ok(issues.some((i) => i.id === "missing-description" && i.skill === "nameless"));

  // Inspection is read-only: the Skill files stay exactly where they were.
  assert.ok(existsSync(join(leaky, "SKILL.md")));
  assert.ok(existsSync(join(nameless, "SKILL.md")));
  assert.equal(existsSync(join(tmp, ".agents", "skills", "leaky")), false);
});

test("secret scanning ignores documented placeholders but keeps real findings", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-doctor-fp-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ssot = join(tmp, ".agents", "skills");

  // Template files carry keys without values and are meant to be committed.
  const template = join(ssot, "template-skill");
  mkdirSync(template, { recursive: true });
  writeFileSync(join(template, "SKILL.md"), "---\nname: template-skill\ndescription: ok\n---\n");
  writeFileSync(join(template, ".env.example"), "# Copy to .env\nAPI_KEY=\n");
  writeFileSync(join(template, "docs.md"), "Use AKIAIOSFODNN7EXAMPLE as the sample value.\n");

  // A real .env and a real-looking key must still be reported.
  const real = join(ssot, "real-skill");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "SKILL.md"), "---\nname: real-skill\ndescription: ok\n---\n");
  writeFileSync(join(real, ".env"), "TOKEN=value\n");
  writeFileSync(join(real, "deploy.sh"), "AWS_KEY=AKIA1234567890ABCDEF\n");

  const issues = runDoctor(buildRegistry(tmp), tmp);
  const secrets = issues.filter((i) => i.id === "secret-detected");

  assert.equal(secrets.some((i) => i.skill === "template-skill"), false,
    "placeholders and .env templates are not reported as leaks");
  assert.ok(secrets.some((i) => i.skill === "real-skill" && i.title.includes("Env File")));
  assert.ok(secrets.some((i) => i.skill === "real-skill" && i.title.includes("AWS")));
});

test("findings are tagged by whether the user can act on them", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-doctor-owned-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ssot = join(tmp, ".agents", "skills");
  const longDesc = "A".repeat(250);

  // The user's own Skill: editable, so it stays in the default report.
  const own = join(ssot, "own-skill");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "SKILL.md"), `---\nname: own-skill\ndescription: ${longDesc}\n---\n`);

  // A Skill inside a tracked bundle: a local edit is lost on the next update.
  const repo = join(tmp, ".agents", "_repos", "vendor-bundle", "vendored");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "SKILL.md"), `---\nname: vendored\ndescription: ${longDesc}\n---\n`);
  mkdirSync(ssot, { recursive: true });
  symlinkSync("../_repos/vendor-bundle/vendored", join(ssot, "vendored"), "dir");

  const issues = runDoctor(buildRegistry(tmp), tmp);

  const mine = issues.find((i) => i.skill === "own-skill" && i.id === "long-description");
  const upstream = issues.find((i) => i.skill === "vendored" && i.id === "long-description");

  assert.equal(mine.owned, true, "the user's own Skill is actionable");
  assert.equal(upstream.owned, false, "an upstream-managed Skill is informational");
  assert.ok(issues.every((i) => typeof i.owned === "boolean"), "every finding carries the tag");
});

test("versioning the Skills folder with git does not hide every finding", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-doctor-git-ssot-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ssot = join(tmp, ".agents", "skills");
  const mine = join(ssot, "mine");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "SKILL.md"), "---\nname: mine\ndescription: my own skill\n---\n");
  const fakeToken = "ghp_" + "b".repeat(34);
  writeFileSync(join(mine, "leak.txt"), `token = ${fakeToken}\n`);

  // Keeping the whole Skills folder under version control is a normal thing to
  // do. It must not turn every Skill inside it into "someone else's".
  execFileSync("git", ["-C", ssot, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", ssot, "remote", "add", "origin", "https://github.com/someone/my-skills.git"], { stdio: "ignore" });

  const issues = runDoctor(buildRegistry(tmp), tmp);
  const secret = issues.find((i) => i.id === "secret-detected" && i.skill === "mine");

  assert.ok(secret, "a planted token inside a git-versioned Skills folder must still be reported");
  assert.equal(secret.owned, true, "a Skill is not upstream-managed just because an ancestor directory is a repo");
  assert.ok(isDefaultReportItem(secret), "the default report must list it");
});

test("real breakage is listed even inside an upstream-managed Skill", () => {
  const upstreamSecret = { tier: "A", owned: false, decision: true };
  const upstreamNote = { tier: "C", owned: false, decision: false };
  const ownNote = { tier: "C", owned: true, decision: false };
  const ownDecision = { tier: "B", owned: true, decision: true };

  assert.equal(isDefaultReportItem(upstreamSecret), true);
  assert.equal(isDefaultReportItem(ownDecision), true);
  assert.equal(isDefaultReportItem(upstreamNote), false);
  assert.equal(isDefaultReportItem(ownNote), false);
});

test("rules cover the three ways a Skill is installed but unusable", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-unusable-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const ssot = join(tmp, ".agents", "skills");

  // 1. A directory name outside the naming shape still gets a trigger word.
  const underscored = join(ssot, "my_diary");
  mkdirSync(underscored, { recursive: true });
  writeFileSync(join(underscored, "SKILL.md"), "---\nname: my_diary\ndescription: d\n---\n");

  // 2. Two directories declaring the same frontmatter name fight over $name.
  for (const dir of ["first", "second"]) {
    const full = join(ssot, dir);
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, "SKILL.md"), "---\nname: shared-trigger\ndescription: d\n---\n");
  }

  // 3. SKILL.md pointing at a file that is not there sends the Agent nowhere.
  const linky = join(ssot, "linky");
  mkdirSync(join(linky, "references"), { recursive: true });
  writeFileSync(join(linky, "references", "present.md"), "here\n");
  writeFileSync(
    join(linky, "SKILL.md"),
    "---\nname: linky\ndescription: d\n---\n\n[a](references/present.md) [b](references/missing.md)\n"
  );

  const issues = runDoctor(buildRegistry(tmp), tmp);

  const invalid = issues.filter((i) => i.id === "invalid-skill-name");
  assert.deepEqual(invalid.map((i) => i.skill), ["my_diary"]);
  assert.equal(invalid[0].tier, "A");

  const collisions = issues.filter((i) => i.id === "duplicate-trigger-name");
  assert.deepEqual(collisions.map((i) => i.skill).sort(), ["first", "second"]);
  assert.ok(collisions.every((i) => i.tier === "A"));

  const broken = issues.filter((i) => i.id === "broken-internal-link");
  assert.deepEqual(broken.map((i) => i.skill), ["linky"]);
  assert.match(broken[0].reason, /references\/missing\.md/);
  assert.doesNotMatch(broken[0].reason, /present\.md/);
});

test("executable scripts are counted but kept out of the default list", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-scripts-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const skill = join(tmp, ".agents", "skills", "runner");
  mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: runner\ndescription: d\n---\n");
  writeFileSync(join(skill, "scripts", "setup.sh"), "#!/bin/sh\necho hi\n");
  writeFileSync(join(skill, "scripts", "tool.py"), "print('hi')\n");
  writeFileSync(join(skill, "notes.md"), "not a script\n");

  const issues = runDoctor(buildRegistry(tmp), tmp);
  const found = issues.find((i) => i.id === "contains-scripts");

  assert.ok(found, "a Skill that can run code should say so");
  assert.match(found.title, /2 个可执行脚本/);
  assert.equal(isDefaultReportItem(found), false, "it is context, not a decision to make");
});

test("a SKILL.md too large to parse is reported as that, not as missing fields", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-doctor-big-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const dir = join(tmp, ".agents", "skills", "huge-skill");
  mkdirSync(dir, { recursive: true });
  // Valid frontmatter, just past the parse ceiling. The parser bails out before
  // reading it, and the report used to turn that into two Tier A findings about
  // fields that are sitting right there in the file.
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: huge-skill\ndescription: a real description\n---\n${"x".repeat(1024 * 1024 + 10)}\n`
  );

  const issues = runDoctor(buildRegistry(tmp), tmp).filter((i) => i.skill === "huge-skill");
  assert.ok(issues.some((i) => i.id === "skill-md-too-large"));
  assert.ok(!issues.some((i) => i.id === "missing-name"), "the name was never read, so it cannot be called missing");
  assert.ok(!issues.some((i) => i.id === "missing-description"));
  assert.ok(!issues.some((i) => i.tier === "A"), "nothing here is a Tier A problem");
});

test("one Skill linked under two names is an alias, not a collision", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-alias-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ssot = join(tmp, ".agents", "skills");
  const real = join(ssot, "open-gstack-browser");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "SKILL.md"), "---\nname: open-gstack-browser\ndescription: launches a browser\n---\n");
  // Upstream bundles ship these deliberately: a second, friendlier name for the
  // same directory. Both entries carry the same frontmatter name because they
  // are the same file.
  symlinkSync(real, join(ssot, "connect-chrome"), "dir");

  const issues = runDoctor(buildRegistry(tmp), tmp);
  assert.equal(issues.filter((i) => i.id === "duplicate-trigger-name").length, 0,
    "nothing is fighting over the trigger — it is one Skill");
  assert.equal(issues.filter((i) => i.id === "name-mismatch").length, 0,
    "the real directory is named exactly after its frontmatter");

  // A genuine collision — two different Skills declaring one name — still counts.
  const other = join(ssot, "my-own-browser");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "SKILL.md"), "---\nname: open-gstack-browser\ndescription: a different thing\n---\n");
  const second = runDoctor(buildRegistry(tmp), tmp);
  assert.ok(second.some((i) => i.id === "duplicate-trigger-name" && i.tier === "A"));
});
