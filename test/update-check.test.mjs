import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSelfUpdate, getCurrentVersion, getUpdateCommand, getPackageName } from "../src/core/update-check.mjs";

test("getCurrentVersion returns package version", () => {
  const ver = getCurrentVersion();
  assert.match(ver, /^\d+\.\d+\.\d+/);
});

test("checkSelfUpdate reads from cache and calculates hasUpdate correctly", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-update-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const cacheDir = join(tmp, ".skillhub", "cache");
  mkdirSync(cacheDir, { recursive: true });

  // 1. Mock cache with newer version
  writeFileSync(
    join(cacheDir, "self-update.json"),
    JSON.stringify({
      latestVersion: "99.0.0",
      releaseUrl: "https://github.com/Vieeeeeee/skillhub/releases",
      releaseNotes: "New awesome features",
      updateCommand: "git pull && npm install",
      checkedAt: new Date().toISOString(),
    })
  );

  const res = await checkSelfUpdate({ force: false, customHome: tmp });
  assert.ok(res.hasUpdate, "Should detect update when latestVersion > currentVersion");
  assert.equal(res.latestVersion, "99.0.0");
  // The command has to be the one the README teaches. A cached value from an
  // older release must not survive either: the user follows what is printed
  // now, and this used to point at a git checkout they never made.
  assert.equal(res.updateCommand, getUpdateCommand());
  assert.match(res.updateCommand, /^npm install --global \S+@latest$/);

  // 2. Mock cache with same version
  writeFileSync(
    join(cacheDir, "self-update.json"),
    JSON.stringify({
      latestVersion: "0.2.0",
      releaseUrl: "https://github.com/Vieeeeeee/skillhub/releases",
      releaseNotes: "",
      updateCommand: "git pull && npm install",
      checkedAt: new Date().toISOString(),
    })
  );

  const sameRes = await checkSelfUpdate({ force: false, customHome: tmp });
  assert.ok(!sameRes.hasUpdate, "Should not flag update when versions are identical");
  assert.equal(sameRes.updateCommand, getUpdateCommand());
});

test("the update command installs the published package, not a git checkout", () => {
  assert.equal(getUpdateCommand(), `npm install --global ${getPackageName()}@latest`);
  assert.equal(getPackageName(), "@wsiwsii/skillhub");
});
