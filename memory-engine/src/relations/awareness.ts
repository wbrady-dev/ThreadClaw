/**
 * Awareness layer — builds contextual notes from the entity graph
 * to inject into the system prompt.
 *
 * Phase 3: Queries memory_objects (kind='entity') and provenance_links
 * (predicate='mentioned_in') instead of legacy entities/entity_mentions tables.
 *
 * Three query types (each with post-hoc 25ms budget guard):
 * 1. Mismatch: entities with divergent context_terms across sources
 * 2. Staleness: entities not seen recently
 * 3. Connections: co-occurring entities across sources
 *
 * All operations are non-fatal — errors return null.
 */

import type { GraphDb } from "./types.js";
import { recordAwarenessEvent } from "./eval.js";
import { estimateTokens as canonicalEstimateTokens } from "../utils/tokens.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AwarenessConfig {
  maxNotes: number;
  maxTokens: number;
  staleDays: number;
  minMentions: number;
  /** Reserved for future unseen-doc surfacing fallback (not yet implemented). */
  docSurfacing: boolean;
  /** Number of recent messages to scan for entity mentions (default 3). */
  messageLookback?: number;
  knowledgeApiUrl?: string;
}

// ---------------------------------------------------------------------------
// Entity name cache (top 5000 by mention count from memory_objects, rebuilt every 30s)
// ---------------------------------------------------------------------------

interface EntityCacheEntry {
  composite_id: string;
  name: string;
  mention_count: number;
}

const CACHE_MAX_SIZE = 5000;
const CACHE_TTL_MS = 30_000;

let entityCache: EntityCacheEntry[] = [];
let cacheBuiltAt = 0;

function rebuildEntityCache(db: GraphDb): EntityCacheEntry[] {
  if (Date.now() - cacheBuiltAt < CACHE_TTL_MS && entityCache.length > 0) {
    return entityCache;
  }
  try {
    // Load entities from memory_objects, parse name from structured_json
    const rows = db.prepare(`
      SELECT composite_id, content,
             json_extract(structured_json, '$.name') as name,
             COALESCE(json_extract(structured_json, '$.mentionCount'), 1) as mention_count
      FROM memory_objects
      WHERE kind = 'entity' AND status = 'active'
      ORDER BY COALESCE(json_extract(structured_json, '$.mentionCount'), 1) DESC
      LIMIT ?
    `).all(CACHE_MAX_SIZE) as Array<{
      composite_id: string;
      content: string;
      name: string | null;
      mention_count: number;
    }>;

    entityCache = rows.map((r) => ({
      composite_id: r.composite_id,
      name: (r.name ?? r.content ?? "").toLowerCase().trim(),
      mention_count: r.mention_count ?? 1,
    }));
    cacheBuiltAt = Date.now();
  } catch {
    // Non-fatal — use stale cache
  }
  return entityCache;
}

/** Exported for tests. */
export function resetEntityCacheForTests(): void {
  entityCache = [];
  cacheBuiltAt = 0;
}

/** Invalidate the awareness entity cache so it rebuilds on next query. */
export function invalidateAwarenessCache(): void {
  entityCache = [];
  cacheBuiltAt = 0;
}

// ---------------------------------------------------------------------------
// Text extraction from agent messages
// ---------------------------------------------------------------------------

/**
 * Extract plain text from an agent message.
 * Handles both string content and array-of-blocks content.
 */
export function extractTextFromAgentMessage(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
      .map((b: unknown) => ((b as Record<string, unknown>).text as string) ?? "")
      .join(" ");
  }
  return "";
}

/**
 * Find known entity names that appear in text using word-boundary matching.
 * Avoids false positives like "red" matching inside "scored".
 */
function extractKeyTerms(text: string, cache: EntityCacheEntry[]): EntityCacheEntry[] {
  if (!text || cache.length === 0) return [];
  const lowerText = text.toLowerCase();
  return cache.filter((e) => {
    // Quick substring pre-check before regex (fast path for non-matches)
    if (!lowerText.includes(e.name)) return false;
    // Word-boundary check using pre-compiled regex
    if (!(e as EntityCacheEntryWithRegex)._regex) {
      const escaped = e.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      (e as EntityCacheEntryWithRegex)._regex = new RegExp(`\\b${escaped}\\b`);
    }
    return (e as EntityCacheEntryWithRegex)._regex!.test(lowerText);
  });
}

interface EntityCacheEntryWithRegex extends EntityCacheEntry {
  _regex?: RegExp;
}

// ---------------------------------------------------------------------------
// Query: Mismatch detection
// ---------------------------------------------------------------------------

interface MismatchNote {
  entity: string;
  sourceA: string;
  termsA: string[];
  sourceB: string;
  termsB: string[];
}

function queryMismatches(db: GraphDb, entityIds: string[], limit: number): MismatchNote[] {
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => "?").join(",");

  // Find entities mentioned from multiple sources via provenance_links
  const rows = db.prepare(`
    SELECT
      mo.content AS entity_name,
      pl1.object_id AS source_a,
      pl1.metadata AS terms_a,
      pl2.object_id AS source_b,
      pl2.metadata AS terms_b
    FROM provenance_links pl1
    JOIN provenance_links pl2 ON pl1.subject_id = pl2.subject_id AND pl1.id < pl2.id
    JOIN memory_objects mo ON pl1.subject_id = mo.composite_id
    WHERE pl1.predicate = 'mentioned_in'
      AND pl2.predicate = 'mentioned_in'
      AND pl1.subject_id IN (${placeholders})
      AND pl1.object_id != pl2.object_id
      AND pl1.created_at > datetime('now', '-90 days')
      AND pl2.created_at > datetime('now', '-90 days')
    ORDER BY pl2.created_at DESC
    LIMIT ?
  `).all(...entityIds, limit) as Array<{
    entity_name: string;
    source_a: string | null;
    terms_a: string | null;
    source_b: string | null;
    terms_b: string | null;
  }>;

  return rows.map((r) => ({
    entity: r.entity_name,
    sourceA: r.source_a ?? "",
    termsA: extractContextTerms(r.terms_a),
    sourceB: r.source_b ?? "",
    termsB: extractContextTerms(r.terms_b),
  }));
}

/** Extract context_terms from provenance_links metadata JSON. */
function extractContextTerms(metadataJson: string | null): string[] {
  if (!metadataJson) return [];
  try {
    const meta = JSON.parse(metadataJson);
    if (typeof meta.context_terms === "string") {
      return safeParse(meta.context_terms);
    }
    if (Array.isArray(meta.context_terms)) {
      return meta.context_terms;
    }
    return [];
  } catch {
    return safeParse(metadataJson);
  }
}

// ---------------------------------------------------------------------------
// Query: Staleness detection
// ---------------------------------------------------------------------------

interface StalenessNote {
  entity: string;
  lastSeen: string;
  daysSince: number;
}

function queryStaleness(db: GraphDb, entityIds: string[], staleDays: number, limit: number): StalenessNote[] {
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT
      content AS display_name,
      COALESCE(last_observed_at, updated_at) AS last_seen_at,
      CAST(julianday('now') - julianday(COALESCE(last_observed_at, updated_at)) AS INTEGER) AS days_since
    FROM memory_objects
    WHERE composite_id IN (${placeholders})
      AND CAST(julianday('now') - julianday(COALESCE(last_observed_at, updated_at)) AS INTEGER) >= ?
    ORDER BY days_since DESC
    LIMIT ?
  `).all(...entityIds, staleDays, limit) as Array<{
    display_name: string;
    last_seen_at: string;
    days_since: number;
  }>;

  return rows.map((r) => ({
    entity: r.display_name,
    lastSeen: r.last_seen_at,
    daysSince: r.days_since,
  }));
}

// ---------------------------------------------------------------------------
// Query: Connections (co-occurring entities)
// ---------------------------------------------------------------------------

interface ConnectionNote {
  entityA: string;
  entityB: string;
  sharedSource: string;
}

function queryConnections(db: GraphDb, entityIds: string[], limit: number): ConnectionNote[] {
  if (entityIds.length < 2) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT
      mo1.content AS entity_a,
      mo2.content AS entity_b,
      pl1.object_id AS shared_source
    FROM provenance_links pl1
    JOIN provenance_links pl2 ON pl1.object_id = pl2.object_id
      AND pl1.subject_id < pl2.subject_id
    JOIN memory_objects mo1 ON pl1.subject_id = mo1.composite_id
    JOIN memory_objects mo2 ON pl2.subject_id = mo2.composite_id
    WHERE pl1.predicate = 'mentioned_in'
      AND pl2.predicate = 'mentioned_in'
      AND pl1.subject_id IN (${placeholders})
      AND pl2.subject_id IN (${placeholders})
    GROUP BY mo1.composite_id, mo2.composite_id
    ORDER BY COUNT(*) DESC
    LIMIT ?
  `).all(...entityIds, ...entityIds, limit) as Array<{
    entity_a: string;
    entity_b: string;
    shared_source: string;
  }>;

  return rows.map((r) => ({
    entityA: r.entity_a,
    entityB: r.entity_b,
    sharedSource: r.shared_source,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParse(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const estimateTokens = canonicalEstimateTokens;

/**
 * Run a query and truncate results if it exceeded the time budget.
 */
function withBudgetGuard<T>(fn: () => T[], budgetMs: number): T[] {
  const start = Date.now();
  try {
    const result = fn();
    if (Date.now() - start > budgetMs) {
      return result.slice(0, 1);
    }
    return result;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Format notes
// ---------------------------------------------------------------------------

function formatMismatch(note: MismatchNote): string {
  const diffA = note.termsA.filter((t) => !note.termsB.includes(t));
  const diffB = note.termsB.filter((t) => !note.termsA.includes(t));
  return `Possible mismatch: "${note.entity}" — ${note.sourceA} mentions [${diffA.join(", ")}] but ${note.sourceB} mentions [${diffB.join(", ")}]`;
}

function formatStaleness(note: StalenessNote): string {
  return `Stale reference: "${note.entity}" last seen ${note.daysSince} days ago (${note.lastSeen})`;
}

function formatConnection(note: ConnectionNote): string {
  return `Connection: "${note.entityA}" and "${note.entityB}" co-occur in ${note.sharedSource}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build awareness notes from the entity graph based on the current turn's messages.
 *
 * @returns Awareness note text to append to system prompt, or null if nothing to surface.
 */
export function buildAwarenessNote(
  messages: unknown[],
  db: GraphDb,
  config: AwarenessConfig,
): string | null {
  const start = Date.now();
  const noteLines: string[] = [];
  const noteTypes: string[] = [];

  try {
    // Extract text from recent messages for entity detection
    const lookback = config.messageLookback ?? 3;
    const recentMessages = messages.slice(-lookback);
    const text = recentMessages.map(extractTextFromAgentMessage).join(" ");
    if (!text.trim()) {
      recordAwarenessEvent({ fired: false, noteCount: 0, noteTypes: [], latencyMs: 0, terms: [], tokensAdded: 0 });
      return null;
    }

    // Find known entities in current turn
    const cache = rebuildEntityCache(db);
    const matchedEntities = extractKeyTerms(text, cache);
    const matchedIds = matchedEntities
      .filter((e) => e.mention_count >= config.minMentions)
      .map((e) => e.composite_id);
    const terms = matchedEntities.map((e) => e.name);

    if (matchedIds.length === 0) {
      recordAwarenessEvent({
        fired: false, noteCount: 0, noteTypes: [], latencyMs: Date.now() - start, terms, tokensAdded: 0,
      });
      return null;
    }

    // Reserve tokens for header "[ThreadClaw Awareness]\n"
    const headerTokens = estimateTokens("[ThreadClaw Awareness]\n");
    let tokenBudget = config.maxTokens - headerTokens;

    // Query 1: Mismatches (25ms guard)
    const mismatches = withBudgetGuard(
      () => queryMismatches(db, matchedIds, config.maxNotes),
      25,
    );
    for (const m of mismatches) {
      if (noteLines.length >= config.maxNotes) break;
      const line = formatMismatch(m);
      const cost = estimateTokens(line);
      if (cost > tokenBudget) continue;
      noteLines.push(line);
      noteTypes.push("mismatch");
      tokenBudget -= cost;
    }

    // Query 2: Staleness (25ms guard)
    const stale = withBudgetGuard(
      () => queryStaleness(db, matchedIds, config.staleDays, config.maxNotes),
      25,
    );
    for (const s of stale) {
      if (noteLines.length >= config.maxNotes) break;
      const line = formatStaleness(s);
      const cost = estimateTokens(line);
      if (cost > tokenBudget) continue;
      noteLines.push(line);
      noteTypes.push("staleness");
      tokenBudget -= cost;
    }

    // Query 3: Connections (25ms guard)
    const connections = withBudgetGuard(
      () => queryConnections(db, matchedIds, config.maxNotes),
      25,
    );
    for (const c of connections) {
      if (noteLines.length >= config.maxNotes) break;
      const line = formatConnection(c);
      const cost = estimateTokens(line);
      if (cost > tokenBudget) continue;
      noteLines.push(line);
      noteTypes.push("connection");
      tokenBudget -= cost;
    }

    const latencyMs = Date.now() - start;
    const tokensAdded = config.maxTokens - tokenBudget;

    if (noteLines.length === 0) {
      recordAwarenessEvent({
        fired: false, noteCount: 0, noteTypes: [], latencyMs, terms, tokensAdded: 0,
      });
      return null;
    }

    recordAwarenessEvent({
      fired: true,
      noteCount: noteLines.length,
      noteTypes,
      latencyMs,
      terms,
      tokensAdded,
    });

    return `[ThreadClaw Awareness]\n${noteLines.join("\n")}`;
  } catch {
    recordAwarenessEvent({
      fired: false, noteCount: 0, noteTypes: [], latencyMs: Date.now() - start, terms: [], tokensAdded: 0,
    });
    return null;
  }
}
