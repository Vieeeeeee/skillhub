import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  assertSafeName,
  isInsideRoot,
  assertSafePath,
  assertSafeRealPath,
  sanitizeUrl,
  escapeHtml,
} from "../src/core/guard.mjs";

test("assertSafeName accepts valid names and rejects dangerous traversal", () => {
  assert.doesNotThrow(() => assertSafeName("my-skill"));
  assert.doesNotThrow(() => assertSafeName("skill_v2.0"));
  assert.doesNotThrow(() => assertSafeName("tool123"));

  assert.throws(() => assertSafeName(""), /cannot be empty/);
  assert.throws(() => assertSafeName(".."), /forbidden characters/);
  assert.throws(() => assertSafeName("."), /forbidden characters/);
  assert.throws(() => assertSafeName("../escape"), /forbidden characters/);
  assert.throws(() => assertSafeName("foo/bar"), /forbidden characters/);
  assert.throws(() => assertSafeName("foo\\bar"), /forbidden characters/);
  assert.throws(() => assertSafeName("skill\0null"), /forbidden characters/);
});

test("isInsideRoot strictly validates path containment", () => {
  const root = resolve("/test/workspace/skills");
  assert.ok(isInsideRoot("/test/workspace/skills/my-skill", root));
  assert.ok(isInsideRoot("/test/workspace/skills/nested/dir/my-skill", root));
  assert.ok(isInsideRoot(root, root));

  assert.ok(!isInsideRoot("/test/workspace/other", root));
  assert.ok(!isInsideRoot("/test/workspace/skills-sibling", root));
  assert.ok(!isInsideRoot("/test/workspace/skills/../escaped", root));
  assert.ok(!isInsideRoot("/etc/passwd", root));
});

test("assertSafePath throws on paths outside allowed roots", () => {
  const root1 = resolve("/test/root1");
  const root2 = resolve("/test/root2");

  assert.doesNotThrow(() => assertSafePath("/test/root1/file", [root1, root2]));
  assert.doesNotThrow(() => assertSafePath("/test/root2/sub/file", [root1, root2]));

  assert.throws(() => assertSafePath("/test/root3/file", [root1, root2]), /Security Exception/);
});

test("assertSafeRealPath rejects lexical containment that escapes through a symlink", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-realpath-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home");
  const outside = join(tmp, "outside");
  mkdirSync(home);
  mkdirSync(outside);
  symlinkSync(outside, join(home, "escaped"), "dir");

  assert.throws(
    () => assertSafeRealPath(join(home, "escaped", "skill"), [home], { followFinalSymlink: false }),
    /Security Exception/,
  );
  assert.doesNotThrow(() =>
    assertSafeRealPath(join(home, "safe", "skill"), [home], { followFinalSymlink: false })
  );
});

test("sanitizeUrl only permits http and https protocols", () => {
  assert.equal(sanitizeUrl("https://github.com/foo/bar"), "https://github.com/foo/bar");
  assert.equal(sanitizeUrl("http://localhost:7777"), "http://localhost:7777/");
  assert.equal(sanitizeUrl("github.com/foo/bar"), "https://github.com/foo/bar");

  assert.equal(sanitizeUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeUrl("data:text/html,<script>alert(1)</script>"), "");
  assert.equal(sanitizeUrl("file:///etc/passwd"), "");
  assert.equal(sanitizeUrl("vbscript:msgbox"), "");
});

test("escapeHtml properly escapes dangerous HTML entities", () => {
  assert.equal(escapeHtml('<script>alert("XSS")</script>'), "&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("Tom & Jerry's"), "Tom &amp; Jerry&#39;s");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});
