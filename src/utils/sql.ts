/**
 * Escape a string for use in SQLite LIKE patterns.
 * Escapes backslash, underscore, and optionally percent.
 */
export function escapeLike(s: string, keepPercent = false): string {
  let result = s.replace(/\\/g, "\\\\").replace(/_/g, "\\_");
  if (!keepPercent) result = result.replace(/%/g, "\\%");
  return result;
}
