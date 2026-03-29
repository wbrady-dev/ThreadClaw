import { logger } from "./logger.js";

export class ThreadClawError extends Error {
  constructor(message: string, public code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ThreadClawError";
    // Restore prototype chain broken by extending built-in Error
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ParseError extends ThreadClawError {
  constructor(message: string, public filePath?: string, options?: { cause?: unknown }) {
    // Do NOT embed filePath in the message — store it as a property only.
    // Embedding paths leaks filesystem layout to HTTP clients.
    super(message, "PARSE_ERROR", options);
    this.name = "ParseError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class EmbeddingError extends ThreadClawError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "EMBEDDING_ERROR", options);
    this.name = "EmbeddingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Centralized error sanitization for HTTP responses ────────────────

/**
 * Strip filesystem paths (Windows & Unix) and URLs from error messages.
 * Prevents leaking internal structure to API clients.
 */
const PATH_RE = /(?:[A-Za-z]:\\|\/(?:usr|home|tmp|var|etc|mnt|opt|Users|proc|sys|dev|c\/|C\\))[^\s:;,)}\]"']+/gi;
const URL_RE = /https?:\/\/[^\s:;,)}\]"']+/gi;

function stripSensitive(msg: string): string {
  return msg.replace(PATH_RE, "<path>").replace(URL_RE, "<url>");
}

/**
 * Produce a safe error message for HTTP clients.
 *
 * - 4xx-class errors (validation, not-found): returns the original message
 *   with paths/URLs stripped and length capped.
 * - 5xx-class errors: returns a generic "${label} failed" message and logs
 *   the real error at warn level.
 *
 * @param err   The caught error (unknown type)
 * @param label Short human label, e.g. "Ingest" or "Query"
 * @param statusCode  HTTP status code being returned (default 500)
 */
export function toClientError(err: unknown, label: string, statusCode = 500): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (statusCode >= 400 && statusCode < 500) {
    // Client errors: return sanitized original message, capped at 200 chars
    const safe = stripSensitive(raw);
    return safe.length > 200 ? safe.slice(0, 197) + "..." : safe;
  }

  // Server errors: log the real message, return generic
  logger.warn({ error: raw, label }, `${label} failed (details suppressed from client)`);
  return `${label} failed`;
}
