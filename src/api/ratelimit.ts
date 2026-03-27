import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

/**
 * Simple sliding-window rate limiter per IP.
 * Configurable via environment variables:
 *   RATE_LIMIT_MAX=300      (requests per window)
 *   RATE_LIMIT_WINDOW=60000 (window size in ms, default 1 minute)
 *   RATE_LIMIT_ENABLED=true (set to "false" to disable)
 */

const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX ?? "300", 10) || 300;
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW ?? "60000", 10) || 60000;
const ENABLED = process.env.RATE_LIMIT_ENABLED !== "false";

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of windows) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < WINDOW_MS);
    if (entry.timestamps.length === 0) windows.delete(ip);
  }
}, 5 * 60 * 1000).unref();

/**
 * Normalize a URL path to prevent bypass via trailing slashes or percent-encoding.
 * Strips query string, decodes percent-encoded characters, collapses slashes,
 * and removes trailing slash.
 */
function normalizePath(url: string): string {
  const pathOnly = url.split("?")[0];
  try {
    const decoded = decodeURIComponent(pathOnly);
    return decoded.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  } catch {
    // If decodeURIComponent fails (malformed %), use raw path
    return pathOnly.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  }
}

function getClientIp(req: FastifyRequest): string {
  // Only trust X-Forwarded-For when behind a verified proxy
  if (process.env.THREADCLAW_TRUST_PROXY === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const raw = forwarded.split(",")[0].trim();
      // Strip port from IPv4 (1.2.3.4:8080) or bracketed IPv6 ([::1]:8080)
      const bracketMatch = raw.match(/^\[(.+)\](:\d+)?$/);
      if (bracketMatch) return bracketMatch[1];
      // Only strip port for IPv4-looking addresses (contains dots, not colons)
      if (raw.includes(".") && !raw.includes("[")) {
        const lastColon = raw.lastIndexOf(":");
        if (lastColon > 0) return raw.substring(0, lastColon);
      }
      return raw;
    }
  }
  return req.ip;
}

/**
 * Register rate limiting as a Fastify onRequest hook.
 * Uses onRequest (not preHandler) for earliest interception — rejects
 * rate-limited requests before body parsing or auth checks run.
 * Applies to all routes. Returns 429 when limit exceeded.
 */
export function registerRateLimit(server: FastifyInstance): void {
  if (!ENABLED) return;

  server.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Skip health checks — monitoring tools should not be rate limited
    const path = normalizePath(req.url);
    if (path === "/health") return;

    const ip = getClientIp(req);
    const now = Date.now();

    let entry = windows.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      windows.set(ip, entry);
    }

    // Remove timestamps outside current window
    entry.timestamps = entry.timestamps.filter((t) => now - t < WINDOW_MS);

    const resetEpochSec = entry.timestamps.length > 0
      ? Math.ceil((entry.timestamps[0] + WINDOW_MS) / 1000)
      : Math.ceil((now + WINDOW_MS) / 1000);

    if (entry.timestamps.length >= MAX_REQUESTS) {
      const retryAfter = Math.max(1, Math.ceil((entry.timestamps[0] + WINDOW_MS - now) / 1000));
      reply
        .status(429)
        .header("Retry-After", String(retryAfter))
        .header("X-RateLimit-Limit", String(MAX_REQUESTS))
        .header("X-RateLimit-Remaining", "0")
        .header("X-RateLimit-Reset", String(resetEpochSec))
        .send({
          error: "Too many requests",
          retryAfterSeconds: retryAfter,
        });
      return;
    }

    entry.timestamps.push(now);

    // Add rate limit headers to all responses (including X-RateLimit-Reset)
    reply.header("X-RateLimit-Limit", String(MAX_REQUESTS));
    reply.header("X-RateLimit-Remaining", String(MAX_REQUESTS - entry.timestamps.length));
    reply.header("X-RateLimit-Reset", String(resetEpochSec));
  });
}
