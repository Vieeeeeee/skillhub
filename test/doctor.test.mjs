import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "../src/core/registry.mjs";
import { runDoctor } from "../src/core/doctor/index.mjs";

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
  assert.equal(Object.keys(reg.skills).length, 0, "nothing is managed in the SSOT yet");

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
