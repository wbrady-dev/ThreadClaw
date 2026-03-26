/**
 * Context compiler + ROI governor.
 *
 * Scores candidate capsules from the evidence store and assembles
 * them into a compact system prompt injection within a token budget.
 *
 * Scoring: (usefulness × confidence × freshness × scopeFit) / tokenCost
 * Budget tiers: lite=110, standard=190, premium=280 tokens
 */

import type { GraphDb } from "./types.js";
import { effectiveConfidence } from "./confidence.js";
import { getActiveClaims, type ClaimRow } from "./claim-store.js";
import { getActiveDecisions, type DecisionRow } from "./decision-store.js";
import { getOpenLoops, type LoopRow } from "./loop-store.js";
import { getRecentDeltas, type DeltaRow } from "./delta-store.js";
import { getActiveInvariants, type InvariantRow } from "./invariant-store.js";
import { getAntiRunbooks, type AntiRunbookRow } from "./anti-runbook-store.js";
import { getRelationGraph } from "./relation-store.js";
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
  premium: 280,
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
  decision: 2,
  claim: 3,
  loop: 4,
  delta: 5,
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

function claimCapsules(claims: ClaimRow[]): CapsuleCandidate[] {
  const results: CapsuleCandidate[] = [];
  for (const c of claims) {
    const predicateLower = c.predicate.toLowerCase().trim();

    // Skip historical/transition claims entirely — they're not current state
    if (HISTORICAL_PREDICATES.has(predicateLower)) continue;

    const daysSince = daysSinceIso(c.last_seen_at);
    const conf = effectiveConfidence(c.confidence, 1, daysSince);
    const text = `[claim] ${c.subject} ${c.predicate}: ${c.object_text ?? "(no value)"} (conf=${c.confidence.toFixed(2)})`;
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

function decisionCapsules(decisions: DecisionRow[]): CapsuleCandidate[] {
  return decisions.map((d) => {
    const text = `[decision] ${d.topic}: ${d.decision_text}`;
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
    const text = `[invariant:${inv.severity}] ${inv.description}`;
    const tokens = estimateTokens(text);
    // Critical invariants score highest
    const severityScore: Record<string, number> = {
      critical: 1.0, error: 0.9, warning: 0.7, info: 0.4,
    };
    const score = severityScore[inv.severity] ?? 0.5;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  // Apply lazy decay + auto-archive before gathering candidates (at most once per 5 minutes)
  if (Date.now() - _lastDecayRun > 300_000) {
    applyDecay(db, scopeId, config.decayDays, config.runbookStaleDays, config.decay);
    _lastDecayRun = Date.now();
  }
  maybeAutoArchive(db, config.autoArchiveIntervalMs, config.autoArchiveEventThreshold);

  // Gather candidates from all evidence types
  const candidates: CapsuleCandidate[] = [];

  try {
    const claims = getActiveClaims(db, scopeId, undefined, config.maxClaims ?? 10);
    candidates.push(...claimCapsules(claims));
  } catch { /* non-fatal */ }

  try {
    const decisions = getActiveDecisions(db, scopeId, undefined, config.maxDecisions ?? 5);
    candidates.push(...decisionCapsules(decisions));
  } catch { /* non-fatal */ }

  try {
    const loops = getOpenLoops(db, scopeId, undefined, config.maxLoops ?? 5);
    candidates.push(...loopCapsules(loops));
  } catch { /* non-fatal */ }

  try {
    const deltas = getRecentDeltas(db, scopeId, { limit: config.maxDeltas ?? 5 });
    candidates.push(...deltaCapsules(deltas));
  } catch { /* non-fatal */ }

  try {
    const invariants = getActiveInvariants(db, scopeId, config.maxInvariants ?? 5);
    candidates.push(...invariantCapsules(invariants));
  } catch { /* non-fatal */ }

  try {
    const antiRbs = getAntiRunbooks(db, scopeId, { limit: 5 });
    candidates.push(...antiRunbookCapsules(antiRbs));
  } catch { /* non-fatal */ }

  try {
    const rels = getRelationGraph(db, scopeId, { limit: 10 });
    candidates.push(...relationCapsules(rels));
  } catch { /* non-fatal */ }

  if (candidates.length === 0) return null;

  // Deduplicate: if two capsules have identical text, keep the higher-scoring one
  const seenTexts = new Set<string>();
  const deduped: CapsuleCandidate[] = [];
  // Sort by score first so we keep the best version
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    // Normalize text for dedup: strip confidence suffix since same claim at different conf is a duplicate
    const dedupKey = c.text.replace(/\(conf=[\d.]+\)/, "").trim();
    if (!seenTexts.has(dedupKey)) {
      seenTexts.add(dedupKey);
      deduped.push(c);
    }
  }

  // ROI Governor: rank by score-per-token, greedy knapsack fill
  deduped.sort((a, b) => b.scorePerToken - a.scorePerToken);

  const selected: CapsuleCandidate[] = [];
  let spent = 0;

  for (const c of deduped) {
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
