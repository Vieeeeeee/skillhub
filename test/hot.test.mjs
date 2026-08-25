import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "../src/core/registry.mjs";
import { getHot } from "../server/hot.mjs";

test("the leaderboard marks a repository installed only on a full owner/repo match", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-hot-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // A local directory that happens to be called `skills`, with no upstream at
  // all. Matching on the bare repo name used to make this one directory claim
  // anthropics/skills, openai/skills and cloudflare/skills all at once.
  const local = join(tmp, ".agents", "skills", "skills");
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, "SKILL.md"), "---\nname: skills\ndescription: my own thing\n---\n");

  const tracked = join(tmp, ".agents", "skills", "renamed-locally");
  mkdirSync(tracked, { recursive: true });
  writeFileSync(join(tracked, "SKILL.md"), "---\nname: renamed-locally\ndescription: from a repo\n---\n");

  buildRegistry(tmp);
  const registryFile = join(tmp, ".skillhub", "registry.json");
  const reg = JSON.parse(readFileSync(registryFile, "utf-8"));
  reg.skills["renamed-locally"].origin = "https://github.com/openai/skills.git";
  writeFileSync(registryFile, JSON.stringify(reg));

  // A fresh cache keeps this offline; getHot re-annotates `installed` from it.
  const cacheDir = join(tmp, ".skillhub", "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "hot-skills.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      totalScanned: 2,
      categories: {
        通用: [
          { repo: "anthropics/skills", stars: 1 },
          { repo: "openai/skills", stars: 2 },
        ],
      },
    })
  );

  const data = await getHot({ customHome: tmp });
  const rows = Object.fromEntries(data.categories.通用.map((r) => [r.repo, r.installed]));
  assert.equal(rows["openai/skills"], true, "this one really is installed, under a different local name");
  assert.equal(rows["anthropics/skills"], false, "a local directory called `skills` is not anthropics/skills");
});
