import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
