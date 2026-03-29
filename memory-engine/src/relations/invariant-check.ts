import type { GraphDb } from "./types.js";
import { getActiveInvariants } from "./invariant-store.js";

export interface InvariantViolation {
  invariantKey: string;
  description: string;
  severity: string;
  matchReason: string;
}

// Cache strict invariants (30s TTL)
let _cache: Array<{ key: string; description: string; severity: string; forbidden: string[] }> = [];
let _cacheTime = 0;
const CACHE_TTL = 30_000;

// Extract forbidden terms from invariant descriptions using negation patterns
const NEGATION_RE = /(?:never|do\s+not|must\s+not|don't|shouldn't|avoid|prohibited|forbidden|no)\s+(?:use\s+|using\s+)?(.+?)(?:\.|,|$)/gi;

function extractForbiddenTerms(description: string): string[] {
  const terms: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(NEGATION_RE.source, NEGATION_RE.flags);
  while ((match = re.exec(description)) !== null) {
    const term = match[1].trim().toLowerCase();
    if (term.length >= 2 && term.length <= 60) {
      terms.push(term);
      // Also add stem variants (e.g., "MongoDB" -> "mongo")
      const stem = term.replace(/\s*(db|database|server|service|client|sdk)$/i, '').trim();
      if (stem.length >= 2 && stem !== term) terms.push(stem);
    }
  }
  return terms;
}

function refreshCache(db: GraphDb, scopeId: number): void {
  if (Date.now() - _cacheTime < CACHE_TTL) return;
  const invariants = getActiveInvariants(db, scopeId);
  _cache = invariants
    .filter(inv => inv.enforcement_mode === 'strict')
    .map(inv => ({
      key: inv.invariant_key,
      description: inv.description,
      severity: inv.severity,
      forbidden: extractForbiddenTerms(inv.description),
    }))
    .filter(inv => inv.forbidden.length > 0); // Only enforce invariants with extractable forbidden terms
  _cacheTime = Date.now();
}

export function checkStrictInvariants(
  db: GraphDb,
  scopeId: number,
  content: string,
  structured: Record<string, unknown> | null,
): InvariantViolation[] {
  refreshCache(db, scopeId);
  if (_cache.length === 0) return [];

  // Build normalized search text from content + structured fields
  const parts = [content];
  if (structured) {
    if (typeof structured.objectText === 'string') parts.push(structured.objectText);
    if (typeof structured.subject === 'string') parts.push(structured.subject);
    if (typeof structured.decisionText === 'string') parts.push(structured.decisionText);
    if (typeof structured.object === 'string') parts.push(structured.object);
  }
  const searchText = parts.join(' ').toLowerCase();

  const violations: InvariantViolation[] = [];
  for (const inv of _cache) {
    for (const term of inv.forbidden) {
      if (searchText.includes(term)) {
        violations.push({
          invariantKey: inv.key,
          description: inv.description,
          severity: inv.severity,
          matchReason: `Contains "${term}" which is forbidden by invariant "${inv.key}"`,
        });
        break; // One match per invariant is enough
      }
    }
  }
  return violations;
}

export function resetInvariantCacheForTests(): void {
  _cache = [];
  _cacheTime = 0;
}
