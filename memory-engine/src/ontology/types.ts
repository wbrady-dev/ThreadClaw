/**
 * RSMA Core Types — Reconciled Semantic Memory Architecture.
 *
 * Every piece of knowledge in ThreadClaw is a MemoryObject with a uniform
 * metadata envelope. Physical stores remain specialized; the ontology
 * unifies the semantic model above them.
 */

// ── Memory Object Kinds ─────────────────────────────────────────────────────

/** All durable knowledge types in ThreadClaw. */
export type MemoryKind =
  | "event"      // raw semantic event (internal: pipeline input before materialization)
  | "chunk"      // document chunks (projected to threadclaw.db)
  | "message"    // conversation messages (projected to memory.db)
  | "summary"    // compacted summaries (projected to memory.db)
  | "claim"      // factual assertions (projected to threadclaw.db)
  | "decision"   // recorded choices (projected to threadclaw.db)
  | "entity"     // named things (projected to threadclaw.db)
  | "relation"   // entity-to-entity relationships (projected to threadclaw.db)
  | "loop"       // open tasks/questions (projected to threadclaw.db)
  | "attempt"    // tool execution records (projected to threadclaw.db)
  | "procedure"  // runbooks + anti-runbooks merged (projected to threadclaw.db)
  | "invariant"  // constraints/rules (projected to threadclaw.db)
  | "delta"      // state changes (projected to threadclaw.db)
  | "conflict"    // first-class contradiction between two+ claims/decisions
  | "capability"; // tracked tools, systems, and services

/** Default scope ID for single-scope deployments. */
export const DEFAULT_SCOPE_ID = 1;

/** How the knowledge entered the system. */
export type SourceKind =
  | "document"
  | "message"
  | "tool_result"
  | "user_explicit"
  | "extraction"
  | "compaction"
  | "inference";

/** Event classification before materialization into MemoryObjects. */
export type EventType =
  | "fact_assertion"
  | "decision"
  | "correction"
  | "preference"
  | "task"
  | "reminder"
  | "observation"
  | "uncertainty"
  | "tool_outcome"
  | "relationship"
  | "invariant";

/** Structured data for invariant memory objects. */
export interface StructuredInvariant {
  key?: string;
  category?: string | null;
  description?: string;
  severity?: "critical" | "error" | "warning" | "info";
  enforcementMode?: "strict" | "advisory";
}

/** Object lifecycle status. */
export type MemoryStatus =
  | "active"
  | "superseded"
  | "retracted"
  | "stale"
  | "needs_confirmation";

/** How much this object should influence agent behavior. */
export type InfluenceWeight = "critical" | "high" | "standard" | "low";

// ── Structured Data Interfaces (per MemoryObject kind) ──────────────────────
// These typed interfaces prevent field-name mismatches between producers
// (semantic-extractor.ts) and consumers (engine.ts legacy bridge).
// If you rename a field here, TypeScript will flag every call site.

/** Structured data for kind="claim" — factual assertions. */
export interface StructuredClaim {
  subject: string;
  predicate: string;
  objectText: string;
  objectJson?: string;
  valueType?: string;
  topic?: string;
}

/** Structured data for kind="decision" — recorded choices. */
export interface StructuredDecision {
  topic: string;
  decisionText: string;
}

/** Structured data for kind="loop" — open tasks/questions. */
export interface StructuredLoop {
  loopType: "task" | "question" | "follow_up" | "dependency";
  text: string;
  priority?: number;
  owner?: string;
  dueAt?: string;
  waitingOn?: string;
  status?: string;
}

/** Structured data for kind="entity" — named things. */
export interface StructuredEntity {
  name: string;
  entityType?: string;
}

/** Structured data for kind="relation" — entity-to-entity relationships. */
export interface StructuredRelation {
  subjectName?: string;
  predicate?: string;
  objectName?: string;
}

/** Structured data for kind="procedure" — runbooks and anti-runbooks. */
export interface StructuredProcedure {
  toolName?: string;
  key?: string;
}

/** Structured data for kind="capability" — tracked tools, systems, services. */
export interface StructuredCapability {
  capabilityType?: string;
  capabilityKey?: string;
}

// ── Provenance ──────────────────────────────────────────────────────────────

/** How knowledge was extracted from raw input. */
export type ExtractionMethod = "regex" | "ner" | "llm" | "frontmatter" | "kv" | "tool_json";

/** Where a MemoryObject came from. */
export interface Provenance {
  source_kind: SourceKind;
  source_id: string;
  source_detail?: string;
  actor: string;               // "system", "user", or agent ID
  trust: number;               // 0.0–1.0 from SOURCE_TRUST hierarchy
  extraction_method?: ExtractionMethod;
}

// ── MemoryObject ────────────────────────────────────────────────────────────

/** The unified type for all knowledge in ThreadClaw. */
export interface MemoryObject {
  id: string;
  kind: MemoryKind;
  content: string;             // human-readable text
  structured?: unknown;        // machine-readable JSON payload
  canonical_key?: string;      // dedup/supersession key (per-kind strategies)

  // Provenance
  provenance: Provenance;

  // Truth state
  confidence: number;          // 0.0–1.0
  freshness: number;           // 0.0–1.0 (decays over time)
  provisional: boolean;        // true for "I think", "for now", "maybe"

  // Lifecycle
  status: MemoryStatus;
  superseded_by?: string;      // ID of the MemoryObject that replaced this

  // Temporal
  observed_at: string;         // when the system learned this (ISO 8601)
  effective_at?: string;       // when it became true ("starting next Monday")
  expires_at?: string;         // when it stops being relevant

  // Scope and influence
  scope_id: number;
  branch_id?: number;
  influence_weight: InfluenceWeight;

  created_at: string;
  updated_at: string;
}

// ── Provenance Links ────────────────────────────────────────────────────────

/** Typed predicates for provenance links — no string soup. */
export type LinkPredicate =
  | "derived_from"   // summary → messages, condensed → leaf summaries
  | "supports"       // evidence that reinforces a claim/decision
  | "contradicts"    // evidence that conflicts
  | "supersedes"     // new belief replacing old
  | "mentioned_in"   // entity appearing in a source
  | "relates_to"     // entity-to-entity semantic relationship
  | "resolved_by";   // conflict resolution link

/** A directional link between two MemoryObjects. */
export interface ProvenanceLink {
  id?: number;
  subject_id: string;          // source MemoryObject ID
  predicate: LinkPredicate;
  object_id: string;           // target MemoryObject ID
  confidence: number;
  detail?: string;             // for "relates_to": the specific relationship (e.g. "manages")
  created_at: string;
}

// ── Relevance Scoring ───────────────────────────────────────────────────────

/** Signals used for relevance-to-action ranking. */
export interface RelevanceSignals {
  semantic: number;            // 0–1: embedding similarity or keyword match
  recency: number;             // 0–1: how recently touched (exponential decay)
  trust: number;               // 0–1: provenance trust score
  conflict: number;            // 0–1: bonus for unresolved conflicts
  influence: number;           // 0–1: from influence_weight
  status_penalty: number;      // 1.0 for active, 0.3 for stale, 0.0 for superseded/retracted
}

/** Per-task-mode ranking weight configuration. */
export interface RankingWeights {
  semantic: number;
  recency: number;
  trust: number;
  conflict: number;
  influence: number;
}

/** Task modes that affect ranking behavior. */
export type TaskMode = "coding" | "planning" | "troubleshooting" | "recall" | "default";

/** Preset ranking weights per task mode. */
export const TASK_MODE_WEIGHTS: Record<TaskMode, RankingWeights> = {
  coding:          { semantic: 0.4,  recency: 0.2,  trust: 0.15, conflict: 0.1,  influence: 0.15 },
  planning:        { semantic: 0.2,  recency: 0.15, trust: 0.15, conflict: 0.25, influence: 0.25 },
  troubleshooting: { semantic: 0.25, recency: 0.3,  trust: 0.15, conflict: 0.1,  influence: 0.2  },
  recall:          { semantic: 0.5,  recency: 0.1,  trust: 0.1,  conflict: 0.1,  influence: 0.2  },
  default:         { semantic: 0.3,  recency: 0.2,  trust: 0.15, conflict: 0.15, influence: 0.2  },
};

// ── Source Trust Hierarchy ──────────────────────────────────────────────────

/**
 * Trust scores by source kind.
 * Order: tool_result (1.0) > user_explicit (0.9) > document (0.7) > message (0.6)
 *      > extraction (0.5) > compaction (0.3) > inference (0.2)
 */
export const SOURCE_TRUST: Record<SourceKind, number> = {
  tool_result:   1.0,
  user_explicit: 0.9,
  document:      0.7,
  extraction:    0.5,
  compaction:    0.3,
  inference:     0.2,
  message:       0.6,
};

/** Correction signals get a trust bonus. */
export const CORRECTION_TRUST_BONUS = 0.15;

/** Provisional (uncertain) signals get halved confidence. */
export const PROVISIONAL_CONFIDENCE_FACTOR = 0.5;

// ── Influence Weight Scores ─────────────────────────────────────────────────

/** Numeric scores for influence weights (used in ranking). */
export const INFLUENCE_SCORES: Record<InfluenceWeight, number> = {
  critical: 1.0,
  high:     0.8,
  standard: 0.5,
  low:      0.2,
};

// ── Utility ─────────────────────────────────────────────────────────────────

/** Compute composite relevance score from signals and weights. */
export function computeRelevance(signals: RelevanceSignals, weights: RankingWeights): number {
  return (
    signals.semantic * weights.semantic +
    signals.recency * weights.recency +
    signals.trust * weights.trust +
    signals.conflict * weights.conflict +
    signals.influence * weights.influence
  ) * signals.status_penalty;
}
