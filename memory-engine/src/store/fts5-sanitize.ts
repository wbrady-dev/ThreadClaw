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
 * Strategy: strip all non-alphanumeric characters (preserving hyphens and
 * underscores), split into words, wrap each in double quotes so FTS5
 * treats them as literal phrase tokens. This matches the approach used in
 * the RAG layer (src/storage/bm25.ts escapeFts5Query).
 *
 * Examples:
 *   "sub-agent restrict"  →  '"sub-agent" "restrict"'
 *   "cc_expand OR crash" →  '"cc_expand" "OR" "crash"'
 *   'hello "world"'       →  '"hello" "world"'
 */

/**
 * Tokenize raw input: strip non-alphanumeric chars (except hyphens, underscores),
 * split on whitespace, and return non-empty words.
 */
function tokenize(raw: string): string[] {
  return raw
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** Quote a single token for FTS5, escaping internal double-quotes. */
function quoteToken(t: string): string {
  return `"${t.replaceAll('"', '""')}"`;
}

export function sanitizeFts5Query(raw: string): string | null {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return null;
  return tokens.map(quoteToken).join(" ");
}

/**
 * Relaxed FTS5 query — uses OR between tokens instead of AND.
 * Used as a fallback when strict AND returns zero results.
 * Any single matching token will surface a result.
 */
export function sanitizeFts5QueryOr(raw: string): string | null {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return null;
  return tokens.map(quoteToken).join(" OR ");
}

/** The number of tokens above which strict AND is likely too restrictive. */
export const FTS_RELAXATION_THRESHOLD = 2;

/**
 * FTS5 prefix query — appends * to the last token for prefix matching.
 * Used for single-token queries where strict match may miss partial words.
 * Only applies prefix to tokens >= 3 characters to avoid overly broad results.
 */
export function sanitizeFts5QueryPrefix(raw: string): string | null {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1];
  // Short tokens: fall back to exact match (prefix too broad for 1-2 char tokens)
  if (last.length < 3) return sanitizeFts5Query(raw);
  const parts = tokens.slice(0, -1).map(quoteToken);
  // FTS5 prefix: token must NOT be quoted — "token"* is invalid syntax.
  // Sanitize by stripping internal double-quotes, then append * unquoted.
  const sanitizedLast = last.replaceAll('"', '');
  parts.push(`${sanitizedLast}*`);
  return parts.join(" ");
}
