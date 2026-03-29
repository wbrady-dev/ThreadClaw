// Relations / Evidence Graph module — public API

export type {
  GraphDb,
  GraphDbStatement,
  ExtractionResult,
  ExtractionStrategy,
  EvidenceEvent,
  UpsertEntityInput,
  InsertMentionInput,
  StoreExtractionInput,
} from "./types.js";

export { runGraphMigrations } from "./schema.js";

export {
  withWriteTransaction,
  writeWithIdempotency,
  isIdempotencyConflict,
  nextScopeSeq,
  logEvidence,
} from "./evidence-log.js";

export { extractFast } from "./entity-extract.js";

export { loadTerms } from "./terms.js";

export {
  upsertEntity,
  insertMention,
  deleteGraphDataForSource,
  storeExtractionResult,
  reExtractGraphForDocument,
} from "./graph-store.js";

export { effectiveConfidence } from "./confidence.js";

export { getGraphConnection } from "./graph-connection.js";

export {
  buildAwarenessNote,
  extractTextFromAgentMessage,
  resetEntityCacheForTests,
  type AwarenessConfig,
} from "./awareness.js";

export {
  recordAwarenessEvent,
  getAwarenessStats,
  resetAwarenessEventsForTests,
  type AwarenessEvent,
  type AwarenessStats,
} from "./eval.js";

export {
  createCcClaimsTool, createCcDecisionsTool,
  createCcLoopsTool, createCcManageLoopTool, createCcAttemptsTool,
  createCcBranchTool, createCcProceduresTool,
  createCcDiagnosticsTool, createCcMemoryTool,
  createCcStateTool, createCcConflictsTool,
} from "./tools.js";

export { compileContextCapsules, type ContextCompilerConfig, type CompilerResult } from "./context-compiler.js";

// Horizon 2: Stores
export {
  upsertClaim, addClaimEvidence, supersedeClaim,
  getActiveClaims, getClaimsWithEvidence, buildCanonicalKey,
  storeClaimExtractionResults,
} from "./claim-store.js";
export {
  upsertDecision, supersedeDecision,
  getActiveDecisions, getDecisionHistory,
} from "./decision-store.js";
export { openLoop, closeLoop, updateLoop, getOpenLoops } from "./loop-store.js";
export { recordStateDelta, getRecentDeltas } from "./delta-store.js";
export { upsertCapability, getCapabilities } from "./capability-store.js";
export { upsertInvariant, getActiveInvariants, getActiveStrictInvariants } from "./invariant-store.js";
export { checkStrictInvariants, resetInvariantCacheForTests, type InvariantViolation } from "./invariant-check.js";
export { extractClaimsFast, extractClaimsFromToolResult, extractClaimsFromUserExplicit } from "./claim-extract.js";

// Horizon 2: Types
export type {
  ClaimStatus, EvidenceRole, ValueType, UpsertClaimInput, UpsertClaimResult, AddClaimEvidenceInput,
  DecisionStatus, UpsertDecisionInput, UpsertDecisionResult,
  LoopStatus, LoopType, OpenLoopInput, UpdateLoopInput,
  RecordStateDeltaInput,
  CapabilityStatus, UpsertCapabilityInput,
  InvariantSeverity, EnforcementMode, InvariantStatus, UpsertInvariantInput,
  ClaimExtractionResult,
} from "./types.js";
export { SOURCE_TRUST } from "./types.js";

// Horizon 3: Stores
export { recordAttempt, getAttemptHistory, getToolSuccessRate } from "./attempt-store.js";
export { upsertRunbook, demoteRunbook, getRunbooks, getRunbooksForTool } from "./runbook-store.js";
export { upsertAntiRunbook, getAntiRunbooks, getAntiRunbooksForTool, addAntiRunbookEvidence, getAntiRunbookEvidence } from "./anti-runbook-store.js";
export { applyDecay, decayAntiRunbooks, decayRunbooks, deduplicateActiveObjects } from "./decay.js";
export { runArchive, getArchiveStats, restoreFromArchive } from "./archive.js";

// Horizon 3: Types
export type {
  AttemptStatus, RecordAttemptInput,
  RunbookStatus, UpsertRunbookInput,
  AntiRunbookStatus, UpsertAntiRunbookInput,
} from "./types.js";

// Horizon 3: Leases & Promotion
export { acquireLease, renewLease, releaseLease, getActiveLeases, cleanExpiredLeases } from "./lease-store.js";
export { checkPromotionPolicy, createBranch, promoteBranch, discardBranch, getBranches } from "./promotion.js";

// Horizon 4: Procedural Memory
export { addRunbookEvidence, getRunbookWithEvidence, inferRunbookFromAttempts } from "./runbook-store.js";
export { getTimeline, formatTimelineEvent } from "./timeline.js";
export { getStateAtTime, getEvidenceAtTime } from "./snapshot.js";

// Horizon 5: Deep Extraction
export { upsertRelation, getRelationGraph, getRelationsForEntity } from "./relation-store.js";
export { extractClaimsDeep, extractRelationsDeep } from "./deep-extract.js";
export { synthesizeScope } from "./synthesis.js";
