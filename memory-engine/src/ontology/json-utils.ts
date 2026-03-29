/**
 * Shared JSON parsing and SQL helpers.
 *
 * Consolidates repeated inline try/catch JSON.parse patterns and
 * escapeLikeValue definitions from across the memory engine.
 */

/**
 * Safely parse a structured_json column value.
 * Returns {} on null, non-string, or malformed JSON.
 */
export function safeParseStructured(val: unknown): Record<string, unknown> {
  if (!val || typeof val !== "string") return {};
  try { return JSON.parse(val) as Record<string, unknown>; }
  catch { return {}; }
}

/**
 * Safely parse a metadata/provenance column value.
 * Alias for safeParseStructured — separate name for call-site readability.
 */
export const safeParseMetadata = safeParseStructured;

/**
 * Escape SQL LIKE meta-characters (%, _, \) so the value is treated literally.
 */
export function escapeLikeValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
