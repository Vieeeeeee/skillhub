import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillMeta,
  buildRegistry,
  loadUserOverrides,
  saveUserOverrides,
} from "../src/core/registry.mjs";
import { classifySkill } from "../src/core/classify.mjs";

test("parseSkillMeta accurately extracts frontmatter fields", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-meta-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const skillDir = join(tmp, "my-skill");
  mkdirSync(skillDir, { recursive: true });

  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---
name: my-skill
description: |
  A test skill with multiline
  description.
version: 1.2.3
---
# Main Content
`
  );

  const meta = parseSkillMeta(skillDir);
  assert.ok(meta.hasSkillMd);
  assert.ok(meta.hasName);
  assert.ok(meta.hasDescription);
  assert.equal(meta.fmName, "my-skill");
  assert.equal(meta.version, "1.2.3");
  assert.match(meta.description, /A test skill with multiline description/);
});

test("classifySkill applies rules and respects user overrides", () => {
  assert.equal(classifySkill("lark-base", "Lark Base tool"), "办公 / 协作");
  assert.equal(classifySkill("ios-qa", "iOS QA runner"), "移动端开发");

  // User override
  assert.equal(
    classifySkill("lark-base", "Lark Base tool", { "lark-base": "自定义办公分类" }),
    "自定义办公分类"
  );
});

test("classification keeps generic words out of the way of specific ones", () => {
  // Nearly every description contains the words "skill" and "agent", so they
  // must not decide the category on their own.
  assert.equal(classifySkill("photo-tool", "A skill for editing photos."), "图像 / 音视频");
  assert.equal(classifySkill("agents-sdk", "Build an agent on Cloudflare Workers."), "云服务 / 部署");
  assert.equal(
    classifySkill("apple-design", "Interface design and motion. Use when reviewing gesture-driven UI."),
    "设计 / 前端",
  );

  // An ASCII keyword needs a word boundary, but a plural still counts.
  assert.equal(classifySkill("news", "Read the latest release notes."), "其他 / 未分类");
  assert.equal(classifySkill("gen", "generate images"), "图像 / 音视频");

  // Chinese descriptions are matched as substrings.
  assert.equal(classifySkill("beta", "写公众号长文的助手"), "写作 / 内容");
  assert.equal(classifySkill("diary", "每天写日记"), "写作 / 内容");

  // "skill" is useless in a description but precise in a directory name.
  assert.equal(classifySkill("find-skills", "搜索和安装新的插件"), "Agent / Skill 工具");
});

test("buildRegistry bootstraps an empty home directory correctly", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-home-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const reg = buildRegistry(tmp);
  assert.equal(reg.version, 3);
  assert.deepEqual(reg.skills, {});
  assert.ok(existsSync(join(tmp, ".skillhub", "registry.json")));
});

test("registry uses configured agent triggers and metadata overrides", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-registry-config-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const skillDir = join(tmp, ".agents", "skills", "demo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: demo skill\n---\n");
  saveUserOverrides(join(tmp, ".skillhub", "overrides.json"), {
    notesOverrides: { demo: "portable note" },
    managedSkills: { demo: "external-manager" },
  });

  const reg = buildRegistry(tmp);
  assert.equal(reg.skills.demo.notes, "portable note");
  assert.equal(reg.skills.demo.managed, "external-manager");
  assert.equal(reg.skills.demo.triggers.codex, "$demo");
  assert.equal(reg.skills.demo.triggers.cursor, "/demo");
});

test("overrides writes are readable and malformed files fail loudly", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-overrides-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const file = join(tmp, ".skillhub", "overrides.json");

  saveUserOverrides(file, { categoryOverrides: { demo: "Tools" } });
  assert.equal(loadUserOverrides(file).categoryOverrides.demo, "Tools");

  writeFileSync(file, "{broken-json");
  assert.throws(() => loadUserOverrides(file), /Unable to read overrides file/);
});
