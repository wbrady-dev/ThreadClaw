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

const GENERAL_FIELDS: FieldDef[] = [
  { key: "RERANKER_URL", label: "Model Server URL", fallback: "http://127.0.0.1:8012", message: "Base URL for the local or remote model server.", description: "Model server URL for reranking (default: http://127.0.0.1:8012)", type: "url", requiresRestart: true },
  { key: "THREADCLAW_PORT", label: "ThreadClaw API Port", fallback: "18800", message: "HTTP port for the ThreadClaw API.", description: "API server port (default: 18800)", type: "number", requiresRestart: true },
  { key: "QUERY_EXPANSION_URL", label: "Expansion LLM URL", fallback: "http://127.0.0.1:1234/v1", message: "Chat endpoint used for query expansion.", description: "LLM endpoint for query expansion (default: http://127.0.0.1:1234/v1)", type: "url" },
  { key: "THREADCLAW_DATA_DIR", label: "Data Directory", fallback: "./data", message: "Where ingested data and databases live.", description: "Data directory for databases and indexes (default: ~/.threadclaw/data)", type: "string", requiresRestart: true },
  { key: "DEFAULT_COLLECTION", label: "Default Collection", fallback: "default", message: "Collection used when none is provided.", description: "Default collection for new documents (default: default)", type: "string" },
  { key: "QUERY_TOP_K", label: "Results Per Query", fallback: "10", message: "How many chunks to return before context compilation.", description: "Default number of results per query (default: 10)", type: "number" },
  { key: "QUERY_TOKEN_BUDGET", label: "Token Budget", fallback: "4000", message: "Max token budget for response context.", description: "Token budget for query responses (default: 4000)", type: "number" },
  { key: "CHUNK_MAX_TOKENS", label: "Max Chunk Size", fallback: "1024", message: "Hard upper bound for ingestion chunks.", description: "Maximum tokens per chunk (default: 1024)", type: "number" },
  { key: "CHUNK_TARGET_TOKENS", label: "Target Chunk Size", fallback: "512", message: "Preferred chunk size for prose splitting.", description: "Target tokens per chunk (default: 512)", type: "number" },
  { key: "CHUNK_MIN_TOKENS", label: "Min Chunk Size", fallback: "100", message: "Chunks smaller than this get merged.", description: "Minimum tokens per chunk (default: 100)", type: "number" },
  { key: "WATCH_DEBOUNCE_MS", label: "Watch Debounce", fallback: "3000", message: "Delay before auto-ingesting changed files.", description: "Delay before processing file changes (ms) (default: 3000)", type: "number" },
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
  { key: "EMBEDDING_API_KEY", label: "Embedding API Key", fallback: "", message: "API key for cloud embedding provider", type: "string", mask: "*" },
  { key: "EMBEDDING_MAX_RETRIES", label: "Max Retries", fallback: "3", message: "Retry count for failed embedding calls", type: "number" },
  { key: "EMBEDDING_CIRCUIT_COOLDOWN_MS", label: "Circuit Cooldown", fallback: "30000", message: "Cooldown after embedding failures (ms)", type: "number" },
  { key: "EMBEDDING_CACHE_MAX", label: "Cache Max", fallback: "200", message: "Max cached query embeddings", type: "number" },
];

const WATCH_TUNING_FIELDS: FieldDef[] = [
  { key: "WATCH_EXCLUDE_PATTERNS", label: "Exclude Patterns", fallback: "", message: "Comma-separated glob patterns to exclude", type: "string" },
  { key: "WATCH_MAX_CONCURRENT", label: "Max Concurrent", fallback: "5", message: "Max concurrent file ingestions", type: "number" },
  { key: "WATCH_MAX_QUEUE", label: "Max Queue", fallback: "1000", message: "Max queued files before dropping", type: "number" },
];

const RATE_LIMITING_FIELDS: FieldDef[] = [
  { key: "RATE_LIMIT_ENABLED", label: "Enabled", fallback: "true", message: "Enable API rate limiting (true/false)", type: "string" },
  { key: "RATE_LIMIT_MAX", label: "Max Requests", fallback: "300", message: "Max requests per window", type: "number" },
  { key: "RATE_LIMIT_WINDOW", label: "Window (ms)", fallback: "60000", message: "Rate limit window (ms)", type: "number" },
];

const EXTRACTION_TUNING_FIELDS: FieldDef[] = [
  { key: "THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE", label: "Extraction Mode", fallback: "smart", message: "Extraction method: smart (LLM) or fast (regex, <5ms)", type: "string" },
  { key: "THREADCLAW_MEMORY_RELATIONS_MIN_MENTIONS", label: "Min Mentions", fallback: "2", message: "Min entity mentions before surfacing", type: "number" },
  { key: "THREADCLAW_MEMORY_RELATIONS_STALE_DAYS", label: "Stale Days", fallback: "30", message: "Days before entity is stale", type: "number" },
  { key: "THREADCLAW_MEMORY_RELATIONS_DECAY_INTERVAL_DAYS", label: "Decay Interval Days", fallback: "90", message: "Days between decay cycles", type: "number" },
  { key: "THREADCLAW_MEMORY_RELATIONS_USER_CLAIM_EXTRACTION_ENABLED", label: "User Claim Extraction", fallback: "false", message: "Extract claims from user messages too", type: "string" },
];

const AWARENESS_TUNING_FIELDS: FieldDef[] = [
  { key: "THREADCLAW_MEMORY_RELATIONS_AWARENESS_MAX_NOTES", label: "Max Notes Per Turn", fallback: "3", message: "Max awareness notes per turn", type: "number" },
  { key: "THREADCLAW_MEMORY_RELATIONS_AWARENESS_MAX_TOKENS", label: "Max Tokens", fallback: "100", message: "Max tokens for awareness context", type: "number" },
  { key: "THREADCLAW_MEMORY_RELATIONS_AWARENESS_DOC_SURFACING", label: "Doc Surfacing", fallback: "false", message: "Surface relevant docs as fallback", type: "string" },
];

const SUMMARY_MODEL_FIELDS: FieldDef[] = [
  { key: "THREADCLAW_MEMORY_SUMMARY_PROVIDER", label: "Summary Provider", fallback: "", message: "LLM provider for memory compaction (openai, anthropic, ollama, lmstudio)", type: "string" },
  { key: "THREADCLAW_MEMORY_SUMMARY_MODEL", label: "Summary Model", fallback: "", message: "Model for memory summaries", type: "string" },
  { key: "THREADCLAW_MEMORY_LARGE_FILE_SUMMARY_PROVIDER", label: "Large File Summary Provider", fallback: "", message: "Provider for large file summaries", type: "string" },
  { key: "THREADCLAW_MEMORY_LARGE_FILE_SUMMARY_MODEL", label: "Large File Summary Model", fallback: "", message: "Model for large file summaries", type: "string" },
];

const QUERY_TUNING_FIELDS: FieldDef[] = [
  { key: "QUERY_EXPANSION_TEMPERATURE", label: "Expansion Temperature", fallback: "0.3", message: "LLM temperature for query expansion", type: "number" },
  { key: "QUERY_EXPANSION_MAX_TOKENS", label: "Expansion Max Tokens", fallback: "512", message: "Max tokens for expanded queries", type: "number" },
  { key: "QUERY_EXPANSION_TIMEOUT_MS", label: "Expansion Timeout", fallback: "15000", message: "Timeout for expansion LLM call (ms)", type: "number" },
  { key: "HYBRID_VECTOR_WEIGHT", label: "Hybrid Vector Weight", fallback: "1.0", message: "Weight for semantic search in hybrid mode", type: "number" },
  { key: "HYBRID_BM25_WEIGHT", label: "Hybrid BM25 Weight", fallback: "1.0", message: "Weight for keyword search in hybrid mode", type: "number" },
  { key: "QUERY_CACHE_MAX_ENTRIES", label: "Cache Max Entries", fallback: "50", message: "Max cached query results", type: "number" },
  { key: "QUERY_CACHE_TTL_MS", label: "Cache TTL", fallback: "300000", message: "Cache entry lifetime (ms)", type: "number" },
  { key: "QUERY_RETRIEVE_MULTIPLIER", label: "Retrieve Multiplier", fallback: "2", message: "Over-retrieve factor before reranking", type: "number" },
];

const INGESTION_TUNING_FIELDS: FieldDef[] = [
  { key: "CHUNK_OVERLAP_RATIO", label: "Chunk Overlap Ratio", fallback: "0.2", message: "Chunk overlap as fraction of target", type: "number" },
  { key: "DEDUP_SIMILARITY_THRESHOLD", label: "Dedup Threshold", fallback: "0.95", message: "Cosine similarity for dedup", type: "number" },
  { key: "OCR_LANGUAGE", label: "OCR Language", fallback: "eng", message: "Tesseract OCR language code", type: "string" },
  { key: "INGEST_MAX_FILE_SIZE_MB", label: "Max File Size (MB)", fallback: "100", message: "Max file size to ingest (MB)", type: "number" },
  { key: "EMBEDDING_MAX_CONCURRENT", label: "Embedding Concurrency", fallback: "2", message: "Concurrent embedding requests", type: "number" },
  { key: "EMBEDDING_TIMEOUT_MS", label: "Embedding Timeout", fallback: "30000", message: "Embedding API timeout (ms)", type: "number" },
];

export async function configureSummaryModel(): Promise<void> {
  await configureFieldGroup("Summary Model", SUMMARY_MODEL_FIELDS);
  await showNotice("Summary Model", "Summary model configured. Changes take effect on next compaction cycle.");
}

export async function configureQueryTuning(): Promise<void> {
  await configureFieldGroup("Query Tuning", QUERY_TUNING_FIELDS);
}

export async function configureIngestionTuning(): Promise<void> {
  await configureFieldGroup("Ingestion Tuning", INGESTION_TUNING_FIELDS);
}

export async function runInkConfigureAction(action: ConfigureAction): Promise<void> {
  if (action === "embed") await configureModel("embed");
  else if (action === "rerank") await configureModel("rerank");
  else if (action === "expansion") await configureExpansion();
  else if (action === "search") await configureFieldGroup("Search Tuning", SEARCH_FIELDS);
  else if (action === "parser") await configureParser();
  else if (action === "ocr") await configureOcr();
  else if (action === "audio") await configureAudio();
  else if (action === "ner") await configureNer();
  else if (action === "evidence") await configureEvidence();
  else if (action === "watch") await configureWatchPaths();
  else if (action === "general") await configureFieldGroup("Ports & Defaults", GENERAL_FIELDS);
  else if (action === "embedding-tuning") await configureEmbeddingTuning();
  else if (action === "watch-tuning") await configureWatchTuning();
  else if (action === "rate-limiting") await configureRateLimiting();
  else if (action === "summary-model") await configureSummaryModel();
  else if (action === "query-tuning") await configureQueryTuning();
  else if (action === "ingestion-tuning") await configureIngestionTuning();
}

export async function configureEmbeddingTuning(): Promise<void> {
  await configureFieldGroup("Embedding Tuning", EMBEDDING_TUNING_FIELDS);
}

export async function configureWatchTuning(): Promise<void> {
  await configureFieldGroup("Watch Tuning", WATCH_TUNING_FIELDS);
}

export async function configureRateLimiting(): Promise<void> {
  await configureFieldGroup("Rate Limiting", RATE_LIMITING_FIELDS);
}

async function configureModel(type: "embed" | "rerank"): Promise<void> {
  const root = getRootDir();
  const config = readConfig(root);
  const python = getPythonCmd();
  const catalog = type === "embed" ? EMBED_MODELS : RERANK_MODELS;
  const currentId = type === "embed" ? config?.embed_model : config?.rerank_model;
  const providers = type === "embed" ? CLOUD_EMBED_PROVIDERS : CLOUD_RERANK_PROVIDERS;

  const items: MenuItem[] = catalog.map((model) => ({
    label: `${model.name}${model.id === currentId ? " (current)" : ""}`,
    value: model.id,
    description: `${model.tier} | ~${model.vramMb >= 1000 ? `${(model.vramMb / 1000).toFixed(1)}GB` : `${model.vramMb}MB`} VRAM | ${model.languages} | ${model.notes}`,
  }));
  items.push({ label: "── Other ──────────────────────", value: "__sep__", color: t.dim });
  items.push({ label: "Cloud provider", value: "__cloud__", color: t.ok, description: "OpenAI, Cohere, Voyage AI, or other API-compatible provider." });
  items.push({ label: "Custom HuggingFace model", value: "__custom__", color: t.ok, description: "Enter any model ID from HuggingFace." });
  items.push({ label: "Back", value: "__back__", color: t.dim });

  const selected = await promptMenu({
    title: type === "embed" ? "Embedding Model" : "Reranker Model",
    message: type === "embed"
      ? "Changing the embedding model requires rebuilding vectors."
      : "Choose the cross-encoder used for final reranking.",
    items,
  });

  if (!selected || selected === "__back__" || selected === "__sep__") return;

  if (selected === "__cloud__") {
    await configureCloudModel(type, providers);
    return;
  }

  if (selected === "__custom__") {
    await configureCustomModel(type, python);
    return;
  }

  const choice = catalog.find((model) => model.id === selected);
  if (!choice) return;

  if (type === "embed") {
    const confirmed = await promptConfirm({
      title: "Rebuild Required",
      message: "Changing the embedding model deletes the current vector DB. Continue?",
      confirmLabel: "Delete DB and apply",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;

    const dbPath = resolve(getDataDir(root), "threadclaw.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);

    writeConfig({
      embed_model: choice.id,
      rerank_model: config?.rerank_model ?? "",
      trust_remote_code: choice.trustRemoteCode || (config?.trust_remote_code ?? false),
      docling_device: config?.docling_device ?? "off",
    }, root);

    updateEnvValues(root, {
      EMBEDDING_MODEL: choice.id,
      EMBEDDING_DIMENSIONS: String(choice.dims),
    });

    await warmModel(choice, python, "embed");
    await showNotice("Embedding Updated", `${choice.name} is configured. Re-ingest documents after restart.`);
    return;
  }

  writeConfig({
    embed_model: config?.embed_model ?? "",
    rerank_model: choice.id,
    trust_remote_code: choice.trustRemoteCode || (config?.trust_remote_code ?? false),
    docling_device: config?.docling_device ?? "off",
  }, root);

  await warmModel(choice, python, "rerank");
  await showNotice("Reranker Updated", `${choice.name} is configured. Restart services to apply.`);
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
  const env = readEnvMap(root);
  const enabled = env.QUERY_EXPANSION_ENABLED === "true";

  const action = await promptMenu({
    title: "Query Expansion",
    message: enabled
      ? `Currently enabled with ${env.QUERY_EXPANSION_MODEL ?? "an unknown model"}.`
      : "Currently disabled.",
    items: [
      { label: "Enable / Update", value: "enable", description: "Set URL, model, and optional API key." },
      { label: "Disable", value: "disable", description: "Turn off query expansion." },
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;
  if (action === "disable") {
    updateEnvValues(root, { QUERY_EXPANSION_ENABLED: "false" });
    await showNotice("Query Expansion", "Query expansion disabled.");
    return;
  }

  const url = await promptText({
    title: "Expansion Endpoint",
    message: "Local LM Studio / Ollama or cloud OpenAI-compatible chat endpoint.",
    label: "URL",
    initial: env.QUERY_EXPANSION_URL ?? "http://127.0.0.1:1234/v1",
  });
  if (!url) return;

  const model = await promptText({
    title: "Expansion Model",
    message: "Model name used to rewrite user queries.",
    label: "Model",
    initial: env.QUERY_EXPANSION_MODEL ?? "",
  });
  if (!model) return;

  const apiKey = await promptText({
    title: "API Key",
    message: "Leave blank if this is a local endpoint.",
    label: "API Key",
    initial: env.QUERY_EXPANSION_API_KEY ?? "",
    mask: "*",
    allowEmpty: true,
  });
  if (apiKey == null) return;

  const updates: Record<string, string> = {
    QUERY_EXPANSION_ENABLED: "true",
    QUERY_EXPANSION_URL: url,
    QUERY_EXPANSION_MODEL: model,
  };
  if (apiKey) updates.QUERY_EXPANSION_API_KEY = apiKey;
  updateEnvValues(root, updates);
  await showNotice("Query Expansion", "Query expansion settings saved.");
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
  const config = readConfig(root);

  const action = await promptMenu({
    title: "Document Parser",
    message: `Current parser: ${config?.docling_device ?? "off"}`,
    items: [
      { label: "Standard (built-in)", value: "off", description: "No Docling dependency required." },
      { label: "Docling CPU", value: "cpu", description: "Layout-aware parsing with no VRAM requirement." },
      { label: "Docling GPU", value: "gpu", description: "Fastest parsing on supported GPUs." },
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;
  if (action !== "off") {
    const install = await promptConfirm({
      title: "Docling Dependency",
      message: "If Docling is missing, install it now?",
      confirmLabel: "Install if needed",
      cancelLabel: "Skip",
    });
    if (install == null) return;
    if (install) {
      try {
        execFileSync(getPythonCmd(), ["-c", "import docling"], { stdio: "pipe", timeout: 10000 });
      } catch {
        const spinner = ora("Installing Docling...").start();
        try {
          execFileSync(getPythonCmd(), ["-m", "pip", "install", "docling"], { stdio: "pipe", timeout: 600000 });
          spinner.succeed("Docling installed");
        } catch (error) {
          spinner.fail("Docling install failed");
          await showNotice("Docling Install Failed", String(error).slice(0, 240));
          return;
        }
      }
    }
  }

  writeConfig({
    ...(config ?? { embed_model: "", rerank_model: "", trust_remote_code: false }),
    docling_device: action,
  }, root);
  await showNotice("Parser Updated", "Document parser settings saved.");
}

async function configureOcr(): Promise<void> {
  const action = await promptMenu({
    title: "Image OCR",
    message: hasTesseract()
      ? "Tesseract is already installed. OCR is active for supported image files."
      : "Tesseract is not installed yet.",
    items: hasTesseract()
      ? [{ label: "Back", value: "__back__", color: t.dim }]
      : [
          { label: "Install Tesseract", value: "install", description: "Install OCR support for images and scans." },
          { label: "Back", value: "__back__", color: t.dim },
        ],
  });

  if (!action || action === "__back__") return;

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
}

async function configureAudio(): Promise<void> {
  const root = getRootDir();
  const env = readEnvMap(root);
  const enabled = env.AUDIO_TRANSCRIPTION_ENABLED === "true";
  const model = env.WHISPER_MODEL ?? "base";

  const action = await promptMenu({
    title: "Audio Transcription",
    message: `Current status: ${enabled ? "enabled" : "disabled"} | model: ${model}`,
    items: [
      { label: enabled ? "Disable transcription" : "Enable transcription", value: "toggle" },
      ...WHISPER_MODELS.map((entry) => ({
        label: `Use ${entry.value}${entry.value === model ? " (current)" : ""}`,
        value: `model:${entry.value}`,
        description: entry.label,
      })),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;
  if (action === "toggle") {
    updateEnvValues(root, { AUDIO_TRANSCRIPTION_ENABLED: enabled ? "false" : "true" });
    await showNotice("Audio Transcription", enabled ? "Transcription disabled." : "Transcription enabled.");
    return;
  }

  if (action.startsWith("model:")) {
    const selectedModel = action.slice("model:".length);
    updateEnvValues(root, {
      WHISPER_MODEL: selectedModel,
      AUDIO_TRANSCRIPTION_ENABLED: "true",
    });
    await showNotice("Audio Transcription", `Whisper model set to ${selectedModel}.`);
  }
}

async function configureNer(): Promise<void> {
  const python = getPythonCmd();
  let installed = false;
  try {
    execFileSync(python, ["-c", "import spacy; spacy.load('en_core_web_sm')"], { stdio: "pipe", timeout: 10000 });
    installed = true;
  } catch {}

  const action = await promptMenu({
    title: "NER (Entity Extraction)",
    message: installed
      ? "spaCy NER model (en_core_web_sm) is installed and available."
      : "NER model not installed. Entity extraction uses regex fallback.\nNER improves entity extraction accuracy when Evidence OS is enabled.",
    items: [
      ...(!installed ? [{ label: "Install NER model", value: "install", description: "Download spaCy en_core_web_sm (~12 MB)" }] : []),
      ...(installed ? [{ label: "Reinstall / update NER model", value: "install" }] : []),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;

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
  }
}

async function configureEvidence(): Promise<void> {
  const root = getRootDir();
  const env = readEnvMap(root);
  const items = await promptChecklist({
    title: "Evidence OS",
    message: "Toggle the relation, awareness, claim, attempt, and deep extraction features.",
    items: [
      { key: "relations", label: "Entity Relations", checked: env.THREADCLAW_MEMORY_RELATIONS_ENABLED === "true", description: "Master switch for graph-aware memory." },
      { key: "awareness", label: "Awareness Notes", checked: env.THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED === "true", description: "Inject short context notes into prompts." },
      { key: "claims", label: "Claim Extraction", checked: env.THREADCLAW_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED === "true", description: "Extract factual claims from outputs." },
      { key: "attempts", label: "Attempt Tracking", checked: env.THREADCLAW_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED === "true", description: "Track successful and failed tool attempts." },
      { key: "deep", label: "Deep Extraction", checked: env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED === "true", description: "Use an LLM for richer graph extraction." },
    ],
    confirmLabel: "Save features",
  });

  if (!items) return;

  const selected = new Set(items.filter((item) => item.checked).map((item) => item.key));
  const relationsEnabled = selected.has("relations");
  updateEnvValues(root, {
    THREADCLAW_MEMORY_RELATIONS_ENABLED: relationsEnabled ? "true" : "false",
    THREADCLAW_RELATIONS_ENABLED: relationsEnabled ? "true" : "false",
    THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED: relationsEnabled && selected.has("awareness") ? "true" : "false",
    THREADCLAW_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED: relationsEnabled && selected.has("claims") ? "true" : "false",
    THREADCLAW_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED: relationsEnabled && selected.has("attempts") ? "true" : "false",
    THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED: relationsEnabled && selected.has("deep") ? "true" : "false",
  });

  if (relationsEnabled) {
    const tier = await promptMenu({
      title: "Context Tier",
      message: "Choose how much Evidence OS context to compile into prompts.",
      items: [
        { label: "Lite (110 tokens)", value: "lite" },
        { label: "Standard (190 tokens)", value: "standard" },
        { label: "Premium (280 tokens)", value: "premium" },
        { label: "Keep current", value: "__keep__", color: t.dim },
      ],
    });
    if (tier && tier !== "__keep__") {
      updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_CONTEXT_TIER: tier });
    }

    if (selected.has("deep")) {
      const provider = await promptText({
        title: "Deep Extraction Provider",
        message: "Examples: ollama, lmstudio, openai, anthropic. Leave blank to use the summary/OpenClaw model.",
        label: "Provider",
        initial: env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER ?? "",
        allowEmpty: true,
      });
      if (provider == null) return;

      const model = await promptText({
        title: "Deep Extraction Model",
        message: "Examples: llama3.1:8b, gpt-4o-mini, claude-sonnet-4-20250514.",
        label: "Model",
        initial: env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL ?? "",
        allowEmpty: true,
      });
      if (model == null) return;

      const apiKey = await promptText({
        title: "Deep Extraction API Key",
        message: "API key for the extraction LLM provider (default: none — uses OpenClaw auth)",
        label: "API Key",
        initial: env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_API_KEY || "",
        allowEmpty: true,
        mask: "*",
      });
      if (apiKey !== null) {
        updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_API_KEY: apiKey });
      }

      const baseUrl = await promptText({
        title: "Deep Extraction Base URL",
        message: "Custom API endpoint for Ollama/LM Studio/compatible (default: auto-detected from provider)",
        label: "Base URL",
        initial: env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_BASE_URL || "",
        allowEmpty: true,
      });
      if (baseUrl !== null) {
        updateEnvValues(root, { THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_BASE_URL: baseUrl });
      }

      updateEnvValues(root, {
        THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER: provider,
        THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL: model,
      });
    }

    await configureFieldGroup("Extraction Tuning", EXTRACTION_TUNING_FIELDS);
    await showNotice("Extraction Tuning", "Extraction tuning settings saved.");

    await configureFieldGroup("Awareness Tuning", AWARENESS_TUNING_FIELDS);
    await showNotice("Awareness Tuning", "Awareness tuning settings saved.");
  }

  await showNotice("Evidence OS", "Evidence OS settings saved.");
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

