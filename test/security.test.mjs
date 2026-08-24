import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, startServer } from "../server/server.mjs";
import { getOrCreateSessionToken } from "../server/session.mjs";

test("server security middleware: enforces CSRF token, Origin check, and Content-Type", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-sec-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const token = getOrCreateSessionToken(tmp);
  const app = createApp(tmp);

  // 1. GET requests work without token
  const getRes = await app.request("http://127.0.0.1/api/registry");
  assert.equal(getRes.status, 200);

  // 2. POST without token is rejected (401 Unauthorized)
  const noTokenRes = await app.request("http://127.0.0.1/api/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(noTokenRes.status, 401);

  const queryTokenRes = await app.request(`http://127.0.0.1/api/refresh?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(queryTokenRes.status, 401);

  // 3. POST with text/plain (CORS exploit attempt) is rejected (415 Unsupported Media Type)
  const textPlainRes = await app.request("http://127.0.0.1/api/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "X-SkillHub-Token": token,
    },
  });
  assert.equal(textPlainRes.status, 415);

  const missingTypeRes = await app.request("http://127.0.0.1/api/refresh", {
    method: "POST",
    headers: { "X-SkillHub-Token": token },
  });
  assert.equal(missingTypeRes.status, 415);

  const multipartRes = await app.request("http://127.0.0.1/api/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data; boundary=test",
      "X-SkillHub-Token": token,
    },
  });
  assert.equal(multipartRes.status, 415);

  // 4. POST with foreign Origin is rejected (403 Forbidden)
  const foreignOriginRes = await app.request("http://127.0.0.1/api/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SkillHub-Token": token,
      "Origin": "https://malicious-website.com",
    },
  });
  assert.equal(foreignOriginRes.status, 403);

  // 5. Valid POST with token and application/json succeeds
  const wrongPortRes = await app.request("http://127.0.0.1/api/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SkillHub-Token": token,
      "Origin": "http://127.0.0.1:7777",
    },
  });
  assert.equal(wrongPortRes.status, 403);

  const validRes = await app.request("http://127.0.0.1:7777/api/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SkillHub-Token": token,
      "Origin": "http://127.0.0.1:7777",
    },
  });
  assert.equal(validRes.status, 200);

  const sessionCrossOrigin = await app.request("http://127.0.0.1:7777/api/session", {
    headers: { Origin: "https://malicious-website.com" },
  });
  assert.equal(sessionCrossOrigin.status, 403);

  const reboundSession = await app.request("http://evil.example:7777/api/session", {
    headers: { Origin: "http://evil.example:7777" },
  });
  assert.equal(reboundSession.status, 403);

  const registryCrossOrigin = await app.request("http://127.0.0.1:7777/api/registry", {
    headers: {
      Origin: "https://malicious-website.com",
      "Sec-Fetch-Site": "cross-site",
    },
  });
  assert.equal(registryCrossOrigin.status, 403);

  const malformedJson = await app.request("http://127.0.0.1:7777/api/toggle", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SkillHub-Token": token,
    },
    body: "{broken",
  });
  assert.equal(malformedJson.status, 400);
});

test("server refuses non-loopback bind addresses", () => {
  assert.throws(
    () => startServer({ host: "0.0.0.0", port: 0, autoOpen: false }),
    /non-loopback host/
  );
  assert.throws(
    () => startServer({ host: "192.168.1.10", port: 0, autoOpen: false }),
    /non-loopback host/
  );
  assert.throws(
    () => startServer({ host: "127.0.0.1", port: 70000, autoOpen: false }),
    /Invalid SkillHub port/
  );
});

test("existing dashboard session tokens are tightened to owner-only permissions", (t) => {
  if (process.platform === "win32") return;
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-session-mode-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const sessionDir = join(tmp, ".skillhub");
  const sessionFile = join(sessionDir, "session");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(sessionFile, "0123456789abcdef0123456789abcdef");
  chmodSync(sessionFile, 0o644);

  getOrCreateSessionToken(tmp);
  assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
});
