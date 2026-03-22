import { homedir } from "os";
import { join } from "path";

export type LcmConfig = {
  enabled: boolean;
  databasePath: string;
  contextThreshold: number;
  freshTailCount: number;
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  incrementalMaxDepth: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  largeFileTokenThreshold: number;
  /** Provider override for large-file text summarization. */
  largeFileSummaryProvider: string;
  /** Model override for large-file text summarization. */
  largeFileSummaryModel: string;
  /** Model override for conversation summarization. */
  summaryModel: string;
  /** Provider override for conversation summarization. */
  summaryProvider: string;
  autocompactDisabled: boolean;
  /** IANA timezone for timestamps in summaries (from TZ env or system default) */
  timezone: string;
  /** When true, retroactively delete HEARTBEAT_OK turn cycles from LCM storage. */
  pruneHeartbeatOk: boolean;
  // ── Relations / Evidence Graph ──────────────────────────────────────────
  /** Enable entity extraction and evidence graph. */
  relationsEnabled: boolean;
  /** Path to the evidence graph SQLite database. */
  relationsGraphDbPath: string;
  /** Minimum mention count before an entity is surfaced. */
  relationsMinMentions: number;
  /** Days after which an entity is considered stale. */
  relationsStaleDays: number;
  /** Enable awareness notes injected into system prompt. */
  relationsAwarenessEnabled: boolean;
  /** Max awareness notes per turn. */
  relationsAwarenessMaxNotes: number;
  /** Max tokens for awareness notes. */
  relationsAwarenessMaxTokens: number;
  /** Enable unseen-document surfacing fallback. */
  relationsAwarenessDocSurfacing: boolean;
  // ── Horizon 2: Claims & Evidence ───────────────────────────────────────
  /** Enable claim extraction from tool results and compacted messages. */
  relationsClaimExtractionEnabled: boolean;
  /** Enable claim extraction from user-explicit statements (Remember:, Note:, etc). */
  relationsUserClaimExtractionEnabled: boolean;
  /** Context compiler tier: lite (110 tokens), standard (190), premium (280). */
  relationsContextTier: string;
  // ── Horizon 3: Attempts & Durability ───────────────────────────────────
  /** Enable attempt tracking for tool outcomes. */
  relationsAttemptTrackingEnabled: boolean;
  /** Days before anti-runbook confidence decay (default 90). */
  relationsDecayIntervalDays: number;
  // ── Horizon 5: Deep Extraction ─────────────────────────────────────────
  /** Enable LLM-powered deep extraction (claims + relations from unstructured text). */
  relationsDeepExtractionEnabled: boolean;
  /** Model for deep extraction (falls back to summaryModel if empty). */
  relationsDeepExtractionModel: string;
  /** Provider for deep extraction (falls back to summaryProvider if empty). */
  relationsDeepExtractionProvider: string;
};

/** Safely coerce an unknown value to a finite number, or return undefined. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Safely coerce an unknown value to a boolean, or return undefined. */
function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Safely coerce an unknown value to a trimmed non-empty string, or return undefined. */
function toStr(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/** Clamp an integer value to [min, max], returning fallback if undefined/NaN. */
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Clamp a float value to [min, max], returning fallback if undefined/NaN. */
function clampFloat(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * Resolve configuration with three-tier precedence:
 *   1. Environment variables (CLAWCORE_MEMORY_* primary, LCM_* fallback)
 *   2. Plugin config object (from plugins.entries.clawcore-memory.config)
 *   3. Hardcoded defaults (lowest)
 */
export function resolveLcmConfig(
  env: NodeJS.ProcessEnv = process.env,
  pluginConfig?: Record<string, unknown>,
): LcmConfig {
  const pc = pluginConfig ?? {};

  // Helper: read CLAWCORE_MEMORY_* first, fall back to LCM_* for upstream compat
  const e = (suffix: string) => env[`CLAWCORE_MEMORY_${suffix}`] ?? env[`LCM_${suffix}`];

  return {
    enabled:
      e("ENABLED") !== undefined
        ? e("ENABLED") !== "false"
        : toBool(pc.enabled) ?? true,
    databasePath:
      e("DATABASE_PATH")
      ?? toStr(pc.dbPath)
      ?? toStr(pc.databasePath)
      ?? join(homedir(), ".clawcore", "data", "memory.db"),
    contextThreshold: clampFloat(
      (e("CONTEXT_THRESHOLD") !== undefined ? parseFloat(e("CONTEXT_THRESHOLD")!) : undefined)
        ?? toNumber(pc.contextThreshold),
      0, 1, 0.75,
    ),
    freshTailCount: clampInt(
      (e("FRESH_TAIL_COUNT") !== undefined ? parseInt(e("FRESH_TAIL_COUNT")!, 10) : undefined)
        ?? toNumber(pc.freshTailCount),
      1, 1000, 32,
    ),
    leafMinFanout: clampInt(
      (e("LEAF_MIN_FANOUT") !== undefined ? parseInt(e("LEAF_MIN_FANOUT")!, 10) : undefined)
        ?? toNumber(pc.leafMinFanout),
      1, 100, 8,
    ),
    condensedMinFanout: clampInt(
      (e("CONDENSED_MIN_FANOUT") !== undefined ? parseInt(e("CONDENSED_MIN_FANOUT")!, 10) : undefined)
        ?? toNumber(pc.condensedMinFanout),
      1, 100, 4,
    ),
    condensedMinFanoutHard: clampInt(
      (e("CONDENSED_MIN_FANOUT_HARD") !== undefined ? parseInt(e("CONDENSED_MIN_FANOUT_HARD")!, 10) : undefined)
        ?? toNumber(pc.condensedMinFanoutHard),
      1, 100, 2,
    ),
    incrementalMaxDepth: clampInt(
      (e("INCREMENTAL_MAX_DEPTH") !== undefined ? parseInt(e("INCREMENTAL_MAX_DEPTH")!, 10) : undefined)
        ?? toNumber(pc.incrementalMaxDepth),
      -1, 100, -1, // -1 = unlimited depth
    ),
    leafChunkTokens: clampInt(
      (e("LEAF_CHUNK_TOKENS") !== undefined ? parseInt(e("LEAF_CHUNK_TOKENS")!, 10) : undefined)
        ?? toNumber(pc.leafChunkTokens),
      100, 200000, 20000,
    ),
    leafTargetTokens: clampInt(
      (e("LEAF_TARGET_TOKENS") !== undefined ? parseInt(e("LEAF_TARGET_TOKENS")!, 10) : undefined)
        ?? toNumber(pc.leafTargetTokens),
      100, 50000, 1200,
    ),
    condensedTargetTokens: clampInt(
      (e("CONDENSED_TARGET_TOKENS") !== undefined ? parseInt(e("CONDENSED_TARGET_TOKENS")!, 10) : undefined)
        ?? toNumber(pc.condensedTargetTokens),
      100, 50000, 2000,
    ),
    maxExpandTokens: clampInt(
      (e("MAX_EXPAND_TOKENS") !== undefined ? parseInt(e("MAX_EXPAND_TOKENS")!, 10) : undefined)
        ?? toNumber(pc.maxExpandTokens),
      100, 200000, 4000,
    ),
    largeFileTokenThreshold: clampInt(
      (e("LARGE_FILE_TOKEN_THRESHOLD") !== undefined ? parseInt(e("LARGE_FILE_TOKEN_THRESHOLD")!, 10) : undefined)
        ?? toNumber(pc.largeFileThresholdTokens)
        ?? toNumber(pc.largeFileTokenThreshold),
      100, 1000000, 25000,
    ),
    largeFileSummaryProvider:
      e("LARGE_FILE_SUMMARY_PROVIDER")?.trim() ?? toStr(pc.largeFileSummaryProvider) ?? "",
    largeFileSummaryModel:
      e("LARGE_FILE_SUMMARY_MODEL")?.trim() ?? toStr(pc.largeFileSummaryModel) ?? "",
    summaryModel:
      e("SUMMARY_MODEL")?.trim() ?? toStr(pc.summaryModel) ?? "",
    summaryProvider:
      e("SUMMARY_PROVIDER")?.trim() ?? toStr(pc.summaryProvider) ?? "",
    autocompactDisabled:
      e("AUTOCOMPACT_DISABLED") !== undefined
        ? e("AUTOCOMPACT_DISABLED") === "true"
        : toBool(pc.autocompactDisabled) ?? false,
    timezone: env.TZ ?? toStr(pc.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    pruneHeartbeatOk:
      e("PRUNE_HEARTBEAT_OK") !== undefined
        ? e("PRUNE_HEARTBEAT_OK") === "true"
        : toBool(pc.pruneHeartbeatOk) ?? false,
    // ── Relations / Evidence Graph ────────────────────────────────────────
    relationsEnabled:
      e("RELATIONS_ENABLED") !== undefined
        ? e("RELATIONS_ENABLED") === "true"
        : toBool(pc.relationsEnabled) ?? false,
    relationsGraphDbPath:
      e("RELATIONS_GRAPH_DB_PATH")?.trim()
      ?? toStr(pc.relationsGraphDbPath)
      ?? join(homedir(), ".clawcore", "data", "graph.db"),
    relationsMinMentions:
      (e("RELATIONS_MIN_MENTIONS") !== undefined ? parseInt(e("RELATIONS_MIN_MENTIONS")!, 10) : undefined)
        ?? toNumber(pc.relationsMinMentions) ?? 2,
    relationsStaleDays:
      (e("RELATIONS_STALE_DAYS") !== undefined ? parseInt(e("RELATIONS_STALE_DAYS")!, 10) : undefined)
        ?? toNumber(pc.relationsStaleDays) ?? 30,
    relationsAwarenessEnabled:
      e("RELATIONS_AWARENESS_ENABLED") !== undefined
        ? e("RELATIONS_AWARENESS_ENABLED") === "true"
        : toBool(pc.relationsAwarenessEnabled) ?? false,
    relationsAwarenessMaxNotes:
      (e("RELATIONS_AWARENESS_MAX_NOTES") !== undefined ? parseInt(e("RELATIONS_AWARENESS_MAX_NOTES")!, 10) : undefined)
        ?? toNumber(pc.relationsAwarenessMaxNotes) ?? 3,
    relationsAwarenessMaxTokens:
      (e("RELATIONS_AWARENESS_MAX_TOKENS") !== undefined ? parseInt(e("RELATIONS_AWARENESS_MAX_TOKENS")!, 10) : undefined)
        ?? toNumber(pc.relationsAwarenessMaxTokens) ?? 100,
    relationsAwarenessDocSurfacing:
      e("RELATIONS_AWARENESS_DOC_SURFACING") !== undefined
        ? e("RELATIONS_AWARENESS_DOC_SURFACING") === "true"
        : toBool(pc.relationsAwarenessDocSurfacing) ?? false,
    // ── Horizon 2: Claims & Evidence ──────────────────────────────────────
    relationsClaimExtractionEnabled:
      e("RELATIONS_CLAIM_EXTRACTION_ENABLED") !== undefined
        ? e("RELATIONS_CLAIM_EXTRACTION_ENABLED") === "true"
        : toBool(pc.relationsClaimExtractionEnabled) ?? false,
    relationsUserClaimExtractionEnabled:
      e("RELATIONS_USER_CLAIM_EXTRACTION_ENABLED") !== undefined
        ? e("RELATIONS_USER_CLAIM_EXTRACTION_ENABLED") === "true"
        : toBool(pc.relationsUserClaimExtractionEnabled) ?? false,
    relationsContextTier:
      e("RELATIONS_CONTEXT_TIER")?.trim()
      ?? toStr(pc.relationsContextTier)
      ?? "standard",
    // ── Horizon 3: Attempts & Durability ──────────────────────────────────
    relationsAttemptTrackingEnabled:
      e("RELATIONS_ATTEMPT_TRACKING_ENABLED") !== undefined
        ? e("RELATIONS_ATTEMPT_TRACKING_ENABLED") === "true"
        : toBool(pc.relationsAttemptTrackingEnabled) ?? false,
    relationsDecayIntervalDays:
      (e("RELATIONS_DECAY_INTERVAL_DAYS") !== undefined ? parseInt(e("RELATIONS_DECAY_INTERVAL_DAYS")!, 10) : undefined)
        ?? toNumber(pc.relationsDecayIntervalDays) ?? 90,
    // ── Horizon 5: Deep Extraction ────────────────────────────────────────
    relationsDeepExtractionEnabled:
      e("RELATIONS_DEEP_EXTRACTION_ENABLED") !== undefined
        ? e("RELATIONS_DEEP_EXTRACTION_ENABLED") === "true"
        : toBool(pc.relationsDeepExtractionEnabled) ?? false,
    relationsDeepExtractionModel:
      e("RELATIONS_DEEP_EXTRACTION_MODEL")?.trim()
      ?? toStr(pc.relationsDeepExtractionModel)
      ?? "",
    relationsDeepExtractionProvider:
      e("RELATIONS_DEEP_EXTRACTION_PROVIDER")?.trim()
      ?? toStr(pc.relationsDeepExtractionProvider)
      ?? "",
  };
}
