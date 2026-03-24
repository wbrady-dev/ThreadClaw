/**
 * Sanitize a user-provided query for use in an FTS5 MATCH expression.
 *
 * FTS5 treats certain characters as operators:
 *   - `-` (NOT), `+` (required), `*` (prefix), `^` (initial token)
 *   - `OR`, `AND`, `NOT` (boolean operators)
 *   - `:` (column filter — e.g. `agent:foo` means "search column agent")
 *   - `"` (phrase query), `(` `)` (grouping)
 *   - `NEAR` (proximity)
 *
 * If the query contains any of these, naive MATCH will either error
 * ("no such column") or return unexpected results.
 *
 * Strategy: wrap each whitespace-delimited token in double quotes so FTS5
 * treats it as a literal phrase token. Internal double quotes are stripped.
 * Empty tokens are dropped. Tokens are joined with spaces (implicit AND).
 *
 * Examples:
 *   "sub-agent restrict"  →  '"sub-agent" "restrict"'
 *   "cc_expand OR crash" →  '"cc_expand" "OR" "crash"'
 *   'hello "world"'       →  '"hello" "world"'
 */
export function sanitizeFts5Query(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((t) => `"${t}"`).join(" ");
}

/**
 * Relaxed FTS5 query — uses OR between tokens instead of AND.
 * Used as a fallback when strict AND returns zero results.
 * Any single matching token will surface a result.
 */
export function sanitizeFts5QueryOr(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/** The number of tokens above which strict AND is likely too restrictive. */
export const FTS_RELAXATION_THRESHOLD = 4;
