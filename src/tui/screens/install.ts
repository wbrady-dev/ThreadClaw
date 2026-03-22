import prompts from "prompts";
import ora, { type Ora } from "ora";
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { clearScreen, kvLine, section, t } from "../theme.js";
import { runStreamedCommand, sanitizeCommandLine } from "../process.js";
import {
  findOpenClaw,
  getPlatform,
  getPythonCmd,
  getRootDir,
  installWindowsServices,
  isAdmin,
  setRootDirOverride,
  writeConfig,
  type ClawCoreConfig,
} from "../platform.js";
import {
  detectGpu,
  EMBED_MODELS,
  getRecommendation,
  RERANK_MODELS,
  type GpuInfo,
  type ModelInfo,
} from "../models.js";
import { selectMenu } from "../menu.js";
import { readEnvMap, type EnvMap } from "../env.js";
import { detectObsidianVaults } from "../../sources/adapters/obsidian.js";

let cancelled = false;
const onCancel = () => {
  cancelled = true;
};

export type EvidenceConfig = {
  relationsEnabled: boolean;
  awarenessEnabled: boolean;
  claimExtraction: boolean;
  attemptTracking: boolean;
  deepExtraction: boolean;
};

export interface InstallPlan {
  sourceRoot: string;
  root: string;
  python: string;
  platform: ReturnType<typeof getPlatform>;
  openclawDir: string | null;
  isRecommended: boolean;
  embedChoice: ModelInfo;
  rerankChoice: ModelInfo;
  parser: string;
  enableOcr: boolean;
  enableAudio: boolean;
  evidenceConfig: EvidenceConfig;
  integrateOpenClaw?: boolean;
  enableObsidian?: boolean;
  installWindowsServices?: boolean;
  huggingFaceToken?: string;
}

export const QUICK_EVIDENCE: EvidenceConfig = {
  relationsEnabled: true,
  awarenessEnabled: true,
  claimExtraction: false,
  attemptTracking: false,
  deepExtraction: false,
};

export const OFF_EVIDENCE: EvidenceConfig = {
  relationsEnabled: false,
  awarenessEnabled: false,
  claimExtraction: false,
  attemptTracking: false,
  deepExtraction: false,
};

/**
 * Non-interactive install — uses recommended defaults, zero prompts.
 * Called by install.bat/install.sh via `clawcore install --non-interactive`.
 * Shell scripts handle venv + pip before this runs.
 */
export async function runNonInteractiveInstall(): Promise<void> {
  const python = getPythonCmd();
  const platform = getPlatform();
  const sourceRoot = getRootDir();
  const openclawDir = findOpenClaw();
  const gpu = detectGpu();
  const tier = getRecommendedTier(gpu);

  const presetMap: Record<string, { embed: string; rerank: string }> = {
    lite: { embed: "sentence-transformers/all-MiniLM-L12-v2", rerank: "cross-encoder/ms-marco-MiniLM-L-6-v2" },
    standard: { embed: "BAAI/bge-large-en-v1.5", rerank: "BAAI/bge-reranker-large" },
    premium: { embed: "nvidia/omni-embed-nemotron-3b", rerank: "BAAI/bge-reranker-v2-gemma" },
  };

  const embedChoice = EMBED_MODELS.find((m) => m.id === presetMap[tier].embed);
  const rerankChoice = RERANK_MODELS.find((m) => m.id === presetMap[tier].rerank);
  if (!embedChoice || !rerankChoice) {
    console.error(t.err("Failed to resolve model preset."));
    return;
  }

  console.log(section("Non-Interactive Install"));
  console.log(kvLine("GPU", gpu.detected ? `${gpu.name} (${gpu.vramTotalMb} MB)` : "CPU mode"));
  console.log(kvLine("Tier", formatTierName(tier)));
  console.log(kvLine("Embedding", embedChoice.name));
  console.log(kvLine("Reranker", rerankChoice.name));
  console.log("");

  // Determine install root
  let root = sourceRoot;
  if (openclawDir) {
    const ocRoot = resolve(openclawDir, "services", "clawcore");
    if (existsSync(resolve(ocRoot, "package.json"))) {
      root = ocRoot;
    } else if (existsSync(resolve(sourceRoot, "package.json"))) {
      // Copy source to OpenClaw location
      mkdirSync(ocRoot, { recursive: true });
      cpSync(sourceRoot, ocRoot, {
        recursive: true,
        filter: (src) => {
          const rel = src.slice(sourceRoot.length + 1).replace(/\\/g, "/");
          if ((rel === "node_modules" || rel.startsWith("node_modules/")) && !rel.startsWith("memory-engine/")) return false;
          if (rel === "data" || rel.startsWith("data/")) return false;
          if (rel === "logs" || rel.startsWith("logs/")) return false;
          if (rel === ".git" || rel.startsWith(".git/")) return false;
          if (rel === ".env") return false;
          return true;
        },
      });
      root = ocRoot;
    }
  }

  await performInstallPlan({
    sourceRoot,
    root,
    python,
    platform,
    openclawDir,
    isRecommended: true,
    embedChoice,
    rerankChoice,
    parser: "cpu",
    enableOcr: true,
    enableAudio: true,
    evidenceConfig: QUICK_EVIDENCE,
    integrateOpenClaw: Boolean(openclawDir),
    enableObsidian: false,
    installWindowsServices: false,
    huggingFaceToken: "",
  });

  console.log(t.ok("\n  Installation complete. Run `clawcore` to launch.\n"));
}

export async function runInstall(): Promise<void> {
  clearScreen();
  cancelled = false;

  console.log(section("Welcome to ClawCore"));
  console.log(t.dim("  Recommended install gets you to a working local setup quickly."));
  console.log(t.dim("  Advanced install lets you tune parser, evidence, integrations,"));
  console.log(t.dim("  sources, and services during setup.\n"));

  const { proceed } = await prompts({ type: "confirm", name: "proceed", message: "Ready to begin?", initial: true }, { onCancel });
  if (!proceed || cancelled) return;

  const python = getPythonCmd();
  const platform = getPlatform();
  const sourceRoot = getRootDir();
  const openclawDir = findOpenClaw();

  clearScreen();
  console.log(section("Prerequisites"));
  let sp = ora("Checking system...").start();

  try {
    const nodeVersion = execFileSync("node", ["--version"], { stdio: "pipe" }).toString().trim();
    const nodeMajor = parseInt(nodeVersion.replace(/^v/, ""), 10);
    if (!Number.isFinite(nodeMajor) || nodeMajor < 22) throw new Error(`Node.js ${nodeVersion} found, but v22+ is required.`);
    const pythonVersion = execFileSync(python, ["--version"], { stdio: "pipe" }).toString().trim();
    const pythonMajor = parseInt(pythonVersion.replace(/Python\s*/i, ""), 10);
    if (!Number.isFinite(pythonMajor) || pythonMajor < 3) throw new Error(`${pythonVersion} found, but Python 3+ is required.`);
  } catch (error) {
    sp.fail(error instanceof Error ? error.message : String(error));
    return;
  }

  sp.succeed("Prerequisites OK");

  console.log(section("Hardware"));
  const gpu = detectGpu();
  if (gpu.detected) {
    console.log(kvLine("GPU", gpu.name));
    console.log(kvLine("VRAM Total", `${gpu.vramTotalMb} MB`));
    console.log(kvLine("VRAM Free", `${gpu.vramFreeMb} MB`));
    console.log(kvLine("Recommended", formatTierName(getRecommendedTier(gpu))));
  } else {
    console.log(t.warn("  No GPU detected. ClawCore will run in CPU mode."));
    const { cpuOk } = await prompts({ type: "confirm", name: "cpuOk", message: "Continue with CPU mode?", initial: true }, { onCancel });
    if (!cpuOk || cancelled) return;
  }

  console.log(section("Install Location"));
  let root: string;
  if (openclawDir) {
    // OpenClaw detected — default to its services directory
    const defaultRoot = resolve(openclawDir, "services", "clawcore");
    console.log(t.ok(`  OpenClaw detected at ${openclawDir}`));
    console.log(t.dim(`  Installing to: ${defaultRoot}\n`));
    const { useDefault } = await prompts({ type: "confirm", name: "useDefault", message: "Install to OpenClaw services directory?", initial: true }, { onCancel });
    if (cancelled) return;
    if (useDefault) {
      root = defaultRoot;
    } else {
      const { installDir } = await prompts({ type: "text", name: "installDir", message: "Custom install directory", initial: sourceRoot }, { onCancel });
      if (!installDir || cancelled) return;
      root = resolve(installDir);
    }
  } else {
    console.log(t.dim("  No OpenClaw installation detected.\n"));
    const { installDir } = await prompts({ type: "text", name: "installDir", message: "Install directory", initial: sourceRoot }, { onCancel });
    if (!installDir || cancelled) return;
    root = resolve(installDir);
  }
  // If target doesn't have package.json, copy source files there (fresh install to new location)
  if (!existsSync(resolve(root, "package.json"))) {
    if (root !== sourceRoot && existsSync(resolve(sourceRoot, "package.json"))) {
      console.log(t.dim(`\n  Copying ClawCore to ${root}...`));
      mkdirSync(root, { recursive: true });
      cpSync(sourceRoot, root, {
        recursive: true,
        filter: (src) => {
          // Skip root node_modules, data, logs, .env, .git
          // Keep memory-engine/node_modules (monorepo deps can't be npm-installed)
          const rel = src.slice(sourceRoot.length + 1).replace(/\\/g, "/");
          if ((rel === "node_modules" || rel.startsWith("node_modules/")) && !rel.startsWith("memory-engine/")) return false;
          if (rel === "data" || rel.startsWith("data/")) return false;
          if (rel === "logs" || rel.startsWith("logs/")) return false;
          if (rel === ".git" || rel.startsWith(".git/")) return false;
          if (rel === ".env") return false;
          return true;
        },
      });
      console.log(t.ok("  Copied.\n"));
    }
    if (!existsSync(resolve(root, "package.json"))) {
      console.log(t.err("\n  The selected directory does not contain a ClawCore package checkout.\n"));
      return;
    }
  }

  const freeDiskGb = getFreeDiskGb(platform, root);
  if (freeDiskGb !== null && freeDiskGb < 15) {
    console.log(t.warn(`\n  Only about ${Math.round(freeDiskGb)}GB free disk space was detected on the install volume.`));
    const { continueAnyway } = await prompts({ type: "confirm", name: "continueAnyway", message: "Continue anyway?", initial: false }, { onCancel });
    if (!continueAnyway || cancelled) return;
  }

  console.log(section("Setup Style"));
  const setupMode = await selectMenu([
    { label: "Recommended - fast path with sensible defaults", value: "recommended" },
    { label: "Advanced - choose features during install", value: "advanced" },
  ]);
  if (!setupMode) return;
  const isRecommended = setupMode === "recommended";

  clearScreen();
  console.log(section("Model Selection"));
  let tier = isRecommended ? getRecommendedTier(gpu) : await selectTier();
  if (!tier) return;
  if (isRecommended) {
    console.log(kvLine("Selected preset", formatTierName(tier)));
    console.log(t.dim("  You can change this later from Configure.\n"));
  }

  let embedChoice: ModelInfo | null;
  let rerankChoice: ModelInfo | null;
  if (tier === "custom") {
    console.log(section("Embedding Model"));
    embedChoice = await selectModel(EMBED_MODELS, gpu, 0, python);
    if (!embedChoice) return;
    console.log(section("Reranking Model"));
    rerankChoice = await selectModel(RERANK_MODELS, gpu, embedChoice.vramMb, python);
    if (!rerankChoice) return;
  } else {
    const presetMap: Record<string, { embed: string; rerank: string }> = {
      lite: { embed: "sentence-transformers/all-MiniLM-L12-v2", rerank: "cross-encoder/ms-marco-MiniLM-L-6-v2" },
      standard: { embed: "BAAI/bge-large-en-v1.5", rerank: "BAAI/bge-reranker-large" },
      premium: { embed: "nvidia/omni-embed-nemotron-3b", rerank: "BAAI/bge-reranker-v2-gemma" },
    };
    embedChoice = EMBED_MODELS.find((model) => model.id === presetMap[tier].embed) ?? null;
    rerankChoice = RERANK_MODELS.find((model) => model.id === presetMap[tier].rerank) ?? null;
    if (!embedChoice || !rerankChoice) {
      console.log(t.err("  Preset models were not found in the catalog."));
      return;
    }
  }

  const totalVram = embedChoice.vramMb + rerankChoice.vramMb;
  console.log(section("VRAM Summary"));
  console.log(kvLine("Embedding", `${embedChoice.name} (${embedChoice.vramMb} MB)`));
  console.log(kvLine("Reranking", `${rerankChoice.name} (${rerankChoice.vramMb} MB)`));
  console.log(kvLine("Total", `${totalVram} MB`));
  if (gpu.detected) {
    const remaining = gpu.vramTotalMb - totalVram;
    const remainingColor = remaining > 4000 ? t.ok : remaining > 1000 ? t.warn : t.err;
    console.log(kvLine("Remaining VRAM", remainingColor(`${remaining} MB`)));
    if (remaining < 0) {
      const { forceVram } = await prompts({ type: "confirm", name: "forceVram", message: "Continue with these models?", initial: false }, { onCancel });
      if (!forceVram || cancelled) return;
    }
  }

  let parser = "off";
  let enableOcr = false;
  let enableAudio = false;
  let evidenceConfig = OFF_EVIDENCE;

  if (isRecommended) {
    console.log(section("Recommended Defaults"));
    parser = "cpu";
    enableOcr = true;
    enableAudio = true;
    evidenceConfig = QUICK_EVIDENCE;
    console.log(kvLine("Document parser", "Docling CPU"));
    console.log(kvLine("OCR", "Tesseract"));
    console.log(kvLine("Audio transcription", "Whisper (base)"));
    console.log(kvLine("NER", "spaCy (en_core_web_sm)"));
    console.log(kvLine("Evidence OS", "Quick Start"));
  } else {
    ({ parser, enableOcr, enableAudio } = await promptDocumentSettings());
    if (cancelled) return;
    evidenceConfig = await promptEvidenceSettings();
    if (cancelled) return;
  }

  await performInstallPlan({
    sourceRoot,
    root,
    python,
    platform,
    openclawDir,
    isRecommended,
    embedChoice,
    rerankChoice,
    parser,
    enableOcr,
    enableAudio,
    evidenceConfig,
    integrateOpenClaw: !isRecommended && Boolean(openclawDir),
    enableObsidian: !isRecommended,
    installWindowsServices: !isRecommended && platform === "windows",
  });

  await selectMenu([{ label: "Continue to main menu", value: "done", color: t.dim }]);
}

export async function performInstallPlan(plan: InstallPlan): Promise<void> {
  const {
    sourceRoot,
    root,
    python,
    platform,
    openclawDir,
    isRecommended,
    embedChoice,
    rerankChoice,
    parser,
    enableOcr,
    enableAudio,
    evidenceConfig,
    integrateOpenClaw,
    enableObsidian,
    installWindowsServices: shouldInstallWindowsServices,
    huggingFaceToken,
  } = plan;

  clearScreen();
  console.log(section("Installing Dependencies"));

  mkdirSync(resolve(root, "data"), { recursive: true });
  mkdirSync(resolve(root, "logs"), { recursive: true });
  const envPath = resolve(root, ".env");
  const hadExistingEnv = existsSync(envPath);
  const existingEnv = hadExistingEnv ? readFileSync(envPath, "utf-8") : "";

  const npmCmd = getPlatform() === "windows" ? "npm.cmd" : "npm";
  const failures: string[] = [];

  // ── Step 1: Node.js dependencies ──
  let sp = ora("Installing Node.js dependencies...").start();
  if (process.env.CLAWCORE_SKIP_NODE_INSTALL === "1") {
    sp.succeed("Node.js dependencies already bootstrapped");
    delete process.env.CLAWCORE_SKIP_NODE_INSTALL;
  } else {
    try {
      await runCommandWithSpinner(sp, "Installing Node.js dependencies...", npmCmd, ["install"], {
        cwd: root,
        timeoutMs: 300000,
      });
      sp.succeed("Node.js dependencies installed");
    } catch (error) {
      sp.fail(`npm install failed: ${String(error).slice(0, 200)}`);
      throw error;
    }
  }
  // Verify
  if (!existsSync(resolve(root, "node_modules"))) {
    failures.push("Node.js: node_modules missing after install. Run: npm install");
  }

  // ── Step 2: Memory-engine dependencies ──
  const memoryEngineDir = resolve(root, "memory-engine");
  const meNodeModules = resolve(memoryEngineDir, "node_modules");
  if (existsSync(resolve(memoryEngineDir, "package.json"))) {
    if (!existsSync(meNodeModules)) {
      const meSourceModules = resolve(sourceRoot, "memory-engine", "node_modules");
      if (root !== sourceRoot && existsSync(meSourceModules)) {
        sp = ora("Copying memory-engine dependencies...").start();
        try {
          cpSync(meSourceModules, meNodeModules, { recursive: true });
          sp.succeed("Memory-engine dependencies copied");
        } catch {
          sp.warn("Copy failed, trying npm install...");
          try {
            await runCommandWithSpinner(sp, "Installing memory-engine dependencies...", npmCmd, ["install"], {
              cwd: memoryEngineDir, timeoutMs: 300000,
            });
            sp.succeed("Memory-engine dependencies installed");
          } catch {
            failures.push("Memory-engine: npm install failed. Run: cd memory-engine && npm install");
            sp.fail("Memory-engine install failed");
          }
        }
      } else {
        sp = ora("Installing memory-engine dependencies...").start();
        try {
          await runCommandWithSpinner(sp, "Installing memory-engine dependencies...", npmCmd, ["install"], {
            cwd: memoryEngineDir, timeoutMs: 300000,
          });
          sp.succeed("Memory-engine dependencies installed");
        } catch {
          failures.push("Memory-engine: npm install failed. Run: cd memory-engine && npm install");
          sp.fail("Memory-engine install failed");
        }
      }
    } else {
      console.log(t.ok("  [ok] Memory-engine dependencies already present"));
    }
    // Verify
    if (!existsSync(resolve(meNodeModules, "@sinclair", "typebox"))) {
      failures.push("Memory-engine: @sinclair/typebox missing. Run: cd memory-engine && npm install");
    }
  }

  // ── Step 3: Python dependencies ──
  // install.bat/install.sh handle venv creation and pinned pip installs.
  // If running directly (not via install script), install deps here.
  const reqsFile = resolve(root, "server", "requirements-pinned.txt");
  let pythonReady = false;
  try {
    execFileSync(python, ["-c", "import sentence_transformers; import flask"], { stdio: "pipe", timeout: 10000 });
    pythonReady = true;
  } catch {}

  if (pythonReady) {
    console.log(t.ok("  [ok] Python dependencies already installed"));
  } else {
    sp = ora("Installing Python dependencies...").start();
    try {
      // PyTorch first
      let hasTorch = false;
      try {
        execFileSync(python, ["-c", "import torch"], { stdio: "pipe", timeout: 10000 });
        hasTorch = true;
      } catch {}

      if (!hasTorch) {
        if (process.platform === "darwin") {
          await runCommandWithSpinner(sp, "Installing PyTorch...", python,
            ["-m", "pip", "install", "torch", "torchvision"], { timeoutMs: 600000 });
        } else {
          try {
            await runCommandWithSpinner(sp, "Installing GPU PyTorch...", python,
              ["-m", "pip", "install", "torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cu124"],
              { timeoutMs: 600000 });
          } catch {
            await runCommandWithSpinner(sp, "Installing CPU PyTorch...", python,
              ["-m", "pip", "install", "torch", "torchvision"], { timeoutMs: 600000 });
          }
        }
      }

      // All other deps via pinned requirements or individual installs
      if (existsSync(reqsFile)) {
        await runCommandWithSpinner(sp, "Installing pinned dependencies...", python,
          ["-m", "pip", "install", "-r", reqsFile], { timeoutMs: 600000 });
      } else {
        await runCommandWithSpinner(sp, "Installing core deps...", python,
          ["-m", "pip", "install", "sentence-transformers", "flask", "spacy", "docling"], { timeoutMs: 600000 });
      }
      sp.succeed("Python dependencies installed");
    } catch (error) {
      sp.fail(`Python install failed: ${String(error).slice(0, 200)}`);
      failures.push(`Python: Install failed. Run: ${python} -m pip install -r server/requirements-pinned.txt`);
    }

    // spaCy NER model
    try {
      execFileSync(python, ["-c", "import spacy; spacy.load('en_core_web_sm')"], { stdio: "pipe", timeout: 30000 });
    } catch {
      sp = ora("Downloading spaCy NER model...").start();
      try {
        await runCommandWithSpinner(sp, "Downloading NER model...", python,
          ["-m", "spacy", "download", "en_core_web_sm"], { timeoutMs: 120000 });
        sp.succeed("spaCy NER model installed");
      } catch {
        sp.warn("spaCy NER failed. Entity extraction will use regex fallback.");
      }
    }
  }

  // Tesseract OCR (system-level, not pip)
  if (enableOcr) {
    try {
      execFileSync("tesseract", ["--version"], { stdio: "pipe", timeout: 5000 });
      console.log(t.ok("  [ok] Tesseract OCR"));
    } catch {
      console.log(t.warn("  [!]  Tesseract not found. Download: https://github.com/UB-Mannheim/tesseract/wiki"));
      failures.push("OCR: Tesseract not installed. Download: https://github.com/UB-Mannheim/tesseract/wiki");
    }
  }

  // ── Report any failures ──
  if (failures.length > 0) {
    console.log(t.warn("\n  Some components need attention:"));
    for (const f of failures) console.log(t.err(`    • ${f}`));
    console.log(t.dim("  These are non-fatal — ClawCore will work with reduced functionality.\n"));
  }

  sp = ora("Writing configuration...").start();
  const config: ClawCoreConfig = {
    embed_model: embedChoice.id,
    rerank_model: rerankChoice.id,
    trust_remote_code: embedChoice.trustRemoteCode || rerankChoice.trustRemoteCode,
    docling_device: parser,
  };
  writeConfig(config, root);
  // Three-way .env merge: preserve user customizations, add new keys, keep unknown keys
  const templateEnv: EnvMap = {
    CLAWCORE_PORT: "18800",
    CLAWCORE_DATA_DIR: "./data",
    EMBEDDING_URL: "http://127.0.0.1:8012/v1",
    EMBEDDING_MODEL: embedChoice.id,
    EMBEDDING_DIMENSIONS: String(embedChoice.dims),
    RERANKER_URL: "http://127.0.0.1:8012",
    QUERY_EXPANSION_ENABLED: "false",
    QUERY_EXPANSION_URL: "http://127.0.0.1:1234/v1",
    QUERY_EXPANSION_MODEL: "",
    WATCH_PATHS: "",
    WATCH_DEBOUNCE_MS: "3000",
    DEFAULT_COLLECTION: "default",
    CHUNK_MIN_TOKENS: "100",
    CHUNK_MAX_TOKENS: "1024",
    CHUNK_TARGET_TOKENS: "512",
    QUERY_TOP_K: "10",
    QUERY_TOKEN_BUDGET: "4000",
    CLAWCORE_RELATIONS_ENABLED: String(evidenceConfig.relationsEnabled),
    CLAWCORE_MEMORY_RELATIONS_ENABLED: String(evidenceConfig.relationsEnabled),
    CLAWCORE_MEMORY_RELATIONS_AWARENESS_ENABLED: String(evidenceConfig.awarenessEnabled),
    CLAWCORE_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED: String(evidenceConfig.claimExtraction),
    CLAWCORE_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED: String(evidenceConfig.attemptTracking),
    CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED: String(evidenceConfig.deepExtraction),
    CLAWCORE_MEMORY_RELATIONS_CONTEXT_TIER: "standard",
    OCR_ENABLED: String(enableOcr),
    AUDIO_TRANSCRIPTION_ENABLED: String(enableAudio),
    WHISPER_MODEL: "base",
  };

  const oldEnv: EnvMap = hadExistingEnv ? readEnvMap(root) : {};
  const mergedLines = ["# ClawCore CRAM Configuration"];
  const templateKeys = new Set(Object.keys(templateEnv));

  // Write template keys — use user's value if they customized it, otherwise template default
  for (const [key, defaultVal] of Object.entries(templateEnv)) {
    const userVal = oldEnv[key];
    // For model-specific keys, always use the new installer value (user just chose these)
    const alwaysOverwrite = key === "EMBEDDING_MODEL" || key === "EMBEDDING_DIMENSIONS";
    if (alwaysOverwrite || userVal === undefined) {
      mergedLines.push(`${key}=${defaultVal}`);
    } else {
      mergedLines.push(`${key}=${userVal}`);
    }
  }

  // Preserve unknown keys from previous install (API keys, source configs, custom settings)
  const preserved: string[] = [];
  for (const [key, value] of Object.entries(oldEnv)) {
    if (!templateKeys.has(key)) {
      preserved.push(`${key}=${value}`);
    }
  }
  if (preserved.length > 0) {
    mergedLines.push("");
    mergedLines.push("# Preserved from previous install");
    mergedLines.push(...preserved);
  }

  writeFileSync(envPath, mergedLines.join("\n") + "\n");
  sp.succeed(hadExistingEnv ? `Configuration merged (${preserved.length} custom keys preserved)` : "Configuration saved");

  if (embedChoice.gated || rerankChoice.gated) {
    if (huggingFaceToken) await loginHuggingFace(python, huggingFaceToken, embedChoice, rerankChoice);
    else console.log(t.warn("  HuggingFace login skipped. Gated models may fail until you authenticate.\n"));
  }

  console.log(section("Downloading Models"));
  await warmModel(python, embedChoice, config.trust_remote_code, "SentenceTransformer");
  await warmModel(python, rerankChoice, config.trust_remote_code, "CrossEncoder");

  if (openclawDir && integrateOpenClaw) {
    await applyOpenClawIntegration(python, root, openclawDir, embedChoice.id);
  } else if (openclawDir && isRecommended) {
    console.log(section("OpenClaw Integration"));
    console.log(t.dim("  OpenClaw was detected and can be connected after install.\n"));
  }

  if (enableObsidian) await enableObsidianVault(envPath);
  else console.log(t.dim("\n  Source setup is skipped for now. Use Sources later.\n"));

  if (platform === "windows") {
    if (shouldInstallWindowsServices) await installWindowsServicesNow(root);
    else console.log(t.dim("  Windows service setup is skipped for now. Use Services later.\n"));
  }

  // Register `clawcore` as a global CLI command (PATH-based, no npm link / no admin)
  sp = ora("Registering clawcore command...").start();
  try {
    const binEntry = resolve(root, "bin", "clawcore.mjs");
    if (platform === "windows") {
      const cmdDir = resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData", "Local"), "ClawCore");
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(resolve(cmdDir, "clawcore.cmd"), `@echo off\r\nnode "${binEntry}" %*\r\n`);
      // Add to user PATH if not already there
      const currentPath = process.env.PATH ?? "";
      if (!currentPath.toLowerCase().includes("clawcore")) {
        try {
          execFileSync("setx", ["PATH", `${currentPath};${cmdDir}`], { stdio: "pipe", timeout: 10000 });
        } catch {}
      }
      sp.succeed("clawcore command registered. Restart terminal to use.");
    } else {
      const localBin = resolve(homedir(), ".local", "bin");
      mkdirSync(localBin, { recursive: true });
      try {
        execFileSync("ln", ["-sf", binEntry, resolve(localBin, "clawcore")], { stdio: "pipe" });
        execFileSync("chmod", ["+x", resolve(localBin, "clawcore")], { stdio: "pipe" });
      } catch {}
      sp.succeed("clawcore command registered at ~/.local/bin/clawcore");
    }
  } catch {
    sp.warn(`Global command not registered. Run: node ${resolve(root, "bin", "clawcore.mjs")}`);
  }

  setRootDirOverride(root);
  printVerification(root, python, envPath);
  installSkills(openclawDir, sourceRoot, root);

  console.log(section("Installation Complete"));
  console.log(kvLine("Embedding", `${embedChoice.name} (${embedChoice.vramMb} MB)`));
  console.log(kvLine("Reranker", `${rerankChoice.name} (${rerankChoice.vramMb} MB)`));
  console.log(kvLine("Parser", parser === "off" ? "Standard" : `Docling (${parser})`));
  console.log("");
  console.log(t.dim("  Next steps:"));
  console.log(t.dim("    1. Use Start from the main menu"));
  console.log(t.dim("    2. Wait for the model server and API to become healthy"));
  console.log(t.dim("    3. Add sources and advanced features later"));
  console.log("");
  console.log(t.highlight("  Type `clawcore` anywhere to launch the management console."));
  console.log("");
}

async function selectTier(): Promise<string | null> {
  return selectMenu([
    { label: "Lite (1-2GB VRAM) - Good quality, works on any GPU", value: "lite" },
    { label: "Standard (3-4GB VRAM) - Great quality for 8GB+ GPUs", value: "standard" },
    { label: "Premium (10-12GB VRAM) - Best quality for 16GB+ GPUs", value: "premium" },
    { label: "Custom - Choose each model individually", value: "custom" },
  ]);
}

async function promptDocumentSettings(): Promise<{ parser: string; enableOcr: boolean; enableAudio: boolean }> {
  console.log(section("Document Processing"));
  const docProcessing = await selectMenu([
    { label: "Configure document features", value: "configure" },
    { label: "Enable all - Docling CPU + OCR + Audio", value: "all" },
    { label: "Skip for now", value: "skip", color: t.dim },
  ]);
  if (!docProcessing) return { parser: "off", enableOcr: false, enableAudio: false };
  if (docProcessing === "all") return { parser: "cpu", enableOcr: true, enableAudio: true };
  if (docProcessing === "skip") return { parser: "off", enableOcr: false, enableAudio: false };
  const parser = await selectMenu([
    { label: "Standard only", value: "off" },
    { label: "Docling CPU", value: "cpu" },
    { label: "Docling GPU", value: "gpu" },
  ]);
  if (!parser) {
    cancelled = true;
    return { parser: "off", enableOcr: false, enableAudio: false };
  }
  const ocrChoice = await selectMenu([{ label: "Enable image OCR", value: "yes" }, { label: "Skip", value: "no", color: t.dim }]);
  const audioChoice = await selectMenu([{ label: "Enable audio transcription", value: "yes" }, { label: "Skip", value: "no", color: t.dim }]);
  return { parser, enableOcr: ocrChoice === "yes", enableAudio: audioChoice === "yes" };
}

async function promptEvidenceSettings(): Promise<EvidenceConfig> {
  console.log(section("Evidence OS"));
  const evidenceTier = await selectMenu([
    { label: "Quick Start - entity awareness + context compiler", value: "quick" },
    { label: "Off - search only", value: "off" },
    { label: "Custom - choose features", value: "custom" },
  ]);
  if (!evidenceTier) {
    cancelled = true;
    return OFF_EVIDENCE;
  }
  if (evidenceTier === "quick") return QUICK_EVIDENCE;
  if (evidenceTier === "off") return OFF_EVIDENCE;
  const { awareness } = await prompts({ type: "confirm", name: "awareness", message: "Enable entity awareness?", initial: true }, { onCancel });
  const { claims } = await prompts({ type: "confirm", name: "claims", message: "Enable claim extraction?", initial: false }, { onCancel });
  const { attempts } = await prompts({ type: "confirm", name: "attempts", message: "Enable attempt tracking?", initial: false }, { onCancel });
  return {
    relationsEnabled: Boolean(awareness || claims || attempts),
    awarenessEnabled: Boolean(awareness),
    claimExtraction: Boolean(claims),
    attemptTracking: Boolean(attempts),
    deepExtraction: false,
  };
}

async function maybeLoginHuggingFace(python: string, embedChoice: ModelInfo, rerankChoice: ModelInfo): Promise<void> {
  console.log(section("HuggingFace Login"));
  try {
    execFileSync(python, ["-c", "from huggingface_hub import whoami; whoami()"], { stdio: "pipe" });
    console.log(t.ok("  Already logged in to HuggingFace.\n"));
    return;
  } catch {}
  const { token } = await prompts({ type: "password", name: "token", message: "HuggingFace token" }, { onCancel });
  if (!token || cancelled) return;
  await loginHuggingFace(python, String(token), embedChoice, rerankChoice);
}

export async function loginHuggingFace(
  python: string,
  token: string,
  embedChoice: ModelInfo,
  rerankChoice: ModelInfo,
): Promise<void> {
  try {
    execFileSync(python, ["-c", "import os; from huggingface_hub import login; login(token=os.environ['HF_TOKEN'])"], { stdio: "pipe", env: { ...process.env, HF_TOKEN: String(token) } });
    console.log(t.ok("  Logged in to HuggingFace.\n"));
  } catch {
    console.log(t.warn(`  Login failed for ${embedChoice.id} / ${rerankChoice.id}.\n`));
  }
}

async function warmModel(python: string, model: ModelInfo, trustRemoteCode: boolean, loader: "SentenceTransformer" | "CrossEncoder"): Promise<void> {
  const trustArg = trustRemoteCode ? ", trust_remote_code=True" : "";
  const sp = ora(`Downloading ${model.name}...`).start();
  const command = loader === "SentenceTransformer"
    ? `from sentence_transformers import SentenceTransformer; SentenceTransformer('${model.id}'${trustArg})`
    : `from sentence_transformers import CrossEncoder; CrossEncoder('${model.id}'${trustArg})`;
  try {
    await runCommandWithSpinner(sp, `Downloading ${model.name}...`, python, ["-c", command], {
      timeoutMs: 900000,
    });
    sp.succeed(`${model.name} ready`);
  } catch (error) {
    sp.warn(`${model.name} download failed. It will retry on first startup.`);
    console.log(t.dim(`  ${String(error).slice(0, 120)}`));
  }
}

export async function applyOpenClawIntegration(
  python: string,
  root: string,
  openclawDir: string,
  embedModel: string,
): Promise<void> {
  const sp = ora("Integrating with OpenClaw...").start();
  try {
    execFileSync(python, [resolve(root, "server", "integrate_openclaw.py"), openclawDir, root, embedModel], { stdio: "pipe" });
    sp.succeed("OpenClaw integrated");
  } catch {
    try {
      const { applyOpenClawIntegration } = await import("../../integration.js");
      applyOpenClawIntegration(resolve(root, "memory-engine"));
      sp.succeed("OpenClaw integrated (fallback path)");
    } catch {
      sp.warn("Integration failed. Run 'clawcore integrate --apply' later.");
    }
  }
}

async function maybeEnableObsidian(envPath: string): Promise<void> {
  console.log(section("Knowledge Sources"));
  const vaults = detectObsidianVaults();
  if (vaults.length === 0) {
    console.log(t.dim("  No Obsidian vault detected.\n"));
    return;
  }
  console.log(t.ok(`  Obsidian vault found: ${vaults[0]}`));
  const { enableObsidian } = await prompts({ type: "confirm", name: "enableObsidian", message: "Index your Obsidian vault now?", initial: true }, { onCancel });
  if (!enableObsidian || cancelled) return;
  await enableObsidianVault(envPath);
}

export async function enableObsidianVault(envPath: string): Promise<void> {
  const vaults = detectObsidianVaults();
  if (vaults.length === 0) {
    console.log(t.dim("  No Obsidian vault detected.\n"));
    return;
  }
  let env = readFileSync(envPath, "utf-8");
  env += `\nOBSIDIAN_ENABLED=true\nOBSIDIAN_VAULT_PATH=${vaults[0]}\nOBSIDIAN_COLLECTION=obsidian\n`;
  const current = env.match(/^WATCH_PATHS=(.*)$/m)?.[1]?.trim() ?? "";
  const obsidianEntry = `${vaults[0]}|obsidian`;
  const updated = current ? `${current},${obsidianEntry}` : obsidianEntry;
  env = env.replace(/^WATCH_PATHS=.*$/m, `WATCH_PATHS=${updated}`);
  writeFileSync(envPath, env);
  console.log(t.ok("  Obsidian indexing enabled.\n"));
}

async function maybeInstallWindowsServices(root: string): Promise<void> {
  console.log(section("Background Services"));
  const { services } = await prompts({ type: "confirm", name: "services", message: "Install Windows services for auto-start?", initial: true }, { onCancel });
  if (!services || cancelled) return;
  await installWindowsServicesNow(root);
}

export async function installWindowsServicesNow(root: string): Promise<void> {
  const sp = ora("Setting up background services...").start();
  const result = installWindowsServices(root);
  if (result.success) sp.succeed("Background services configured");
  else sp.warn(`Service setup failed: ${result.error}`);
}

function printVerification(root: string, python: string, envPath: string): void {
  console.log(section("Verification"));
  const checks: Array<[string, boolean, string?]> = [];

  // Node
  checks.push(["Node.js dependencies", existsSync(resolve(root, "node_modules")), "Run: npm install"]);
  checks.push(["Memory-engine dependencies", existsSync(resolve(root, "memory-engine", "node_modules", "@sinclair", "typebox")), "Run: cd memory-engine && npm install"]);

  // Python
  try {
    execFileSync(python, ["-c", "import sentence_transformers"], { stdio: "pipe", timeout: 10000 });
    checks.push(["sentence-transformers", true]);
  } catch {
    checks.push(["sentence-transformers", false, "Run: pip install sentence-transformers"]);
  }
  try {
    execFileSync(python, ["-c", "import flask"], { stdio: "pipe", timeout: 10000 });
    checks.push(["Flask", true]);
  } catch {
    checks.push(["Flask", false, "Run: pip install flask"]);
  }
  try {
    execFileSync(python, ["-c", "import spacy; spacy.load('en_core_web_sm')"], { stdio: "pipe", timeout: 30000 });
    checks.push(["spaCy NER", true]);
  } catch {
    checks.push(["spaCy NER", false, "Run: pip install spacy && python -m spacy download en_core_web_sm"]);
  }
  try {
    execFileSync(python, ["-c", "import docling"], { stdio: "pipe", timeout: 10000 });
    checks.push(["Docling", true]);
  } catch {
    checks.push(["Docling", false, "Run: pip install docling"]);
  }
  try {
    execFileSync(python, ["-c", "import whisper"], { stdio: "pipe", timeout: 10000 });
    checks.push(["Whisper", true]);
  } catch {
    checks.push(["Whisper", false, "Run: pip install openai-whisper"]);
  }
  try {
    execFileSync("tesseract", ["--version"], { stdio: "pipe", timeout: 5000 });
    checks.push(["Tesseract OCR", true]);
  } catch {
    checks.push(["Tesseract OCR", false, "Download: https://github.com/UB-Mannheim/tesseract/wiki"]);
  }

  // Config
  checks.push(["Configuration file", existsSync(envPath)]);
  checks.push(["Model configuration", existsSync(resolve(root, "server", "config.json")) || existsSync(resolve(root, "config.json"))]);

  // Global command
  try {
    const which = getPlatform() === "windows" ? "where" : "which";
    execFileSync(which, ["clawcore"], { stdio: "pipe", timeout: 5000 });
    checks.push(["clawcore global command", true]);
  } catch {
    checks.push(["clawcore global command", false, `Run: cd ${root} && npm link`]);
  }

  let allOk = true;
  for (const [label, ok, fix] of checks) {
    if (ok) {
      console.log(t.ok(`  [ok] ${label}`));
    } else {
      console.log(t.err(`  [x]  ${label}`) + (fix ? t.dim(`  → ${fix}`) : ""));
      allOk = false;
    }
  }
  console.log("");
  if (!allOk) {
    console.log(t.warn("  Some checks failed. ClawCore will work with reduced functionality."));
    console.log(t.dim("  Fix the items above and restart services to enable all features.\n"));
  }
}

function installSkills(openclawDir: string | null, sourceRoot: string, root: string): void {
  if (!openclawDir) return;
  try {
    const openclawConfig = JSON.parse(readFileSync(resolve(openclawDir, "openclaw.json"), "utf-8"));
    const workspace = openclawConfig?.agents?.defaults?.workspace ?? resolve(openclawDir, "workspace");
    const skillsSource = existsSync(resolve(root, "skills")) ? resolve(root, "skills") : resolve(sourceRoot, "skills");
    if (!existsSync(skillsSource)) return;
    const skillsDestination = resolve(workspace, "skills");
    mkdirSync(skillsDestination, { recursive: true });
    for (const skillDir of ["clawcore-evidence", "clawcore-knowledge"]) {
      const source = resolve(skillsSource, skillDir);
      if (existsSync(source)) cpSync(source, resolve(skillsDestination, skillDir), { recursive: true });
    }
  } catch {}
}

async function selectModel(models: ModelInfo[], gpu: GpuInfo, otherModelVram: number, pythonCmd: string): Promise<ModelInfo | null> {
  const formatted = models.map((model) => {
    const recommendation = getRecommendation(model, gpu, otherModelVram);
    let badge = "";
    if (recommendation === "recommended") badge = t.ok(" *");
    else if (recommendation === "fits") badge = t.info(" +");
    else if (recommendation === "tight") badge = t.warn(" !");
    else if (recommendation === "too-large") badge = t.err(" x");
    return {
      id: model.id,
      label: model.name,
      vram: `${model.vramMb} MB`,
      quality: model.tier,
      qualityColor: tierColorFn(model.qualityScore),
      badge,
      description: model.notes,
    };
  });
  const menuItems: { label: string; value: string; color?: (s: string) => string; description?: string }[] = formatted.map((m) => ({
    label: `${m.label.padEnd(24)} ${t.dim(m.vram.padEnd(9))} ${m.qualityColor(m.quality.padEnd(10))}${m.badge}`,
    value: m.id,
    description: m.description,
  }));

  menuItems.push({
    label: t.info("Cloud provider"),
    value: "__cloud__",
    description: "OpenAI, Cohere, Voyage AI, Google, and more",
    color: t.info,
  });
  menuItems.push({
    label: t.info("+ Custom local model"),
    value: "__custom__",
    description: "Enter any HuggingFace model ID",
    color: t.info,
  });
  menuItems.push({
    label: "Back",
    value: "__back__",
    color: t.dim,
  });

  console.log(t.dim(`  ${t.ok("*")} = good fit for your hardware  ${t.info("cloud")} = hosted (no GPU needed)\n`));
  console.log(t.dim(`  ${"Model".padEnd(26)} ${"VRAM".padEnd(9)} ${"Type".padEnd(10)}`));

  const modelId = await selectMenu(menuItems);
  if (!modelId || modelId === "__back__" || modelId === "__cloud__") return null;
  if (modelId === "__custom__") return handleCustomModel(pythonCmd);
  return models.find((model) => model.id === modelId) ?? null;
}

async function handleCustomModel(pythonCmd: string): Promise<ModelInfo | null> {
  const { modelId } = await prompts({ type: "text", name: "modelId", message: "HuggingFace model ID" }, { onCancel });
  if (!modelId || cancelled) return null;
  const sp = ora(`Testing ${modelId}...`).start();
  try {
    const output = execFileSync(pythonCmd, ["-c", `from sentence_transformers import SentenceTransformer; m = SentenceTransformer('${modelId}', trust_remote_code=True); print(m.get_sentence_embedding_dimension())`], { stdio: "pipe", timeout: 600000 }).toString().trim();
    const dims = parseInt(output, 10) || 0;
    sp.succeed(`${modelId} works. Dimensions: ${dims}`);
    return { id: modelId, name: modelId.split("/").pop() ?? modelId, dims, vramMb: 0, sizeMb: 0, tier: "Custom", qualityScore: 5, languages: "Unknown", trustRemoteCode: true, gated: false, notes: "Custom model" };
  } catch {
    sp.fail(`${modelId} failed to load.`);
    return null;
  }
}

export function getRecommendedTier(gpu: GpuInfo): "lite" | "standard" | "premium" {
  if (!gpu.detected) return "lite";
  if (gpu.vramTotalMb >= 16000) return "premium";
  if (gpu.vramTotalMb >= 8000) return "standard";
  return "lite";
}

export function formatTierName(tier: string): string {
  if (tier === "premium") return "Premium";
  if (tier === "standard") return "Standard";
  if (tier === "lite") return "Lite";
  return "Custom";
}

function tierColorFn(score: number): (text: string) => string {
  if (score <= 4) return t.dim;
  if (score <= 5) return t.muted;
  if (score <= 6) return t.info;
  if (score <= 7) return t.ok;
  if (score <= 8) return t.warn;
  return t.err;
}

export function getDiskProbeTarget(platform: ReturnType<typeof getPlatform>, installPath: string): string {
  if (platform === "windows") {
    const match = resolve(installPath).match(/^[A-Za-z]:/);
    return (match?.[0] ?? "C:").toUpperCase();
  }
  return resolve(installPath);
}

export function getFreeDiskGb(
  platform: ReturnType<typeof getPlatform>,
  installPath = getRootDir(),
): number | null {
  try {
    const target = getDiskProbeTarget(platform, installPath);
    if (platform === "windows") {
      // Use Node.js native statfsSync (available since Node 18.15)
      try {
        const { statfsSync } = require("fs");
        const stats = statfsSync(installPath);
        return (stats.bavail * stats.bsize) / 1024 / 1024 / 1024;
      } catch {}
      // Fallback to dir command
      try {
        const out = execFileSync("cmd", ["/c", `dir ${target}\\`], { stdio: "pipe" }).toString();
        const match = out.match(/([\d,]+)\s+bytes free/);
        if (match) {
          const bytes = parseInt(match[1].replace(/,/g, ""), 10);
          return Number.isFinite(bytes) ? bytes / 1024 / 1024 / 1024 : null;
        }
      } catch {}
      return null;
    }
    const out = execFileSync("df", ["-BG", target], { stdio: "pipe" }).toString();
    const lastLine = out.trim().split("\n").pop() ?? "";
    return parseInt(lastLine.split(/\s+/)[3], 10) || null;
  } catch {
    return null;
  }
}

async function runCommandWithSpinner(
  spinner: Ora,
  prefix: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<void> {
  await runStreamedCommand(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    onLine: (line) => {
      const clean = sanitizeCommandLine(line);
      if (clean) spinner.text = `${prefix} ${clean}`.slice(0, 180);
    },
  });
}
