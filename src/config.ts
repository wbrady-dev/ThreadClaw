import { resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { watchFile, unwatchFile, existsSync } from "fs";
import { readEnvMap, type EnvMap } from "./tui/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const envPath = resolve(rootDir, ".env");

// Populate process.env from .env (same behavior as dotenv: don't overwrite existing)
const startupEnv = readEnvMap(rootDir);
for (const [k, v] of Object.entries(startupEnv)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === "true" || v === "1";
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

// ── Hot-reloadable settings (feature flags + thresholds) ──

const hotConfig = {
  // Reranker tuning
  // Raw-logit cross-encoders (e.g. bge-reranker-large) commonly produce negative scores
  // for relevant documents, so the floor must be well below zero to avoid false filtering.
  rerankScoreThreshold: clamp(-100, 100, envFloat("RERANK_SCORE_THRESHOLD", -10.0)),
  rerankDisabled: envBool("RERANK_DISABLED", false),
  rerankTopK: clamp(1, 200, envInt("RERANK_TOP_K", 20)),
  rerankSmartSkip: envBool("RERANK_SMART_SKIP", true),
  // Embedding tuning
  // 1.05 is intentionally above max cosine similarity (1.0) to effectively disable
  // similarity-based pre-filtering. The reranker handles relevance filtering instead.
  similarityThreshold: envFloat("EMBEDDING_SIMILARITY_THRESHOLD", 1.05),
  prefixMode: (() => {
    const mode = env("EMBEDDING_PREFIX_MODE", "auto");
    return (["auto", "always", "never"] as const).includes(mode as any) ? mode as "auto" | "always" | "never" : "auto";
  })(),
  batchSize: clamp(1, 1000, envInt("EMBEDDING_BATCH_SIZE", 32)),
  // Feature flags
  audioTranscriptionEnabled: envBool("AUDIO_TRANSCRIPTION_ENABLED", false),
  whisperModel: env("WHISPER_MODEL", "base"),
  relationsEnabled: envBool("THREADCLAW_RELATIONS_ENABLED", false),
  queryExpansionEnabled: envBool("QUERY_EXPANSION_ENABLED", false),
};

/**
 * Re-read hot-reloadable settings from .env without restarting.
 * Note: duplicates some env parsing logic from the top-level config init.
 * This is intentional — the hot-reload path re-parses the .env file directly
 * rather than going through process.env, to pick up changes immediately.
 */
function reloadHotConfig(): void {
  try {
    if (!existsSync(envPath)) return;
    const parsed = readEnvMap(rootDir);
    const get = (key: string, fallback: string): string =>
      parsed[key]?.trim() ?? fallback;
    const getBool = (key: string, fallback: boolean): boolean => {
      const v = get(key, String(fallback));
      return v === "true" || v === "1";
    };

    const getFloat = (key: string, fallback: number): number => {
      const n = parseFloat(get(key, String(fallback)));
      return Number.isFinite(n) ? n : fallback;
    };
    const getInt = (key: string, fallback: number): number => {
      const n = parseInt(get(key, String(fallback)), 10);
      return Number.isFinite(n) ? n : fallback;
    };

    hotConfig.rerankScoreThreshold = clamp(-100, 100, getFloat("RERANK_SCORE_THRESHOLD", -10.0));
    hotConfig.rerankDisabled = getBool("RERANK_DISABLED", false);
    hotConfig.rerankTopK = clamp(1, 200, getInt("RERANK_TOP_K", 20));
    hotConfig.rerankSmartSkip = getBool("RERANK_SMART_SKIP", true);
    hotConfig.similarityThreshold = getFloat("EMBEDDING_SIMILARITY_THRESHOLD", 1.05);
    const prefixRaw = get("EMBEDDING_PREFIX_MODE", "auto");
    hotConfig.prefixMode = (["auto", "always", "never"] as const).includes(prefixRaw as any)
      ? prefixRaw as "auto" | "always" | "never"
      : "auto";
    hotConfig.batchSize = clamp(1, 1000, getInt("EMBEDDING_BATCH_SIZE", 32));
    hotConfig.audioTranscriptionEnabled = getBool("AUDIO_TRANSCRIPTION_ENABLED", false);
    hotConfig.whisperModel = get("WHISPER_MODEL", "base");
    hotConfig.relationsEnabled = getBool("THREADCLAW_RELATIONS_ENABLED", false);
    hotConfig.queryExpansionEnabled = getBool("QUERY_EXPANSION_ENABLED", false);

    // Sync ONLY hot-reloadable keys back to process.env — never overwrite ports, paths, API keys, etc.
    const HOT_RELOAD_KEYS = new Set([
      "RERANK_SCORE_THRESHOLD", "RERANK_DISABLED", "RERANK_TOP_K", "RERANK_SMART_SKIP",
      "EMBEDDING_SIMILARITY_THRESHOLD", "EMBEDDING_PREFIX_MODE", "EMBEDDING_BATCH_SIZE",
      "AUDIO_TRANSCRIPTION_ENABLED", "WHISPER_MODEL",
      "THREADCLAW_RELATIONS_ENABLED", "THREADCLAW_MEMORY_RELATIONS_ENABLED",
      "QUERY_EXPANSION_ENABLED",
    ]);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined && HOT_RELOAD_KEYS.has(key)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Non-fatal — keep existing values
  }
}

// Watch .env for changes — reload hot config automatically (debounced to avoid mid-write reads).
// Uses fs.watchFile (polling at 3s) instead of fs.watch because fs.watch is unreliable on
// network drives and some Windows setups. The 3s poll interval is a good tradeoff.
let hotReloadTimer: ReturnType<typeof setTimeout> | null = null;
let _envWatchActive = false;
if (existsSync(envPath)) {
  watchFile(envPath, { interval: 3000 }, () => {
    if (hotReloadTimer) clearTimeout(hotReloadTimer);
    hotReloadTimer = setTimeout(() => reloadHotConfig(), 500);
  });
  _envWatchActive = true;
}

/** Stop watching .env — call on shutdown to release the file handle. */
export function cleanupConfigWatcher(): void {
  if (_envWatchActive) {
    unwatchFile(envPath);
    _envWatchActive = false;
  }
  if (hotReloadTimer) {
    clearTimeout(hotReloadTimer);
    hotReloadTimer = null;
  }
}

// ── Main config (frozen at startup for model/port/path settings) ──

// API key warning is deferred to server startup (warnIfNoApiKey) to avoid
// flashing in the TUI when config.ts is imported by CLI commands.
export function warnIfNoApiKey(): void {
  if (!process.env.THREADCLAW_API_KEY) {
    console.warn("[threadclaw] THREADCLAW_API_KEY is not set — API endpoints are unauthenticated");
  }
}

export const config = {
  port: envInt("THREADCLAW_PORT", 18800),
  host: env("THREADCLAW_HOST", "127.0.0.1"),
  apiKey: env("THREADCLAW_API_KEY", ""),
  dataDir: resolve(env("THREADCLAW_DATA_DIR", resolve(homedir(), ".threadclaw", "data"))),
  rootDir,

  embedding: {
    url: env("EMBEDDING_URL", "http://127.0.0.1:8012/v1"),
    model: env("EMBEDDING_MODEL", "mixedbread-ai/mxbai-embed-large-v1"),
    dimensions: envInt("EMBEDDING_DIMENSIONS", 1024),
    get prefixMode() { return hotConfig.prefixMode; },
    get batchSize() { return hotConfig.batchSize; },
    get similarityThreshold() { return hotConfig.similarityThreshold; },
  },

  reranker: {
    url: env("RERANKER_URL", "http://127.0.0.1:8012"),
    model: env("RERANKER_MODEL", ""),
    timeoutMs: envInt("RERANK_TIMEOUT_MS", 30_000),
    get scoreThreshold() { return hotConfig.rerankScoreThreshold; },
    get disabled() { return hotConfig.rerankDisabled; },
    get topK() { return hotConfig.rerankTopK; },
    get smartSkip() { return hotConfig.rerankSmartSkip; },
  },

  queryExpansion: {
    get enabled() { return hotConfig.queryExpansionEnabled; },
    url: env("QUERY_EXPANSION_URL", "http://127.0.0.1:1234/v1"),
    model: env("QUERY_EXPANSION_MODEL", ""),
    apiKey: env("QUERY_EXPANSION_API_KEY", ""),
    temperature: envFloat("QUERY_EXPANSION_TEMPERATURE", 0.3),
    maxTokens: envInt("QUERY_EXPANSION_MAX_TOKENS", 512),
    timeoutMs: envInt("QUERY_EXPANSION_TIMEOUT_MS", 15000),
  },

  // ── Query Pipeline ──
  query: {
    cacheMaxEntries: envInt("QUERY_CACHE_MAX_ENTRIES", 50),
    cacheTtlMs: envInt("QUERY_CACHE_TTL_MS", 300000),
    hybridRrfK: envInt("HYBRID_RRF_K", 60),
    hybridVectorWeight: envFloat("HYBRID_VECTOR_WEIGHT", 1.0),
    hybridBm25Weight: envFloat("HYBRID_BM25_WEIGHT", 1.0),
    maxLength: envInt("QUERY_MAX_LENGTH", 2000),
    retrieveMultiplier: envInt("QUERY_RETRIEVE_MULTIPLIER", 2),
    vectorOverRetrieveFactor: envInt("QUERY_VECTOR_OVER_RETRIEVE_FACTOR", 3),
    lowConfidenceThreshold: envFloat("QUERY_LOW_CONFIDENCE_THRESHOLD", 0.3),
  },

  // ── Extraction Pipeline ──
  extraction: {
    ingestMaxFileSizeMb: envInt("INGEST_MAX_FILE_SIZE_MB", 100),
    dedupSimilarityThreshold: envFloat("DEDUP_SIMILARITY_THRESHOLD", 0.95),
    dedupMaxPairwise: envInt("DEDUP_MAX_PAIRWISE", 500),
    chunkOverlapRatio: envFloat("CHUNK_OVERLAP_RATIO", 0.2),
    chunkTableRows: envInt("CHUNK_TABLE_ROWS", 20),
    embeddingMaxConcurrent: envInt("EMBEDDING_MAX_CONCURRENT", 2),
    embeddingMaxRetries: envInt("EMBEDDING_MAX_RETRIES", 3),
    embeddingTimeoutMs: envInt("EMBEDDING_TIMEOUT_MS", 30000),
    embeddingCircuitCooldownMs: envInt("EMBEDDING_CIRCUIT_COOLDOWN_MS", 30000),
    embeddingCacheMax: envInt("EMBEDDING_CACHE_MAX", 200),
    ocrLanguage: env("OCR_LANGUAGE", "eng"),
    ocrTimeoutMs: envInt("OCR_TIMEOUT_MS", 30000),
    doclingTimeoutMs: envInt("DOCLING_TIMEOUT_MS", 120000),
  },

  watch: {
    paths: env("WATCH_PATHS", ""),
    debounceMs: envInt("WATCH_DEBOUNCE_MS", 3000),
    excludePatterns: env("WATCH_EXCLUDE_PATTERNS", ""),
    maxConcurrent: envInt("WATCH_MAX_CONCURRENT", 5),
    maxQueue: envInt("WATCH_MAX_QUEUE", 1000),
  },

  defaults: {
    collection: env("DEFAULT_COLLECTION", "default"),
    chunkMinTokens: envInt("CHUNK_MIN_TOKENS", 100),
    chunkMaxTokens: envInt("CHUNK_MAX_TOKENS", 1024),
    chunkTargetTokens: envInt("CHUNK_TARGET_TOKENS", 512),
    queryTopK: clamp(1, 500, envInt("QUERY_TOP_K", 10)),
    queryTokenBudget: clamp(100, 100000, envInt("QUERY_TOKEN_BUDGET", 4000)),
  },

  relations: {
    get enabled() { return hotConfig.relationsEnabled; },
    graphDbPath: env(
      "THREADCLAW_RELATIONS_GRAPH_DB_PATH",
      env("THREADCLAW_MEMORY_RELATIONS_GRAPH_DB_PATH",
        resolve(env("THREADCLAW_DATA_DIR", resolve(homedir(), ".threadclaw", "data")), "threadclaw.db")),
    ),
  },

  synthesis: {
    model: env("SYNTHESIS_MODEL", ""),
    url: env("SYNTHESIS_LLM_URL", ""),
    maxTokens: envInt("SYNTHESIS_MAX_TOKENS", 500),
    timeoutMs: envInt("SYNTHESIS_TIMEOUT_MS", 30000),
  },

  web: {
    urls: env("WEB_URLS", ""),
    pollInterval: envInt("WEB_POLL_INTERVAL", 3600),
  },

  brief: {
    maxPerSource: envInt("BRIEF_MAX_PER_SOURCE", 3),
    relevanceWeight: envFloat("BRIEF_RELEVANCE_WEIGHT", 0.7),
    termMatchWeight: envFloat("BRIEF_TERM_MATCH_WEIGHT", 0.3),
  },

  audio: {
    get enabled() { return hotConfig.audioTranscriptionEnabled; },
    get whisperModel() { return hotConfig.whisperModel; },
  },
};

export type Config = typeof config;
