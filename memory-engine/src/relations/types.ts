/**
 * Shared types for the ClawCore relations/evidence module.
 *
 * The GraphDb interface abstracts over both `node:sqlite` DatabaseSync
 * and `better-sqlite3` so the same store code works in both processes.
 */

// ---------------------------------------------------------------------------
// Database abstraction
// ---------------------------------------------------------------------------

export interface GraphDbStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface GraphDb {
  prepare(sql: string): GraphDbStatement;
  exec(sql: string): void;
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

export type ExtractionStrategy = "capitalized" | "terms_list" | "quoted";

export interface ExtractionResult {
  /** Raw extracted name (will be lowercased + trimmed before storage). */
  name: string;
  /** Confidence score 0–1. */
  confidence: number;
  /** Which extraction strategy produced this result. */
  strategy: ExtractionStrategy;
  /** Up to 200 chars of surrounding context. */
  snippet?: string;
  /** Co-occurring terms-list entries found in the same text. */
  contextTerms?: string[];
}

// ---------------------------------------------------------------------------
// Evidence log
// ---------------------------------------------------------------------------

export interface EvidenceEvent {
  scopeId?: number;
  branchId?: number;
  objectType: string;
  objectId: number;
  eventType: string;
  actor?: string;
  runId?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Store inputs
// ---------------------------------------------------------------------------

export interface UpsertEntityInput {
  name: string;
  displayName?: string;
  entityType?: string;
}

export interface InsertMentionInput {
  entityId: number;
  scopeId?: number;
  sourceType: string;
  sourceId: string;
  sourceDetail?: string;
  contextTerms?: string[];
  actor?: string;
  runId?: string;
}

export interface StoreExtractionInput {
  sourceType: string;
  sourceId: string;
  sourceDetail?: string;
  scopeId?: number;
  actor?: string;
  runId?: string;
}

// ---------------------------------------------------------------------------
// Horizon 2: Claims
// ---------------------------------------------------------------------------

export type ClaimStatus = "active" | "superseded" | "retracted" | "stale";
export type EvidenceRole = "support" | "contradict" | "update";
export type ValueType = "text" | "json" | "number" | "boolean" | "date";

export interface UpsertClaimInput {
  scopeId: number;
  branchId?: number;
  subject: string;
  predicate: string;
  objectText?: string;
  objectJson?: string;
  valueType?: ValueType;
  confidence?: number;
  trustScore?: number;
  sourceAuthority?: number;
  canonicalKey: string;
  extractionVersion?: number;
}

export interface UpsertClaimResult {
  claimId: number;
  isNew: boolean;
}

export interface AddClaimEvidenceInput {
  claimId: number;
  sourceType: string;
  sourceId: string;
  sourceDetail?: string;
  evidenceRole: EvidenceRole;
  snippetHash?: string;
  confidenceDelta?: number;
}

// ---------------------------------------------------------------------------
// Horizon 2: Decisions
// ---------------------------------------------------------------------------

export type DecisionStatus = "active" | "superseded" | "revoked";

export interface UpsertDecisionInput {
  scopeId: number;
  branchId?: number;
  topic: string;
  decisionText: string;
  status?: DecisionStatus;
  sourceType?: string;
  sourceId?: string;
  sourceDetail?: string;
}

export interface UpsertDecisionResult {
  decisionId: number;
  isNew: boolean;
}

// ---------------------------------------------------------------------------
// Horizon 2: Open Loops
// ---------------------------------------------------------------------------

export type LoopStatus = "open" | "closed" | "blocked" | "stale";
export type LoopType = "task" | "question" | "follow_up" | "dependency" | "test" | "smoke";

export interface OpenLoopInput {
  scopeId: number;
  branchId?: number;
  loopType?: LoopType;
  text: string;
  priority?: number;
  owner?: string;
  dueAt?: string;
  waitingOn?: string;
  sourceType?: string;
  sourceId?: string;
  sourceDetail?: string;
}

export interface UpdateLoopInput {
  loopId: number;
  status?: LoopStatus;
  priority?: number;
  waitingOn?: string;
}

// ---------------------------------------------------------------------------
// Horizon 2: State Deltas
// ---------------------------------------------------------------------------

export interface RecordStateDeltaInput {
  scopeId: number;
  branchId?: number;
  deltaType: string;
  entityKey: string;
  summary?: string;
  oldValue?: string;
  newValue?: string;
  confidence?: number;
  sourceType?: string;
  sourceId?: string;
  sourceDetail?: string;
}

// ---------------------------------------------------------------------------
// Horizon 2: Capabilities
// ---------------------------------------------------------------------------

export type CapabilityStatus = "available" | "unavailable" | "degraded" | "unknown";

export interface UpsertCapabilityInput {
  scopeId: number;
  capabilityType: string;
  capabilityKey: string;
  displayName?: string;
  status?: CapabilityStatus;
  summary?: string;
  metadataJson?: string;
}

// ---------------------------------------------------------------------------
// Horizon 2: Invariants
// ---------------------------------------------------------------------------

export type InvariantSeverity = "info" | "warning" | "error" | "critical";
export type EnforcementMode = "advisory" | "warn" | "block";
export type InvariantStatus = "active" | "suspended" | "retired";

export interface UpsertInvariantInput {
  scopeId: number;
  invariantKey: string;
  category?: string;
  description: string;
  severity?: InvariantSeverity;
  enforcementMode?: EnforcementMode;
  status?: InvariantStatus;
  sourceType?: string;
  sourceId?: string;
  sourceDetail?: string;
}

// ---------------------------------------------------------------------------
// Source trust hierarchy
// ---------------------------------------------------------------------------

export const SOURCE_TRUST: Record<string, number> = {
  tool_result: 1.0,
  user_explicit: 0.9,
  recent_document: 0.7,
  old_document: 0.4,
  summary: 0.3,
  inferred: 0.2,
};

// ---------------------------------------------------------------------------
// Claim extraction result
// ---------------------------------------------------------------------------

export interface ClaimExtractionResult {
  claim: Omit<UpsertClaimInput, "scopeId">;
  evidence: Omit<AddClaimEvidenceInput, "claimId">;
}

// ---------------------------------------------------------------------------
// Horizon 3: Attempts
// ---------------------------------------------------------------------------

export type AttemptStatus = "success" | "failure" | "partial" | "timeout";

export interface RecordAttemptInput {
  scopeId: number;
  branchId?: number;
  toolName: string;
  inputSummary?: string;
  outputSummary?: string;
  status: AttemptStatus;
  durationMs?: number;
  errorText?: string;
}

// ---------------------------------------------------------------------------
// Horizon 3: Runbooks
// ---------------------------------------------------------------------------

export type RunbookStatus = "active" | "stale" | "under_review";

export interface UpsertRunbookInput {
  scopeId: number;
  runbookKey: string;
  toolName: string;
  pattern: string;
  description?: string;
  successCount?: number;
  failureCount?: number;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Horizon 3: Anti-Runbooks
// ---------------------------------------------------------------------------

export type AntiRunbookStatus = "active" | "stale" | "under_review";

export interface UpsertAntiRunbookInput {
  scopeId: number;
  antiRunbookKey: string;
  toolName: string;
  failurePattern: string;
  description?: string;
  failureCount?: number;
  confidence?: number;
}
