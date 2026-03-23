/**
 * RSMA Ontology — barrel export.
 *
 * Single import point for all ontology modules.
 * Usage: import { readMemoryObjects, understandMessage, reconcile } from "./ontology/index.js";
 */

// Types
export type {
  MemoryObject,
  MemoryKind,
  MemoryStatus,
  SourceKind,
  EventType,
  ExtractionMethod,
  InfluenceWeight,
  Provenance,
  ProvenanceLink,
  LinkPredicate,
  RelevanceSignals,
  RankingWeights,
  TaskMode,
} from "./types.js";

export {
  computeRelevance,
  TASK_MODE_WEIGHTS,
  SOURCE_TRUST,
  INFLUENCE_SCORES,
  CORRECTION_TRUST_BONUS,
  PROVISIONAL_CONFIDENCE_FACTOR,
} from "./types.js";

// Canonical keys
export { buildCanonicalKey, normalize, hashPrefix } from "./canonical.js";

// Reader
export type { MemoryReaderOptions } from "./reader.js";
export { readMemoryObjects, readMemoryObjectById, countMemoryObjects } from "./reader.js";

// Writer
export type { WriterResult } from "./writer.js";
export { understandMessage, understandToolResult } from "./writer.js";

// Truth Engine
export type {
  ReconcileResult,
  ReconcileAction,
  ReconcileStats,
  SupersessionAction,
  ConflictAction,
  InsertAction,
  EvidenceAction,
} from "./truth.js";
export { reconcile } from "./truth.js";

// Projector
export {
  insertProvenanceLink,
  getProvenanceLinksForSubject,
  getProvenanceLinksForObject,
  projectProvenance,
  recordSupersession,
  recordConflict,
  recordMention,
  recordEvidence,
  recordDerivation,
  recordResolution,
} from "./projector.js";

// Migration
export { migrateToProvenanceLinks, isMigrationNeeded } from "./migration.js";

// Semantic extraction (LLM-powered)
export type { CompleteFn, SemanticExtractorConfig } from "./semantic-extractor.js";
export { semanticExtract } from "./semantic-extractor.js";

// Signal detection
export type { SignalDetectionResult, TemporalSignal } from "./correction.js";
export {
  detectCorrection,
  detectUncertainty,
  detectPreference,
  detectTemporal,
  detectSignals,
} from "./correction.js";
