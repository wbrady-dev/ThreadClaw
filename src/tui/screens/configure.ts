import prompts from "prompts";
import ora from "ora";
import { execFileSync } from "child_process";
import { existsSync, unlinkSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { section, kvLine, t, clearScreen } from "../theme.js";
import {
  readConfig,
  writeConfig,
  getRootDir,
  getDataDir,
  getPythonCmd,
  getApiPort,
  getModelBaseUrl,
} from "../platform.js";
import {
  EMBED_MODELS,
  RERANK_MODELS,
  CLOUD_EMBED_PROVIDERS,
  CLOUD_RERANK_PROVIDERS,
  detectGpu,
  getRecommendation,
  type ModelInfo,
} from "../models.js";
import { selectMenu } from "../menu.js";

export type ConfigureAction =
  | "embed"
  | "rerank"
  | "expansion"
  | "search"
  | "parser"
  | "ocr"
  | "audio"
  | "evidence"
  | "watch"
  | "general";

export async function runConfigure(): Promise<void> {
  const root = getRootDir();
  const python = getPythonCmd();

  while (true) {
    clearScreen();

    const config = readConfig();

    if (config) {
      // Read .env for additional info
      let envData = "";
      try {
        const envPath = resolve(root, ".env");
        if (existsSync(envPath)) envData = readFileSync(envPath, "utf-8");
      } catch {}
      const envVal = (key: string, fb: string) => envData.match(new RegExp(`${key}=(.*)`))?.[1]?.trim() ?? fb;

      console.log(section("Configuration"));

      // Models
      console.log(t.dim("  Models"));
      console.log(kvLine("  Embed", config.embed_model));
      console.log(kvLine("  Rerank", config.rerank_model));
      console.log(kvLine("  Query Expansion", getExpansionStatus(root)));
      console.log(kvLine("  Document Parser", formatDoclingDevice(config.docling_device)));

      // Automation
      const wp = getWatchPaths(root);
      console.log(t.dim("\n  Automation"));
      console.log(kvLine("  Watch Paths", wp.length > 0 ? t.ok(`${wp.length} active`) : t.dim("none")));
      console.log(kvLine("  Watch Debounce", `${envVal("WATCH_DEBOUNCE_MS", "3000")}ms`));

      // Network
      console.log(t.dim("\n  Network"));
      console.log(kvLine("  Model Server", getModelBaseUrl()));
      console.log(kvLine("  ClawCore API Port", String(getApiPort())));
      const expUrl = envVal("QUERY_EXPANSION_URL", "http://127.0.0.1:1234/v1");
      const expEnabled = envVal("QUERY_EXPANSION_ENABLED", "false") === "true";
      if (expEnabled) console.log(kvLine("  Expansion LLM", expUrl));
      console.log(kvLine("  Data Directory", envVal("CLAWCORE_DATA_DIR", "./data")));

      // Search & Ingestion
      console.log(t.dim("\n  Defaults"));
      console.log(kvLine("  Collection", envVal("DEFAULT_COLLECTION", "default")));
      console.log(kvLine("  Results/Query", envVal("QUERY_TOP_K", "10")));
      console.log(kvLine("  Token Budget", envVal("QUERY_TOKEN_BUDGET", "4000")));
      console.log(kvLine("  Chunk Size", `${envVal("CHUNK_TARGET_TOKENS", "512")} target, ${envVal("CHUNK_MAX_TOKENS", "1024")} max, ${envVal("CHUNK_MIN_TOKENS", "100")} min`));

      // Evidence OS
      const relEnabled = envVal("CLAWCORE_MEMORY_RELATIONS_ENABLED", "false") === "true";
      console.log(t.dim("\n  Evidence OS"));
      console.log(kvLine("  Relations", relEnabled ? t.ok("enabled") : t.dim("disabled")));
      if (relEnabled) {
        console.log(kvLine("  Awareness", envVal("CLAWCORE_MEMORY_RELATIONS_AWARENESS_ENABLED", "false") === "true" ? t.ok("on") : t.dim("off")));
        console.log(kvLine("  Claim Extraction", envVal("CLAWCORE_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED", "false") === "true" ? t.ok("on") : t.dim("off")));
        console.log(kvLine("  Attempt Tracking", envVal("CLAWCORE_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED", "false") === "true" ? t.ok("on") : t.dim("off")));
        const deepOn = envVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED", "false") === "true";
        console.log(kvLine("  Deep Extraction", deepOn ? t.ok("on") : t.dim("off")));
        if (deepOn) {
          const deepModel = envVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL", "");
          const deepProvider = envVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER", "");
          console.log(kvLine("    Model", deepModel || t.dim("(uses summary model)")));
          if (deepProvider) console.log(kvLine("    Provider", deepProvider));
        }
        console.log(kvLine("  Context Tier", envVal("CLAWCORE_MEMORY_RELATIONS_CONTEXT_TIER", "standard")));
      }

      console.log("");
    }

    console.log(t.dim("  Choose a section:\n"));
    const what = await selectMenu([
      { label: "Embedding model", value: "embed" },
      { label: "Reranker model", value: "rerank" },
      { label: "Query Expansion", value: "expansion" },
      { label: "Search Tuning", value: "search" },
      { label: "Document Parser (Docling)", value: "parser" },
      { label: "Image OCR (Tesseract)", value: "ocr" },
      { label: "Audio Transcription (Whisper)", value: "audio" },
      { label: "Evidence OS", value: "evidence" },
      { label: "Watch Paths", value: "watch" },
      { label: "Ports & Defaults", value: "general" },
      { label: "Back", value: "back", color: t.dim },
    ]);

    if (!what || what === "back") return;
    await runConfigureActionInternal(what as ConfigureAction, config, root, python);

    // Brief pause to read success message, then loop back
    await new Promise((r) => setTimeout(r, 800));
  }
}

export async function runConfigureAction(action: ConfigureAction): Promise<void> {
  const root = getRootDir();
  const python = getPythonCmd();
  const config = readConfig();
  await runConfigureActionInternal(action, config, root, python);
}

async function runConfigureActionInternal(
  action: ConfigureAction,
  config: ReturnType<typeof readConfig>,
  root: string,
  python: string,
): Promise<void> {
  if (action === "embed") await changeEmbedModel(config, root, python);
  if (action === "rerank") await changeRerankModel(config, root, python);
  if (action === "parser") await changeParser(config);
  if (action === "expansion") await changeExpansion(root);
  if (action === "search") await changeSearchTuning(root);
  if (action === "ocr") await changeOcrSettings(root);
  if (action === "audio") await changeAudioTranscription(root);
  if (action === "evidence") await changeEvidenceSettings(root);
  if (action === "watch") await configureWatchPaths(root);
  if (action === "general") await changeGeneralSettings(root);
}

async function changeEmbedModel(
  config: ReturnType<typeof readConfig>,
  root: string,
  python: string,
): Promise<void> {
  clearScreen();
  console.log(section("Select Embedding Model"));
  const gpu = detectGpu();

  const modelId = await buildModelSelector(EMBED_MODELS, gpu, 0);
  if (!modelId) return;

  if (modelId === "__cloud__") {
    await setupCloudModel(null, root, config, "embed");
    return;
  }

  let choice: ModelInfo | null = null;
  if (modelId === "__custom__") {
    choice = await handleCustomModel("embed", python);
    if (!choice) return;
  } else {
    choice = EMBED_MODELS.find((m) => m.id === modelId) ?? null;
    if (!choice) return;
  }

  console.log(t.warn("\n  Changing embedding model requires deleting the database and re-ingesting."));
  console.log(t.dim("  Vectors from different models are incompatible.\n"));

  let embedCancelled = false;
  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: "Delete database and apply?",
    initial: false,
  }, { onCancel: () => { embedCancelled = true; } });
  if (embedCancelled || !confirm) return;

  const newConfig = {
    embed_model: choice.id,
    rerank_model: config?.rerank_model ?? "",
    trust_remote_code: choice.trustRemoteCode || (config?.trust_remote_code ?? false),
    docling_device: config?.docling_device ?? "off",
  };
  writeConfig(newConfig);

  const dbPath = resolve(getDataDir(), "clawcore.db");
  if (existsSync(dbPath)) unlinkSync(dbPath);

  updateEnvValues(root, {
    EMBEDDING_MODEL: choice.id,
    EMBEDDING_DIMENSIONS: String(choice.dims),
  });

  const sp = ora(`Downloading ${choice.name}...`).start();
  try {
    const trustArg = choice.trustRemoteCode ? ", trust_remote_code=True" : "";
    execFileSync(python, ["-c", `from sentence_transformers import SentenceTransformer; SentenceTransformer('${choice.id}'${trustArg})`], { stdio: "pipe", timeout: 600000 });
    sp.succeed(`${choice.name} ready. Restart services and re-ingest documents.`);
  } catch {
    sp.warn("Download failed. Will retry on server start.");
  }
}

async function changeRerankModel(
  config: ReturnType<typeof readConfig>,
  root: string,
  python: string,
): Promise<void> {
  clearScreen();
  console.log(section("Select Reranking Model"));
  const gpu = detectGpu();
  const embedVram = EMBED_MODELS.find((m) => m.id === config?.embed_model)?.vramMb ?? 0;

  const modelId = await buildModelSelector(RERANK_MODELS, gpu, embedVram);
  if (!modelId) return;

  if (modelId === "__cloud__") {
    await setupCloudModel(null, root, config, "rerank");
    return;
  }

  let choice: ModelInfo | null = null;
  if (modelId === "__custom__") {
    choice = await handleCustomModel("rerank", python);
    if (!choice) return;
  } else {
    choice = RERANK_MODELS.find((m) => m.id === modelId) ?? null;
    if (!choice) return;
  }

  const newConfig = {
    embed_model: config?.embed_model ?? "",
    rerank_model: choice.id,
    trust_remote_code: choice.trustRemoteCode || (config?.trust_remote_code ?? false),
    docling_device: config?.docling_device ?? "off",
  };
  writeConfig(newConfig);

  const sp = ora(`Downloading ${choice.name}...`).start();
  try {
    const trustArg = choice.trustRemoteCode ? ", trust_remote_code=True" : "";
    execFileSync(python, ["-c", `from sentence_transformers import CrossEncoder; CrossEncoder('${choice.id}'${trustArg})`], { stdio: "pipe", timeout: 600000 });
    sp.succeed(`${choice.name} ready. Restart services to apply.`);
  } catch {
    sp.warn("Download failed. Will retry on server start.");
  }
}

async function changeParser(config: ReturnType<typeof readConfig>): Promise<void> {
  clearScreen();
  console.log(section("Document Parser"));

  const current = formatDoclingDevice(config?.docling_device);
  console.log(kvLine("Current", current));
  console.log("");

  const parserId = await selectMenu([
    { label: "Standard (built-in, lightweight)", value: "off" },
    { label: "Docling CPU (layout-aware, OCR, 109 languages, no VRAM)", value: "cpu", description: "Adds ~500MB" },
    { label: "Docling GPU (~8GB VRAM during parse only)", value: "gpu", description: "For 20GB+ GPUs" },
    { label: "Back", value: "back", color: t.dim },
  ]);

  if (!parserId || parserId === "back") return;

  if (parserId !== "off") {
    // Check if Docling is already installed
    let alreadyInstalled = false;
    try {
      const python = getPythonCmd();
      execFileSync(python, ["-c", "import docling"], { stdio: "pipe", timeout: 10000 });
      alreadyInstalled = true;
    } catch {}

    if (!alreadyInstalled) {
      console.log(t.warn("\n  Docling needs to be installed (~500MB download)."));
      let cancelled = false;
      const { confirm } = await prompts({
        type: "confirm",
        name: "confirm",
        message: "Install Docling now?",
        initial: true,
      }, { onCancel: () => { cancelled = true; } });
      if (cancelled) return;

      if (confirm) {
        const sp = ora("Installing Docling (this may take a few minutes)...").start();
        try {
          execFileSync("pip", ["install", "docling"], { stdio: "pipe", timeout: 600000 });
          sp.succeed("Docling installed");
        } catch {
          sp.warn("Docling install failed. Standard parser will be used.");
          return;
        }
      } else {
        return;
      }
    }
  }

  const newConfig = {
    ...(config ?? { embed_model: "", rerank_model: "", trust_remote_code: false }),
    docling_device: parserId,
  };
  writeConfig(newConfig);
  console.log(t.ok("\n  Parser updated. Restart services to apply."));
}

async function changeExpansion(root: string): Promise<void> {
  clearScreen();
  console.log(section("Query Expansion"));
  console.log(t.dim("  Uses a chat LLM to rephrase queries for better recall."));
  console.log(t.dim("  Works with local (LM Studio, Ollama) or cloud (OpenAI, Anthropic, etc.).\n"));

  const currentStatus = getExpansionStatus(root);
  console.log(kvLine("Status", currentStatus === "off" ? t.dim("off") : t.ok(currentStatus)));
  console.log("");

  const action = await selectMenu([
    { label: "Enable / Configure", value: "enable" },
    { label: "Disable", value: "disable" },
    { label: "Back", value: "back", color: t.dim },
  ]);

  if (!action || action === "back") return;

  if (action === "disable") {
    updateEnvValues(root, { QUERY_EXPANSION_ENABLED: "false" });
    console.log(t.ok("\n  Query expansion disabled."));
    return;
  }

  // Enable flow — use prompts for text input
  console.log("");
  let cancelled = false;
  const onCancel = () => { cancelled = true; };

  const { url } = await prompts({
    type: "text",
    name: "url",
    message: "Chat LLM endpoint URL",
    initial: "http://127.0.0.1:1234/v1",
  }, { onCancel });
  if (cancelled || !url) return;

  const { model } = await prompts({
    type: "text",
    name: "model",
    message: "Model name",
    initial: "",
  }, { onCancel });
  if (cancelled || !model) return;

  const { apiKey } = await prompts({
    type: "password",
    name: "apiKey",
    message: "API key (leave empty for local models)",
  }, { onCancel });
  if (cancelled) return;

  const updates: Record<string, string> = {
    QUERY_EXPANSION_ENABLED: "true",
    QUERY_EXPANSION_URL: url,
    QUERY_EXPANSION_MODEL: model,
  };
  if (apiKey) updates.QUERY_EXPANSION_API_KEY = apiKey;

  updateEnvValues(root, updates);
  console.log(t.ok("\n  Query expansion enabled. Restart ClawCore to apply."));
}

// ── Image OCR ──

async function changeOcrSettings(root: string): Promise<void> {
  clearScreen();
  console.log(section("Image OCR (Tesseract)"));
  console.log("");
  console.log(t.dim("  Extract text from images — screenshots, scanned pages, whiteboards."));
  console.log(t.dim("  Uses Tesseract OCR. Runs locally on CPU. No API key needed.\n"));
  console.log(t.label("  Supported formats:\n"));
  console.log(t.dim("  .png, .jpg, .jpeg, .gif, .webp, .bmp, .tiff\n"));

  // Check if Tesseract is installed
  let installed = false;
  try {
    execFileSync("tesseract", ["--version"], { stdio: "pipe", timeout: 5000 });
    installed = true;
  } catch {}

  if (installed) {
    console.log(`  ${t.ok("✓")} Tesseract is installed and ready`);
    console.log(t.dim("  Image OCR is always active when Tesseract is available."));
    console.log(t.dim("  No configuration needed — just ingest images and they'll be OCR'd.\n"));
  } else {
    console.log(`  ${t.warn("⚠")} Tesseract is not installed`);
    console.log(t.dim("  Images will ingest but text won't be extracted.\n"));

    const choice = await selectMenu([
      { label: "Install Tesseract now", value: "install" },
      { label: "Back", value: "back", color: t.dim },
    ]);

    if (choice === "install") {
      const sp = ora("Installing Tesseract OCR...").start();
      try {
        const platform = process.platform;
        if (platform === "win32") {
          try {
            execFileSync("winget", ["install", "UB-Mannheim.TesseractOCR", "--accept-source-agreements", "--accept-package-agreements"], { stdio: "pipe", timeout: 120000 });
          } catch {
            execFileSync("choco", ["install", "tesseract", "-y"], { stdio: "pipe", timeout: 120000 });
          }
        } else if (platform === "darwin") {
          execFileSync("brew", ["install", "tesseract"], { stdio: "pipe", timeout: 120000 });
        } else {
          try {
            execFileSync("sudo", ["apt", "install", "-y", "tesseract-ocr"], { stdio: "pipe", timeout: 120000 });
          } catch {
            execFileSync("sudo", ["yum", "install", "-y", "tesseract"], { stdio: "pipe", timeout: 120000 });
          }
        }
        sp.succeed("Tesseract installed");
      } catch {
        sp.warn("Install failed. Try manually: https://github.com/UB-Mannheim/tesseract/wiki");
      }
    }
    return;
  }

  await selectMenu([
    { label: "Back", value: "back", color: t.dim },
  ]);
}

// ── Audio Transcription ──

async function changeAudioTranscription(root: string): Promise<void> {
  const envPath = resolve(root, ".env");
  let envData = "";
  try {
    envData = readFileSync(envPath, "utf-8");
  } catch {
    try { writeFileSync(envPath, "# ClawCore Configuration\n"); envData = "# ClawCore Configuration\n"; } catch (e: any) {
      console.log(t.err(`\n  Cannot read or create .env at ${envPath}: ${e.message}\n`));
      await new Promise((r) => setTimeout(r, 2000));
      return;
    }
  }

  const getVal = (key: string, fallback: string) =>
    envData.match(new RegExp(`${key}=([^\\n]*)`))?.[1]?.trim() ?? fallback;

  const enabled = getVal("AUDIO_TRANSCRIPTION_ENABLED", "false") === "true";
  const model = getVal("WHISPER_MODEL", "base");

  clearScreen();
  console.log(section("Audio Transcription"));
  console.log(kvLine("Status", enabled ? t.ok("enabled") : t.dim("disabled")));
  console.log(kvLine("Model", t.value(model)));
  console.log(kvLine("Mode", t.dim("Local Whisper transcription")));
  console.log("");

  const choice = await selectMenu([
    { label: enabled ? "Disable transcription" : "Enable transcription", value: "toggle" },
    { label: "Change model", value: "model" },
    { label: "Back", value: "back", color: t.dim },
  ]);

  if (!choice || choice === "back") return;

  if (choice === "toggle") {
    const newVal = enabled ? "false" : "true";
    updateEnvValues(root, { AUDIO_TRANSCRIPTION_ENABLED: newVal });
    console.log(t.ok(`\n  Audio transcription ${newVal === "true" ? "enabled" : "disabled"}. Changes take effect immediately.\n`));
    await new Promise((r) => setTimeout(r, 1500));
  } else if (choice === "model") {
    const modelChoice = await selectMenu([
      { label: "tiny (~40MB, fastest)", value: "tiny" },
      { label: "base (~150MB, recommended)", value: "base" },
      { label: "small (~500MB, better quality)", value: "small" },
      { label: "medium (~1.5GB, high quality)", value: "medium" },
      { label: "large (~3GB, best quality)", value: "large" },
    ]);
    if (modelChoice) {
      updateEnvValues(root, { WHISPER_MODEL: modelChoice, AUDIO_TRANSCRIPTION_ENABLED: "true" });
      console.log(t.ok(`\n  Whisper model set to ${modelChoice}. Transcription enabled. Model change requires restart.\n`));
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// ── Search Tuning ──

async function changeSearchTuning(root: string): Promise<void> {
  const envPath = resolve(root, ".env");
  let envData = "";
  try {
    envData = readFileSync(envPath, "utf-8");
  } catch {
    try { writeFileSync(envPath, "# ClawCore Configuration\n"); envData = "# ClawCore Configuration\n"; } catch (e: any) {
      console.log(t.err(`\n  Cannot read or create .env at ${envPath}: ${e.message}\n`));
      await new Promise((r) => setTimeout(r, 2000));
      return;
    }
  }

  const getVal = (key: string, fallback: string) =>
    envData.match(new RegExp(`${key}=([^\\n]*)`))?.[1]?.trim() ?? fallback;

  const values: Record<string, string> = {
    RERANK_SCORE_THRESHOLD: getVal("RERANK_SCORE_THRESHOLD", "0.0"),
    RERANK_TOP_K: getVal("RERANK_TOP_K", "20"),
    RERANK_SMART_SKIP: getVal("RERANK_SMART_SKIP", "true"),
    RERANK_DISABLED: getVal("RERANK_DISABLED", "false"),
    EMBEDDING_SIMILARITY_THRESHOLD: getVal("EMBEDDING_SIMILARITY_THRESHOLD", "1.05"),
    EMBEDDING_PREFIX_MODE: getVal("EMBEDDING_PREFIX_MODE", "auto"),
    EMBEDDING_BATCH_SIZE: getVal("EMBEDDING_BATCH_SIZE", "32"),
  };

  while (true) {
    clearScreen();
    console.log(section("Search Tuning"));

    // Build menu items showing current values
    const rerankOn = values.RERANK_DISABLED !== "true";
    const smartOn = values.RERANK_SMART_SKIP === "true";

    console.log(kvLine("Rerank Threshold", values.RERANK_SCORE_THRESHOLD));
    console.log(kvLine("Rerank Candidates", values.RERANK_TOP_K));
    console.log(kvLine("Smart Skip", smartOn ? t.ok("on") : t.dim("off")));
    console.log(kvLine("Reranking", rerankOn ? t.ok("enabled") : t.warn("disabled")));
    console.log(kvLine("Similarity Gate", values.EMBEDDING_SIMILARITY_THRESHOLD));
    console.log(kvLine("Prefix Mode", values.EMBEDDING_PREFIX_MODE));
    console.log(kvLine("Embed Batch Size", values.EMBEDDING_BATCH_SIZE));
    console.log("");

    const choice = await selectMenu([
      { label: `Rerank Threshold      ${t.value(values.RERANK_SCORE_THRESHOLD)}`,
        value: "threshold", description: "Min score to keep a result (0.0 = keep all, 0.1-0.3 = filter weak)" },
      { label: `Rerank Candidates     ${t.value(values.RERANK_TOP_K)}`,
        value: "topk", description: "How many candidates hit the cross-encoder (higher = slower but better)" },
      { label: `Smart Skip            ${smartOn ? t.ok("on") : t.dim("off")}`,
        value: "smart", description: "Auto-skip reranking when top result clearly dominates (saves 50-200ms)" },
      { label: `Reranking             ${rerankOn ? t.ok("enabled") : t.warn("disabled")}`,
        value: "toggle", description: "Enable/disable cross-encoder reranking entirely" },
      { label: `Similarity Gate       ${t.value(values.EMBEDDING_SIMILARITY_THRESHOLD)}`,
        value: "sim", description: "Max L2 distance for vector matches (0.95 = strict, 1.15 = loose)" },
      { label: `Prefix Mode           ${t.value(values.EMBEDDING_PREFIX_MODE)}`,
        value: "prefix", description: "query:/passage: prefix handling (auto, always, never)" },
      { label: `Embed Batch Size      ${t.value(values.EMBEDDING_BATCH_SIZE)}`,
        value: "batch", description: "Embeddings per request during ingestion" },
      { label: "Save & Back", value: "save", color: t.dim },
    ]);

    if (!choice || choice === "save") break;

    if (choice === "threshold") {
      const val = await numberInput("Rerank score threshold", values.RERANK_SCORE_THRESHOLD, 0, 1, 0.01);
      if (val != null) values.RERANK_SCORE_THRESHOLD = val;
    } else if (choice === "topk") {
      const val = await numberInput("Rerank candidates (top-K)", values.RERANK_TOP_K, 1, 100, 1);
      if (val != null) values.RERANK_TOP_K = val;
    } else if (choice === "smart") {
      values.RERANK_SMART_SKIP = values.RERANK_SMART_SKIP === "true" ? "false" : "true";
    } else if (choice === "toggle") {
      values.RERANK_DISABLED = values.RERANK_DISABLED === "true" ? "false" : "true";
    } else if (choice === "sim") {
      const val = await numberInput("Similarity gate (L2 distance)", values.EMBEDDING_SIMILARITY_THRESHOLD, 0.5, 2.0, 0.01);
      if (val != null) values.EMBEDDING_SIMILARITY_THRESHOLD = val;
    } else if (choice === "prefix") {
      const modes = ["auto", "always", "never"];
      const idx = modes.indexOf(values.EMBEDDING_PREFIX_MODE);
      values.EMBEDDING_PREFIX_MODE = modes[(idx + 1) % modes.length];
    } else if (choice === "batch") {
      const val = await numberInput("Embed batch size", values.EMBEDDING_BATCH_SIZE, 1, 256, 1);
      if (val != null) values.EMBEDDING_BATCH_SIZE = val;
    }
  }

  updateEnvValues(root, values);
  console.log(t.ok("\n  Search tuning saved. Changes take effect immediately.\n"));
  await new Promise((r) => setTimeout(r, 1500));
}

/** Prompt for a numeric value using the select menu's text input. */
async function numberInput(label: string, current: string, min: number, max: number, step: number): Promise<string | null> {
  clearScreen();
  console.log(section(label));
  console.log("");
  console.log(t.dim(`  Current: ${current}`));
  console.log(t.dim(`  Range: ${min} – ${max}\n`));

  const p = (await import("prompts")).default;
  let cancelled = false;
  const { value } = await p({
    type: "text", name: "value",
    message: label,
    initial: current,
    validate: (v: string) => {
      const n = parseFloat(v);
      if (isNaN(n)) return "Must be a number";
      if (n < min || n > max) return `Must be ${min}–${max}`;
      return true;
    },
  }, { onCancel: () => { cancelled = true; } });

  if (cancelled || value === undefined) return null;
  return String(step >= 1 ? parseInt(value, 10) : parseFloat(value));
}

// ── Ports & Defaults ──

interface Setting {
  key: string;
  envKey: string;
  label: string;
  description: string;
  fallback: string;
  group: string;
  transform?: (val: string) => Record<string, string>;
}

const SETTINGS: Setting[] = [
  {
    key: "modelServerUrl", envKey: "RERANKER_URL", label: "Model Server URL",
    description: "Full URL for the embedding & reranking server",
    fallback: "http://127.0.0.1:8012", group: "Network",
    transform: (val) => {
      const base = val.replace(/\/+$/, "");
      return {
        EMBEDDING_URL: `${base}/v1`,
        RERANKER_URL: base,
      };
    },
  },
  {
    key: "clawcorePort", envKey: "CLAWCORE_PORT", label: "ClawCore API Port",
    description: "HTTP port for the RAG search API",
    fallback: "18800", group: "Network",
  },
  {
    key: "expansionUrl", envKey: "QUERY_EXPANSION_URL", label: "Expansion LLM URL",
    description: "Chat LLM endpoint for query expansion (if enabled)",
    fallback: "http://127.0.0.1:1234/v1", group: "Network",
  },
  {
    key: "dataDir", envKey: "CLAWCORE_DATA_DIR", label: "Data Directory",
    description: "Where the database and ingested data are stored",
    fallback: "./data", group: "Network",
  },
  {
    key: "defaultCollection", envKey: "DEFAULT_COLLECTION", label: "Default Collection",
    description: "Collection used when none is specified",
    fallback: "default", group: "Search",
  },
  {
    key: "topK", envKey: "QUERY_TOP_K", label: "Results Per Query",
    description: "Number of chunks returned per search",
    fallback: "10", group: "Search",
  },
  {
    key: "tokenBudget", envKey: "QUERY_TOKEN_BUDGET", label: "Token Budget",
    description: "Max tokens in search response context",
    fallback: "4000", group: "Search",
  },
  {
    key: "chunkMax", envKey: "CHUNK_MAX_TOKENS", label: "Max Chunk Size",
    description: "Maximum tokens per chunk during ingestion",
    fallback: "1024", group: "Ingestion",
  },
  {
    key: "chunkTarget", envKey: "CHUNK_TARGET_TOKENS", label: "Target Chunk Size",
    description: "Preferred chunk size for prose splitting",
    fallback: "512", group: "Ingestion",
  },
  {
    key: "chunkMin", envKey: "CHUNK_MIN_TOKENS", label: "Min Chunk Size",
    description: "Chunks smaller than this are merged with neighbors",
    fallback: "100", group: "Ingestion",
  },
  {
    key: "watchDebounce", envKey: "WATCH_DEBOUNCE_MS", label: "Watch Debounce",
    description: "Delay (ms) before auto-ingesting a changed file",
    fallback: "3000", group: "Automation",
  },
];

async function changeGeneralSettings(root: string): Promise<void> {
  const envPath = resolve(root, ".env");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  const getEnv = (key: string, fallback: string): string => {
    const match = env.match(new RegExp(`${key}=(.*)`));
    return match?.[1]?.trim() ?? fallback;
  };

  // Build settings list with current values
  const items = SETTINGS.map((s) => ({
    ...s,
    current: getEnv(s.envKey, s.fallback),
  }));

  // Group and display
  let currentGroup = "";
  const menuItems = items.map((item) => {
    let prefix = "";
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      prefix = item.group;
    }
    return {
      ...item,
      groupHeader: prefix,
    };
  });

  // Show as a selectable list — pick one to edit
  while (true) {
    clearScreen();
    console.log(section("Ports & Defaults"));

    // Display current settings grouped
    let lastGroup = "";
    for (const item of menuItems) {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        console.log(t.dim(`\n  ${item.group}`));
      }
      console.log(`  ${t.label(item.label.padEnd(22))} ${t.ok(item.current.padEnd(8))} ${t.dim(item.description)}`);
    }

    console.log("");

    const editItems = [
      ...menuItems.map((m) => ({
        label: `${m.label.padEnd(22)} ${t.dim(m.current)}`,
        value: m.key,
      })),
      { label: "Back", value: "back", color: t.dim },
    ];

    const choice = await selectMenu(editItems);
    if (!choice || choice === "back") return;

    const setting = menuItems.find((m) => m.key === choice);
    if (!setting) continue;

    console.log(`\n  ${t.label(setting.label)}`);
    console.log(`  ${t.dim(setting.description)}\n`);

    let editCancelled = false;
    const { newValue } = await prompts({
      type: "text",
      name: "newValue",
      message: setting.label,
      initial: setting.current,
    }, { onCancel: () => { editCancelled = true; } });

    if (!editCancelled && newValue !== undefined && newValue !== setting.current) {
      if (setting.transform) {
        updateEnvValues(root, setting.transform(newValue));
      } else {
        updateEnvValues(root, { [setting.envKey]: newValue });
      }
      setting.current = newValue;
      console.log(t.ok("  Saved. Restart to apply."));
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

// ── Cloud Model Setup ──

async function setupCloudModel(
  _choice: ModelInfo | null,
  root: string,
  config: ReturnType<typeof readConfig>,
  type: "embed" | "rerank",
): Promise<void> {
  const providers = type === "embed" ? CLOUD_EMBED_PROVIDERS : CLOUD_RERANK_PROVIDERS;

  console.log(section("Cloud Provider"));

  // Pick provider
  const providerItems = providers.map((p) => ({
    label: p.name,
    value: p.name,
    description: p.hint,
  }));
  providerItems.push({ label: "Back", value: "back", color: t.dim } as any);

  const providerName = await selectMenu(providerItems);
  if (!providerName || providerName === "back") return;

  const provider = providers.find((p) => p.name === providerName)!;

  // API URL
  console.log("");
  let cloudCancelled = false;
  const cloudOnCancel = () => { cloudCancelled = true; };

  const { apiUrl } = await prompts({
    type: "text",
    name: "apiUrl",
    message: "API endpoint URL",
    initial: provider.apiUrl || "https://",
  }, { onCancel: cloudOnCancel });
  if (cloudCancelled || !apiUrl) return;

  // Model name
  console.log(t.dim(`\n  ${provider.hint}\n`));
  const { modelName } = await prompts({
    type: "text",
    name: "modelName",
    message: "Model name",
  }, { onCancel: cloudOnCancel });
  if (cloudCancelled || !modelName) return;

  // Dimensions (for embed only)
  let dims = 0;
  if (type === "embed") {
    const { dimensions } = await prompts({
      type: "text",
      name: "dimensions",
      message: "Embedding dimensions (check provider docs)",
      initial: "1536",
    }, { onCancel: cloudOnCancel });
    if (cloudCancelled) return;
    dims = parseInt(dimensions) || 1536;
  }

  // API key
  const { apiKey } = await prompts({
    type: "password",
    name: "apiKey",
    message: `${provider.name} API key`,
  }, { onCancel: cloudOnCancel });
  if (cloudCancelled || !apiKey) return;

  // Apply
  if (type === "embed") {
    console.log(t.warn("\n  Changing embedding model requires deleting the database."));
    const { confirm } = await prompts({
      type: "confirm",
      name: "confirm",
      message: "Delete database and apply?",
      initial: false,
    }, { onCancel: cloudOnCancel });
    if (cloudCancelled || !confirm) return;

    const dbPath = resolve(getDataDir(), "clawcore.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);

    updateEnvValues(root, {
      EMBEDDING_URL: apiUrl.replace(/\/+$/, ""),
      EMBEDDING_MODEL: modelName,
      EMBEDDING_DIMENSIONS: String(dims),
      EMBEDDING_API_KEY: apiKey,
    });

    writeConfig({
      embed_model: `${provider.name}/${modelName}`,
      rerank_model: config?.rerank_model ?? "",
      trust_remote_code: false,
      docling_device: config?.docling_device ?? "off",
    });
  } else {
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
    });
  }

  console.log(t.ok(`\n  ${provider.name} ${modelName} configured.`));
  console.log(t.dim("  No local model server needed for this model."));
  if (type === "embed") console.log(t.dim("  Re-ingest documents after restarting."));
}

// ── Custom Model Support ──

async function handleCustomModel(
  type: "embed" | "rerank",
  python: string,
): Promise<ModelInfo | null> {
  console.log(section("Custom HuggingFace Model"));
  console.log(t.dim("  Enter any model ID from huggingface.co (e.g., BAAI/bge-large-en-v1.5)\n"));

  let customCancelled = false;
  const customOnCancel = () => { customCancelled = true; };

  const { modelId } = await prompts({
    type: "text",
    name: "modelId",
    message: "HuggingFace model ID",
  }, { onCancel: customOnCancel });

  if (customCancelled || !modelId) return null;

  // Test if model works
  const sp = ora(`Testing ${modelId}...`).start();
  try {
    let dims = 0;
    if (type === "embed") {
      const output = execFileSync(python, ["-c", `from sentence_transformers import SentenceTransformer; m = SentenceTransformer('${modelId}', trust_remote_code=True); print(m.get_sentence_embedding_dimension())`], {
        stdio: "pipe", timeout: 600000,
      }).toString().trim();
      dims = parseInt(output) || 0;
      sp.succeed(`${modelId} works! Dimensions: ${dims}`);
    } else {
      execFileSync(python, ["-c", `from sentence_transformers import CrossEncoder; CrossEncoder('${modelId}', trust_remote_code=True)`], {
        stdio: "pipe", timeout: 600000,
      });
      sp.succeed(`${modelId} works!`);
    }

    const { trustRemote } = await prompts({
      type: "confirm",
      name: "trustRemote",
      message: "Does this model need trust_remote_code?",
      initial: true,
    }, { onCancel: customOnCancel });
    if (customCancelled) return null;

    return {
      id: modelId,
      name: modelId.split("/").pop() ?? modelId,
      dims,
      vramMb: 0,
      sizeMb: 0,
      tier: "Custom",
      qualityScore: 5,
      languages: "Unknown",
      trustRemoteCode: trustRemote,
      gated: false,
      notes: "Custom model",
    };
  } catch (err) {
    sp.fail(`${modelId} failed to load. Check the model ID and try again.`);
    console.log(t.dim(`  Error: ${String(err).slice(0, 200)}`));
    return null;
  }
}

// ── Helpers ──

function buildModelSelector(
  models: ModelInfo[],
  gpu: ReturnType<typeof detectGpu>,
  otherVram: number,
): Promise<string | null> {
  const formatted = models.map((model) => {
    let badge = "";
    if (model.cloud) {
      badge = t.info(" ☁");
    } else {
      const rec = getRecommendation(model, gpu, otherVram);
      if (rec === "recommended") badge = t.ok(" ★");
      else if (rec === "fits") badge = t.info(" ✓");
      else if (rec === "tight") badge = t.warn(" ⚠");
      else if (rec === "too-large") badge = t.err(" ✗");
    }

    return {
      id: model.id,
      label: model.name,
      vram: model.cloud ? "CLOUD" : `${model.vramMb} MB`,
      quality: model.tier,
      qualityColor: tierColorFn(model.qualityScore),
      badge,
      description: model.cloud ? `${model.cloud.provider} — ${model.notes}` : model.notes,
    };
  });

  const items: { label: string; value: string; color?: (s: string) => string; description?: string }[] = formatted.map((model) => ({
    label: `${model.label.padEnd(24)} ${t.dim(model.vram.padEnd(9))} ${model.qualityColor(model.quality.padEnd(10))}${model.badge}`,
    value: model.id,
    description: model.description,
  }));

  items.push({
    label: t.info("Cloud provider"),
    value: "__cloud__",
    description: "OpenAI, Cohere, Voyage AI, Google, and more",
    color: t.info,
  });
  items.push({
    label: t.info("+ Custom local model"),
    value: "__custom__",
    description: "Enter any HuggingFace model ID",
    color: t.info,
  });
  items.push({
    label: "Back",
    value: "__back__",
    color: t.dim,
  });

  console.log(t.dim(`  ${t.ok("*")} = good fit for your hardware  ${t.info("cloud")} = hosted (no GPU needed)\n`));
  console.log(t.dim(`  ${"Model".padEnd(26)} ${"VRAM".padEnd(9)} ${"Type".padEnd(10)}`));

  return selectMenu(items);
}

function tierColorFn(score: number): (s: string) => string {
  if (score <= 4) return t.dim;
  if (score <= 5) return t.muted;
  if (score <= 6) return t.info;
  if (score <= 7) return t.ok;
  if (score <= 8) return t.warn;
  return t.err;
}

export function getExpansionStatus(root: string): string {
  try {
    const envPath = resolve(root, ".env");
    if (existsSync(envPath)) {
      const env = readFileSync(envPath, "utf-8");
      const enabled = env.match(/QUERY_EXPANSION_ENABLED=(\w+)/)?.[1];
      const model = env.match(/QUERY_EXPANSION_MODEL=(.+)/)?.[1]?.trim();
      if (enabled === "true" && model) return model;
    }
  } catch {}
  return "off";
}

export function formatDoclingDevice(device?: string): string {
  if (!device || device === "off") return "Standard (built-in)";
  if (device === "cpu") return "Docling (CPU)";
  return "Docling (GPU)";
}

function updateEnvValues(root: string, values: Record<string, string>): void {
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) return;
  let env = readFileSync(envPath, "utf-8");
  for (const [key, value] of Object.entries(values)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(env)) {
      env = env.replace(regex, `${key}=${value}`);
    } else {
      // Key doesn't exist yet — append it
      env = env.trimEnd() + `\n${key}=${value}\n`;
    }
  }
  writeFileSync(envPath, env);
}

// ── Watch Paths ──

interface WatchEntry {
  path: string;
  collection: string;
  enabled: boolean;
  depth: number;
  children?: WatchEntry[];
  expanded?: boolean;
  isCustom?: boolean;
}

export async function configureWatchPaths(root: string): Promise<void> {
  const currentWatchEntries = getWatchPaths(root);
  const currentPaths = new Set(currentWatchEntries.map((w) => w.path));

  // Saved paths shown at top for easy toggle
  const savedEntries: WatchEntry[] = currentWatchEntries.map((w) => ({
    path: w.path,
    collection: w.collection,
    enabled: true,
    depth: 0,
  }));

  // Drive tree — only system drives as top-level roots
  const tree: WatchEntry[] = [];

  if (process.platform === "win32") {
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command",
        "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root"], { stdio: "pipe", timeout: 5000 }).toString();
      for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const drivePath = resolve(line);
        if (existsSync(drivePath)) {
          tree.push(buildDirNode(drivePath, drivePath.replace(/[:\\\/]/g, "").toLowerCase(), 0, currentPaths, 1));
        }
      }
    } catch {
      tree.push(buildDirNode("C:\\", "c", 0, currentPaths, 1));
    }
  } else {
    tree.push(buildDirNode(homedir(), "home", 0, currentPaths, 1));
    if (existsSync("/Volumes")) tree.push(buildDirNode("/Volumes", "volumes", 0, currentPaths, 1));
    tree.push(buildDirNode("/", "root", 0, currentPaths, 1));
  }

  const result = await treeCheckboxMenu(tree, currentPaths, savedEntries);
  if (!result) return;

  // Flatten all enabled entries
  const enabled = flattenEnabled(result);
  const watchValue = enabled.map((e) => `${e.path}|${e.collection}`).join(",");

  const envPath = resolve(root, ".env");
  if (existsSync(envPath)) {
    let env = readFileSync(envPath, "utf-8");
    if (/WATCH_PATHS=/.test(env)) {
      env = env.replace(/WATCH_PATHS=.*/, `WATCH_PATHS=${watchValue}`);
    } else {
      env += `\nWATCH_PATHS=${watchValue}\n`;
    }
    writeFileSync(envPath, env);
  }

  console.log(t.ok(`\n  ${enabled.length} watch paths saved. Restart to apply.`));
}

export function getWatchPaths(root: string): { path: string; collection: string }[] {
  try {
    const envPath = resolve(root, ".env");
    if (!existsSync(envPath)) return [];
    const env = readFileSync(envPath, "utf-8");
    const raw = env.match(/WATCH_PATHS=(.*)/)?.[1]?.trim();
    if (!raw) return [];
    return raw.split(",").filter(Boolean).map((entry) => {
      const pipeIdx = entry.lastIndexOf("|");
      return {
        path: pipeIdx > 0 ? entry.slice(0, pipeIdx) : entry,
        collection: pipeIdx > 0 ? entry.slice(pipeIdx + 1) : "default",
      };
    });
  } catch { return []; }
}

// Directories that should never be watched (internal data, would cause feedback loops or noise)
const EXCLUDED_DIRS = new Set([
  // System / build
  "node_modules", ".git", "dist", "__pycache__", "Windows", "ProgramData",
  // ClawCore internals
  "clawcore-files",   // memory engine file store
  "clawcore-memory",  // memory engine internal
  "memory-engine",    // ClawCore memory engine source
  // OpenClaw internals
  "skills",           // skill definitions (SKILL.md, scripts) — not user knowledge
  "memory",           // OpenClaw conversation memory — redundant with ClawCore memory engine
  "logs",             // log files
  "cache",            // cached data
  "services",         // ClawCore service installation
]);

function buildDirNode(dirPath: string, collection: string, depth: number, enabledPaths: Set<string>, maxDepth = 3): WatchEntry {
  const children: WatchEntry[] = [];
  if (depth < maxDepth) {
    try {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("$")
            && !EXCLUDED_DIRS.has(entry.name)) {
          const childPath = resolve(dirPath, entry.name);
          const childColl = depth === 0 ? entry.name : `${collection}-${entry.name}`;
          children.push(buildDirNode(childPath, childColl, depth + 1, enabledPaths, maxDepth));
        }
      }
    } catch {}
  } else {
    // At max depth, just check if directory has subdirectories (lazy placeholder)
    try {
      const hasSubdirs = readdirSync(dirPath, { withFileTypes: true }).some(
        (e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("$"),
      );
      if (hasSubdirs) {
        // Mark as expandable but don't load children yet
        return {
          path: dirPath,
          collection,
          enabled: enabledPaths.has(dirPath),
          depth,
          children: [{ path: "__placeholder__", collection: "", enabled: false, depth: depth + 1 }],
          expanded: false,
        };
      }
    } catch {}
  }

  return {
    path: dirPath,
    collection,
    enabled: enabledPaths.has(dirPath),
    depth,
    children: children.length > 0 ? children : undefined,
    expanded: false,
  };
}

function flattenEnabled(nodes: WatchEntry[]): { path: string; collection: string }[] {
  const result: { path: string; collection: string }[] = [];
  for (const node of nodes) {
    if (node.enabled) result.push({ path: node.path, collection: node.collection });
    if (node.children) result.push(...flattenEnabled(node.children));
  }
  return result;
}

function flattenVisible(nodes: WatchEntry[]): WatchEntry[] {
  const result: WatchEntry[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.expanded && node.children) {
      result.push(...flattenVisible(node.children));
    }
  }
  return result;
}

function dirName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

/**
 * Tree checkbox menu with expand/collapse.
 * ↑↓ navigate, Space toggle, →/← expand/collapse, Enter save, Esc cancel.
 */
/**
 * Tree checkbox menu with expand/collapse.
 * Uses a fixed render window — clears and redraws completely each frame.
 * No line count tracking bugs.
 */
function treeCheckboxMenu(tree: WatchEntry[], enabledPaths: Set<string> = new Set(), savedEntries: WatchEntry[] = []): Promise<WatchEntry[] | null> {
  return new Promise((resolveMenu) => {
    let selected = 0;
    const nodes = tree;
    const customEntries: WatchEntry[] = [];
    let resolved = false;

    // Saved paths (toggleable) + separator marker + drive tree
    const getVisible = () => {
      const saved = savedEntries.filter(Boolean);
      const driveNodes = flattenVisible(nodes);
      return [...saved, ...customEntries, ...driveNodes];
    };
    const savedCount = () => savedEntries.length + customEntries.length;

    const renderLine = (item: WatchEntry, idx: number, isSel: boolean): string => {
      const cursor = isSel ? t.selected("›") : " ";
      const check = item.enabled ? t.ok("[✓]") : t.dim("[ ]");
      const indent = "  ".repeat(item.depth);
      const arrow = item.children ? (item.expanded ? t.dim("v ") : t.dim("> ")) : "  ";
      const name = dirName(item.path);
      const label = isSel ? t.selected(name) : t.value(name);
      const coll = t.dim(` → ${item.collection}`);
      return `  ${cursor} ${check} ${indent}${arrow}${label}${coll}`;
    };

    const fullRender = () => {
      process.stdout.write("\x1b[2J\x1b[H");

      console.log(section("Watch Paths"));
      console.log(t.dim("  Space = toggle, ←/→ = collapse/expand"));
      console.log(t.dim("  Enter = save, q = back without saving"));
      console.log(t.warn("  ⚠ Internal directories (memory, skills, logs) are auto-excluded.\n"));

      const sc = savedCount();
      const visible = getVisible();

      // Saved/active paths section
      if (sc > 0) {
        console.log(t.title("  --- Currently Watched ---"));
        for (let i = 0; i < sc; i++) {
          console.log(renderLine(visible[i], i, i === selected));
        }
        console.log("");
      }

      // Drive tree section
      console.log(t.title("  --- Browse Drives ---"));
      for (let i = sc; i < visible.length; i++) {
        console.log(renderLine(visible[i], i, i === selected));
      }

      // Add custom path option
      const customSel = selected === visible.length;
      console.log(`\n  ${customSel ? t.selected("›") : " "}     ${customSel ? t.selected("+ Add custom path") : t.info("+ Add custom path")}`);
    };

    fullRender();

    process.stdout.write("\x1b[?25l"); // hide cursor

    // Ensure stdin is fully active for raw keyboard input
    // Must resume BEFORE setting raw mode to avoid EAGAIN on some platforms
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("keypress");
    process.stdin.resume();
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch (e) {
        // If raw mode fails, we can't do keyboard navigation
        console.error(t.err("\n  Failed to enable keyboard input. Try running from a standard terminal."));
        resolveMenu(null);
        return;
      }
    }
    // Keep the event loop alive while waiting for input
    const keepAlive = setInterval(() => {}, 60000);

    const finish = (result: WatchEntry[] | null) => {
      clearInterval(keepAlive);
      if (resolved) return;
      resolved = true;
      process.stdin.removeListener("data", onKey);
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stdin.pause();
      process.stdout.write("\x1b[?25h"); // show cursor
      resolveMenu(result);
    };

    const onKey = async (key: Buffer) => {
      if (resolved) return;
      const s = key.toString();
      const vis = getVisible();
      const totalRows = vis.length + 1;

      // Arrow keys come as 3-byte sequences: \x1b[A, \x1b[B, \x1b[C, \x1b[D
      if (s.includes("\x1b[A") || s === "k") {
        selected = (selected - 1 + totalRows) % totalRows;
        fullRender();
      } else if (s.includes("\x1b[B") || s === "j") {
        selected = (selected + 1) % totalRows;
        fullRender();
      } else if (s === " " && selected < vis.length) {
        vis[selected].enabled = !vis[selected].enabled;
        fullRender();
      } else if (s.includes("\x1b[C") && selected < vis.length) {
        // Expand — lazy-load children if placeholder
        const node = vis[selected];
        if (node.children && !node.expanded) {
          if (node.children.length === 1 && node.children[0].path === "__placeholder__") {
            node.children = [];
            try {
              for (const entry of readdirSync(node.path, { withFileTypes: true })) {
                if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("$")
                    && !EXCLUDED_DIRS.has(entry.name)) {
                  const childPath = resolve(node.path, entry.name);
                  const childColl = `${node.collection}-${entry.name}`;
                  node.children.push(buildDirNode(childPath, childColl, node.depth + 1, enabledPaths, node.depth + 2));
                }
              }
            } catch {}
            if (node.children.length === 0) node.children = undefined;
          }
          node.expanded = true;
          fullRender();
        }
      } else if (s.includes("\x1b[D") && selected < vis.length) {
        // Collapse
        if (vis[selected].children && vis[selected].expanded) {
          vis[selected].expanded = false;
          const newVis = getVisible();
          if (selected >= newVis.length) selected = newVis.length;
          fullRender();
        }
      } else if (s === "\r" || s === "\n") {
        if (selected === vis.length) {
          // Custom path entry
          finish(null); // exit tree first
          const p = (await import("prompts")).default;
          console.log("");
          let _cc = false;
          const _oc = () => { _cc = true; };
          const { customPath } = await p({ type: "text", name: "customPath", message: "Directory path" }, { onCancel: _oc });
          const { customColl } = await p({ type: "text", name: "customColl", message: "Collection name", initial: "custom" }, { onCancel: _oc });
          if (customPath && customColl && !_cc) {
            customEntries.push({ path: customPath, collection: customColl, enabled: true, depth: 0 });
          }
          resolveMenu(nodes);
        } else {
          finish(nodes);
        }
      } else if (s === "q" || s === "\x03") {
        finish(s === "\x03" ? null : null);
        if (s === "\x03") process.exit(0);
      }
      // Standalone \x1b (Esc without arrow) — ignore it, use 'q' to quit
    };

    process.stdin.on("data", onKey);
  });
}

// ── Evidence OS Settings ──

interface EvidenceFeature {
  label: string;
  key: string;
  enabled: boolean;
  description: string;
  indent?: number;        // 0 = master, 1 = sub-feature
  dependsOn?: string;     // key of parent feature
  configAction?: string;  // "deep_model" = show model config on ENTER
}

async function changeEvidenceSettings(root: string): Promise<void> {
  clearScreen();
  console.log(section("Evidence OS Configuration"));
  console.log(kvLine("Summary", t.dim("Local graph memory, claims, and awareness")));
  console.log(kvLine("Deep Extraction", t.dim("Optional LLM-assisted extraction")));
  console.log("");

  const envPath = resolve(root, ".env");
  let envData = "";
  try {
    envData = readFileSync(envPath, "utf-8");
  } catch {
    try { writeFileSync(envPath, "# ClawCore Configuration\n"); envData = "# ClawCore Configuration\n"; } catch (e: any) {
      console.log(t.err(`\n  Cannot read or create .env at ${envPath}: ${e.message}\n`));
      await new Promise((r) => setTimeout(r, 2000));
      return;
    }
  }

  const getVal = (key: string) => envData.match(new RegExp(`${key}=([^\\n]*)`))?.[1]?.trim() ?? "false";
  const setVal = (key: string, val: string) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(envData)) {
      envData = envData.replace(re, `${key}=${val}`);
    } else {
      envData += `\n${key}=${val}`;
    }
  };

  const MASTER_KEY = "CLAWCORE_MEMORY_RELATIONS_ENABLED";

  // ── Feature list with dependency grouping ──
  const features: EvidenceFeature[] = [
    { label: "Entity Relations", key: MASTER_KEY, enabled: getVal(MASTER_KEY) === "true", description: "Entity graph + evidence tracking (required)", indent: 0 },
    { label: "Awareness Notes", key: "CLAWCORE_MEMORY_RELATIONS_AWARENESS_ENABLED", enabled: getVal("CLAWCORE_MEMORY_RELATIONS_AWARENESS_ENABLED") === "true", description: "Surface context in prompts (~30-80 tokens)", indent: 1, dependsOn: MASTER_KEY },
    { label: "Claim Extraction", key: "CLAWCORE_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED", enabled: getVal("CLAWCORE_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED") === "true", description: "Extract facts from tool results (no LLM)", indent: 1, dependsOn: MASTER_KEY },
    { label: "Attempt Tracking", key: "CLAWCORE_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED", enabled: getVal("CLAWCORE_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED") === "true", description: "Record tool outcomes + learn patterns", indent: 1, dependsOn: MASTER_KEY },
    { label: "Deep Extraction", key: "CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED", enabled: getVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED") === "true", description: "LLM-powered (ENTER to configure model)", indent: 1, dependsOn: MASTER_KEY, configAction: "deep_model" },
  ];

  const toggledFeatures = await evidenceCheckboxMenu(features, envData, getVal, setVal);
  if (!toggledFeatures) return;

  for (const f of toggledFeatures) {
    setVal(f.key, String(f.enabled));
  }
  // Also set the top-level alias used by non-memory-engine code
  setVal("CLAWCORE_RELATIONS_ENABLED", String(toggledFeatures[0].enabled));

  // ── Context tier ──
  clearScreen();
  console.log(section("Context Compiler Budget"));
  const currentTier = getVal("CLAWCORE_MEMORY_RELATIONS_CONTEXT_TIER") || "standard";
  console.log(kvLine("Current", currentTier));
  console.log(kvLine("Lite", t.dim("lowest token overhead")));
  console.log(kvLine("Standard", t.dim("balanced default")));
  console.log(kvLine("Premium", t.dim("maximum context")));
  console.log("");
  const tierChoice = await selectMenu([
    { label: `Lite (110 tokens) — minimal overhead${currentTier === "lite" ? "  ← current" : ""}`, value: "lite" },
    { label: `Standard (190 tokens) — balanced${currentTier === "standard" ? "  ← current" : ""}`, value: "standard" },
    { label: `Premium (280 tokens) — maximum context${currentTier === "premium" ? "  ← current" : ""}`, value: "premium" },
  ]);
  if (tierChoice) setVal("CLAWCORE_MEMORY_RELATIONS_CONTEXT_TIER", tierChoice);

  writeFileSync(envPath, envData);
  console.log(t.ok("\n  Evidence OS settings saved. Restart services to apply.\n"));
  await new Promise((r) => setTimeout(r, 1500));
}

/** Deep extraction model configuration sub-screen. */
async function configureDeepExtractionModel(
  getVal: (key: string) => string,
  setVal: (key: string, val: string) => void,
): Promise<void> {
  clearScreen();
  console.log(section("Deep Extraction Model"));
  const currentModel = getVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL");
  const currentProvider = getVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER");
  const currentLabel = currentModel && currentModel !== "false"
    ? `${currentProvider || "default"}/${currentModel}`
    : "summary/OpenClaw default";

  console.log(kvLine("Current", currentLabel));
  console.log(kvLine("Requirement", t.dim("Chat model with reliable JSON output")));
  console.log("");

  const modelChoice = await selectMenu([
    { label: "Use OpenClaw's current model (strongest, may cost tokens)", value: "openclaw" },
    { label: "Use the summary model (already configured for memory)", value: "summary" },
    { label: "Ollama local model (free, private, 7B+ recommended)", value: "ollama" },
    { label: "LM Studio local model", value: "lmstudio" },
    { label: "Cloud API (Anthropic, OpenAI, etc.)", value: "cloud" },
    { label: "Custom (enter model + provider)", value: "custom" },
    { label: "Back", value: "__back__" },
  ]);

  if (!modelChoice || modelChoice === "__back__") return;

  if (modelChoice === "openclaw" || modelChoice === "summary") {
    setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL", "");
    setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER", "");
    console.log(t.ok("\n  Will use the summary/OpenClaw default model.\n"));
  } else if (modelChoice === "ollama") {
    console.log(t.dim("\n  Popular Ollama models for extraction:\n"));
    const ollamaModel = await selectMenu([
      { label: "llama3.1:8b (best quality, ~5GB)", value: "llama3.1:8b" },
      { label: "mistral:7b (fast, good quality, ~4GB)", value: "mistral:7b" },
      { label: "qwen2.5:7b (multilingual, ~4GB)", value: "qwen2.5:7b" },
      { label: "gemma2:9b (Google, ~5GB)", value: "gemma2:9b" },
      { label: "phi3:mini (smallest, ~2GB)", value: "phi3:mini" },
      { label: "Custom Ollama model", value: "__custom__" },
    ]);
    if (ollamaModel === "__custom__") {
      const p = (await import("prompts")).default;
      const { name } = await p({ type: "text", name: "name", message: "Ollama model name" });
      if (name) {
        setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL", name.trim());
        setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER", "ollama");
      }
    } else if (ollamaModel) {
      setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL", ollamaModel);
      setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER", "ollama");
    }
  } else if (modelChoice === "lmstudio") {
    const p = (await import("prompts")).default;
    const { model } = await p({
      type: "text", name: "model",
      message: "LM Studio model name (from /v1/models)",
      initial: "local-model",
    });
    if (model) {
      setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL", model.trim());
      setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER", "lmstudio");
    }
  } else if (modelChoice === "cloud") {
    const cloudChoice = await selectMenu([
      { label: "Anthropic (Claude)", value: "anthropic" },
      { label: "OpenAI (GPT)", value: "openai" },
      { label: "Google (Gemini)", value: "google" },
    ]);
    if (cloudChoice) {
      const defaults: Record<string, string> = {
        anthropic: "claude-sonnet-4-20250514",
        openai: "gpt-4o-mini",
        google: "gemini-2.0-flash",
      };
      const p = (await import("prompts")).default;
      const { model } = await p({
        type: "text", name: "model",
        message: "Model name",
        initial: defaults[cloudChoice] ?? "",
      });
      if (model) {
        setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL", model.trim());
        setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER", cloudChoice);
      }
    }
  } else if (modelChoice === "custom") {
    const p = (await import("prompts")).default;
    const { model } = await p({ type: "text", name: "model", message: "Model name" });
    const { provider } = await p({ type: "text", name: "provider", message: "Provider" });
    if (model) setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL", model.trim());
    if (provider) setVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER", provider.trim());
  }
}

/**
 * Checkbox menu for Evidence OS feature toggles.
 * - Entity Relations is the master toggle — disabling it greys out all sub-features.
 * - Toggling master OFF auto-disables all sub-features.
 * - Deep Extraction shows "ENTER to configure model" and opens model config on ENTER.
 * - ESC cancels without saving.
 */
function evidenceCheckboxMenu(
  features: EvidenceFeature[],
  _envData: string,
  getVal: (key: string) => string,
  setVal: (key: string, val: string) => void,
): Promise<EvidenceFeature[] | null> {
  return new Promise((resolveMenu) => {
    let selected = 0;
    const items = features.map((f) => ({ ...f }));
    const MASTER_KEY = items[0].key;

    const isMasterEnabled = () => items[0].enabled;

    // Rows: items + separator + confirm + back + hint
    const ROW_COUNT = items.length + 4;

    const renderLine = (i: number) => {
      const item = items[i];
      const isSub = (item.indent ?? 0) > 0;
      const masterOff = isSub && !isMasterEnabled();
      const prefix = isSub ? "    " : "  ";
      const cursor = i === selected ? t.selected("›") : " ";

      if (masterOff) {
        // Greyed out — master is off
        const check = t.dim("[-]");
        const label = t.dim(item.label.padEnd(20));
        const desc = t.dim("(needs Entity Relations)");
        process.stdout.write(`\x1b[2K${prefix}${cursor} ${check} ${label} ${desc}\n`);
      } else {
        const check = item.enabled ? t.ok("[✓]") : t.dim("[ ]");
        const label = i === selected ? t.selected(item.label.padEnd(20)) : t.value(item.label.padEnd(20));
        let desc = t.dim(item.description);
        if (item.configAction === "deep_model" && item.enabled) {
          const curModel = getVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL");
          const curProv = getVal("CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER");
          if (curModel && curModel !== "false") {
            desc = t.dim(`Model: ${curProv || "default"}/${curModel}  [ENTER to change]`);
          } else {
            desc = t.dim("No model set  [ENTER to configure]");
          }
        }
        process.stdout.write(`\x1b[2K${prefix}${cursor} ${check} ${label} ${desc}\n`);
      }
    };

    const renderAll = () => {
      process.stdout.write(`\x1b[${ROW_COUNT}A`);
      for (let i = 0; i < items.length; i++) {
        renderLine(i);
      }
      // Separator
      process.stdout.write(`\x1b[2K\n`);
      // Confirm row
      const confirmIdx = items.length;
      const confirmSel = selected === confirmIdx;
      process.stdout.write(`\x1b[2K  ${confirmSel ? t.selected("›") : " "} ${confirmSel ? t.ok("Save & Continue") : t.value("Save & Continue")}\n`);
      // Back row
      const backIdx = items.length + 1;
      const backSel = selected === backIdx;
      process.stdout.write(`\x1b[2K  ${backSel ? t.selected("›") : " "} ${backSel ? t.dim("Back (discard changes)") : t.dim("Back (discard changes)")}\n`);
      // Hint
      process.stdout.write(`\x1b[2K${t.dim("  ↑↓ navigate  SPACE toggle  ENTER select/configure  ESC back")}\n`);
    };

    // Initial render — reserve lines
    for (let i = 0; i < ROW_COUNT; i++) {
      process.stdout.write("\n");
    }
    renderAll();

    process.stdout.write("\x1b[?25l");
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const totalSelectable = items.length + 2; // items + confirm + back

    const onKey = async (key: Buffer) => {
      const s = key.toString();

      if (s === "\x1b[A" || s === "k") {
        selected = (selected - 1 + totalSelectable) % totalSelectable;
        renderAll();
      } else if (s === "\x1b[B" || s === "j") {
        selected = (selected + 1) % totalSelectable;
        renderAll();
      } else if (s === " ") {
        if (selected < items.length) {
          const item = items[selected];
          const isSub = (item.indent ?? 0) > 0;
          const masterOff = isSub && !isMasterEnabled();
          if (masterOff) return; // can't toggle greyed-out items

          item.enabled = !item.enabled;

          // If master was just disabled, auto-disable all sub-features
          if (item.key === MASTER_KEY && !item.enabled) {
            for (let i = 1; i < items.length; i++) {
              items[i].enabled = false;
            }
          }
          renderAll();
        }
      } else if (s === "\r" || s === "\n") {
        if (selected === items.length) {
          // Save & Continue
          cleanup();
          resolveMenu(items);
        } else if (selected === items.length + 1) {
          // Back
          cleanup();
          resolveMenu(null);
        } else if (selected < items.length) {
          const item = items[selected];
          // If this item has a config action and is enabled, open config
          if (item.configAction === "deep_model" && item.enabled) {
            cleanup();
            await configureDeepExtractionModel(getVal, setVal);
            // Return to checkbox — re-render
            clearScreen();
            console.log(section("Evidence OS Configuration"));
            console.log(t.dim("\n  Continue selecting features:\n"));
            for (let i = 0; i < ROW_COUNT; i++) {
              process.stdout.write("\n");
            }
            process.stdout.write("\x1b[?25l");
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on("data", onKey);
            renderAll();
            return;
          }
          // Otherwise ENTER on a feature row acts like SPACE (toggle)
          const isSub = (item.indent ?? 0) > 0;
          const masterOff = isSub && !isMasterEnabled();
          if (!masterOff) {
            item.enabled = !item.enabled;
            if (item.key === MASTER_KEY && !item.enabled) {
              for (let i = 1; i < items.length; i++) {
                items[i].enabled = false;
              }
            }
            renderAll();
          }
        }
      } else if (s === "\x1b" || s === "q") {
        // ESC or q — cancel
        cleanup();
        resolveMenu(null);
      } else if (s === "\x03") {
        cleanup();
        resolveMenu(null);
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    process.stdin.on("data", onKey);
  });
}
