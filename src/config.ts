import { config as loadEnv, parse } from "dotenv";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { readFileSync, watchFile, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const envPath = resolve(rootDir, ".env");

loadEnv({ path: envPath, quiet: true });

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

// ── Hot-reloadable settings (feature flags + thresholds) ──

const hotConfig = {
  // Reranker tuning
  rerankScoreThreshold: envFloat("RERANK_SCORE_THRESHOLD", 0.0),
  rerankDisabled: envBool("RERANK_DISABLED", false),
  rerankTopK: envInt("RERANK_TOP_K", 20),
  rerankSmartSkip: envBool("RERANK_SMART_SKIP", true),
  // Embedding tuning
  similarityThreshold: envFloat("EMBEDDING_SIMILARITY_THRESHOLD", 1.05),
  prefixMode: env("EMBEDDING_PREFIX_MODE", "auto") as "auto" | "always" | "never",
  batchSize: envInt("EMBEDDING_BATCH_SIZE", 32),
  // Feature flags
  audioTranscriptionEnabled: envBool("AUDIO_TRANSCRIPTION_ENABLED", false),
  whisperModel: env("WHISPER_MODEL", "base"),
  relationsEnabled: envBool("CLAWCORE_RELATIONS_ENABLED", false),
  queryExpansionEnabled: envBool("QUERY_EXPANSION_ENABLED", false),
};

/** Re-read hot-reloadable settings from .env without restarting. */
function reloadHotConfig(): void {
  try {
    if (!existsSync(envPath)) return;
    const raw = readFileSync(envPath, "utf-8");
    const parsed = parse(raw);
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

    hotConfig.rerankScoreThreshold = getFloat("RERANK_SCORE_THRESHOLD", 0.0);
    hotConfig.rerankDisabled = getBool("RERANK_DISABLED", false);
    hotConfig.rerankTopK = getInt("RERANK_TOP_K", 20);
    hotConfig.rerankSmartSkip = getBool("RERANK_SMART_SKIP", true);
    hotConfig.similarityThreshold = getFloat("EMBEDDING_SIMILARITY_THRESHOLD", 1.05);
    hotConfig.prefixMode = get("EMBEDDING_PREFIX_MODE", "auto") as "auto" | "always" | "never";
    hotConfig.batchSize = getInt("EMBEDDING_BATCH_SIZE", 32);
    hotConfig.audioTranscriptionEnabled = getBool("AUDIO_TRANSCRIPTION_ENABLED", false);
    hotConfig.whisperModel = get("WHISPER_MODEL", "base");
    hotConfig.relationsEnabled = getBool("CLAWCORE_RELATIONS_ENABLED", false);
    hotConfig.queryExpansionEnabled = getBool("QUERY_EXPANSION_ENABLED", false);
  } catch {
    // Non-fatal — keep existing values
  }
}

// Watch .env for changes — reload hot config automatically (debounced to avoid mid-write reads)
let hotReloadTimer: ReturnType<typeof setTimeout> | null = null;
if (existsSync(envPath)) {
  watchFile(envPath, { interval: 3000 }, () => {
    if (hotReloadTimer) clearTimeout(hotReloadTimer);
    hotReloadTimer = setTimeout(() => reloadHotConfig(), 500);
  });
}

// ── Main config (frozen at startup for model/port/path settings) ──

export const config = {
  port: envInt("CLAWCORE_PORT", 18800),
  dataDir: resolve(env("CLAWCORE_DATA_DIR", resolve(homedir(), ".clawcore", "data"))),
  rootDir,

  embedding: {
    url: env("EMBEDDING_URL", "http://127.0.0.1:8012/v1"),
    model: env("EMBEDDING_MODEL", "BAAI/bge-large-en-v1.5"),
    dimensions: envInt("EMBEDDING_DIMENSIONS", 1024),
    get prefixMode() { return hotConfig.prefixMode; },
    get batchSize() { return hotConfig.batchSize; },
    get similarityThreshold() { return hotConfig.similarityThreshold; },
  },

  reranker: {
    url: env("RERANKER_URL", "http://127.0.0.1:8012"),
    get scoreThreshold() { return hotConfig.rerankScoreThreshold; },
    get disabled() { return hotConfig.rerankDisabled; },
    get topK() { return hotConfig.rerankTopK; },
    get smartSkip() { return hotConfig.rerankSmartSkip; },
  },

  queryExpansion: {
    get enabled() { return hotConfig.queryExpansionEnabled; },
    url: env("QUERY_EXPANSION_URL", "http://127.0.0.1:1234/v1"),
    model: env("QUERY_EXPANSION_MODEL", ""),
  },

  watch: {
    paths: env("WATCH_PATHS", ""),
    debounceMs: envInt("WATCH_DEBOUNCE_MS", 3000),
  },

  defaults: {
    collection: env("DEFAULT_COLLECTION", "default"),
    chunkMinTokens: envInt("CHUNK_MIN_TOKENS", 100),
    chunkMaxTokens: envInt("CHUNK_MAX_TOKENS", 1024),
    chunkTargetTokens: envInt("CHUNK_TARGET_TOKENS", 512),
    queryTopK: envInt("QUERY_TOP_K", 10),
    queryTokenBudget: envInt("QUERY_TOKEN_BUDGET", 4000),
  },

  relations: {
    get enabled() { return hotConfig.relationsEnabled; },
    graphDbPath: env(
      "CLAWCORE_RELATIONS_GRAPH_DB_PATH",
      env("CLAWCORE_MEMORY_RELATIONS_GRAPH_DB_PATH",
        resolve(homedir(), ".clawcore", "data", "graph.db")),
    ),
  },

  audio: {
    get enabled() { return hotConfig.audioTranscriptionEnabled; },
    get whisperModel() { return hotConfig.whisperModel; },
  },
};

export type Config = typeof config;
