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
  /**
   * Enable claim extraction from user-explicit statements (Remember:, Note:, etc).
   * NOTE: RSMA semantic extraction (relationsExtractionMode="smart") bypasses
   * this flag entirely. This only gates the LEGACY regex extraction pipeline.
   * When RSMA is active, all user messages go through the semantic extractor.
   */
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
  /**
   * Direct API key for the extraction model provider.
   * When set, ThreadClaw calls the provider API directly instead of going
   * through OpenClaw's OAuth. Keeps extraction isolated from agent tokens.
   * Supports: Anthropic, OpenAI, Google (Gemini).
   */
  relationsDeepExtractionApiKey: string;
  /** Base URL override for extraction model (e.g., Ollama at http://localhost:11434). */
  relationsDeepExtractionBaseUrl: string;
  // ── Engine Tuning ────────────────────────────────────────────────────
  /** Max compaction rounds per cycle (default 10). */
  maxRounds: number;
  /** NER circuit breaker reset interval in ms (default 30000). */
  nerCircuitResetMs: number;
  /** SQLite busy_timeout in ms for memory DB (default 5000). */
  busyTimeoutMs: number;
  /** SQLite busy_timeout in ms for graph DB (default 5000). */
  graphBusyTimeoutMs: number;
  // ── Decay Tuning ──────────────────────────────────────────────────────
  /** Anti-runbook tool-success decay multiplier (default 0.7). */
  relationsDecayToolSuccessMultiplier: number;
  /** Anti-runbook staleness decay multiplier (default 0.8). */
  relationsDecayStalenessMultiplier: number;
  /** Anti-runbook tool-success decay floor (default 0.3). */
  relationsDecayToolSuccessFloor: number;
  /** Anti-runbook staleness decay floor (default 0.2). */
  relationsDecayStalenessFloor: number;
  /** Days before runbook is marked stale (default 180). */
  relationsRunbookStaleDays: number;
  // ── Confidence Tuning ─────────────────────────────────────────────────
  /** Recency bracket boundary in days: full weight below this (default 7). */
  relationsRecencyFullDays: number;
  /** Recency bracket boundary in days: high weight below this (default 30). */
  relationsRecencyHighDays: number;
  /** Recency bracket boundary in days: medium weight below this (default 90). */
  relationsRecencyMediumDays: number;
  /** Recency weight for the high bracket (default 0.8). */
  relationsRecencyHighWeight: number;
  /** Recency weight for the medium bracket (default 0.5). */
  relationsRecencyMediumWeight: number;
  /** Recency weight for the stale bracket (default 0.3). */
  relationsRecencyStaleWeight: number;
  // ── Awareness Cache ───────────────────────────────────────────────────
  /** Max entities in awareness cache (default 5000). */
  relationsAwarenessCacheMaxSize: number;
  /** Awareness cache TTL in ms (default 30000). */
  relationsAwarenessCacheTtlMs: number;
  // ── Deep Extraction Limits ────────────────────────────────────────────
  /** Max input chars for deep extraction LLM call (default 4000). */
  relationsDeepExtractionMaxInputChars: number;
  /** Max tokens for deep extraction LLM response (default 1000). */
  relationsDeepExtractionMaxTokens: number;
  /** Max field length for extracted claims (default 500). */
  relationsDeepExtractionMaxFieldLength: number;
  /** Max items from a single extraction (default 50). */
  relationsDeepExtractionMaxItems: number;
  /** Default trust score for deep-extracted claims (default 0.6). */
  relationsDeepExtractionDefaultTrust: number;
  /** Default source authority for deep-extracted claims (default 0.6). */
  relationsDeepExtractionDefaultAuthority: number;
  // ── Context Compiler ──────────────────────────────────────────────────
  /** Auto-archive check interval in ms (default 3600000). */
  relationsAutoArchiveIntervalMs: number;
  /** Evidence log event threshold to trigger auto-archive (default 5000). */
  relationsAutoArchiveEventThreshold: number;
  // ── RSMA Extraction Mode ─────────────────────────────────────────────
  /**
   * Extraction mode: "smart" | "fast"
   * - "smart": LLM-based semantic extraction. Understands natural language
   *   without magic prefixes. Uses the same model as deep extraction. One LLM call.
   * - "fast": Regex-only extraction. No LLM calls. <5ms. Use when no model configured.
   * Default: "smart" if deep extraction is enabled, "fast" otherwise.
   */
  relationsExtractionMode: "smart" | "fast";
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
 *   1. Environment variables (THREADCLAW_MEMORY_* primary, LCM_* fallback)
 *   2. Plugin config object (from plugins.entries.threadclaw-memory.config)
 *   3. Hardcoded defaults (lowest)
 */
export function resolveLcmConfig(
  env: NodeJS.ProcessEnv = process.env,
  pluginConfig?: Record<string, unknown>,
): LcmConfig {
  const pc = pluginConfig ?? {};

  // Helper: read THREADCLAW_MEMORY_* first, fall back to LCM_* for upstream compat
  const e = (suffix: string) => env[`THREADCLAW_MEMORY_${suffix}`] ?? env[`LCM_${suffix}`];

  return {
    enabled:
      e("ENABLED") !== undefined
        ? e("ENABLED") !== "false"
        : toBool(pc.enabled) ?? true,
    databasePath:
      e("DATABASE_PATH")
      ?? toStr(pc.dbPath)
      ?? toStr(pc.databasePath)
      ?? join(homedir(), ".threadclaw", "data", "memory.db"),
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
      ?? join(homedir(), ".threadclaw", "data", "graph.db"),
    relationsMinMentions: clampInt(
      (e("RELATIONS_MIN_MENTIONS") !== undefined ? parseInt(e("RELATIONS_MIN_MENTIONS")!, 10) : undefined)
        ?? toNumber(pc.relationsMinMentions),
      1, 1000, 2,
    ),
    relationsStaleDays: clampInt(
      (e("RELATIONS_STALE_DAYS") !== undefined ? parseInt(e("RELATIONS_STALE_DAYS")!, 10) : undefined)
        ?? toNumber(pc.relationsStaleDays),
      1, 3650, 30,
    ),
    relationsAwarenessEnabled:
      e("RELATIONS_AWARENESS_ENABLED") !== undefined
        ? e("RELATIONS_AWARENESS_ENABLED") === "true"
        : toBool(pc.relationsAwarenessEnabled) ?? false,
    relationsAwarenessMaxNotes: clampInt(
      (e("RELATIONS_AWARENESS_MAX_NOTES") !== undefined ? parseInt(e("RELATIONS_AWARENESS_MAX_NOTES")!, 10) : undefined)
        ?? toNumber(pc.relationsAwarenessMaxNotes),
      1, 100, 3,
    ),
    relationsAwarenessMaxTokens: clampInt(
      (e("RELATIONS_AWARENESS_MAX_TOKENS") !== undefined ? parseInt(e("RELATIONS_AWARENESS_MAX_TOKENS")!, 10) : undefined)
        ?? toNumber(pc.relationsAwarenessMaxTokens),
      1, 10000, 100,
    ),
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
    relationsDecayIntervalDays: clampInt(
      (e("RELATIONS_DECAY_INTERVAL_DAYS") !== undefined ? parseInt(e("RELATIONS_DECAY_INTERVAL_DAYS")!, 10) : undefined)
        ?? toNumber(pc.relationsDecayIntervalDays),
      1, 3650, 90,
    ),
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
    relationsDeepExtractionApiKey:
      e("RELATIONS_DEEP_EXTRACTION_API_KEY")?.trim()
      ?? toStr(pc.relationsDeepExtractionApiKey)
      ?? "",
    relationsDeepExtractionBaseUrl:
      e("RELATIONS_DEEP_EXTRACTION_BASE_URL")?.trim()
      ?? toStr(pc.relationsDeepExtractionBaseUrl)
      ?? "",
    // ── Engine Tuning ─────────────────────────────────────────────────
    maxRounds: clampInt(
      (e("MAX_ROUNDS") !== undefined ? parseInt(e("MAX_ROUNDS")!, 10) : undefined)
        ?? toNumber(pc.maxRounds),
      1, 100, 10,
    ),
    nerCircuitResetMs: clampInt(
      (e("NER_CIRCUIT_RESET_MS") !== undefined ? parseInt(e("NER_CIRCUIT_RESET_MS")!, 10) : undefined)
        ?? toNumber(pc.nerCircuitResetMs),
      1000, 600_000, 30_000,
    ),
    busyTimeoutMs: clampInt(
      (e("BUSY_TIMEOUT_MS") !== undefined ? parseInt(e("BUSY_TIMEOUT_MS")!, 10) : undefined)
        ?? toNumber(pc.busyTimeoutMs),
      100, 60_000, 5000,
    ),
    graphBusyTimeoutMs: clampInt(
      (e("GRAPH_BUSY_TIMEOUT_MS") !== undefined ? parseInt(e("GRAPH_BUSY_TIMEOUT_MS")!, 10) : undefined)
        ?? toNumber(pc.graphBusyTimeoutMs),
      100, 60_000, 5000,
    ),
    // ── Decay Tuning ────────────────────────────────────────────────────
    relationsDecayToolSuccessMultiplier: clampFloat(
      (e("RELATIONS_DECAY_TOOL_SUCCESS_MULTIPLIER") !== undefined ? parseFloat(e("RELATIONS_DECAY_TOOL_SUCCESS_MULTIPLIER")!) : undefined)
        ?? toNumber(pc.relationsDecayToolSuccessMultiplier),
      0, 1, 0.7,
    ),
    relationsDecayStalenessMultiplier: clampFloat(
      (e("RELATIONS_DECAY_STALENESS_MULTIPLIER") !== undefined ? parseFloat(e("RELATIONS_DECAY_STALENESS_MULTIPLIER")!) : undefined)
        ?? toNumber(pc.relationsDecayStalenessMultiplier),
      0, 1, 0.8,
    ),
    relationsDecayToolSuccessFloor: clampFloat(
      (e("RELATIONS_DECAY_TOOL_SUCCESS_FLOOR") !== undefined ? parseFloat(e("RELATIONS_DECAY_TOOL_SUCCESS_FLOOR")!) : undefined)
        ?? toNumber(pc.relationsDecayToolSuccessFloor),
      0, 1, 0.3,
    ),
    relationsDecayStalenessFloor: clampFloat(
      (e("RELATIONS_DECAY_STALENESS_FLOOR") !== undefined ? parseFloat(e("RELATIONS_DECAY_STALENESS_FLOOR")!) : undefined)
        ?? toNumber(pc.relationsDecayStalenessFloor),
      0, 1, 0.2,
    ),
    relationsRunbookStaleDays: clampInt(
      (e("RELATIONS_RUNBOOK_STALE_DAYS") !== undefined ? parseInt(e("RELATIONS_RUNBOOK_STALE_DAYS")!, 10) : undefined)
        ?? toNumber(pc.relationsRunbookStaleDays),
      1, 3650, 180,
    ),
    // ── Confidence Tuning ───────────────────────────────────────────────
    relationsRecencyFullDays: clampInt(
      (e("RELATIONS_RECENCY_FULL_DAYS") !== undefined ? parseInt(e("RELATIONS_RECENCY_FULL_DAYS")!, 10) : undefined)
        ?? toNumber(pc.relationsRecencyFullDays),
      1, 365, 7,
    ),
    relationsRecencyHighDays: clampInt(
      (e("RELATIONS_RECENCY_HIGH_DAYS") !== undefined ? parseInt(e("RELATIONS_RECENCY_HIGH_DAYS")!, 10) : undefined)
        ?? toNumber(pc.relationsRecencyHighDays),
      1, 365, 30,
    ),
    relationsRecencyMediumDays: clampInt(
      (e("RELATIONS_RECENCY_MEDIUM_DAYS") !== undefined ? parseInt(e("RELATIONS_RECENCY_MEDIUM_DAYS")!, 10) : undefined)
        ?? toNumber(pc.relationsRecencyMediumDays),
      1, 3650, 90,
    ),
    relationsRecencyHighWeight: clampFloat(
      (e("RELATIONS_RECENCY_HIGH_WEIGHT") !== undefined ? parseFloat(e("RELATIONS_RECENCY_HIGH_WEIGHT")!) : undefined)
        ?? toNumber(pc.relationsRecencyHighWeight),
      0, 1, 0.8,
    ),
    relationsRecencyMediumWeight: clampFloat(
      (e("RELATIONS_RECENCY_MEDIUM_WEIGHT") !== undefined ? parseFloat(e("RELATIONS_RECENCY_MEDIUM_WEIGHT")!) : undefined)
        ?? toNumber(pc.relationsRecencyMediumWeight),
      0, 1, 0.5,
    ),
    relationsRecencyStaleWeight: clampFloat(
      (e("RELATIONS_RECENCY_STALE_WEIGHT") !== undefined ? parseFloat(e("RELATIONS_RECENCY_STALE_WEIGHT")!) : undefined)
        ?? toNumber(pc.relationsRecencyStaleWeight),
      0, 1, 0.3,
    ),
    // ── Awareness Cache ─────────────────────────────────────────────────
    relationsAwarenessCacheMaxSize: clampInt(
      (e("RELATIONS_AWARENESS_CACHE_MAX_SIZE") !== undefined ? parseInt(e("RELATIONS_AWARENESS_CACHE_MAX_SIZE")!, 10) : undefined)
        ?? toNumber(pc.relationsAwarenessCacheMaxSize),
      100, 100_000, 5000,
    ),
    relationsAwarenessCacheTtlMs: clampInt(
      (e("RELATIONS_AWARENESS_CACHE_TTL_MS") !== undefined ? parseInt(e("RELATIONS_AWARENESS_CACHE_TTL_MS")!, 10) : undefined)
        ?? toNumber(pc.relationsAwarenessCacheTtlMs),
      1000, 600_000, 30_000,
    ),
    // ── Deep Extraction Limits ──────────────────────────────────────────
    relationsDeepExtractionMaxInputChars: clampInt(
      (e("RELATIONS_DEEP_EXTRACTION_MAX_INPUT_CHARS") !== undefined ? parseInt(e("RELATIONS_DEEP_EXTRACTION_MAX_INPUT_CHARS")!, 10) : undefined)
        ?? toNumber(pc.relationsDeepExtractionMaxInputChars),
      100, 100_000, 4000,
    ),
    relationsDeepExtractionMaxTokens: clampInt(
      (e("RELATIONS_DEEP_EXTRACTION_MAX_TOKENS") !== undefined ? parseInt(e("RELATIONS_DEEP_EXTRACTION_MAX_TOKENS")!, 10) : undefined)
        ?? toNumber(pc.relationsDeepExtractionMaxTokens),
      100, 10_000, 1000,
    ),
    relationsDeepExtractionMaxFieldLength: clampInt(
      (e("RELATIONS_DEEP_EXTRACTION_MAX_FIELD_LENGTH") !== undefined ? parseInt(e("RELATIONS_DEEP_EXTRACTION_MAX_FIELD_LENGTH")!, 10) : undefined)
        ?? toNumber(pc.relationsDeepExtractionMaxFieldLength),
      10, 10_000, 500,
    ),
    relationsDeepExtractionMaxItems: clampInt(
      (e("RELATIONS_DEEP_EXTRACTION_MAX_ITEMS") !== undefined ? parseInt(e("RELATIONS_DEEP_EXTRACTION_MAX_ITEMS")!, 10) : undefined)
        ?? toNumber(pc.relationsDeepExtractionMaxItems),
      1, 500, 50,
    ),
    relationsDeepExtractionDefaultTrust: clampFloat(
      (e("RELATIONS_DEEP_EXTRACTION_DEFAULT_TRUST") !== undefined ? parseFloat(e("RELATIONS_DEEP_EXTRACTION_DEFAULT_TRUST")!) : undefined)
        ?? toNumber(pc.relationsDeepExtractionDefaultTrust),
      0, 1, 0.6,
    ),
    relationsDeepExtractionDefaultAuthority: clampFloat(
      (e("RELATIONS_DEEP_EXTRACTION_DEFAULT_AUTHORITY") !== undefined ? parseFloat(e("RELATIONS_DEEP_EXTRACTION_DEFAULT_AUTHORITY")!) : undefined)
        ?? toNumber(pc.relationsDeepExtractionDefaultAuthority),
      0, 1, 0.6,
    ),
    // ── Context Compiler ────────────────────────────────────────────────
    relationsAutoArchiveIntervalMs: clampInt(
      (e("RELATIONS_AUTO_ARCHIVE_INTERVAL_MS") !== undefined ? parseInt(e("RELATIONS_AUTO_ARCHIVE_INTERVAL_MS")!, 10) : undefined)
        ?? toNumber(pc.relationsAutoArchiveIntervalMs),
      60_000, 86_400_000, 3_600_000,
    ),
    relationsAutoArchiveEventThreshold: clampInt(
      (e("RELATIONS_AUTO_ARCHIVE_EVENT_THRESHOLD") !== undefined ? parseInt(e("RELATIONS_AUTO_ARCHIVE_EVENT_THRESHOLD")!, 10) : undefined)
        ?? toNumber(pc.relationsAutoArchiveEventThreshold),
      100, 1_000_000, 5000,
    ),
    // ── RSMA Extraction Mode ────────────────────────────────────────────
    // BUG 4 FIX: Derive default from whether deep extraction is enabled.
    // "smart" requires an LLM model; if deep extraction is disabled, default to "fast"
    // to avoid misleading behavior where "smart" silently falls back to regex anyway.
    relationsExtractionMode:
      (() => {
        const explicit = e("RELATIONS_EXTRACTION_MODE")?.trim() ?? toStr(pc.relationsExtractionMode);
        if (explicit) return explicit === "fast" ? "fast" : "smart";
        // No explicit mode set — derive from deep extraction config
        const deepEnabled = e("RELATIONS_DEEP_EXTRACTION_ENABLED") !== undefined
          ? e("RELATIONS_DEEP_EXTRACTION_ENABLED") === "true"
          : toBool(pc.relationsDeepExtractionEnabled) ?? false;
        return deepEnabled ? "smart" : "fast";
      })(),
  };
}
