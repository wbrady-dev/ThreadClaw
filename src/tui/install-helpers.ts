import prompts from "prompts";
import ora, { type Ora } from "ora";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, resolve } from "path";
import { homedir, tmpdir } from "os";
import { clearScreen, kvLine, section, t } from "./theme.js";
import { runStreamedCommand, sanitizeCommandLine } from "./process.js";
import {
  findOpenClaw,
  getPlatform,
  getPythonCmd,
  getRootDir,
  installWindowsServices,
  setRootDirOverride,
  writeConfig,
  type ThreadClawConfig,
} from "./platform.js";
import {
  detectGpu,
  EMBED_MODELS,
  RERANK_MODELS,
  type GpuInfo,
  type ModelInfo,
} from "./models.js";
import { readEnvMap, writeEnvMap, backupEnvIfNeeded, updateEnvValues, type EnvMap } from "./env.js";
import { detectObsidianVaults } from "../sources/adapters/obsidian.js";

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
 * Called by install.bat/install.sh via `threadclaw install --non-interactive`.
 * Shell scripts handle venv + pip before this runs.
 */
export async function runNonInteractiveInstall(): Promise<void> {
  cancelled = false; // Reset module-level flag in case of prior call
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
  let root = openclawDir ? resolve(openclawDir, "services", "threadclaw") : resolve(homedir(), ".threadclaw");
  if (openclawDir) {
    const ocRoot = resolve(openclawDir, "services", "threadclaw");
    if (existsSync(resolve(ocRoot, "package.json"))) {
      root = ocRoot;
    } else if (existsSync(resolve(sourceRoot, "package.json"))) {
      // Copy source to OpenClaw location
      mkdirSync(ocRoot, { recursive: true });
      cpSync(sourceRoot, ocRoot, {
        recursive: true,
        filter: (src) => {
          // Keep .git/ so install location is a proper git repo (enables threadclaw update)
          const rel = src.slice(sourceRoot.length + 1).replace(/\\/g, "/");
          if ((rel === "node_modules" || rel.startsWith("node_modules/")) && !rel.startsWith("memory-engine/")) return false;
          if (rel === ".venv" || rel.startsWith(".venv/")) return false;
          if (rel === "dist" || rel.startsWith("dist/")) return false;
          if (rel === "data" || rel.startsWith("data/")) return false;
          if (rel === "logs" || rel.startsWith("logs/")) return false;
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

  console.log(t.ok("\n  Installation complete. Run `threadclaw` to launch."));
  if (platform === "windows") {
    console.log(t.dim("  Note: Windows background services were not set up during non-interactive install."));
    console.log(t.dim("  Use `threadclaw` → Services to configure auto-start.\n"));
  } else {
    console.log("");
  }
}

export async function performInstallPlan(plan: InstallPlan): Promise<void> {
  const {
    sourceRoot,
    root,
    python: pythonFromPlan,
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

  // Point all operations at the install root from the start, so getPythonCmd(),
  // getRootDir(), etc. resolve relative to the install location, not the clone.
  setRootDirOverride(root);

  // python may point to the source location's .venv; will be re-resolved after
  // we create a .venv at the install root (see Step 2c below).
  let python = pythonFromPlan;

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
  // Only honour the skip flag when install root matches the source root (where
  // install.bat ran npm install). If files were copied to a different location
  // (e.g. .openclaw), we must run npm install there.
  const canSkipNode = process.env.THREADCLAW_SKIP_NODE_INSTALL === "1" && root === sourceRoot;
  if (canSkipNode) {
    sp.succeed("Node.js dependencies already bootstrapped");
    delete process.env.THREADCLAW_SKIP_NODE_INSTALL;
  } else {
    delete process.env.THREADCLAW_SKIP_NODE_INSTALL;
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

  // ── Step 2b: Build TypeScript ──
  sp = ora("Building ThreadClaw...").start();
  try {
    await runCommandWithSpinner(sp, "Building...", npmCmd, ["run", "build"], { cwd: root, timeoutMs: 60000 });
    sp.succeed("ThreadClaw built");
  } catch {
    sp.warn("Build failed — will use development mode");
    failures.push("Build: npm run build failed. Run: npm run build");
  }

  // ── Step 2c: Create Python venv at install root ──
  // install.bat creates a .venv at the clone location, but if we copied files
  // to a different directory (e.g. .openclaw/services/threadclaw), there is no
  // .venv there.  Create one so all Python deps live inside the install root.
  const venvDir = resolve(root, ".venv");
  const venvPython = platform === "windows"
    ? resolve(venvDir, "Scripts", "python.exe")
    : resolve(venvDir, "bin", "python3");
  if (!existsSync(venvPython)) {
    sp = ora("Creating Python virtual environment...").start();
    try {
      // Use system python (not the plan's python which may be the source .venv)
      const sysPython = platform === "windows" ? "python" : "python3";
      await runCommandWithSpinner(sp, "Creating .venv...", sysPython,
        ["-m", "venv", venvDir], { timeoutMs: 60000 });
      sp.succeed("Python virtual environment created");
    } catch (error) {
      sp.fail(`Failed to create .venv: ${String(error).slice(0, 200)}`);
      failures.push("Python: venv creation failed. Run: python -m venv .venv");
    }
  }
  // Re-resolve python to use the install root's .venv
  if (existsSync(venvPython)) {
    python = venvPython;
  }

  // ── Step 3: Python dependencies ──
  // Force progress output for pip and HuggingFace downloads so the spinner
  // shows download progress instead of appearing frozen.
  const pipEnv = { ...process.env, PIP_PROGRESS_BAR: "on", PYTHONUNBUFFERED: "1" };
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
            ["-m", "pip", "install", "torch", "torchvision"], { timeoutMs: 600000, env: pipEnv });
        } else {
          try {
            await runCommandWithSpinner(sp, "Installing GPU PyTorch...", python,
              ["-m", "pip", "install", "torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cu124"],
              { timeoutMs: 600000, env: pipEnv });
          } catch {
            await runCommandWithSpinner(sp, "Installing CPU PyTorch...", python,
              ["-m", "pip", "install", "torch", "torchvision"], { timeoutMs: 600000, env: pipEnv });
          }
        }
      }

      // All other deps via pinned requirements or individual installs
      if (existsSync(reqsFile)) {
        await runCommandWithSpinner(sp, "Installing pinned dependencies...", python,
          ["-m", "pip", "install", "-r", reqsFile], { timeoutMs: 600000, env: pipEnv });
      } else {
        await runCommandWithSpinner(sp, "Installing core deps...", python,
          ["-m", "pip", "install", "sentence-transformers", "flask", "spacy", "docling"], { timeoutMs: 600000, env: pipEnv });
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
    // If critical deps (node_modules, Python) are missing, offer to abort
    const hasCritical = failures.some((f) => f.startsWith("Node.js:") || f.startsWith("Python:"));
    if (hasCritical) {
      console.log(t.err("\n  Critical dependencies are missing. Installation may not work."));
      const { abort } = await prompts({
        type: "confirm", name: "abort",
        message: "Abort installation?", initial: false,
      }, { onCancel });
      if (abort && !cancelled) {
        console.log(t.dim("\n  Installation aborted. Fix the issues above and retry.\n"));
        return;
      }
    }
    console.log(t.dim("  These are non-fatal — ThreadClaw will work with reduced functionality.\n"));
  }

  sp = ora("Writing configuration...").start();
  const config: ThreadClawConfig = {
    embed_model: embedChoice.id,
    rerank_model: rerankChoice.id,
    trust_remote_code: embedChoice.trustRemoteCode || rerankChoice.trustRemoteCode,
    docling_device: parser,
  };
  try {
    writeConfig(config, root);
  } catch (error) {
    sp.fail(`Failed to write config.json: ${String(error).slice(0, 200)}`);
    failures.push("Config: config.json write failed. Check file permissions.");
  }
  // Three-way .env merge: preserve user customizations, add new keys, keep unknown keys
  const templateEnv: EnvMap = {
    THREADCLAW_PORT: "18800",
    THREADCLAW_DATA_DIR: resolve(root, "data"),
    EMBEDDING_URL: process.env.EMBEDDING_URL ?? "http://127.0.0.1:8012/v1",
    EMBEDDING_MODEL: embedChoice.id,
    EMBEDDING_DIMENSIONS: String(embedChoice.dims),
    EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY ?? "",
    RERANKER_URL: process.env.RERANKER_URL ?? "http://127.0.0.1:8012",
    RERANKER_MODEL: process.env.RERANKER_MODEL ?? "",
    RERANKER_API_KEY: process.env.RERANKER_API_KEY ?? "",
    QUERY_EXPANSION_ENABLED: "false",
    QUERY_EXPANSION_URL: "http://127.0.0.1:1234/v1",
    QUERY_EXPANSION_MODEL: "",
    WATCH_PATHS: process.env.THREADCLAW_INSTALL_WATCH_PATHS ?? "",
    WATCH_DEBOUNCE_MS: "3000",
    DEFAULT_COLLECTION: "default",
    CHUNK_MIN_TOKENS: "100",
    CHUNK_MAX_TOKENS: "1024",
    CHUNK_TARGET_TOKENS: "512",
    QUERY_TOP_K: "10",
    QUERY_TOKEN_BUDGET: "4000",
    THREADCLAW_RELATIONS_ENABLED: String(evidenceConfig.relationsEnabled),
    THREADCLAW_MEMORY_RELATIONS_ENABLED: String(evidenceConfig.relationsEnabled),
    THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED: String(evidenceConfig.awarenessEnabled),
    THREADCLAW_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED: String(evidenceConfig.claimExtraction),
    THREADCLAW_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED: String(evidenceConfig.attemptTracking),
    THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED: String(evidenceConfig.deepExtraction),
    THREADCLAW_MEMORY_RELATIONS_CONTEXT_TIER: "standard",
    OCR_ENABLED: String(enableOcr),
    AUDIO_TRANSCRIPTION_ENABLED: String(enableAudio),
    WHISPER_MODEL: "base",
  };

  const oldEnv: EnvMap = hadExistingEnv ? readEnvMap(root) : {};
  const templateKeys = new Set(Object.keys(templateEnv));

  // Build merged env: user customizations win except for keys we always overwrite
  const alwaysOverwrite = new Set(["EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS", "RERANKER_MODEL"]);
  const mergedEnv: EnvMap = {};

  for (const [key, defaultVal] of Object.entries(templateEnv)) {
    const userVal = oldEnv[key];
    mergedEnv[key] = (alwaysOverwrite.has(key) || userVal === undefined) ? defaultVal : userVal;
  }

  // Preserve unknown keys from previous install (API keys, source configs, custom settings)
  let preservedCount = 0;
  for (const [key, value] of Object.entries(oldEnv)) {
    if (!templateKeys.has(key)) {
      mergedEnv[key] = value;
      preservedCount++;
    }
  }

  try {
    if (hadExistingEnv) backupEnvIfNeeded(envPath);
    writeEnvMap(root, mergedEnv);
    sp.succeed(hadExistingEnv ? `Configuration merged (${preservedCount} custom keys preserved)` : "Configuration saved");
  } catch (error) {
    sp.fail(`Failed to write .env: ${String(error).slice(0, 200)}`);
    failures.push("Config: .env write failed. Check file permissions.");
  }

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

  // Register `threadclaw` as a global CLI command (PATH-based, no npm link / no admin)
  sp = ora("Registering threadclaw command...").start();
  try {
    const binEntry = resolve(root, "bin", "threadclaw.mjs");
    if (platform === "windows") {
      const cmdDir = resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData", "Local"), "ThreadClaw");
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(resolve(cmdDir, "threadclaw.cmd"), `@echo off\r\nnode "${binEntry}" %*\r\n`);
      // Add to user PATH if not already there — read from registry to avoid corrupting system PATH
      let pathRegistered = false;
      if (!((process.env.PATH ?? "").toLowerCase().includes("threadclaw"))) {
        try {
          const regOutput = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "PATH"], { stdio: "pipe", timeout: 10000 }).toString();
          const match = regOutput.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
          const userPath = match ? match[1].trim() : "";
          if (!match || !userPath) {
            // Registry returned data but regex failed to parse — skip to avoid overwriting PATH
            console.error(t.dim("  Could not parse user PATH from registry. Add manually: setx PATH \"%PATH%;" + cmdDir + "\""));
          } else if (!userPath.toLowerCase().includes("threadclaw")) {
            const newPath = `${userPath};${cmdDir}`;
            execFileSync("setx", ["PATH", newPath], { stdio: "pipe", timeout: 10000 });
            pathRegistered = true;
          } else {
            pathRegistered = true;
          }
        } catch {
          // User PATH key may not exist yet — append to current process PATH to avoid
          // overwriting with just our directory (which would break other tools)
          try {
            const currentPath = process.env.PATH ?? "";
            const newPath = currentPath ? `${currentPath};${cmdDir}` : cmdDir;
            execFileSync("setx", ["PATH", newPath], { stdio: "pipe", timeout: 10000 });
            pathRegistered = true;
          } catch (setxError) {
            console.error(t.dim(`  setx failed: ${String(setxError).slice(0, 100)}`));
          }
        }
      } else {
        pathRegistered = true;
      }
      if (pathRegistered) {
        sp.succeed("threadclaw command registered. Restart terminal to use.");
      } else {
        sp.warn(`PATH not updated. Add manually: setx PATH "%PATH%;${cmdDir}"`);
      }
    } else {
      const localBin = resolve(homedir(), ".local", "bin");
      mkdirSync(localBin, { recursive: true });
      let linkCreated = false;
      try {
        execFileSync("ln", ["-sf", binEntry, resolve(localBin, "threadclaw")], { stdio: "pipe" });
        execFileSync("chmod", ["+x", resolve(localBin, "threadclaw")], { stdio: "pipe" });
        linkCreated = true;
      } catch (lnError) {
        console.error(t.dim(`  Symlink failed: ${String(lnError).slice(0, 100)}`));
      }
      if (linkCreated) {
        sp.succeed("threadclaw command registered at ~/.local/bin/threadclaw");
      } else {
        sp.warn(`Symlink failed. Run manually: ln -sf "${binEntry}" ~/.local/bin/threadclaw`);
      }
    }
  } catch {
    sp.warn(`Global command not registered. Run: node ${resolve(root, "bin", "threadclaw.mjs")}`);
  }

  // ── Run schema migrations + write manifest (same as `threadclaw upgrade`) ──
  // Fresh installs need this for DB init, schema creation, and manifest.
  try {
    const { ensureThreadClawHome, getAppVersion, readManifest, writeManifest, THREADCLAW_DATA_DIR } = await import("../../version.js");
    ensureThreadClawHome();

    // RAG DB + Evidence OS graph initialization (consolidated into one DB)
    const ragDbPath = resolve(THREADCLAW_DATA_DIR, "threadclaw.db");
    try {
      mkdirSync(dirname(ragDbPath), { recursive: true });
      const { getDb, closeDb } = await import("../../storage/sqlite.js");
      const { runMigrations } = await import("../../storage/index.js");
      const { ensureCollection } = await import("../../storage/collections.js");
      const ragDb = getDb(ragDbPath);
      runMigrations(ragDb);
      ensureCollection(ragDb, "default");

      // Graph/evidence migrations run against the same consolidated DB
      if (evidenceConfig.relationsEnabled) {
        try {
          for (const ext of [".js", ".ts"]) {
            try {
              const schemaPath = resolve(root, "memory-engine", "src", "relations", "schema" + ext);
              const { runGraphMigrations } = await import(schemaPath);
              runGraphMigrations(ragDb, ragDbPath);
              break;
            } catch { /* try next extension */ }
          }
        } catch {
          // Graph migrations will run on first server start — non-fatal during install
        }
      }

      closeDb();
    } catch (ragErr) {
      console.error(t.warn(`  Database init failed (non-fatal): ${String(ragErr).slice(0, 200)}`));
    }

    // Write initial manifest so upgrade detection works on next launch
    const manifest = readManifest();
    if (!manifest.appVersion) {
      writeManifest({
        ...manifest,
        appVersion: getAppVersion(),
        lastUpgradeAt: new Date().toISOString(),
        features: { ...manifest.features, managedIntegration: true, consolidatedData: true, noAutoMigrate: true },
      });
    }
  } catch (upgradeErr) {
    console.error(t.warn(`  Post-install upgrade step failed (non-fatal): ${String(upgradeErr).slice(0, 200)}`));
    console.error(t.dim("  Run `threadclaw upgrade` manually after install to complete setup."));
  }

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
  console.log(t.highlight("  Type `threadclaw` anywhere to launch the management console."));
  console.log("");

  // Write completion marker so first-run detection knows install finished successfully
  try {
    writeFileSync(resolve(root, ".install-complete"), new Date().toISOString());
  } catch {
    console.error(t.warn("  Could not write install completion marker. Next launch may re-run installer."));
  }
}

export async function loginHuggingFace(
  python: string,
  token: string,
  embedChoice: ModelInfo,
  rerankChoice: ModelInfo,
): Promise<void> {
  try {
    const loginScript = resolve(tmpdir(), `threadclaw_login_${randomUUID()}.py`);
    writeFileSync(loginScript, "import os\nfrom huggingface_hub import login\nlogin(token=os.environ['HF_TOKEN'])");
    try {
      execFileSync(python, [loginScript], { stdio: "pipe", env: { ...process.env, HF_TOKEN: String(token) } });
    } finally { try { unlinkSync(loginScript); } catch {} }
    console.log(t.ok("  Logged in to HuggingFace.\n"));
  } catch (error) {
    console.error(t.warn(`  HuggingFace login failed for ${embedChoice.id} / ${rerankChoice.id}.`));
    console.error(t.dim(`  Error: ${String(error).slice(0, 200)}`));
    console.error(t.dim("  Check your token at https://huggingface.co/settings/tokens\n"));
  }
}

async function warmModel(python: string, model: ModelInfo, trustRemoteCode: boolean, loader: "SentenceTransformer" | "CrossEncoder"): Promise<void> {
  const trustArg = trustRemoteCode ? ", trust_remote_code=True" : "";
  const sizeLabel = model.sizeMb ? ` (~${model.sizeMb >= 1000 ? (model.sizeMb / 1000).toFixed(1) + " GB" : model.sizeMb + " MB"})` : "";
  let sp = ora(`Downloading ${model.name}${sizeLabel}...`).start();
  // Write Python code to temp file instead of using -c flag.
  // On Windows, spawn with shell:false and long -c strings can cause EINVAL.
  const script = loader === "SentenceTransformer"
    ? `import sys\nfrom sentence_transformers import SentenceTransformer\nSentenceTransformer(sys.argv[1]${trustArg})`
    : `import sys\nfrom sentence_transformers import CrossEncoder\nCrossEncoder(sys.argv[1]${trustArg})`;
  const tmpScript = resolve(tmpdir(), `threadclaw_warm_${randomUUID()}.py`);
  writeFileSync(tmpScript, script);
  // 300ms per MB = ~3.3 MB/s minimum speed. 1.5GB model = 450s, 6GB model = 1800s
  const timeoutMs = Math.max(900000, (model.sizeMb || 1500) * 300);
  try {
    await runCommandWithSpinner(sp, `Downloading ${model.name}${sizeLabel}...`, python, [tmpScript, model.id], {
      timeoutMs,
      activityTimeoutMs: 0, // HuggingFace downloads may produce no output for long periods
      env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: "0", PYTHONUNBUFFERED: "1" },
    });
    sp.succeed(`${model.name} ready`);
  } catch (error) {
    const msg = String(error);
    let hint = "";
    if (msg.includes("403") || msg.includes("Forbidden") || msg.includes("gated"))
      hint = "\nThis model may require authentication. Run: huggingface-cli login";
    else if (msg.includes("429") || msg.includes("rate"))
      hint = "\nRate limited by HuggingFace. Wait 60 seconds and retry.";
    else if (msg.includes("disk") || msg.includes("space") || msg.includes("ENOSPC"))
      hint = "\nInsufficient disk space. Free up space and retry.";
    else if (msg.includes("timed out") || msg.includes("timeout"))
      hint = "\nDownload timed out. Check your internet connection and retry.";

    sp.fail(`${model.name} download failed.${hint}`);
    throw new Error(`Model download failed for ${model.name}: ${msg.slice(0, 300)}${hint}`);
  } finally {
    try { unlinkSync(tmpScript); } catch {}
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
      sp.warn("Integration failed. Run 'threadclaw integrate --apply' later.");
    }
  }
}

export async function enableObsidianVault(envPath: string): Promise<void> {
  const vaults = detectObsidianVaults();
  if (vaults.length === 0) {
    console.log(t.dim("  No Obsidian vault detected.\n"));
    return;
  }
  const root = resolve(envPath, "..");
  const currentEnv = readEnvMap(root);
  const currentWatch = currentEnv.WATCH_PATHS?.trim() ?? "";
  const obsidianEntry = `${vaults[0]}|obsidian`;
  const updatedWatch = currentWatch ? `${currentWatch},${obsidianEntry}` : obsidianEntry;

  updateEnvValues(root, {
    OBSIDIAN_ENABLED: "true",
    OBSIDIAN_VAULT_PATH: vaults[0],
    OBSIDIAN_COLLECTION: "obsidian",
    WATCH_PATHS: updatedWatch,
  });
  console.log(t.ok("  Obsidian indexing enabled.\n"));
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

  // RAG database
  const env = readEnvMap(root);
  const dataDir = env.THREADCLAW_DATA_DIR || resolve(root, "data");
  const dbPath = resolve(dataDir, "threadclaw.db");
  const homeDbPath = resolve(process.env.HOME || process.env.USERPROFILE || "~", ".threadclaw", "data", "threadclaw.db");
  const dbExists = existsSync(dbPath) || existsSync(homeDbPath);
  checks.push(["RAG database", dbExists, dbExists ? undefined : "Database will be created on first service start"]);

  // Config
  checks.push(["Configuration file", existsSync(envPath)]);
  checks.push(["Model configuration", existsSync(resolve(root, "server", "config.json")) || existsSync(resolve(root, "config.json"))]);

  // Global command
  try {
    const which = getPlatform() === "windows" ? "where" : "which";
    execFileSync(which, ["threadclaw"], { stdio: "pipe", timeout: 5000 });
    checks.push(["threadclaw global command", true]);
  } catch {
    checks.push(["threadclaw global command", false, `Run: cd ${root} && npm link`]);
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
    console.log(t.warn("  Some checks failed. ThreadClaw will work with reduced functionality."));
    console.log(t.dim("  Fix the items above and restart services to enable all features.\n"));
  }
}

function installSkills(openclawDir: string | null, _sourceRoot: string, root: string): void {
  if (!openclawDir) return;
  try {
    const openclawConfig = JSON.parse(readFileSync(resolve(openclawDir, "openclaw.json"), "utf-8"));
    const workspace = openclawConfig?.agents?.defaults?.workspace ?? resolve(openclawDir, "workspace");
    const shippedDir = resolve(root, "skills");
    if (!existsSync(shippedDir)) return;
    const workspaceSkillsDir = resolve(workspace, "skills");
    mkdirSync(workspaceSkillsDir, { recursive: true });

    // Use syncSkills for proper 3-way merge (same as upgrade path)
    const { syncSkills } = require("../../skills.js");
    const { readManifest, writeManifest } = require("../../version.js");
    const manifest = readManifest();
    const { results, updatedHashes } = syncSkills(shippedDir, workspaceSkillsDir, manifest.skills ?? {});
    for (const r of results) {
      if (r.action === "installed") console.log(t.ok(`  Skills: ${r.name} installed`));
      else if (r.action === "updated") console.log(t.ok(`  Skills: ${r.name} updated`));
      else if (r.action === "skipped") console.log(t.warn(`  Skills: ${r.name} skipped — ${r.reason}`));
    }
    // Persist skill hashes in manifest so upgrade can detect user modifications
    writeManifest({ ...manifest, skills: updatedHashes });
  } catch (error) {
    console.error(t.warn(`  Skills sync failed (non-fatal): ${String(error).slice(0, 200)}`));
  }
}

export function getRecommendedTier(gpu: GpuInfo): "lite" | "standard" | "premium" {
  if (!gpu.detected) return "lite";
  // Premium needs ~11 GB (Nemotron 3B + Gemma reranker). Require 20GB+ to leave
  // headroom for OS, desktop apps, and CUDA overhead. Previously 16GB triggered
  // premium which caused OOM when both models loaded together.
  if (gpu.vramTotalMb >= 20000) return "premium";
  if (gpu.vramTotalMb >= 8000) return "standard";
  return "lite";
}

export function formatTierName(tier: string): string {
  if (tier === "premium") return "Premium";
  if (tier === "standard") return "Standard";
  if (tier === "lite") return "Lite";
  return "Custom";
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
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; activityTimeoutMs?: number } = {},
): Promise<void> {
  await runStreamedCommand(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    activityTimeoutMs: options.activityTimeoutMs,
    onLine: (line) => {
      const clean = sanitizeCommandLine(line);
      if (clean) spinner.text = `${prefix} ${clean}`.slice(0, 180);
    },
  });
}
