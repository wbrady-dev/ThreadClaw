/**
 * SQL utility functions for ThreadClaw's SQLite layer.
 *
 * Currently only contains LIKE escaping. Additional helpers (e.g., parameterized
 * query builders, batch insert helpers) should be added here as the query layer grows.
 */

/**
 * Escape a string for use in SQLite LIKE patterns.
 * Escapes backslash, underscore, and optionally percent.
 *
 * **IMPORTANT:** Because this uses backslash as the escape character, every
 * LIKE clause that consumes the escaped value **must** include `ESCAPE '\'`
 * or the escaping will have no effect in SQLite.
 *
 * Example:  `WHERE col LIKE ? ESCAPE '\'`
 */
export function escapeLike(s: string, keepPercent = false): string {
  let result = s.replace(/\\/g, "\\\\").replace(/_/g, "\\_");
  if (!keepPercent) result = result.replace(/%/g, "\\%");
  return result;
}
