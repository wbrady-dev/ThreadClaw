import prompts from "prompts";
import ora from "ora";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { homedir, tmpdir } from "os";
import { clearScreen, kvLine, section, t } from "../theme.js";
import { selectMenu } from "../menu.js";
import {
  findOpenClaw,
  getPlatform,
  getPythonCmd,
  getRootDir,
} from "../platform.js";
import {
  detectGpu,
  EMBED_MODELS,
  getRecommendation,
  RERANK_MODELS,
  type GpuInfo,
  type ModelInfo,
} from "../models.js";
import {
  type EvidenceConfig,
  type InstallPlan,
  QUICK_EVIDENCE,
  OFF_EVIDENCE,
  getRecommendedTier,
  formatTierName,
  getFreeDiskGb,
  performInstallPlan,
} from "../install-helpers.js";

let cancelled = false;
const onCancel = () => {
  cancelled = true;
};

export async function runInstall(): Promise<void> {
  clearScreen();
  cancelled = false;

  console.log(section("Welcome to ThreadClaw"));
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
  const sp = ora("Checking system...").start();

  try {
    const nodeVersion = execFileSync("node", ["--version"], { stdio: "pipe" }).toString().trim();
    const nodeMajor = parseInt(nodeVersion.replace(/^v/, ""), 10);
    if (!Number.isFinite(nodeMajor) || nodeMajor < 22) throw new Error(`Node.js ${nodeVersion} found, but v22+ is required.`);
    const pythonVersion = execFileSync(python, ["--version"], { stdio: "pipe" }).toString().trim();
    const pythonParts = pythonVersion.replace(/Python\s*/i, "").split(".");
    const pythonMajor = parseInt(pythonParts[0], 10);
    const pythonMinor = parseInt(pythonParts[1], 10);
    if (!Number.isFinite(pythonMajor) || pythonMajor < 3 || (pythonMajor === 3 && (!Number.isFinite(pythonMinor) || pythonMinor < 10)))
      throw new Error(`${pythonVersion} found, but Python 3.10+ is required.`);
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
    console.log(t.warn("  No GPU detected. ThreadClaw will run in CPU mode."));
    const { cpuOk } = await prompts({ type: "confirm", name: "cpuOk", message: "Continue with CPU mode?", initial: true }, { onCancel });
    if (!cpuOk || cancelled) return;
  }

  console.log(section("Install Location"));
  let root: string;
  if (openclawDir) {
    // OpenClaw detected — default to its services directory
    const defaultRoot = resolve(openclawDir, "services", "threadclaw");
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
    const defaultDir = resolve(homedir(), ".threadclaw");
    const { installDir } = await prompts({ type: "text", name: "installDir", message: "Install directory", initial: defaultDir }, { onCancel });
    if (!installDir || cancelled) return;
    root = resolve(installDir);
  }
  // If target doesn't have package.json, copy source files there (fresh install to new location)
  if (!existsSync(resolve(root, "package.json"))) {
    if (root !== sourceRoot && existsSync(resolve(sourceRoot, "package.json"))) {
      console.log(t.dim(`\n  Copying ThreadClaw source to ${root}...`));
      console.log(t.dim("  (node_modules, .venv, and data are skipped — they will be created fresh)\n"));
      mkdirSync(root, { recursive: true });
      let fileCount = 0;
      cpSync(sourceRoot, root, {
        recursive: true,
        filter: (src) => {
          // Skip heavy/runtime dirs that will be recreated by the installer.
          // Keep memory-engine/node_modules (monorepo deps can't be npm-installed).
          // Keep .git/ so install location is a proper git repo (enables threadclaw update).
          const rel = src.slice(sourceRoot.length + 1).replace(/\\/g, "/");
          if ((rel === "node_modules" || rel.startsWith("node_modules/")) && !rel.startsWith("memory-engine/")) return false;
          if (rel === ".venv" || rel.startsWith(".venv/")) return false;
          if (rel === "dist" || rel.startsWith("dist/")) return false;
          if (rel === "data" || rel.startsWith("data/")) return false;
          if (rel === "logs" || rel.startsWith("logs/")) return false;
          if (rel === ".env") return false;
          if (rel) {
            fileCount++;
            if (fileCount % 50 === 0) process.stdout.write(`\r  Copied ${fileCount} files...`);
          }
          return true;
        },
      });
      process.stdout.write(`\r  Copied ${fileCount} files.           \n`);
    }
    if (!existsSync(resolve(root, "package.json"))) {
      console.log(t.err("\n  The selected directory does not contain a ThreadClaw package checkout.\n"));
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
  const tier = isRecommended ? getRecommendedTier(gpu) : await selectTier();
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
    // Warn when combined VRAM exceeds 90% of GPU — leaves too little for OS/desktop.
    // Also warn when it exceeds 100% (obviously won't fit).
    if (remaining < 0) {
      console.log(t.err("  These models together exceed your GPU's VRAM. They will not fit."));
      const { forceVram } = await prompts({ type: "confirm", name: "forceVram", message: "Force install anyway? (will likely OOM)", initial: false }, { onCancel });
      if (!forceVram || cancelled) return;
    } else if (totalVram > gpu.vramTotalMb * 0.9) {
      console.log(t.warn("  Combined VRAM usage is very high (>90%). Model server may OOM under load."));
      console.log(t.dim("  Consider a lighter reranker or choosing Standard tier instead."));
      const { continueVram } = await prompts({ type: "confirm", name: "continueVram", message: "Continue with these models?", initial: true }, { onCancel });
      if (!continueVram || cancelled) return;
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

    // Offer to set up watch paths for document folders
    const docsFolder = resolve(homedir(), "Documents");
    const docsFolderExists = existsSync(docsFolder);
    console.log(section("Watch Paths"));
    if (docsFolderExists) {
      console.log(t.dim(`  Detected Documents folder: ${docsFolder}\n`));
      const { watchDocs } = await prompts({
        type: "confirm", name: "watchDocs",
        message: "Watch your Documents folder for new files to index? (You can add more later)",
        initial: true,
      }, { onCancel });
      if (!cancelled && watchDocs) {
        process.env.THREADCLAW_INSTALL_WATCH_PATHS = `${docsFolder}|documents`;
        console.log(t.ok(`  Will watch: ${docsFolder}\n`));
      }
    } else {
      const { addWatch } = await prompts({
        type: "confirm", name: "addWatch",
        message: "Would you like ThreadClaw to watch any folders for documents? (You can add more later)",
        initial: false,
      }, { onCancel });
      if (!cancelled && addWatch) {
        const { customPath } = await prompts({
          type: "text", name: "customPath",
          message: "Folder path to watch",
        }, { onCancel });
        if (!cancelled && customPath && existsSync(customPath)) {
          process.env.THREADCLAW_INSTALL_WATCH_PATHS = `${customPath}|documents`;
          console.log(t.ok(`  Will watch: ${customPath}\n`));
        }
      }
    }
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
    integrateOpenClaw: Boolean(openclawDir),
    // Obsidian prompt is only shown during advanced install; recommended skips it
    enableObsidian: !isRecommended && !cancelled,
    installWindowsServices: !isRecommended && platform === "windows",
    huggingFaceToken: "",
  });

  await selectMenu([{ label: "Continue to main menu", value: "done", color: t.dim }]);
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
  // __cloud__ returns null here — cloud config is handled post-install via Configure screen
  if (!modelId || modelId === "__back__" || modelId === "__cloud__") return null;
  if (modelId === "__custom__") return handleCustomModel(pythonCmd);
  return models.find((model) => model.id === modelId) ?? null;
}

async function handleCustomModel(pythonCmd: string): Promise<ModelInfo | null> {
  const { modelId } = await prompts({ type: "text", name: "modelId", message: "HuggingFace model ID" }, { onCancel });
  if (!modelId || cancelled) return null;
  const sp = ora(`Testing ${modelId}...`).start();
  try {
    // Use sys.argv[1] for model ID — never interpolate user input into Python code
    const tmpScript = resolve(tmpdir(), `threadclaw_check_${randomUUID()}.py`);
    writeFileSync(tmpScript, "import sys; from sentence_transformers import SentenceTransformer; m = SentenceTransformer(sys.argv[1], trust_remote_code=True); print(m.get_sentence_embedding_dimension())");
    let output: string;
    try {
      output = execFileSync(pythonCmd, [tmpScript, modelId], { stdio: "pipe", timeout: 600000 }).toString().trim();
    } finally { try { unlinkSync(tmpScript); } catch {} }
    const dims = parseInt(output, 10) || 0;
    sp.succeed(`${modelId} works. Dimensions: ${dims}`);
    return { id: modelId, name: modelId.split("/").pop() ?? modelId, dims, vramMb: 0, sizeMb: 0, tier: "Custom", qualityScore: 5, languages: "Unknown", trustRemoteCode: true, gated: false, notes: "Custom model" };
  } catch {
    sp.fail(`${modelId} failed to load.`);
    return null;
  }
}

function tierColorFn(score: number): (text: string) => string {
  if (score <= 4) return t.dim;
  if (score <= 5) return t.muted;
  if (score <= 6) return t.info;
  if (score <= 7) return t.ok;
  if (score <= 8) return t.warn;
  // 9-10: premium tier — use highlight (green) rather than err (red)
  return t.highlight;
}
