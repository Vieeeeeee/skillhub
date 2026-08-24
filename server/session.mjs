import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { getPaths, isWindows } from "../src/core/paths.mjs";
import { assertSafeRealPath } from "../src/core/guard.mjs";

const _sessionTokens = new Map();

export function getOrCreateSessionToken(customHome = null) {
  const paths = getPaths(customHome);
  const sessionFile = paths.SESSION_FILE;
  assertSafeRealPath(sessionFile, [paths.HOME], { followFinalSymlink: true });
  if (_sessionTokens.has(sessionFile)) return _sessionTokens.get(sessionFile);

  if (existsSync(sessionFile)) {
    try {
      const token = readFileSync(sessionFile, "utf-8").trim();
      if (token && token.length >= 16) {
        if (!isWindows) {
          try {
            chmodSync(sessionFile, 0o600);
          } catch {}
        }
        _sessionTokens.set(sessionFile, token);
        return token;
      }
    } catch {}
  }

  const newToken = randomBytes(24).toString("hex");
  const dir = dirname(sessionFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(sessionFile, newToken, { encoding: "utf-8", mode: 0o600 });
  if (!isWindows) {
    try {
      chmodSync(sessionFile, 0o600);
    } catch {}
  }

  _sessionTokens.set(sessionFile, newToken);
  return newToken;
}

function isSameOrigin(headerValue, requestUrl) {
  if (!headerValue) return true;
  try {
    return new URL(headerValue).origin === requestUrl.origin;
  } catch {
    return false;
  }
}

function isLoopbackRequest(url) {
  const hostname = String(url.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

/**
 * Middleware for CSRF and Request origin validation.
 */
export function createSecurityMiddleware(customHome = null) {
  const token = getOrCreateSessionToken(customHome);

  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const url = new URL(c.req.url);
    const origin = c.req.header("origin") || "";
    const referer = c.req.header("referer") || "";
    const fetchSite = (c.req.header("sec-fetch-site") || "").toLowerCase();

    // Do not trust Host when deciding whether a request is local. This blocks
    // DNS-rebinding pages whose Origin and Host agree on an attacker domain.
    if (!isLoopbackRequest(url)) {
      return c.json({ ok: false, error: "Security Violation: Non-loopback Host rejected" }, 403);
    }

    // Browser requests for every API endpoint must originate from the exact
    // local page. This also protects GET endpoints that can refresh caches or
    // make outbound network requests. Header-less CLI requests remain valid.
    if (!isSameOrigin(origin, url) || !isSameOrigin(referer, url) || fetchSite === "cross-site") {
      return c.json({ ok: false, error: "Security Violation: Cross-Origin request rejected" }, 403);
    }

    // Only inspect mutating requests (POST, PUT, DELETE, PATCH)
    if (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") {
      // 1. All mutating endpoints use JSON, including body-less actions. This
      // rejects simple form requests, missing headers, and multipart uploads.
      const contentType = (c.req.header("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        return c.json(
          {
            ok: false,
            error: "Security Violation: Content-Type must be application/json",
          },
          415
        );
      }

      // 2. Validate Session Token
      const reqToken =
        c.req.header("x-skillhub-token") ||
        c.req.header("authorization")?.replace(/^Bearer\s+/i, "");

      if (!reqToken || reqToken !== token) {
        return c.json(
          {
            ok: false,
            error: "Security Violation: Missing or invalid session token",
          },
          401
        );
      }
    }

    await next();
  };
}
