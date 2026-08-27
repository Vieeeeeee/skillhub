import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setMetadataOverride } from "../src/core/ops.mjs";
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
  // cursor is switched on explicitly; gemini is left to the default, and its
  // directory does not exist in this sandbox.
  // The link has to exist for cursor to have a trigger word at all: a trigger
  // is what an Agent that can reach the Skill would answer to, and cursor can
  // only reach it through this link.
  const cursorSkills = join(tmp, ".cursor", "skills");
  mkdirSync(cursorSkills, { recursive: true });
  symlinkSync(skillDir, join(cursorSkills, "demo"), "dir");
  saveUserOverrides(join(tmp, ".skillhub", "overrides.json"), {
    notesOverrides: { demo: "portable note" },
    managedSkills: { demo: "external-manager" },
    agentVisibility: { cursor: true },
  });

  const reg = buildRegistry(tmp);
  assert.equal(reg.skills.demo.notes, "portable note");
  assert.equal(reg.skills.demo.managed, "external-manager");

  // Codex discovers natively and triggers on the frontmatter name; the
  // link-based Agents trigger on the directory name.
  assert.equal(reg.skills.demo.triggers.codex, "$demo");
  assert.equal(reg.skills.demo.triggers.cursor, "/demo");

  // Take the link away and the trigger word goes with it. An Agent that cannot
  // reach the Skill has no command to offer, and printing one sends the user to
  // type something that does nothing — which is what `unlink` and a restore
  // from the trash both used to leave behind.
  rmSync(join(cursorSkills, "demo"));
  const afterUnlink = buildRegistry(tmp);
  assert.equal(afterUnlink.skills.demo.agents.cursor, false);
  assert.equal(afterUnlink.skills.demo.triggers.cursor, undefined);
  assert.equal(afterUnlink.skills.demo.triggers.codex, "$demo", "the native Agent still reaches it");

  // An Agent that is not in use is left out of the registry entirely, so the
  // switch means the same thing to `scan`, to the sync planner and to the
  // dashboard.
  assert.equal(reg.skills.demo.triggers.gemini, undefined);
  assert.equal(reg.skills.demo.agents.gemini, undefined);
  assert.ok(!("gemini" in reg.agents));
  assert.ok("cursor" in reg.agents);
});

test("a dangling SSOT link stays in the listing instead of vanishing", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-broken-ssot-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ssot = join(tmp, ".agents", "skills");
  mkdirSync(ssot, { recursive: true });
  symlinkSync(join(tmp, "gone"), join(ssot, "orphan"), "dir");

  // Dropping it meant the dashboard showed nothing at all and only the health
  // report knew the entry existed.
  const entry = buildRegistry(tmp).skills.orphan;
  assert.ok(entry, "the entry has to appear");
  assert.equal(entry.type, "broken-symlink");
  assert.equal(entry.broken, true);
});

test("overrides writes are readable and malformed files fail loudly", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-overrides-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const file = join(tmp, ".skillhub", "overrides.json");

  saveUserOverrides(file, { categoryOverrides: { demo: "Tools" } });
  assert.equal(loadUserOverrides(file).categoryOverrides.demo, "Tools");

  writeFileSync(file, "{broken-json");
  // Refusing a damaged file is right — starting over silently would throw away
  // the user's blurbs. The message has to name the file and the way out.
  assert.throws(() => loadUserOverrides(file), (error) => {
    assert.match(error.message, /Cannot read .*overrides\.json/);
    assert.match(error.message, /blurbs/);
    assert.match(error.message, /move it aside/);
    return true;
  });
});

test("an erased Chinese blurb stays erased across rescans", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-blurb-clear-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const skill = join(tmp, ".agents", "skills", "alpha");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha\ndescription: an english description\n---\n");

  setMetadataOverride("alpha", { zh: "第一版介绍" }, tmp);
  assert.equal(buildRegistry(tmp).skills.alpha.zh, "第一版介绍");

  // Writing an empty blurb used to report success while the previous registry
  // quietly handed the old text back on the next scan.
  setMetadataOverride("alpha", { zh: "" }, tmp);
  assert.equal(buildRegistry(tmp).skills.alpha.zh, "", "clearing a blurb must actually clear it");
});

test("a broken Agent link does not count as the Agent seeing the Skill", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-broken-visible-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const skill = join(tmp, ".agents", "skills", "alpha");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha\ndescription: d\n---\n");

  const claudeSkills = join(tmp, ".claude", "skills");
  mkdirSync(claudeSkills, { recursive: true });
  symlinkSync(join(tmp, "gone"), join(claudeSkills, "alpha"), "dir");

  const reg = buildRegistry(tmp);
  assert.equal(
    reg.skills.alpha.agents.claude,
    false,
    "a dangling link was reported as visible while the sync plan called it broken"
  );
});

test("the registry carries no upstream-version fields it never fills in", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-no-phantom-update-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const skill = join(tmp, ".agents", "skills", "alpha");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha\ndescription: d\n---\n");

  // Nothing in SkillHub queries an upstream version. Keeping the fields around
  // let the dashboard render "all up to date" out of a value that was only ever
  // copied forward as false.
  const entry = buildRegistry(tmp).skills.alpha;
  for (const field of ["hasUpdate", "latestUpstream", "lastChecked"]) {
    assert.ok(!(field in entry), `registry must not expose ${field}`);
  }
});

test("a hand-written Chinese blurb counts towards classification", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-zh-classify-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Neither the directory name nor the English description says what this is.
  const skill = join(tmp, ".agents", "skills", "zz-tool");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: zz-tool\ndescription: helper\n---\n");

  const before = buildRegistry(tmp).skills["zz-tool"].category;
  assert.equal(before, "其他 / 未分类");

  setMetadataOverride("zz-tool", { zh: "把设计稿做成 PPT 演示文稿" }, tmp);

  // Writing blurbs and sorting Skills into categories are the two main jobs
  // here; the first used to do nothing at all for the second.
  const after = buildRegistry(tmp).skills["zz-tool"].category;
  assert.notEqual(after, "其他 / 未分类", "the blurb names exactly what the rules look for");
});

test("the registry drops fields nothing reads", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-dead-fields-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const skill = join(tmp, ".agents", "skills", "alpha");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha\ndescription: d\nversion: 1.2.3\n---\n");

  const entry = buildRegistry(tmp).skills.alpha;
  for (const field of ["upstreamPath", "installedVersion"]) {
    assert.ok(!(field in entry), `${field} was written on every entry and read nowhere`);
  }
  // aliasOf earns its place only on an entry that really is a second name for
  // another Skill, and realPath only when it differs from the entry path.
  assert.ok(!("aliasOf" in entry), "an ordinary Skill is not an alias of anything");
  // On macOS the temp directory is itself reached through a symlink, so a real
  // realPath here is correct. The contract is that it is never a duplicate.
  assert.notEqual(entry.realPath, entry.path, "the same string must not be stored twice");
});

test("a Skill only one Agent can read is listed, marked, and never written to", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-agent-only-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ssot = join(tmp, ".agents", "skills");
  mkdirSync(join(ssot, "shared"), { recursive: true });
  writeFileSync(join(ssot, "shared", "SKILL.md"), "---\nname: shared\ndescription: d\n---\n");

  // Codex's bundled Skill Creator installs here. The Skill is real and
  // loadable; it just cannot be shared until it moves.
  const codexOnly = join(tmp, ".codex", "skills", "made-in-codex");
  mkdirSync(codexOnly, { recursive: true });
  writeFileSync(join(codexOnly, "SKILL.md"), "---\nname: made-in-codex\ndescription: makes images\n---\n");

  const reg = buildRegistry(tmp);
  const entry = reg.skills["made-in-codex"];
  assert.ok(entry, "an inventory that claims to hold every Skill has to hold this one");
  assert.equal(entry.type, "agent-only");
  assert.equal(entry.agentOnly, "codex");
  assert.equal(entry.agents.codex, true);
  assert.equal(entry.path, codexOnly, "the row points at where the body really is");
  assert.notEqual(entry.category, "其他 / 未分类", "it is classified like any other Skill");
  // An Agent that cannot read it has no trigger word for it, and showing one
  // told the user to type a command that does nothing.
  assert.deepEqual(Object.keys(entry.triggers), ["codex"]);
  assert.equal(entry.triggers.codex, "$made-in-codex");

  // Nothing here writes to it, and the refusal says why rather than reading
  // like the Skill went missing.
  assert.throws(
    () => setMetadataOverride("made-in-codex", { zh: "试试" }, tmp),
    /read-only here/
  );

  // A copy under a name the managed folder already knows stays out of the list.
  const dupe = join(tmp, ".codex", "skills", "shared");
  mkdirSync(dupe, { recursive: true });
  writeFileSync(join(dupe, "SKILL.md"), "---\nname: shared\ndescription: d\n---\n");
  const again = buildRegistry(tmp);
  assert.equal(again.skills.shared.type, "local", "the managed copy stays the one that counts");
  assert.equal(Object.keys(again.skills).length, 2);
});
