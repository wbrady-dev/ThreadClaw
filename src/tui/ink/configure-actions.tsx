import ora from "ora";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { resolve } from "path";
import {
  CLOUD_EMBED_PROVIDERS,
  CLOUD_RERANK_PROVIDERS,
  EMBED_MODELS,
  RERANK_MODELS,
  type ModelInfo,
} from "../models.js";
import {
  findOpenClaw,
  getDataDir,
  getRootDir,
  getPlatform,
  getPythonCmd,
  readConfig,
  writeConfig,
} from "../platform.js";
import { ensureEnvFile, readEnvMap, updateEnvValues } from "../env.js";
import type { ConfigureAction } from "../screens/configure.js";
import { promptChecklist, promptConfirm, promptMenu, promptText } from "./prompts.js";
import { t, type MenuItem } from "./components.js";

interface FieldDef {
  key: string;
  label: string;
  fallback: string;
  message: string;
  description?: string;
  type: "number" | "string" | "url";
  requiresRestart?: boolean;
  mask?: string;
}

function validateField(value: string, type: FieldDef["type"]): string | null {
  if (type === "number") {
    if (isNaN(Number(value))) return "Value must be a number.";
  } else if (type === "url") {
    if (!/^https?:\/\//.test(value)) return "URL must start with http:// or https://";
  }
  return null;
}

const WHISPER_MODELS = [
  { label: "tiny (~40MB, fastest)", value: "tiny" },
  { label: "base (~150MB, recommended)", value: "base" },
  { label: "small (~500MB, better quality)", value: "small" },
  { label: "medium (~1.5GB, high quality)", value: "medium" },
  { label: "large (~3GB, best quality)", value: "large" },
];

const SEARCH_FIELDS: FieldDef[] = [
  { key: "RERANK_SCORE_THRESHOLD", label: "Rerank Threshold", fallback: "0.0", message: "Minimum rerank score to keep a result.", description: "Minimum reranker score to keep (default: 0.0)", type: "number" },
  { key: "RERANK_TOP_K", label: "Rerank Candidates", fallback: "20", message: "How many chunks go through the reranker.", description: "Candidates sent to reranker (default: 20)", type: "number" },
  { key: "RERANK_SMART_SKIP", label: "Smart Skip", fallback: "true", message: "Auto-skip reranking when vector results are decisive.", description: "Skip reranking when top result dominates (default: true)", type: "string" },
  { key: "RERANK_DISABLED", label: "Reranking Disabled", fallback: "false", message: "Set true to disable reranking entirely.", description: "Disable reranking entirely (default: false)", type: "string" },
  { key: "EMBEDDING_SIMILARITY_THRESHOLD", label: "Similarity Gate", fallback: "1.05", message: "Max L2 distance to consider a vector match.", description: "Max L2 distance for vector match (default: 1.05)", type: "number" },
  { key: "EMBEDDING_PREFIX_MODE", label: "Prefix Mode", fallback: "auto", message: "auto, always, or never for query:/passage: prefixes.", description: "Embedding prefix: auto, always, or never (default: auto)", type: "string" },
  { key: "EMBEDDING_BATCH_SIZE", label: "Embed Batch Size", fallback: "32", message: "Texts per embedding batch during ingestion.", description: "Batch size for bulk embedding (default: 32)", type: "number" },
];

const EMBEDDING_TUNING_FIELDS: FieldDef[] = [
  { key: "EMBEDDING_API_KEY", label: "Embedding API Key", fallback: "", message: "API key for cloud embedding provider", description: "API key for cloud embedding services (leave blank for local models)", type: "string", mask: "*" },
  { key: "EMBEDDING_MAX_RETRIES", label: "Max Retries", fallback: "3", message: "Retry count for failed embedding calls", description: "How many times to retry a failed embedding request before giving up (default: 3)", type: "number" },
  { key: "EMBEDDING_CIRCUIT_COOLDOWN_MS", label: "Circuit Cooldown", fallback: "30000", message: "Cooldown after embedding failures (ms)", description: "Wait time in ms after repeated failures before trying again (default: 30000)", type: "number" },
  { key: "EMBEDDING_CACHE_MAX", label: "Cache Max", fallback: "200", message: "Max cached query embeddings", description: "Number of recent query embeddings to keep in memory (default: 200)", type: "number" },
];

const WATCH_TUNING_FIELDS: FieldDef[] = [
  { key: "WATCH_EXCLUDE_PATTERNS", label: "Exclude Patterns", fallback: "", message: "Comma-separated glob patterns to exclude", description: "Glob patterns for files and folders to skip during watch (comma-separated)", type: "string" },
  { key: "WATCH_MAX_CONCURRENT", label: "Max Concurrent", fallback: "5", message: "Max concurrent file ingestions", description: "How many files can be ingested at the same time (default: 5)", type: "number" },
  { key: "WATCH_MAX_QUEUE", label: "Max Queue", fallback: "1000", message: "Max queued files before dropping", description: "Maximum pending files in the watch queue before new changes are dropped (default: 1000)", type: "number" },
];

const RATE_LIMITING_FIELDS: FieldDef[] = [
  { key: "RATE_LIMIT_ENABLED", label: "Enabled", fallback: "true", message: "Enable API rate limiting (true/false)", description: "Turn API rate limiting on or off (default: true)", type: "string" },
  { key: "RATE_LIMIT_MAX", label: "Max Requests", fallback: "300", message: "Max requests per window", description: "Maximum API requests allowed per time window (default: 300)", type: "number" },
  { key: "RATE_LIMIT_WINDOW", label: "Window (ms)", fallback: "60000", message: "Rate limit window (ms)", description: "Time window for rate limiting in milliseconds (default: 60000 = 1 minute)", type: "number" },
];

const EXTRACTION_TUNING_FIELDS: FieldDef[] = [
  { key: "THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE", label: "Extraction Mode", fallback: "smart", message: "Extraction method: smart (LLM) or fast (regex, <5ms)", description: "How entities are extracted: smart uses an LLM for accuracy, fast uses regex for speed (default: smart)", type: "string" },
  { key: "THREADCLAW_MEMORY_RELATIONS_MIN_MENTIONS", label: "Min Mentions", fallback: "2", message: "Min entity mentions before surfacing", description: "How many times an entity must appear before it shows up in results (default: 2)", type: "number" },
  { key: "THREADCLAW_MEMORY_RELATIONS_STALE_DAYS", label: "Stale Days", fallback: "30", message: "Days before entity is stale", description: "Days of inactivity before an entity is considered stale (default: 30)", type: "number" },
  { key: "THREADCLAW_MEMORY_RELATIONS_DECAY_INTERVAL_DAYS", label: "Decay Interval Days", fallback: "90", message: "Days between decay cycles", description: "How often entity relevance scores are reduced over time (default: every 90 days)", type: "number" },
  { key: "THREADCLAW_MEMORY_RELATIONS_USER_CLAIM_EXTRACTION_ENABLED", label: "User Claim Extraction", fallback: "false", message: "Extract claims from user messages too", description: "Also extract factual claims from user messages, not just assistant output (default: false)", type: "string" },
];

const AWARENESS_TUNING_FIELDS: FieldDef[] = [
  { key: "THREADCLAW_MEMORY_RELATIONS_AWARENESS_MAX_NOTES", label: "Max Notes Per Turn", fallback: "3", message: "Max awareness notes per turn", description: "Maximum entity context notes injected into each prompt turn (default: 3)", type: "number" },
  { key: "THREADCLAW_MEMORY_RELATIONS_AWARENESS_MAX_TOKENS", label: "Max Tokens", fallback: "100", message: "Max tokens for awareness context", description: "Token budget for awareness context added to each prompt (default: 100)", type: "number" },
  { key: "THREADCLAW_MEMORY_RELATIONS_AWARENESS_DOC_SURFACING", label: "Doc Surfacing", fallback: "false", message: "Surface relevant docs as fallback", description: "Show related documents when no entity matches are found (default: false)", type: "string" },
];

const SUMMARY_MODEL_FIELDS: FieldDef[] = [
  { key: "THREADCLAW_MEMORY_SUMMARY_PROVIDER", label: "Summary Provider", fallback: "", message: "LLM provider for memory compaction (openai, anthropic, ollama, lmstudio)", description: "Which LLM provider compresses conversation history (blank = OpenClaw default)", type: "string" },
  { key: "THREADCLAW_MEMORY_SUMMARY_MODEL", label: "Summary Model", fallback: "", message: "Model for memory summaries", description: "Model name for memory summaries, e.g. gpt-4o-mini or llama3.1:8b (blank = default)", type: "string" },
  { key: "THREADCLAW_MEMORY_LARGE_FILE_SUMMARY_PROVIDER", label: "Large File Summary Provider", fallback: "", message: "Provider for large file summaries", description: "Override provider for files over 25k tokens (blank = same as summary provider)", type: "string" },
  { key: "THREADCLAW_MEMORY_LARGE_FILE_SUMMARY_MODEL", label: "Large File Summary Model", fallback: "", message: "Model for large file summaries", description: "Override model for large file summaries (blank = same as summary model)", type: "string" },
];

const QUERY_TUNING_FIELDS: FieldDef[] = [
  { key: "QUERY_EXPANSION_TEMPERATURE", label: "Expansion Temperature", fallback: "0.3", message: "LLM temperature for query expansion", description: "Randomness for query rewriting (0.0 = focused, 2.0 = creative, default: 0.3)", type: "number" },
  { key: "QUERY_EXPANSION_MAX_TOKENS", label: "Expansion Max Tokens", fallback: "512", message: "Max tokens for expanded queries", description: "Maximum tokens the LLM can use when rewriting a query (default: 512)", type: "number" },
  { key: "QUERY_EXPANSION_TIMEOUT_MS", label: "Expansion Timeout", fallback: "15000", message: "Timeout for expansion LLM call (ms)", description: "How long to wait for the expansion LLM before timing out, in ms (default: 15000)", type: "number" },
  { key: "HYBRID_VECTOR_WEIGHT", label: "Hybrid Vector Weight", fallback: "1.0", message: "Weight for semantic search in hybrid mode", description: "How much weight semantic (vector) search gets in hybrid mode (default: 1.0)", type: "number" },
  { key: "HYBRID_BM25_WEIGHT", label: "Hybrid BM25 Weight", fallback: "1.0", message: "Weight for keyword search in hybrid mode", description: "How much weight keyword (BM25) search gets in hybrid mode (default: 1.0)", type: "number" },
  { key: "QUERY_CACHE_MAX_ENTRIES", label: "Cache Max Entries", fallback: "50", message: "Max cached query results", description: "Number of recent query results to cache for faster repeat lookups (default: 50)", type: "number" },
  { key: "QUERY_CACHE_TTL_MS", label: "Cache TTL", fallback: "300000", message: "Cache entry lifetime (ms)", description: "How long cached query results stay valid, in ms (default: 300000 = 5 minutes)", type: "number" },
  { key: "QUERY_RETRIEVE_MULTIPLIER", label: "Retrieve Multiplier", fallback: "2", message: "Over-retrieve factor before reranking", description: "Fetch this many times more results than requested, then rerank to pick the best (default: 2)", type: "number" },
];

export async function runInkConfigureAction(action: ConfigureAction): Promise<void> {
  if (action === "embed") await configureModel("embed");
  else if (action === "rerank") await configureModel("rerank");
  else if (action === "expansion") await configureExpansion();
  else if (action === "parser") await configureParser();
  else if (action === "ocr") await configureOcr();
  else if (action === "audio") await configureAudio();
  else if (action === "ner") await configureNer();
  else if (action === "evidence") await configureEvidence();
  else if (action === "watch") await configureWatchPaths();
  else if (action === "embedding-tuning") await configureEmbeddingTuning();
  else if (action === "watch-tuning") await configureWatchTuning();
  else if (action === "rate-limiting") await configureRateLimiting();
  else if (action === "search-ranking") await configureSearchAndRanking();
  else if (action === "chunking") await configureChunkingAndParsing();
  else if (action === "ocr-media") await configureOcrAndMedia();
  else if (action === "memory-summary") await configureMemoryAndSummary();
  else if (action === "network") await configureNetworkAndPorts();
}

async function configureEmbeddingTuning(): Promise<void> {
  await configureFieldGroup("Embedding Tuning", EMBEDDING_TUNING_FIELDS);
}

async function configureWatchTuning(): Promise<void> {
  await configureFieldGroup("Watch Tuning", WATCH_TUNING_FIELDS);
}

async function configureRateLimiting(): Promise<void> {
  await configureFieldGroup("Rate Limiting", RATE_LIMITING_FIELDS);
}

const SEARCH_AND_RANKING_FIELDS: FieldDef[] = [
  ...SEARCH_FIELDS,
  ...QUERY_TUNING_FIELDS,
];

const CHUNKING_AND_PARSING_FIELDS: FieldDef[] = [
  { key: "CHUNK_MAX_TOKENS", label: "Max Chunk Size", fallback: "1024", message: "Hard upper bound for ingestion chunks.", description: "Maximum tokens per chunk (default: 1024)", type: "number" },
  { key: "CHUNK_TARGET_TOKENS", label: "Target Chunk Size", fallback: "512", message: "Preferred chunk size for prose splitting.", description: "Target tokens per chunk (default: 512)", type: "number" },
  { key: "CHUNK_MIN_TOKENS", label: "Min Chunk Size", fallback: "100", message: "Chunks smaller than this get merged.", description: "Minimum tokens per chunk (default: 100)", type: "number" },
  { key: "CHUNK_OVERLAP_RATIO", label: "Chunk Overlap Ratio", fallback: "0.2", message: "Chunk overlap as fraction of target", description: "Overlap ratio between chunks (default: 0.2)", type: "number" },
  { key: "DEDUP_SIMILARITY_THRESHOLD", label: "Dedup Threshold", fallback: "0.95", message: "Cosine similarity for dedup", description: "Cosine similarity to deduplicate chunks (default: 0.95)", type: "number" },
  { key: "INGEST_MAX_FILE_SIZE_MB", label: "Max File Size (MB)", fallback: "100", message: "Max file size to ingest (MB)", description: "Maximum file size to ingest (default: 100 MB)", type: "number" },
  { key: "OCR_LANGUAGE", label: "OCR Language", fallback: "eng", message: "Tesseract OCR language code", description: "OCR language code (default: eng)", type: "string" },
  { key: "EMBEDDING_MAX_CONCURRENT", label: "Embedding Concurrency", fallback: "2", message: "Concurrent embedding requests", description: "Concurrent embedding requests during ingest (default: 2)", type: "number" },
  { key: "EMBEDDING_TIMEOUT_MS", label: "Embedding Timeout", fallback: "30000", message: "Embedding API timeout (ms)", description: "Embedding call timeout in ms (default: 30000)", type: "number" },
];

const NETWORK_AND_PORTS_FIELDS: FieldDef[] = [
  { key: "THREADCLAW_PORT", label: "ThreadClaw API Port", fallback: "18800", message: "HTTP port for the ThreadClaw API.", description: "API server port (default: 18800)", type: "number", requiresRestart: true },
  { key: "RERANKER_URL", label: "Model Server URL", fallback: "http://127.0.0.1:8012", message: "Base URL for the local or remote model server.", description: "Model server URL for reranking (default: http://127.0.0.1:8012)", type: "url", requiresRestart: true },
  { key: "QUERY_EXPANSION_URL", label: "Expansion LLM URL", fallback: "http://127.0.0.1:1234/v1", message: "Chat endpoint used for query expansion.", description: "LLM endpoint for query expansion", type: "url" },
  { key: "THREADCLAW_DATA_DIR", label: "Data Directory", fallback: "./data", message: "Where ingested data and databases live.", description: "Data directory for databases and indexes", type: "string", requiresRestart: true },
  { key: "DEFAULT_COLLECTION", label: "Default Collection", fallback: "default", message: "Collection used when none is provided.", description: "Default collection for new documents (default: default)", type: "string" },
  { key: "QUERY_TOP_K", label: "Results Per Query", fallback: "10", message: "How many chunks to return before context compilation.", description: "Default number of results per query (default: 10)", type: "number" },
  { key: "QUERY_TOKEN_BUDGET", label: "Token Budget", fallback: "4000", message: "Max token budget for response context.", description: "Token budget for query responses (default: 4000)", type: "number" },
  { key: "WATCH_DEBOUNCE_MS", label: "Watch Debounce", fallback: "3000", message: "Delay before auto-ingesting changed files.", description: "Delay before processing file changes (ms)", type: "number" },
];

async function configureSearchAndRanking(): Promise<void> {
  await configureFieldGroup("Search & Ranking", SEARCH_AND_RANKING_FIELDS);
}

async function configureChunkingAndParsing(): Promise<void> {
  await configureFieldGroup("Chunking & Parsing", CHUNKING_AND_PARSING_FIELDS);
}

async function configureOcrAndMedia(): Promise<void> {
  const action = await promptMenu({
    title: "OCR & Media",
    message: "Install or configure OCR, audio transcription, and NER.",
    items: [
      { label: "Image OCR (Tesseract)", value: "ocr", description: "Install or check Tesseract status" },
      { label: "Audio transcription (Whisper)", value: "audio", description: "Enable/disable and choose model" },
      { label: "NER (spaCy)", value: "ner", description: "Install spaCy entity recognition model" },
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;
  if (action === "ocr") await configureOcr();
  else if (action === "audio") await configureAudio();
  else if (action === "ner") await configureNer();
}

async function configureMemoryAndSummary(): Promise<void> {
  const root = getRootDir();

  while (true) {
    const env = readEnvMap(root);
    const provider = env.THREADCLAW_MEMORY_SUMMARY_PROVIDER || "default (OpenClaw gateway)";
    const model = env.THREADCLAW_MEMORY_SUMMARY_MODEL || "default (gateway model)";
    const lfProvider = env.THREADCLAW_MEMORY_LARGE_FILE_SUMMARY_PROVIDER || "same as above";
    const lfModel = env.THREADCLAW_MEMORY_LARGE_FILE_SUMMARY_MODEL || "same as above";
    const tier = env.THREADCLAW_MEMORY_RELATIONS_CONTEXT_TIER ?? "standard";
    const relationsOn = env.THREADCLAW_MEMORY_RELATIONS_ENABLED === "true";

    const action = await promptMenu({
      title: "Memory & Summary",
      message: "Controls the LLM used to compress conversation history and summarize large files.\nLeave blank to use the default OpenClaw gateway model.",
      items: [
        { label: t.dim("── Compaction LLM ────────────"), value: "__sep_comp__" },
        { label: `  Provider            ${t.dim(provider)}`, value: "provider", description: "openai, anthropic, ollama, lmstudio, or blank for default" },
        { label: `  Model               ${t.dim(model)}`, value: "model", description: "e.g. gpt-4o-mini, llama3.1:8b, or blank for default" },
        { label: "", value: "__sep_blank1__" },
        { label: t.dim("── Large File Overrides ──────"), value: "__sep_lf__" },
        { label: `  Provider            ${t.dim(lfProvider)}`, value: "lf-provider", description: "Override for files >25k tokens (blank = same as above)" },
        { label: `  Model               ${t.dim(lfModel)}`, value: "lf-model", description: "Override for large file summaries (blank = same as above)" },
        ...(relationsOn ? [
          { label: "", value: "__sep_blank2__" },
          { label: t.dim("── Evidence OS Context ───────"), value: "__sep_evi__" },
          { label: `  Context Tier        ${t.dim(tier)}`, value: "context-tier", description: "How much graph context per prompt (lite/standard/premium)" },
        ] : []),
        { label: "", value: "__sep_blank3__" },
        { label: "Back", value: "__back__", color: t.dim },
      ],
    });

    if (!action || action === "__back__") return;
    if (action.startsWith("__sep")) continue;

    if (action === "provider") {
      const val = await promptText({ title: "Summary Provider", message: "openai, anthropic, ollama, lmstudio — or leave blank for OpenClaw default", label: "Provider", initial: env.THREADCLAW_MEMORY_SUMMARY_PROVIDER ?? "", allowEmpty: true });
      if (val != null) updateEnvValues(root, { THREADCLAW_MEMORY_SUMMARY_PROVIDER: val });
      continue;
    }
    if (action === "model") {
      const val = await promptText({ title: "Summary Model", message: "e.g. gpt-4o-mini, llama3.1:8b — or leave blank for gateway default", label: "Model", initial: env.THREADCLAW_MEMORY_SUMMARY_MODEL ?? "", allowEmpty: true });
      if (val != null) updateEnvValues(root, { THREADCLAW_MEMORY_SUMMARY_MODEL: val });
      continue;
    }
    if (action === "lf-provider") {
      const val = await promptText({ title: "Large File Summary Provider", message: "Override provider for files >25k tokens. Blank = same as compaction provider.", label: "Provider", initial: env.THREADCLAW_MEMORY_LARGE_FILE_SUMMARY_PROVIDER ?? "", allowEmpty: true });
      if (val != null) updateEnvValues(root, { THREADCLAW_MEMORY_LARGE_FILE_SUMMARY_PROVIDER: val });
      continue;
    }
    if (action === "lf-model") {
      const val = await promptText({ title: "Large File Summary Model", message: "Override model for files >25k tokens. Blank = same as compaction model.", label: "Model", initial: env.THREADCLAW_MEMORY_LARGE_FILE_SUMMARY_MODEL ?? "", allowEmpty: true });
      if (val != null) updateEnvValues(root, { THREADCLAW_MEMORY_LARGE_FILE_SUMMARY_MODEL: val });
      continue;
    }
    if (action === "context-tier") {
      const val = await promptMenu({
        title: "Context Tier",
        message: "How much Evidence OS context to compile into each prompt.",
        items: [
          { label: `Lite — 110 tokens${tier === "lite" ? " (current)" : ""}`, value: "lite" },
          { label: `Standard — 190 tokens${tier === "standard" ? " (current)" : ""}`, value: "standard" },
          { label: `Premium — 280 tokens${tier === "premium" ? " (current)" : ""}`, value: "premium" },
          { label: "Cancel", value: "__back__", color: t.dim },
        ],
      });
      if (val && val !== "__back__") updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_CONTEXT_TIER: val });
      continue;
    }
  }
}

async function configureNetworkAndPorts(): Promise<void> {
  await configureFieldGroup("Network & Ports", NETWORK_AND_PORTS_FIELDS);
}

async function configureModel(type: "embed" | "rerank"): Promise<void> {
  const root = getRootDir();
  const python = getPythonCmd();
  const catalog = type === "embed" ? EMBED_MODELS : RERANK_MODELS;
  const providers = type === "embed" ? CLOUD_EMBED_PROVIDERS : CLOUD_RERANK_PROVIDERS;
  const title = type === "embed" ? "Embedding Model" : "Reranker Model";

  while (true) {
    const config = readConfig(root);
    const env = readEnvMap(root);
    const currentId = type === "embed" ? config?.embed_model : config?.rerank_model;
    const currentModel = catalog.find((m) => m.id === currentId);
    const trustRemote = config?.trust_remote_code ?? false;

    // Build current model summary for the header
    const currentName = currentModel?.name ?? currentId ?? "not set";
    const dimsInfo = type === "embed"
      ? ` | ${currentModel?.dims ?? env.EMBEDDING_DIMENSIONS ?? "?"} dims`
      : "";
    const vramInfo = currentModel
      ? ` | ~${currentModel.vramMb >= 1000 ? `${(currentModel.vramMb / 1000).toFixed(1)}GB` : `${currentModel.vramMb}MB`} VRAM`
      : "";
    const apiKeyEnv = type === "embed" ? env.EMBEDDING_API_KEY : env.RERANKER_API_KEY;
    const apiKeyDisplay = apiKeyEnv
      ? `${apiKeyEnv.slice(0, 4)}${"*".repeat(Math.min(apiKeyEnv.length - 4, 12))}`
      : "not set";

    const items: MenuItem[] = [
      { label: "── Model Selection ────────────", value: "__sep1__", color: t.dim },
      { label: "Browse catalog", value: "__catalog__", description: `${catalog.length} models available` },
      { label: "Use cloud provider", value: "__cloud__", color: t.ok, description: "OpenAI, Cohere, Voyage AI, or other API-compatible provider." },
      { label: "Use custom HuggingFace", value: "__custom__", color: t.ok, description: "Enter any model ID from HuggingFace." },
      { label: "── Current Settings ───────────", value: "__sep2__", color: t.dim },
      { label: `Model                   ${currentName}`, value: "__readonly_model__", color: t.dim },
    ];
    if (type === "embed") {
      items.push({
        label: `Dimensions              ${currentModel?.dims ?? env.EMBEDDING_DIMENSIONS ?? "?"}`,
        value: "__readonly_dims__",
        color: t.dim,
      });
    }
    items.push({
      label: `API Key                 ${apiKeyDisplay}`,
      value: "__apikey__",
      description: "Edit API key for cloud providers",
    });
    items.push({
      label: `Trust Remote Code       ${trustRemote}`,
      value: "__trust__",
      description: "Toggle trust_remote_code",
    });
    items.push({ label: "Back", value: "__back__", color: t.dim });

    const selected = await promptMenu({
      title,
      message: `Current: ${currentName}${dimsInfo}${vramInfo}`,
      items,
    });

    if (!selected || selected === "__back__") return;
    if (selected.startsWith("__sep") || selected.startsWith("__readonly")) continue;

    // ── Browse catalog ──
    if (selected === "__catalog__") {
      const catalogItems: MenuItem[] = catalog.map((model) => ({
        label: `${model.name}${model.id === currentId ? " (current)" : ""}`,
        value: model.id,
        description: `${model.tier} | ~${model.vramMb >= 1000 ? `${(model.vramMb / 1000).toFixed(1)}GB` : `${model.vramMb}MB`} VRAM | ${model.languages} | ${model.notes}`,
      }));
      catalogItems.push({ label: "Back", value: "__back__", color: t.dim });

      const catalogChoice = await promptMenu({
        title: `${title} Catalog`,
        message: type === "embed"
          ? "Select an embedding model. This will require rebuilding vectors."
          : "Select a cross-encoder model for reranking.",
        items: catalogItems,
      });

      if (!catalogChoice || catalogChoice === "__back__") continue;

      const choice = catalog.find((model) => model.id === catalogChoice);
      if (!choice) continue;

      if (type === "embed") {
        const confirmed = await promptConfirm({
          title: "Rebuild Required",
          message: `Switch to ${choice.name} (${choice.dims} dims, ~${choice.vramMb >= 1000 ? `${(choice.vramMb / 1000).toFixed(1)}GB` : `${choice.vramMb}MB`} VRAM)?\n\nThis deletes the current vector DB. You must re-ingest all documents.`,
          confirmLabel: "Delete DB and apply",
          cancelLabel: "Cancel",
        });
        if (!confirmed) continue;

        const dbPath = resolve(getDataDir(root), "threadclaw.db");
        if (existsSync(dbPath)) unlinkSync(dbPath);

        writeConfig({
          embed_model: choice.id,
          rerank_model: config?.rerank_model ?? "",
          trust_remote_code: choice.trustRemoteCode || trustRemote,
          docling_device: config?.docling_device ?? "off",
        }, root);

        updateEnvValues(root, {
          EMBEDDING_MODEL: choice.id,
          EMBEDDING_DIMENSIONS: String(choice.dims),
        });

        await warmModel(choice, python, "embed");
        await showNotice("Embedding Updated", `${choice.name} is configured. Re-ingest documents after restart.`);
      } else {
        writeConfig({
          embed_model: config?.embed_model ?? "",
          rerank_model: choice.id,
          trust_remote_code: choice.trustRemoteCode || trustRemote,
          docling_device: config?.docling_device ?? "off",
        }, root);

        await warmModel(choice, python, "rerank");
        await showNotice("Reranker Updated", `${choice.name} is configured. Restart services to apply.`);
      }
      continue;
    }

    // ── Cloud provider ──
    if (selected === "__cloud__") {
      await configureCloudModel(type, providers);
      continue;
    }

    // ── Custom HuggingFace ──
    if (selected === "__custom__") {
      await configureCustomModel(type, python);
      continue;
    }

    // ── Edit API Key ──
    if (selected === "__apikey__") {
      const envKey = type === "embed" ? "EMBEDDING_API_KEY" : "RERANKER_API_KEY";
      const newKey = await promptText({
        title: "API Key",
        message: `Current: ${apiKeyDisplay}. Leave blank to clear.`,
        label: "API Key",
        mask: "*",
        initial: apiKeyEnv ?? "",
      });
      if (newKey != null) {
        updateEnvValues(root, { [envKey]: newKey });
        await showNotice("API Key Updated", newKey ? "API key saved." : "API key cleared.");
      }
      continue;
    }

    // ── Toggle Trust Remote Code ──
    if (selected === "__trust__") {
      const newTrust = !trustRemote;
      writeConfig({
        embed_model: config?.embed_model ?? "",
        rerank_model: config?.rerank_model ?? "",
        trust_remote_code: newTrust,
        docling_device: config?.docling_device ?? "off",
      }, root);
      await showNotice("Trust Remote Code", `trust_remote_code set to ${newTrust}. Restart services to apply.`);
      continue;
    }
  }
}

async function configureCloudModel(
  type: "embed" | "rerank",
  providers: Array<{ name: string; apiUrl: string; hint: string }>,
): Promise<void> {
  const root = getRootDir();
  const config = readConfig(root);

  const providerName = await promptMenu({
    title: "Cloud Provider",
    message: "Pick the provider backing this model.",
    items: [
      ...providers.map((provider) => ({
        label: provider.name,
        value: provider.name,
        description: provider.hint,
      })),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!providerName || providerName === "__back__") return;
  const provider = providers.find((entry) => entry.name === providerName);
  if (!provider) return;

  const apiUrl = await promptText({
    title: "API Endpoint",
    message: provider.hint,
    label: "API URL",
    initial: provider.apiUrl || "https://",
  });
  if (!apiUrl) return;

  const modelName = await promptText({
    title: "Model Name",
    message: provider.hint,
    label: "Model",
  });
  if (!modelName) return;

  let dimensions = "1536";
  if (type === "embed") {
    const dimsValue = await promptText({
      title: "Embedding Dimensions",
      message: "Check the provider docs for the correct output dimension.",
      label: "Dimensions",
      initial: "1536",
    });
    if (!dimsValue) return;
    dimensions = String(parseInt(dimsValue, 10) || 1536);
  }

  const apiKey = await promptText({
    title: "API Key",
    message: "Stored in .env for the configured provider.",
    label: "API Key",
    mask: "*",
  });
  if (!apiKey) return;

  if (type === "embed") {
    const confirmed = await promptConfirm({
      title: "Rebuild Required",
      message: "Cloud embedding changes also require deleting the current vector DB. Continue?",
      confirmLabel: "Delete DB and apply",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;

    const dbPath = resolve(getDataDir(root), "threadclaw.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);

    updateEnvValues(root, {
      EMBEDDING_URL: apiUrl.replace(/\/+$/, ""),
      EMBEDDING_MODEL: modelName,
      EMBEDDING_DIMENSIONS: dimensions,
      EMBEDDING_API_KEY: apiKey,
    });

    writeConfig({
      embed_model: `${provider.name}/${modelName}`,
      rerank_model: config?.rerank_model ?? "",
      trust_remote_code: false,
      docling_device: config?.docling_device ?? "off",
    }, root);

    await showNotice("Cloud Embedding Saved", `${provider.name}/${modelName} is configured. Re-ingest after restart.`);
    return;
  }

  updateEnvValues(root, {
    RERANKER_URL: apiUrl.replace(/\/+$/, ""),
    RERANKER_MODEL: modelName,
    RERANKER_API_KEY: apiKey,
  });

  writeConfig({
    embed_model: config?.embed_model ?? "",
    rerank_model: `${provider.name}/${modelName}`,
    trust_remote_code: false,
    docling_device: config?.docling_device ?? "off",
  }, root);

  await showNotice("Cloud Reranker Saved", `${provider.name}/${modelName} is configured.`);
}

async function configureCustomModel(type: "embed" | "rerank", python: string): Promise<void> {
  const root = getRootDir();
  const config = readConfig(root);

  const modelId = await promptText({
    title: "Custom HuggingFace Model",
    message: "Enter any model ID from huggingface.co.",
    label: "Model ID",
  });
  if (!modelId) return;

  const trustRemote = await promptConfirm({
    title: "Remote Code",
    message: "Enable trust_remote_code for this model?",
    confirmLabel: "Yes",
    cancelLabel: "No",
  });
  if (trustRemote == null) return;

  const spinner = ora(`Validating ${modelId}...`).start();
  try {
    let dimensions = 0;
    const trustArg = trustRemote ? "True" : "False";
    const tmpScript = resolve(tmpdir(), `threadclaw_check_${randomUUID()}.py`);
    try {
      if (type === "embed") {
        writeFileSync(tmpScript, `import sys; from sentence_transformers import SentenceTransformer; model = SentenceTransformer(sys.argv[1], trust_remote_code=${trustArg}); print(model.get_sentence_embedding_dimension())`);
        const output = execFileSync(python, [tmpScript, modelId], { stdio: "pipe", timeout: 600000 }).toString().trim();
        dimensions = parseInt(output, 10) || 0;
      } else {
        writeFileSync(tmpScript, `import sys; from sentence_transformers import CrossEncoder; CrossEncoder(sys.argv[1], trust_remote_code=${trustArg})`);
        execFileSync(python, [tmpScript, modelId], { stdio: "pipe", timeout: 600000 });
      }
    } finally { try { unlinkSync(tmpScript); } catch {} }
    spinner.succeed(`${modelId} validated`);

    if (type === "embed") {
      const confirmed = await promptConfirm({
        title: "Rebuild Required",
        message: "Apply this custom embedding model and delete the existing vector DB?",
        confirmLabel: "Delete DB and apply",
        cancelLabel: "Cancel",
      });
      if (!confirmed) return;

      const dbPath = resolve(getDataDir(root), "threadclaw.db");
      if (existsSync(dbPath)) unlinkSync(dbPath);

      writeConfig({
        embed_model: modelId,
        rerank_model: config?.rerank_model ?? "",
        trust_remote_code: trustRemote,
        docling_device: config?.docling_device ?? "off",
      }, root);
      updateEnvValues(root, {
        EMBEDDING_MODEL: modelId,
        EMBEDDING_DIMENSIONS: String(dimensions),
      });
      await showNotice("Custom Embedding Saved", `${modelId} is configured. Re-ingest after restart.`);
      return;
    }

    writeConfig({
      embed_model: config?.embed_model ?? "",
      rerank_model: modelId,
      trust_remote_code: trustRemote,
      docling_device: config?.docling_device ?? "off",
    }, root);
    await showNotice("Custom Reranker Saved", `${modelId} is configured.`);
  } catch (error) {
    spinner.fail(`${modelId} failed to load`);
    await showNotice("Validation Failed", String(error).slice(0, 240));
  }
}

async function configureExpansion(): Promise<void> {
  const root = getRootDir();

  while (true) {
    const env = readEnvMap(root);
    const enabled = env.QUERY_EXPANSION_ENABLED === "true";
    const url = env.QUERY_EXPANSION_URL || "http://127.0.0.1:1234/v1";
    const model = env.QUERY_EXPANSION_MODEL || "not set";
    const apiKey = env.QUERY_EXPANSION_API_KEY;
    const temperature = env.QUERY_EXPANSION_TEMPERATURE || "0.3";
    const maxTokens = env.QUERY_EXPANSION_MAX_TOKENS || "512";
    const timeout = env.QUERY_EXPANSION_TIMEOUT_MS || "15000";
    const dot = (on: boolean) => on ? t.ok("on") : t.dim("off");

    const action = await promptMenu({
      title: "Query Expansion",
      message: "LLM-powered query rewriting (optional).\nAll settings take effect immediately.",
      items: [
        { label: t.dim("── Status ────────────────────"), value: "__sep_status__" },
        { label: `  Enabled               ${dot(enabled)}`, value: "toggle-enabled", description: "Toggle query expansion on/off" },
        { label: "", value: "__sep_blank1__" },
        { label: t.dim("── LLM Connection ────────────"), value: "__sep_llm__" },
        { label: `  Endpoint URL          ${t.dim(url)}`, value: "edit-url", description: "Local LM Studio / Ollama or cloud chat endpoint" },
        { label: `  Model                 ${t.dim(model)}`, value: "edit-model", description: "Model name for query rewriting" },
        { label: `  API Key               ${t.dim(apiKey ? "••••••" : "not set")}`, value: "edit-apikey", description: "Required for cloud providers" },
        { label: "", value: "__sep_blank2__" },
        { label: t.dim("── Parameters ────────────────"), value: "__sep_params__" },
        { label: `  Temperature           ${t.dim(temperature)}`, value: "edit-temperature", description: "Sampling temperature (0.0–2.0)" },
        { label: `  Max Tokens            ${t.dim(maxTokens)}`, value: "edit-max-tokens", description: "Maximum tokens in expansion response" },
        { label: `  Timeout (ms)          ${t.dim(timeout)}`, value: "edit-timeout", description: "Request timeout in milliseconds" },
        { label: "", value: "__sep_blank3__" },
        { label: "Back", value: "__back__", color: t.dim },
      ],
    });

    if (!action || action === "__back__") return;
    if (action.startsWith("__sep")) continue;

    if (action === "toggle-enabled") {
      updateEnvValues(root, { QUERY_EXPANSION_ENABLED: enabled ? "false" : "true" });
      continue;
    }
    if (action === "edit-url") {
      const val = await promptText({
        title: "Expansion Endpoint URL",
        message: "Local LM Studio / Ollama or cloud OpenAI-compatible chat endpoint.",
        label: "URL",
        initial: env.QUERY_EXPANSION_URL || "http://127.0.0.1:1234/v1",
        validate: (v) => validateField(v, "url"),
      });
      if (val != null) updateEnvValues(root, { QUERY_EXPANSION_URL: val });
      continue;
    }
    if (action === "edit-model") {
      const val = await promptText({
        title: "Expansion Model",
        message: "Model name used to rewrite user queries (e.g. llama3.1:8b, gpt-4o-mini).",
        label: "Model",
        initial: env.QUERY_EXPANSION_MODEL ?? "",
        allowEmpty: false,
      });
      if (val != null) updateEnvValues(root, { QUERY_EXPANSION_MODEL: val });
      continue;
    }
    if (action === "edit-apikey") {
      const val = await promptText({
        title: "Expansion API Key",
        message: "Leave blank if this is a local endpoint.",
        label: "API Key",
        initial: env.QUERY_EXPANSION_API_KEY ?? "",
        mask: "*",
        allowEmpty: true,
      });
      if (val != null) updateEnvValues(root, { QUERY_EXPANSION_API_KEY: val });
      continue;
    }
    if (action === "edit-temperature") {
      const val = await promptText({
        title: "Expansion Temperature",
        message: "Sampling temperature for query rewriting (0.0–2.0). Lower = more focused.",
        label: "Temperature",
        initial: env.QUERY_EXPANSION_TEMPERATURE || "0.3",
        validate: (v) => {
          const n = Number(v);
          if (isNaN(n)) return "Must be a number.";
          if (n < 0 || n > 2) return "Must be between 0.0 and 2.0.";
          return null;
        },
      });
      if (val != null) updateEnvValues(root, { QUERY_EXPANSION_TEMPERATURE: val });
      continue;
    }
    if (action === "edit-max-tokens") {
      const val = await promptText({
        title: "Expansion Max Tokens",
        message: "Maximum tokens in the expansion response.",
        label: "Max Tokens",
        initial: env.QUERY_EXPANSION_MAX_TOKENS || "512",
        validate: (v) => validateField(v, "number"),
      });
      if (val != null) updateEnvValues(root, { QUERY_EXPANSION_MAX_TOKENS: val });
      continue;
    }
    if (action === "edit-timeout") {
      const val = await promptText({
        title: "Expansion Timeout",
        message: "Request timeout in milliseconds. Increase for slow endpoints.",
        label: "Timeout (ms)",
        initial: env.QUERY_EXPANSION_TIMEOUT_MS || "15000",
        validate: (v) => validateField(v, "number"),
      });
      if (val != null) updateEnvValues(root, { QUERY_EXPANSION_TIMEOUT_MS: val });
      continue;
    }
  }
}

async function configureFieldGroup(
  title: string,
  fields: FieldDef[],
): Promise<void> {
  const root = getRootDir();
  ensureEnvFile(root);

  while (true) {
    const env = readEnvMap(root);
    const action = await promptMenu({
      title,
      message: "Select a setting to edit. Values save immediately.",
      items: [
        ...fields.map((field) => {
          const currentValue = env[field.key] ?? field.fallback;
          const desc = field.description ? ` ${t.dim(`— ${field.description}`)}` : "";
          return {
            label: `${field.label}${desc} ${t.dim(`(current: ${currentValue})`)}`,
            value: field.key,
            description: field.message,
          };
        }),
        { label: "Reset all to defaults", value: "__reset__", color: t.warn },
        { label: "Back", value: "__back__", color: t.dim },
      ],
    });

    if (!action || action === "__back__") return;

    if (action === "__reset__") {
      const confirmed = await promptConfirm({
        title: "Reset to Defaults",
        message: "This will overwrite all fields in this group with their default values. Continue?",
        confirmLabel: "Reset",
        cancelLabel: "Cancel",
      });
      if (!confirmed) continue;
      const updates: Record<string, string> = {};
      for (const field of fields) updates[field.key] = field.fallback;
      updateEnvValues(root, updates);
      await showNotice(title, "All fields reset to defaults.");
      continue;
    }

    const field = fields.find((entry) => entry.key === action);
    if (!field) continue;

    const newValue = await promptText({
      title,
      message: field.message,
      description: field.description,
      label: field.label,
      initial: env[field.key] ?? field.fallback,
      allowEmpty: false,
      validate: (v) => validateField(v, field.type),
      ...(field.mask ? { mask: field.mask } : {}),
    });
    if (newValue == null) continue;

    if (field.key === "RERANKER_URL") {
      const base = newValue.replace(/\/+$/, "");
      updateEnvValues(root, {
        RERANKER_URL: base,
        EMBEDDING_URL: `${base}/v1`,
      });
    } else {
      updateEnvValues(root, { [field.key]: newValue });
    }

    if (field.requiresRestart) {
      await showNotice(title, t.warn("Restart services to apply this change."));
    }
  }
}

async function configureParser(): Promise<void> {
  const root = getRootDir();
  const python = getPythonCmd();

  while (true) {
    const config = readConfig(root);
    const mode = config?.docling_device ?? "off";

    let doclingInstalled = false;
    try {
      execFileSync(python, ["-c", "import docling"], { stdio: "pipe", timeout: 10000 });
      doclingInstalled = true;
    } catch {}

    const modeLabel = mode === "off" ? "off" : mode === "cpu" ? "Docling CPU" : "Docling GPU";
    const statusLabel = doclingInstalled ? t.ok("installed") : t.dim("not installed");

    const action = await promptMenu({
      title: "Document Parser",
      message: "Controls how documents are parsed during ingestion.",
      items: [
        { label: `  Parser Mode         ${t.dim(modeLabel)}`, value: "mode", description: "Standard / Docling CPU / Docling GPU" },
        { label: `  Docling Status      ${statusLabel}`, value: "__sep_status__" },
        { label: `  Install Docling`, value: "install", description: "Download and install the Docling package" },
        { label: "", value: "__sep_blank__" },
        { label: "Back", value: "__back__", color: t.dim },
      ],
    });

    if (!action || action === "__back__") return;
    if (action.startsWith("__sep")) continue;

    if (action === "mode") {
      const selected = await promptMenu({
        title: "Parser Mode",
        message: `Current: ${modeLabel}`,
        items: [
          { label: "Standard (built-in)", value: "off", description: "No Docling dependency required." },
          { label: "Docling CPU", value: "cpu", description: "Layout-aware parsing with no VRAM requirement." },
          { label: "Docling GPU", value: "gpu", description: "Fastest parsing on supported GPUs." },
          { label: "Back", value: "__back__", color: t.dim },
        ],
      });
      if (!selected || selected === "__back__") continue;
      writeConfig({
        ...(config ?? { embed_model: "", rerank_model: "", trust_remote_code: false }),
        docling_device: selected,
      }, root);
      await showNotice("Parser Updated", `Parser mode set to ${selected === "off" ? "Standard" : `Docling ${selected.toUpperCase()}`}.`);
      continue;
    }

    if (action === "install") {
      if (doclingInstalled) {
        await showNotice("Docling", "Docling is already installed.");
        continue;
      }
      const spinner = ora("Installing Docling...").start();
      try {
        execFileSync(python, ["-m", "pip", "install", "docling"], { stdio: "pipe", timeout: 600000 });
        spinner.succeed("Docling installed");
        await showNotice("Docling", "Docling installed successfully.");
      } catch (error) {
        spinner.fail("Docling install failed");
        await showNotice("Docling Install Failed", String(error).slice(0, 240));
      }
      continue;
    }
  }
}

async function configureOcr(): Promise<void> {
  const root = getRootDir();

  while (true) {
    const installed = hasTesseract();
    const env = readEnvMap(root);
    const ocrLang = env.OCR_LANGUAGE ?? "eng";
    const statusLabel = installed ? t.ok("installed") : t.dim("not installed");

    const action = await promptMenu({
      title: "Image OCR (Tesseract)",
      message: "Extracts text from images and scanned documents.",
      items: [
        { label: `  Status              ${statusLabel}`, value: "__sep_status__" },
        { label: `  OCR Language        ${t.dim(ocrLang)}`, value: "language", description: "Tesseract language code (e.g. eng, deu, fra)" },
        { label: `  Install Tesseract`, value: "install", description: "Download and install Tesseract OCR" },
        { label: "", value: "__sep_blank__" },
        { label: "Back", value: "__back__", color: t.dim },
      ],
    });

    if (!action || action === "__back__") return;
    if (action.startsWith("__sep")) continue;

    if (action === "language") {
      const newLang = await promptText({
        title: "OCR Language",
        message: "Enter Tesseract language code (e.g. eng, deu, fra, jpn):",
        label: "Language code",
        initial: ocrLang,
        allowEmpty: false,
      });
      if (newLang != null) {
        updateEnvValues(root, { OCR_LANGUAGE: newLang });
        await showNotice("OCR Language", `Language set to ${newLang}.`);
      }
      continue;
    }

    if (action === "install") {
      if (installed) {
        await showNotice("Tesseract", "Tesseract is already installed.");
        continue;
      }
      const spinner = ora("Installing Tesseract...").start();
      try {
        const platform = getPlatform();
        if (platform === "windows") {
          try {
            execFileSync("winget", ["install", "UB-Mannheim.TesseractOCR", "--accept-source-agreements", "--accept-package-agreements"], { stdio: "pipe", timeout: 120000 });
          } catch {
            execFileSync("choco", ["install", "tesseract", "-y"], { stdio: "pipe", timeout: 120000 });
          }
        } else if (platform === "mac") {
          execFileSync("brew", ["install", "tesseract"], { stdio: "pipe", timeout: 120000 });
        } else {
          try {
            execFileSync("sudo", ["apt", "install", "-y", "tesseract-ocr"], { stdio: "pipe", timeout: 120000 });
          } catch {
            execFileSync("sudo", ["yum", "install", "-y", "tesseract"], { stdio: "pipe", timeout: 120000 });
          }
        }
        spinner.succeed("Tesseract installed");
        await showNotice("Image OCR", "Tesseract installed successfully.");
      } catch (error) {
        spinner.fail("Tesseract install failed");
        await showNotice("Image OCR", `Install failed: ${String(error).slice(0, 220)}`);
      }
      continue;
    }
  }
}

async function configureAudio(): Promise<void> {
  const root = getRootDir();

  while (true) {
    const env = readEnvMap(root);
    const enabled = env.AUDIO_TRANSCRIPTION_ENABLED === "true";
    const model = env.WHISPER_MODEL ?? "base";

    const action = await promptMenu({
      title: "Audio Transcription",
      message: "Whisper-based audio transcription for ingested audio files.",
      items: [
        { label: "Status", value: "toggle", description: enabled ? "on" : "off" },
        { label: "Model", value: "model", description: model },
        { label: "Back", value: "__back__", color: t.dim },
      ],
    });

    if (!action || action === "__back__") return;

    if (action === "toggle") {
      updateEnvValues(root, { AUDIO_TRANSCRIPTION_ENABLED: enabled ? "false" : "true" });
      await showNotice("Audio Transcription", enabled ? "Transcription disabled." : "Transcription enabled.");
      continue;
    }

    if (action === "model") {
      const selected = await promptMenu({
        title: "Whisper Model",
        message: "Select the Whisper model to use for audio transcription.",
        items: [
          ...WHISPER_MODELS.map((entry) => ({
            label: `${entry.value}${entry.value === model ? " (current)" : ""}`,
            value: entry.value,
            description: entry.label,
          })),
          { label: "Back", value: "__back__", color: t.dim },
        ],
      });

      if (selected && selected !== "__back__") {
        updateEnvValues(root, { WHISPER_MODEL: selected });
        await showNotice("Whisper Model", `Model set to ${selected}.`);
      }
      continue;
    }
  }
}

async function configureNer(): Promise<void> {
  const python = getPythonCmd();

  while (true) {
    let installed = false;
    try {
      execFileSync(python, ["-c", "import spacy; spacy.load('en_core_web_sm')"], { stdio: "pipe", timeout: 10000 });
      installed = true;
    } catch {}

    const statusLabel = installed ? t.ok("installed") : t.dim("not installed");

    const action = await promptMenu({
      title: "NER — Named Entity Recognition (spaCy)",
      message: "Improves entity extraction accuracy for Evidence OS.",
      items: [
        { label: `  Status              ${statusLabel}`, value: "__sep_status__" },
        { label: `  Model               ${t.dim("en_core_web_sm")}`, value: "__sep_model__" },
        { label: `  Install / Update`, value: "install", description: "Download spaCy en_core_web_sm (~12 MB)" },
        { label: "", value: "__sep_blank__" },
        { label: "Back", value: "__back__", color: t.dim },
      ],
    });

    if (!action || action === "__back__") return;
    if (action.startsWith("__sep")) continue;

    if (action === "install") {
      const spinner = ora("Installing spaCy NER model...").start();
      try {
        execFileSync(python, ["-m", "spacy", "download", "en_core_web_sm"], { stdio: "pipe", timeout: 120000 });
        spinner.succeed("NER model installed (en_core_web_sm)");

        const restart = await promptConfirm({
          title: "Restart Required",
          message: "The model server must be restarted for NER to load. Restart now?",
        });
        if (restart) {
          const { performServiceAction } = await import("../service-actions.js");
          await performServiceAction("restart", {
            onStatus: (detail) => process.stdout.write(`\r  ${detail}${"".padEnd(40)}`),
          });
          console.log("");
          await showNotice("NER", "Model server restarted. NER is now active.");
        } else {
          await showNotice("NER", "NER will activate on next model server restart.");
        }
      } catch (error) {
        spinner.fail("NER install failed");
        await showNotice("NER", `Install failed: ${String(error).slice(0, 220)}`);
      }
      continue;
    }
  }
}

async function configureEvidence(): Promise<void> {
  const root = getRootDir();

  while (true) {
    const env = readEnvMap(root);
    const relOn = env.THREADCLAW_MEMORY_RELATIONS_ENABLED === "true";
    const awarenessOn = env.THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED === "true";
    const claimsOn = env.THREADCLAW_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED === "true";
    const attemptsOn = env.THREADCLAW_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED === "true";
    const deepOn = env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED === "true";
    const tier = env.THREADCLAW_MEMORY_RELATIONS_CONTEXT_TIER ?? "standard";
    const deepProvider = env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER || "none";
    const deepModel = env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL || "none";
    const mode = env.THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE ?? "smart";
    const dot = (on: boolean) => on ? t.ok("on") : t.dim("off");

    const action = await promptMenu({
      title: "Evidence OS",
      message: "Knowledge graph, entity tracking, and LLM extraction settings.\nAll features are optional — ThreadClaw works without them.",
      items: [
        { label: t.dim("── Feature Toggles ────────────"), value: "__sep_toggles__" },
        { label: `  Entity Relations    ${dot(relOn)}`, value: "toggle-relations", description: "Master switch for the knowledge graph" },
        { label: `  Awareness Notes     ${dot(awarenessOn)}`, value: "toggle-awareness", description: "Inject entity context into prompts" },
        { label: `  Claim Extraction    ${dot(claimsOn)}`, value: "toggle-claims", description: "Extract factual claims from outputs" },
        { label: `  Attempt Tracking    ${dot(attemptsOn)}`, value: "toggle-attempts", description: "Track tool success/failure patterns" },
        { label: `  Deep Extraction     ${dot(deepOn)}`, value: "toggle-deep", description: "Use an LLM for richer extraction" },
        { label: "", value: "__sep_blank1__" },
        { label: t.dim("── Extraction LLM ────────────"), value: "__sep_llm__" },
        { label: `  Provider            ${t.dim(deepProvider)}`, value: "deep-provider", description: "ollama, lmstudio, openai, anthropic" },
        { label: `  Model               ${t.dim(deepModel)}`, value: "deep-model", description: "e.g. llama3.1:8b, gpt-4o-mini" },
        { label: `  API Key             ${t.dim(env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_API_KEY ? "••••••" : "not set")}`, value: "deep-apikey", description: "Required for cloud providers" },
        { label: `  Base URL            ${t.dim(env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_BASE_URL || "auto")}`, value: "deep-baseurl", description: "Custom endpoint for Ollama/LM Studio" },
        { label: "", value: "__sep_blank2__" },
        { label: t.dim("── Tuning ────────────────────"), value: "__sep_tuning__" },
        { label: `  Context Tier        ${t.dim(tier)}`, value: "context-tier", description: "How much graph context per prompt (lite/standard/premium)" },
        { label: `  Extraction Mode     ${t.dim(mode)}`, value: "extraction-mode", description: "smart (LLM) or fast (regex, <5ms)" },
        { label: `  Extraction Tuning`, value: "extraction-tuning", description: "Min mentions, stale days, decay interval" },
        { label: `  Awareness Tuning`, value: "awareness-tuning", description: "Max notes, max tokens, doc surfacing" },
        { label: "", value: "__sep_blank3__" },
        { label: "Back", value: "__back__", color: t.dim },
      ],
    });

    if (!action || action === "__back__") return;
    if (action.startsWith("__sep")) continue;

    if (action === "toggle-relations") {
      const next = relOn ? "false" : "true";
      updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_ENABLED: next, THREADCLAW_RELATIONS_ENABLED: next });
      continue;
    }
    if (action === "toggle-awareness") {
      updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED: awarenessOn ? "false" : "true" });
      continue;
    }
    if (action === "toggle-claims") {
      updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED: claimsOn ? "false" : "true" });
      continue;
    }
    if (action === "toggle-attempts") {
      updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED: attemptsOn ? "false" : "true" });
      continue;
    }
    if (action === "toggle-deep") {
      updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED: deepOn ? "false" : "true" });
      continue;
    }
    if (action === "deep-provider") {
      const val = await promptText({ title: "Deep Extraction Provider", message: "ollama, lmstudio, openai, anthropic, or blank for OpenClaw default", label: "Provider", initial: env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER ?? "", allowEmpty: true });
      if (val != null) updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER: val });
      continue;
    }
    if (action === "deep-model") {
      const val = await promptText({ title: "Deep Extraction Model", message: "e.g. llama3.1:8b, gpt-4o-mini, claude-sonnet-4-20250514", label: "Model", initial: env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL ?? "", allowEmpty: true });
      if (val != null) updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL: val });
      continue;
    }
    if (action === "deep-apikey") {
      const val = await promptText({ title: "Deep Extraction API Key", message: "API key for cloud providers. Leave blank to use OpenClaw auth.", label: "API Key", initial: env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_API_KEY ?? "", allowEmpty: true, mask: "*" });
      if (val != null) updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_API_KEY: val });
      continue;
    }
    if (action === "deep-baseurl") {
      const val = await promptText({ title: "Deep Extraction Base URL", message: "Custom endpoint (e.g. http://localhost:11434/v1). Blank = auto-detect.", label: "Base URL", initial: env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_BASE_URL ?? "", allowEmpty: true });
      if (val != null) updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_BASE_URL: val });
      continue;
    }
    if (action === "context-tier") {
      const val = await promptMenu({
        title: "Context Tier",
        message: "How much Evidence OS context to compile into each prompt.",
        items: [
          { label: `Lite (110 tokens)${tier === "lite" ? " (current)" : ""}`, value: "lite" },
          { label: `Standard (190 tokens)${tier === "standard" ? " (current)" : ""}`, value: "standard" },
          { label: `Premium (280 tokens)${tier === "premium" ? " (current)" : ""}`, value: "premium" },
          { label: "Cancel", value: "__back__", color: t.dim },
        ],
      });
      if (val && val !== "__back__") updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_CONTEXT_TIER: val });
      continue;
    }
    if (action === "extraction-mode") {
      const val = await promptMenu({
        title: "Extraction Mode",
        message: "How entities and relations are extracted from text.",
        items: [
          { label: `Smart — LLM-based, higher quality${mode === "smart" ? " (current)" : ""}`, value: "smart" },
          { label: `Fast — regex only, <5ms per message${mode === "fast" ? " (current)" : ""}`, value: "fast" },
          { label: "Cancel", value: "__back__", color: t.dim },
        ],
      });
      if (val && val !== "__back__") updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE: val });
      continue;
    }
    if (action === "extraction-tuning") {
      await configureFieldGroup("Extraction Tuning", EXTRACTION_TUNING_FIELDS);
      continue;
    }
    if (action === "awareness-tuning") {
      await configureFieldGroup("Awareness Tuning", AWARENESS_TUNING_FIELDS);
      continue;
    }
  }
}

async function configureWatchPaths(): Promise<void> {
  const root = getRootDir();
  const current = getCurrentWatchEntries(root);
  const discovered = discoverWatchCandidates();
  const merged = new Map<string, { path: string; collection: string; checked: boolean }>();

  for (const entry of discovered) {
    merged.set(entry.path, { ...entry, checked: false });
  }
  for (const entry of current) {
    merged.set(entry.path, { ...entry, checked: true });
  }

  const selected = await promptChecklist({
    title: "Watch Paths",
    message: "Toggle directories to auto-ingest. Add custom paths after this step if needed.",
    items: Array.from(merged.values()).map((entry) => ({
      key: entry.path,
      label: `${shortenPath(entry.path)} -> ${entry.collection}`,
      checked: entry.checked,
    })),
    confirmLabel: "Save watch paths",
  });

  if (!selected) return;

  const finalEntries = selected
    .filter((entry) => entry.checked)
    .map((entry) => merged.get(entry.key))
    .filter((entry): entry is { path: string; collection: string; checked: boolean } => Boolean(entry))
    .map(({ path, collection }) => ({ path, collection }));

  const customPath = await promptText({
    title: "Custom Watch Path",
    message: "Optional. Leave blank if you do not want to add another directory.",
    label: "Directory",
    allowEmpty: true,
  });
  if (customPath == null) return;
  if (customPath.trim()) {
    const collection = await promptText({
      title: "Custom Collection",
      message: "Collection name for the custom watch path.",
      label: "Collection",
      initial: "custom",
    });
    if (!collection) return;
    finalEntries.push({ path: customPath.trim(), collection });
  }

  updateEnvValues(root, {
    WATCH_PATHS: finalEntries.map((entry) => `${entry.path}|${entry.collection}`).join(","),
  });
  await showNotice("Watch Paths", `${finalEntries.length} watch path(s) saved.`);
}

function getCurrentWatchEntries(root: string): Array<{ path: string; collection: string }> {
  const raw = readEnvMap(root).WATCH_PATHS;
  if (!raw) return [];
  return raw.split(",").filter(Boolean).map((entry) => {
    const separator = entry.lastIndexOf("|");
    return {
      path: separator > 0 ? entry.slice(0, separator) : entry,
      collection: separator > 0 ? entry.slice(separator + 1) : "default",
    };
  });
}

function discoverWatchCandidates(): Array<{ path: string; collection: string }> {
  const found = new Map<string, { path: string; collection: string }>();
  const openclawDir = findOpenClaw();
  if (openclawDir) {
    const workspace = resolve(openclawDir, "workspace");
    if (existsSync(workspace)) found.set(workspace, { path: workspace, collection: "workspace" });

    const mediaInbound = resolve(openclawDir, "media", "inbound");
    if (existsSync(mediaInbound)) found.set(mediaInbound, { path: mediaInbound, collection: "inbound" });

    if (existsSync(workspace)) {
      try {
        for (const entry of readdirSync(workspace, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const folderPath = resolve(workspace, entry.name);
          found.set(folderPath, { path: folderPath, collection: entry.name });
        }
      } catch {}
    }
  }

  for (const candidate of [
    { path: resolve(homedir(), "Documents"), collection: "documents" },
    { path: resolve(homedir(), "Downloads"), collection: "downloads" },
    { path: resolve(homedir(), "Desktop"), collection: "desktop" },
  ]) {
    if (existsSync(candidate.path)) found.set(candidate.path, candidate);
  }

  return Array.from(found.values());
}

async function warmModel(choice: ModelInfo, python: string, type: "embed" | "rerank"): Promise<void> {
  const spinner = ora(`Downloading ${choice.name}...`).start();
  const dlScript = resolve(tmpdir(), `threadclaw_dl_${randomUUID()}.py`);
  try {
    const trustPy = choice.trustRemoteCode ? ", trust_remote_code=True" : "";
    if (type === "embed") {
      writeFileSync(dlScript, `import sys; from sentence_transformers import SentenceTransformer; SentenceTransformer(sys.argv[1]${trustPy})`);
    } else {
      writeFileSync(dlScript, `import sys; from sentence_transformers import CrossEncoder; CrossEncoder(sys.argv[1]${trustPy})`);
    }
    execFileSync(python, [dlScript, choice.id], { stdio: "pipe", timeout: 600000 });
    spinner.succeed(`${choice.name} ready`);
  } catch {
    spinner.warn("Download failed. The server will retry on startup.");
  } finally { try { unlinkSync(dlScript); } catch {} }
}

function hasTesseract(): boolean {
  // Check PATH first
  try {
    execFileSync("tesseract", ["--version"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {}

  // Check common Windows install locations
  if (getPlatform() === "windows") {
    const candidates = [
      "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
      "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe",
      resolve(process.env.LOCALAPPDATA ?? "", "Programs", "Tesseract-OCR", "tesseract.exe"),
    ];
    for (const p of candidates) {
      try {
        execFileSync(p, ["--version"], { stdio: "pipe", timeout: 5000 });
        return true;
      } catch {}
    }
  }

  return false;
}

async function showNotice(title: string, message: string): Promise<void> {
  await promptMenu({
    title,
    message,
    items: [{ label: "Continue", value: "continue" }],
  });
}

function shortenPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.length <= 4) return path;
  return "..." + parts.slice(-3).join("/");
}

