/**
 * TruthEngine — reconciliation for RSMA.
 *
 * Takes candidate MemoryObjects from the Writer and reconciles them against
 * existing knowledge in the graph database. Handles:
 *
 * 1. Supersession: new belief replaces old (same canonical key, higher confidence)
 * 2. Conflict creation: contradictory values surface as first-class Conflict objects
 * 3. Confidence resolution: trust × freshness × correction bonus
 * 4. Provisional handling: uncertain statements don't override firm beliefs
 *
 * Safety guards (5-point check for correction-triggered supersession):
 * - Canonical key match exists in DB
 * - Same scope (or compatible scope)
 * - Same kind family (claims supersede claims, decisions supersede decisions)
 * - Minimum confidence threshold (0.3)
 * - Auditable reason trace on every supersession
 *
 * INVARIANTS:
 * - This module NEVER mutates input MemoryObjects.
 * - It is deterministic: same inputs → same outputs.
 * - It is side-effect-free: the caller (Projector) handles DB writes.
 */

import { randomUUID } from "node:crypto";
import type { GraphDb } from "../relations/types.js";
import type { MemoryObject, MemoryKind } from "./types.js";
import { CORRECTION_TRUST_BONUS } from "./types.js";
import { buildCanonicalKey } from "./canonical.js";
import { safeParseStructured } from "./json-utils.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SupersessionAction {
  type: "supersede";
  newObject: MemoryObject;
  oldObjectId: string;
  reason: string;
}

export interface ConflictAction {
  type: "conflict";
  conflictObject: MemoryObject;
  objectIdA: string;
  objectIdB: string;
  reason: string;
}

export interface InsertAction {
  type: "insert";
  object: MemoryObject;
}

export interface EvidenceAction {
  type: "evidence";
  newObject: MemoryObject;
  existingObjectId: string;
  predicate: "supports" | "contradicts";
  reason: string;
}

export type ReconcileAction =
  | SupersessionAction
  | ConflictAction
  | InsertAction
  | EvidenceAction;

export interface ReconcileStats {
  totalCandidates: number;
  inserts: number;
  supersessions: number;
  conflicts: number;
  evidence: number;
}

export interface ReconcileResult {
  actions: ReconcileAction[];
  stats: ReconcileStats;
}

// ── Configuration ───────────────────────────────────────────────────────────

const MIN_SUPERSESSION_CONFIDENCE = 0.3;

const SUPERSESSION_KINDS = new Set<MemoryKind>([
  "claim", "decision", "loop", "invariant", "procedure", "relation", "entity", "capability",
]);

function kindFamily(kind: MemoryKind): string {
  switch (kind) {
    case "claim": return "claim";
    case "decision": return "decision";
    case "loop": return "loop";
    case "invariant": return "invariant";
    case "procedure": return "procedure";
    case "relation": return "relation";
    case "entity": return "entity";
    case "capability": return "capability";
    default: return kind;
  }
}

// ── DB Lookup ───────────────────────────────────────────────────────────────

interface ExistingMatch {
  id: string;
  rawId: number;
  kind: MemoryKind;
  canonicalKey: string;
  status: string;
  confidence: number;
  content: string;
  /** Extracted comparable value from structured_json (objectText for claims, decisionText for decisions, etc.) */
  value: string | null;
  scopeId: number;
}

function extractValueFromRow(row: Record<string, unknown>): string | null {
  const kind = String(row.kind ?? "");
  let structured: Record<string, unknown> = {};
  if (row.structured_json != null && typeof row.structured_json === "string") {
    structured = safeParseStructured(row.structured_json);
  }
  if (kind === "claim" && typeof structured.objectText === "string") return structured.objectText;
  if (kind === "decision" && typeof structured.decisionText === "string") return structured.decisionText;
  if (kind === "relation") {
    const val = [structured.subjectName, structured.predicate, structured.objectName].filter(Boolean).join(" ");
    return val || String(row.content ?? "");
  }
  if (kind === "loop") return String(row.content ?? "");
  if (kind === "invariant" && typeof structured.description === "string") return structured.description;
  return String(row.content ?? "");
}

function toMatch(row: Record<string, unknown>): ExistingMatch {
  return {
    id: String(row.composite_id ?? `${row.kind}:${row.id}`),
    rawId: Number(row.id),
    kind: String(row.kind ?? "claim") as MemoryKind,
    canonicalKey: String(row.canonical_key ?? ""),
    status: String(row.status ?? "active"),
    confidence: Number(row.confidence ?? 0.5),
    content: String(row.content ?? ""),
    value: extractValueFromRow(row),
    scopeId: Number(row.scope_id ?? 1),
  };
}

/**
 * Find existing active objects with the same canonical key.
 * Queries the unified memory_objects table.
 */
function findExistingByCanonicalKey(
  db: GraphDb,
  kind: MemoryKind,
  canonicalKey: string,
  scopeId: number,
  branchId?: number,
): ExistingMatch[] {
  try {
    const rows = db.prepare(`
      SELECT * FROM memory_objects
      WHERE canonical_key = ? AND scope_id = ? AND kind = ?
        AND branch_id = ?
        AND status IN ('active', 'needs_confirmation')
    `).all(canonicalKey, scopeId, kind, branchId ?? 0) as Array<Record<string, unknown>>;

    return rows.map(toMatch);
  } catch {
    // Non-fatal: if table doesn't exist, return empty
    return [];
  }
}

// ── Value Comparison ────────────────────────────────────────────────────────

/** Extract the comparable value from a MemoryObject. */
function extractValueForComparison(obj: MemoryObject): string | null {
  const s = obj.structured as Record<string, unknown> | undefined;
  if (!s) return typeof obj.content === "string" ? obj.content : null;
  if (obj.kind === "claim" && typeof s.objectText === "string") return s.objectText;
  if (obj.kind === "decision" && typeof s.decisionText === "string") return s.decisionText;
  if (obj.kind === "relation") {
    const val = [s?.subjectName, s?.predicate, s?.objectName].filter(Boolean).join(" ");
    return val || (typeof obj.content === "string" ? obj.content : null);
  }
  if (obj.kind === "loop" && typeof obj.content === "string") return obj.content;
  if (obj.kind === "invariant" && typeof s.description === "string") return s.description as string;
  return typeof obj.content === "string" ? obj.content : null;
}

/** Check if two values represent a meaningful contradiction. */
function valuesContradict(
  candidateValue: string | null,
  existingValue: string | null,
): boolean {
  if (!candidateValue || !existingValue) return false;
  // Normalize both for comparison
  const a = candidateValue.toLowerCase().trim();
  const b = existingValue.toLowerCase().trim();
  // Same value = no contradiction
  if (a === b) return false;
  // Empty values = no contradiction
  if (a.length === 0 || b.length === 0) return false;
  // Containment check: if one value contains the other, it's a refinement, not a contradiction
  // e.g. "port 8080" vs "port 8080 (verified)" — not a contradiction
  if (a.includes(b) || b.includes(a)) return false;
  // Jaccard word similarity: high overlap = refinement, not contradiction
  // Strip punctuation first so "8080," and "8080" produce the same word
  const clean = (s: string) => s.replace(/[^\w\s]/g, " ").toLowerCase();
  const wordsA = new Set(clean(a).split(/\s+/).filter((w) => w.length > 1));
  const wordsB = new Set(clean(b).split(/\s+/).filter((w) => w.length > 1));
  if (wordsA.size > 0 && wordsB.size > 0) {
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    if (union > 0 && intersection / union > 0.7) return false;
  }
  return true;
}

// ── Core Reconciliation ─────────────────────────────────────────────────────

/**
 * Reconcile a list of candidate MemoryObjects against existing knowledge.
 *
 * Returns a list of actions the Projector should execute.
 * NEVER mutates input objects — creates copies where needed.
 */
export function reconcile(
  db: GraphDb,
  candidates: MemoryObject[],
  options: {
    isCorrection?: boolean;
    correctionSignal?: string;
  } = {},
): ReconcileResult {
  const actions: ReconcileAction[] = [];

  for (const candidate of candidates) {
    // Skip kinds that don't participate in truth reconciliation
    if (!candidate.canonical_key || !SUPERSESSION_KINDS.has(candidate.kind)) {
      actions.push({ type: "insert", object: candidate });
      continue;
    }

    // Find existing objects with the same canonical key
    const existing = findExistingByCanonicalKey(
      db,
      candidate.kind,
      candidate.canonical_key,
      candidate.scope_id,
      candidate.branch_id,
    );

    // No existing match → plain insert
    if (existing.length === 0) {
      actions.push({ type: "insert", object: candidate });
      continue;
    }

    // Take the highest-confidence existing match
    const match = existing.reduce((best, cur) =>
      cur.confidence > best.confidence ? cur : best, existing[0]);

    // ── Rule 6: Provisional objects don't supersede firm beliefs ──
    if (candidate.provisional && match.status !== "needs_confirmation") {
      actions.push({
        type: "evidence",
        newObject: candidate,
        existingObjectId: match.id,
        predicate: "supports",
        reason: `provisional: "${candidate.provenance.source_detail ?? "uncertainty signal"}"`,
      });
      continue;
    }

    // ── Determine supersession vs evidence ──
    let didSupersede = false;

    // ── Rule 5: Correction signal → auto-supersede (with 5-point guard) ──
    if (options.isCorrection) {
      const guardResult = checkSupersessionGuards(candidate, match, options.correctionSignal);
      if (guardResult.pass) {
        // Apply correction trust bonus — deep copy to preserve immutability
        const boosted: MemoryObject = {
          ...candidate,
          provenance: { ...candidate.provenance },
          structured: candidate.structured != null
            ? JSON.parse(JSON.stringify(candidate.structured))
            : undefined,
          confidence: Math.min(1.0, candidate.confidence + CORRECTION_TRUST_BONUS),
        };
        actions.push({
          type: "supersede",
          newObject: boosted,
          oldObjectId: match.id,
          reason: guardResult.reason,
        });
        didSupersede = true;
      }
    }

    // ── Rules 1-3: Standard confidence-based supersession ──
    if (!didSupersede) {
      const confidenceDiff = candidate.confidence - match.confidence;
      if (confidenceDiff > 0.001) {
        // Rule 1: Higher confidence → supersede
        actions.push({
          type: "supersede",
          newObject: candidate,
          oldObjectId: match.id,
          reason: `higher confidence: ${candidate.confidence.toFixed(2)} > ${match.confidence.toFixed(2)}`,
        });
        didSupersede = true;
      } else if (Math.abs(confidenceDiff) <= 0.001) {
        // Rule 2: Same confidence — only supersede if values actually differ.
        // If values are identical, just add as evidence (avoids pointless churn).
        const candidateVal = extractValueForComparison(candidate);
        const existingVal = match.value ?? match.content;
        const sameValue = candidateVal && existingVal
          && candidateVal.toLowerCase().trim() === existingVal.toLowerCase().trim();
        if (sameValue) {
          actions.push({
            type: "evidence",
            newObject: candidate,
            existingObjectId: match.id,
            predicate: "supports",
            reason: `same confidence and same value — no supersession needed`,
          });
        } else {
          actions.push({
            type: "supersede",
            newObject: candidate,
            oldObjectId: match.id,
            reason: `same confidence (${candidate.confidence.toFixed(2)}), newer object wins`,
          });
          didSupersede = true;
        }
      } else {
        // Rule 3: Lower confidence → add as evidence only
        const candidateVal = extractValueForComparison(candidate);
        const existingVal = match.value ?? match.content;
        const contradicts = valuesContradict(candidateVal, existingVal);
        actions.push({
          type: "evidence",
          newObject: candidate,
          existingObjectId: match.id,
          predicate: contradicts ? "contradicts" : "supports",
          reason: `lower confidence: ${candidate.confidence.toFixed(2)} < ${match.confidence.toFixed(2)}`,
        });
      }
    }

    // ── Rule 4: Value contradiction → create Conflict ──
    // This runs INDEPENDENTLY of supersession. Even if new object supersedes old,
    // a conflict can still be created to flag the value change for user review.
    // Conflict is created when: values differ AND candidate has meaningful confidence.
    const candidateValue = extractValueForComparison(candidate);
    const existingValue = match.value ?? match.content;
    if (valuesContradict(candidateValue, existingValue)
        && candidate.confidence >= MIN_SUPERSESSION_CONFIDENCE) {
      // If supersession happened, the conflict is informational (status: "active" not "needs_confirmation")
      // If only evidence was added, the conflict needs user confirmation
      const conflictStatus = didSupersede ? "active" as const : "needs_confirmation" as const;
      const conflictObj = createConflictObject(candidate, match, conflictStatus);
      actions.push({
        type: "conflict",
        conflictObject: conflictObj,
        objectIdA: candidate.id,
        objectIdB: match.id,
        reason: `contradictory values: "${(candidateValue ?? "").substring(0, 50)}" vs "${(existingValue ?? "").substring(0, 50)}"`,
      });
    }
  }

  const stats: ReconcileStats = {
    totalCandidates: candidates.length,
    inserts: actions.filter((a) => a.type === "insert").length,
    supersessions: actions.filter((a) => a.type === "supersede").length,
    conflicts: actions.filter((a) => a.type === "conflict").length,
    evidence: actions.filter((a) => a.type === "evidence").length,
  };

  return { actions, stats };
}

// ── 5-Point Supersession Guard ──────────────────────────────────────────────

interface GuardResult {
  pass: boolean;
  reason: string;
}

function checkSupersessionGuards(
  candidate: MemoryObject,
  existing: ExistingMatch,
  correctionSignal?: string | null,
): GuardResult {
  // Guard 1: Canonical key match (guaranteed by lookup)

  // Guard 2: Same scope
  if (candidate.scope_id !== existing.scopeId) {
    return {
      pass: false,
      reason: `scope mismatch: candidate scope ${candidate.scope_id} != existing scope ${existing.scopeId}`,
    };
  }

  // Guard 3: Same kind family
  if (kindFamily(candidate.kind) !== kindFamily(existing.kind)) {
    return {
      pass: false,
      reason: `kind family mismatch: ${candidate.kind} != ${existing.kind}`,
    };
  }

  // Guard 4: Minimum confidence threshold
  if (candidate.confidence < MIN_SUPERSESSION_CONFIDENCE) {
    return {
      pass: false,
      reason: `confidence too low: ${candidate.confidence.toFixed(2)} < ${MIN_SUPERSESSION_CONFIDENCE}`,
    };
  }

  // Guard 5: Auditable reason trace
  const reason = `correction_supersession: signal="${correctionSignal ?? "unknown"}", `
    + `canonical_key="${candidate.canonical_key}", `
    + `old_id="${existing.id}", `
    + `confidence=${candidate.confidence.toFixed(2)} vs ${existing.confidence.toFixed(2)}`;

  return { pass: true, reason };
}

// ── Conflict Object Factory ─────────────────────────────────────────────────

function createConflictObject(
  objA: MemoryObject,
  existing: ExistingMatch,
  status: "active" | "needs_confirmation",
): MemoryObject {
  const now = new Date().toISOString();
  const contentA = objA.content.substring(0, 80);
  const contentB = existing.content.substring(0, 80);

  return {
    id: `conflict:${randomUUID()}`,
    kind: "conflict",
    content: `${objA.kind} conflict: "${contentA}" vs "${contentB}"`,
    structured: {
      objectIdA: objA.id,
      objectIdB: existing.id,
      canonicalKey: objA.canonical_key,
      kind: objA.kind,
    },
    canonical_key: `conflict::${objA.canonical_key ?? contentA}::vs::${existing.canonicalKey ?? contentB}`,
    provenance: {
      source_kind: "inference",
      source_id: objA.id,
      actor: "system",
      trust: 0.9,
    },
    confidence: 0.9,
    freshness: 1.0,
    provisional: false,
    status,
    observed_at: now,
    scope_id: objA.scope_id,
    influence_weight: "high",
    created_at: now,
    updated_at: now,
  };
}
