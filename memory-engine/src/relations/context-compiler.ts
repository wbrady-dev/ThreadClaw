/**
 * Context compiler + ROI governor.
 *
 * Scores candidate capsules from the evidence store and assembles
 * them into a compact system prompt injection within a token budget.
 *
 * Scoring: (usefulness × confidence × freshness × scopeFit) / tokenCost
 * Budget tiers: lite=110, standard=190, premium=380 tokens
 */

import type { GraphDb } from "./types.js";
import { effectiveConfidence } from "./confidence.js";
import { moRowToClaimRow, type ClaimRow } from "./claim-store.js";
import { moRowToDecisionRow, type DecisionRow } from "./decision-store.js";
import { moRowToLoopRow, type LoopRow } from "./loop-store.js";
import { getRecentDeltas, type DeltaRow } from "./delta-store.js";
import { moRowToInvariantRow, type InvariantRow } from "./invariant-store.js";
import { moRowToAntiRunbookRow, type AntiRunbookRow } from "./anti-runbook-store.js";
import { moRowToRunbookRow } from "./runbook-store.js";
import { moRowToRelationRow } from "./relation-store.js";
import { safeParseStructured } from "../ontology/json-utils.js";
import { applyDecay, type DecayConfig } from "./decay.js";
import { runArchive } from "./archive.js";
import { resolve } from "path";
import { homedir } from "os";
import { estimateTokens as canonicalEstimateTokens } from "../utils/tokens.js";

// ---------------------------------------------------------------------------
// Budget tiers
// ---------------------------------------------------------------------------

const BUDGET_TIERS: Record<string, number> = {
  lite: 110,
  standard: 190,
  premium: 380,
};

// ---------------------------------------------------------------------------
// Auto-archive — lazy trigger, runs at most once per hour
// ---------------------------------------------------------------------------

// Defaults — overridden by ContextCompilerConfig.autoArchiveIntervalMs / autoArchiveEventThreshold
const DEFAULT_AUTO_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_AUTO_ARCHIVE_EVENT_THRESHOLD = 5000;        // trigger when evidence_log exceeds this
let _lastAutoArchiveCheck = 0;

function maybeAutoArchive(
  db: GraphDb,
  intervalMs = DEFAULT_AUTO_ARCHIVE_INTERVAL_MS,
  eventThreshold = DEFAULT_AUTO_ARCHIVE_EVENT_THRESHOLD,
): void {
  const now = Date.now();
  if (now - _lastAutoArchiveCheck < intervalMs) return;
  _lastAutoArchiveCheck = now;

  try {
    const eventCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM evidence_log",
    ).get() as { cnt: number }).cnt;

    if (eventCount < eventThreshold) return;

    const archivePath = resolve(homedir(), ".threadclaw", "data", "archive.db");
    runArchive(db, archivePath);
  } catch {
    // Non-fatal: auto-archive failure must not break context compilation
  }
}

/** Capsule type rendering order (deterministic output). */
const CAPSULE_ORDER: Record<string, number> = {
  anti_runbook: 0,
  invariant: 1,
  conflict: 2,
  decision: 3,
  claim: 4,
  loop: 5,
  delta: 6,
  runbook: 7,
  relation: 8,
};

// ---------------------------------------------------------------------------
// Capsule types
// ---------------------------------------------------------------------------

interface CapsuleCandidate {
  type: string;
  text: string;
  tokens: number;
  score: number;
  scorePerToken: number;
}

const estimateTokens = canonicalEstimateTokens;

// ---------------------------------------------------------------------------
// Capsule builders
// ---------------------------------------------------------------------------

// Subjects that are low-value for capsule injection (identity, meta, self-description)
const LOW_VALUE_SUBJECTS = new Set([
  "document", "user_note", "constraint", "copper", "copper vibe",
  "copper identity", "conversation history tools", "agent", "bot",
]);

// Predicates that describe history/transitions rather than current state.
// These are EXCLUDED from capsules entirely — they waste budget on non-current info.
const HISTORICAL_PREDICATES = new Set([
  "renamed_to", "renamed_from", "previously", "origin", "former",
  "was", "used_to_be", "migrated_from", "replaced_by", "superseded_by",
]);

// Note: casual predicates (likes, prefers, enjoys) are NOT penalized here.
// Legitimate preferences are valuable memory. The extraction prompt handles
// filtering noise vs intentional preferences at extraction time.

/**
 * Compute epistemic label for a capsule based on confidence and contested status.
 * - FIRM: confidence >= 0.9 AND not contested
 * - CONTESTED: composite_id is in the contested set
 * - PROVISIONAL: confidence < 0.5
 * - empty string: everything else
 */
function epistemicLabel(confidence: number, compositeId: string | undefined, contestedIds: Set<string>): string {
  if (compositeId && contestedIds.has(compositeId)) return " [CONTESTED]";
  if (confidence >= 0.9) return " [FIRM]";
  if (confidence < 0.5) return " [PROVISIONAL]";
  return "";
}

function claimCapsules(claims: ClaimRow[], compositeIds: string[], contestedIds: Set<string>): CapsuleCandidate[] {
  const results: CapsuleCandidate[] = [];
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i];
    const predicateLower = c.predicate.toLowerCase().trim();

    // Skip historical/transition claims entirely — they're not current state
    if (HISTORICAL_PREDICATES.has(predicateLower)) continue;

    const daysSince = daysSinceIso(c.last_seen_at);
    const conf = effectiveConfidence(c.confidence, c.mention_count ?? 1, daysSince);
    const label = epistemicLabel(c.confidence, compositeIds[i], contestedIds);
    const text = `[claim] ${c.subject} ${c.predicate}: ${c.object_text ?? "(no value)"}${label}`;
    const tokens = estimateTokens(text);

    const subjectLower = c.subject.toLowerCase().trim();

    // Demote identity/meta claims
    let valuePenalty = 1.0;
    if (LOW_VALUE_SUBJECTS.has(subjectLower)) valuePenalty = 0.2;

    const score = conf * c.trust_score * valuePenalty;
    results.push({
      type: "claim",
      text,
      tokens,
      score,
      scorePerToken: score / Math.max(1, tokens),
    });
  }
  return results;
}

function decisionCapsules(decisions: DecisionRow[], compositeIds: string[], contestedIds: Set<string>): CapsuleCandidate[] {
  return decisions.map((d, i) => {
    const label = epistemicLabel(0.9, compositeIds[i], contestedIds);
    const text = `[decision] ${d.topic}: ${d.decision_text}${label}`;
    const tokens = estimateTokens(text);
    // Decisions have high usefulness — they represent active choices
    const score = 0.9;
    return {
      type: "decision",
      text,
      tokens,
      score,
      scorePerToken: score / Math.max(1, tokens),
    };
  });
}

function loopCapsules(loops: LoopRow[]): CapsuleCandidate[] {
  return loops.map((l) => {
    const detail = l.waiting_on ? ` (waiting on: ${l.waiting_on})` : "";
    const text = `[loop] ${l.text}${detail}`;
    const tokens = estimateTokens(text);
    // Priority-weighted score (0-10 → 0.3-1.0)
    const score = 0.3 + (Math.min(10, l.priority) / 10) * 0.7;
    return {
      type: "loop",
      text,
      tokens,
      score,
      scorePerToken: score / Math.max(1, tokens),
    };
  });
}

function deltaCapsules(deltas: DeltaRow[]): CapsuleCandidate[] {
  return deltas.slice(0, 5).map((d) => {
    const text = `[delta] ${d.entity_key}: ${d.old_value ?? "?"} → ${d.new_value ?? "?"}`;
    const tokens = estimateTokens(text);
    return {
      type: "delta",
      text,
      tokens,
      score: 0.5,
      scorePerToken: 0.5 / Math.max(1, tokens),
    };
  });
}

function invariantCapsules(invariants: InvariantRow[]): CapsuleCandidate[] {
  return invariants.map((inv) => {
    const modeLabel = inv.enforcement_mode === "strict" ? "STRICT" : "advisory";
    const text = `[INVARIANT: ${modeLabel}/${inv.severity}] ${inv.description}`;
    const tokens = estimateTokens(text);
    // Strict invariants always make the budget (score 1.0)
    // Advisory invariants scored by severity
    const severityScore: Record<string, number> = {
      critical: 1.0, error: 0.9, warning: 0.7, info: 0.4,
    };
    const score = inv.enforcement_mode === "strict" ? 1.0 : (severityScore[inv.severity] ?? 0.5);
    return {
      type: "invariant",
      text,
      tokens,
      score,
      scorePerToken: score / Math.max(1, tokens),
    };
  });
}

function antiRunbookCapsules(antiRunbooks: AntiRunbookRow[]): CapsuleCandidate[] {
  return antiRunbooks.map((ar) => {
    const text = `[anti-runbook] AVOID: ${ar.failure_pattern} (${ar.tool_name}, ${ar.failure_count} failures)`;
    const tokens = estimateTokens(text);
    // Anti-runbooks get very high score — preventing known failures is critical
    const score = 0.95;
    return {
      type: "anti_runbook",
      text,
      tokens,
      score,
      scorePerToken: score / Math.max(1, tokens),
    };
  });
}

function runbookCapsules(runbooks: Array<{ tool_name: string; pattern: string; confidence: number; success_count: number; failure_count: number }>): CapsuleCandidate[] {
  return runbooks.map((rb) => {
    const rate = (rb.success_count + rb.failure_count) > 0
      ? ((rb.success_count / (rb.success_count + rb.failure_count)) * 100).toFixed(0) : "N/A";
    const text = `[runbook] ${rb.tool_name}: ${rb.pattern} (${rate}% success)`;
    const tokens = estimateTokens(text);
    const score = rb.confidence * 0.85;
    return {
      type: "runbook",
      text,
      tokens,
      score,
      scorePerToken: score / Math.max(1, tokens),
    };
  });
}

function relationCapsules(relations: Array<{ subject_name: string; predicate: string; object_name: string; confidence: number }>): CapsuleCandidate[] {
  return relations.map((r) => {
    const text = `[relation] ${r.subject_name} ${r.predicate} ${r.object_name}`;
    const tokens = estimateTokens(text);
    const score = r.confidence * 0.8; // Slightly below claims
    return {
      type: "relation",
      text,
      tokens,
      score,
      scorePerToken: score / Math.max(1, tokens),
    };
  });
}

function conflictCapsules(rows: Array<Record<string, unknown>>): CapsuleCandidate[] {
  return rows.map((row) => {
    const s = safeParseStructured(row.structured_json);
    const sideA = String(s.objectIdA ?? "?");
    const sideB = String(s.objectIdB ?? "?");
    const status = String(row.status ?? "active");
    const label = status === "active" ? "unresolved" : status;
    const text = `[conflict] ${sideA} vs ${sideB} (${label})`;
    const tokens = estimateTokens(text);
    // Conflicts scored between decisions (0.9) and anti-runbooks (0.95)
    const score = 0.85;
    return {
      type: "conflict",
      text,
      tokens,
      score,
      scorePerToken: score / Math.max(1, tokens),
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute keyword overlap between a query and capsule text.
 * Returns a relevance factor in [0.2, 1.0] — 0.2 floor ensures
 * unrelated capsules are demoted but not zeroed entirely.
 */
function queryRelevance(queryWords: string[], capsuleText: string): number {
  if (queryWords.length === 0) return 1.0;
  const lowerText = capsuleText.toLowerCase();
  let hits = 0;
  for (const w of queryWords) {
    if (lowerText.includes(w)) hits++;
  }
  const overlap = hits / queryWords.length; // 0..1
  // Map 0..1 overlap to 0.2..1.0 relevance factor
  return 0.2 + 0.8 * overlap;
}

function daysSinceIso(isoDate: string): number {
  try {
    const ms = Date.now() - new Date(isoDate).getTime();
    return Math.max(0, Math.floor(ms / 86_400_000));
  } catch {
    return 999;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ContextCompilerConfig {
  tier: string | number;
  scopeId: number;
  /** Optional query string for relevance-weighted scoring. */
  queryContext?: string;
  maxClaims?: number;
  maxDecisions?: number;
  maxLoops?: number;
  maxDeltas?: number;
  maxInvariants?: number;
  /** Override auto-archive check interval in ms (default 3600000). */
  autoArchiveIntervalMs?: number;
  /** Override evidence_log event threshold for auto-archive (default 5000). */
  autoArchiveEventThreshold?: number;
  /** Decay interval days for anti-runbooks (default 90). */
  decayDays?: number;
  /** Stale days for runbooks (default 180). */
  runbookStaleDays?: number;
  /** Decay multiplier/floor overrides. */
  decay?: DecayConfig;
}

export interface CompilerResult {
  text: string;
  capsuleCount: number;
  tokensUsed: number;
  budgetTotal: number;
  capsuleTypes: Record<string, number>;
}

// Time guard: run decay at most once per 5 minutes to avoid per-turn UPDATE storms
let _lastDecayRun = 0;

/**
 * Compile evidence context capsules within a token budget.
 *
 * Queries the evidence store for active claims, decisions, loops,
 * deltas, and invariants. Scores each by relevance and cost.
 * Fills the budget greedily by score-per-token.
 *
 * @returns Compiled text for system prompt injection, or null if nothing to surface.
 */
export function compileContextCapsules(
  db: GraphDb,
  config: ContextCompilerConfig,
): CompilerResult | null {
  const budget = typeof config.tier === "number" ? config.tier : (BUDGET_TIERS[config.tier] ?? BUDGET_TIERS.standard);
  const scopeId = config.scopeId;

  // Decay + auto-archive are now handled by a background timer (startDecayTimer)
  // to keep the assemble() hot path fast. Lazy fallback here only if timer hasn't
  // run yet (e.g., compileContextCapsules called outside the engine lifecycle).
  if (Date.now() - _lastDecayRun > 600_000) { // 10 min fallback (timer runs every 5 min)
    try { applyDecay(db, scopeId, config.decayDays, config.runbookStaleDays, config.decay); } catch {}
    _lastDecayRun = Date.now();
  }
  maybeAutoArchive(db, config.autoArchiveIntervalMs, config.autoArchiveEventThreshold);

  // Gather candidates from all evidence types.
  // Unified query: fetch all active memory_objects for the scope in one SQL call,
  // then split by kind in TypeScript. Reduces 7 DB round-trips to 1.
  // Deltas stay separate — they live in the legacy state_deltas table.
  const candidates: CapsuleCandidate[] = [];

  try {
    const allRows = db.prepare(`
      SELECT * FROM memory_objects
      WHERE scope_id = ? AND branch_id = 0 AND status = 'active'
        AND kind IN ('claim', 'decision', 'loop', 'invariant', 'procedure', 'relation', 'conflict')
      ORDER BY kind, confidence DESC, last_observed_at DESC
    `).all(scopeId) as Array<Record<string, unknown>>;

    // Per-kind limits
    const maxClaims = config.maxClaims ?? 10;
    const maxDecisions = config.maxDecisions ?? 5;
    const maxLoops = config.maxLoops ?? 5;
    const maxInvariants = config.maxInvariants ?? 5;
    const maxRunbooks = 5;
    const maxAntiRunbooks = 5;
    const maxRelations = 10;
    const maxConflicts = 5;

    // Build contested composite_id set from conflict rows (first pass)
    const contestedIds = new Set<string>();
    for (const row of allRows) {
      if (String(row.kind) === "conflict") {
        const s = safeParseStructured(row.structured_json);
        if (s.objectIdA) contestedIds.add(String(s.objectIdA));
        if (s.objectIdB) contestedIds.add(String(s.objectIdB));
      }
    }

    // Counters
    let claimCount = 0, decisionCount = 0, loopCount = 0;
    let invariantCount = 0, runbookCount = 0, antiRunbookCount = 0, relationCount = 0, conflictCount = 0;

    for (const row of allRows) {
      const kind = String(row.kind);
      switch (kind) {
        case "claim":
          if (claimCount++ < maxClaims) candidates.push(...claimCapsules([moRowToClaimRow(row)], [String(row.composite_id ?? "")], contestedIds));
          break;
        case "decision":
          if (decisionCount++ < maxDecisions) candidates.push(...decisionCapsules([moRowToDecisionRow(row)], [String(row.composite_id ?? "")], contestedIds));
          break;
        case "loop":
          if (loopCount++ < maxLoops) candidates.push(...loopCapsules([moRowToLoopRow(row)]));
          break;
        case "invariant":
          if (invariantCount++ < maxInvariants) candidates.push(...invariantCapsules([moRowToInvariantRow(row)]));
          break;
        case "procedure": {
          const s = safeParseStructured(row.structured_json);
          if (s.isNegative === true || s.isNegative === "true") {
            if (antiRunbookCount++ < maxAntiRunbooks) candidates.push(...antiRunbookCapsules([moRowToAntiRunbookRow(row)]));
          } else {
            if (runbookCount++ < maxRunbooks) candidates.push(...runbookCapsules([moRowToRunbookRow(row)]));
          }
          break;
        }
        case "relation":
          if (relationCount++ < maxRelations) {
            const rel = moRowToRelationRow(row);
            candidates.push(...relationCapsules([rel]));
          }
          break;
        case "conflict":
          if (conflictCount++ < maxConflicts) candidates.push(...conflictCapsules([row]));
          break;
      }
    }
  } catch { /* non-fatal: unified query failure should not break compilation */ }

  // Deltas: separate query — state_deltas table, not memory_objects
  try {
    const deltas = getRecentDeltas(db, scopeId, { limit: config.maxDeltas ?? 5 });
    candidates.push(...deltaCapsules(deltas));
  } catch { /* non-fatal */ }

  if (candidates.length === 0) return null;

  // Deduplicate: if two capsules have identical text, keep the higher-scoring one
  const seenTexts = new Set<string>();
  const deduped: CapsuleCandidate[] = [];
  // Sort by score first so we keep the best version
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    // Normalize text for dedup: strip epistemic labels since same claim at different label is a duplicate
    const dedupKey = c.text.replace(/\s*\[(FIRM|CONTESTED|PROVISIONAL)\]/, "").trim();
    if (!seenTexts.has(dedupKey)) {
      seenTexts.add(dedupKey);
      deduped.push(c);
    }
  }

  // Query-aware relevance boosting: multiply scores by keyword overlap
  const queryWords = config.queryContext
    ? config.queryContext.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 2)
    : [];
  if (queryWords.length > 0) {
    for (const c of deduped) {
      const relevance = queryRelevance(queryWords, c.text);
      c.score *= relevance;
      c.scorePerToken = c.score / Math.max(1, c.tokens);
    }
  }

  // ROI Governor: rank by score-per-token, greedy knapsack fill
  deduped.sort((a, b) => b.scorePerToken - a.scorePerToken);

  const selected: CapsuleCandidate[] = [];
  // Pre-deduct header cost: "[ThreadClaw Evidence]\n" ≈ 6 tokens
  const headerTokens = estimateTokens("[ThreadClaw Evidence]\n");
  let spent = headerTokens;

  for (const c of deduped) {
    if (c.score <= 0) continue;
    if (spent + c.tokens <= budget) {
      selected.push(c);
      spent += c.tokens;
    }
  }

  if (selected.length === 0) return null;

  // Deterministic output ordering (invariant > decision > claim > loop > delta)
  selected.sort((a, b) => (CAPSULE_ORDER[a.type] ?? 99) - (CAPSULE_ORDER[b.type] ?? 99));

  // Count capsule types
  const capsuleTypes: Record<string, number> = {};
  for (const c of selected) {
    capsuleTypes[c.type] = (capsuleTypes[c.type] ?? 0) + 1;
  }

  const text = `[ThreadClaw Evidence]\n${selected.map((c) => c.text).join("\n")}`;

  return {
    text,
    capsuleCount: selected.length,
    tokensUsed: spent,
    budgetTotal: budget,
    capsuleTypes,
  };
}
