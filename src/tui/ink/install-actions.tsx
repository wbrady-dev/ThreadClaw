import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { resolve } from "path";
import {
  type EvidenceConfig,
  type InstallPlan,
  OFF_EVIDENCE,
  QUICK_EVIDENCE,
  applyOpenClawIntegration,
  enableObsidianVault,
  getFreeDiskGb,
  getRecommendedTier,
  installWindowsServicesNow,
  loginHuggingFace,
  performInstallPlan,
} from "../screens/install.js";
import { detectObsidianVaults } from "../../sources/adapters/obsidian.js";
import {
  CLOUD_EMBED_PROVIDERS,
  CLOUD_RERANK_PROVIDERS,
  detectGpu,
  EMBED_MODELS,
  getRecommendation,
  RERANK_MODELS,
  type GpuInfo,
  type ModelInfo,
} from "../models.js";
import {
  findOpenClaw,
  getPlatform,
  getPythonCmd,
  getRootDir,
} from "../platform.js";
import { promptConfirm, promptMenu, promptText } from "./prompts.js";
import { t } from "./components.js";

export async function runInkInstall(): Promise<boolean> {
  const proceed = await promptConfirm({
    title: "Welcome to ThreadClaw",
    message: "ThreadClaw is a local RAG system that indexes your documents and provides\nsemantic search, knowledge graphs, and context compilation for AI assistants.\n\nRecommended setup gets you to a working local install quickly. Advanced setup lets you tune models, parsing, evidence, integrations, and services up front.",
    confirmLabel: "Begin setup",
    cancelLabel: "Cancel",
  });
  if (!proceed) return false;

  const python = getPythonCmd();
  const platform = getPlatform();
  const sourceRoot = getRootDir();
  const openclawDir = findOpenClaw();

  const prereqError = validatePrerequisites(python);
  if (prereqError) {
    await showNotice("Prerequisites", prereqError);
    return false;
  }

  const gpu = detectGpu();
  if (!gpu.detected) {
    const cpuOk = await promptConfirm({
      title: "GPU Not Detected",
      message: "ThreadClaw can still run in CPU mode, but indexing and search will be slower. Continue?",
      confirmLabel: "Use CPU mode",
      cancelLabel: "Cancel",
    });
    if (!cpuOk) return false;
  }

  let root: string;
  if (openclawDir) {
    const defaultRoot = resolve(openclawDir, "services", "threadclaw");
    const useDefault = await promptConfirm({
      title: "Install Location",
      message: `OpenClaw detected. Install to ${defaultRoot}?`,
      confirmLabel: "Use OpenClaw directory",
      cancelLabel: "Choose different location",
    });
    if (useDefault == null) return false;
    if (useDefault) {
      root = defaultRoot;
    } else {
      const installDir = await promptText({
        title: "Install Location",
        message: "Enter a custom install directory.",
        label: "Install directory",
        initial: sourceRoot,
      });
      if (!installDir) return false;
      root = resolve(installDir);
    }
  } else {
    const installDir = await promptText({
      title: "Install Location",
      message: "No OpenClaw detected. Enter the ThreadClaw install directory.",
      label: "Install directory",
      initial: sourceRoot,
    });
    if (!installDir) return false;
    root = resolve(installDir);
  }
  // If target directory doesn't have package.json, copy source files there (fresh install)
  if (!existsSync(resolve(root, "package.json"))) {
    if (root !== sourceRoot && existsSync(resolve(sourceRoot, "package.json"))) {
      const { cpSync, mkdirSync } = await import("fs");
      mkdirSync(root, { recursive: true });
      console.log(t.dim(`\n  Copying ThreadClaw source to ${root}...`));
      console.log(t.dim("  (node_modules, .venv, data, and .git are skipped — they will be created fresh)\n"));
      let fileCount = 0;
      cpSync(sourceRoot, root, {
        recursive: true,
        filter: (src) => {
          // Skip heavy/runtime dirs that will be recreated by the installer.
          // Keep memory-engine/node_modules (monorepo deps can't be npm-installed).
          const rel = src.slice(sourceRoot.length + 1).replace(/\\/g, "/");
          if ((rel === "node_modules" || rel.startsWith("node_modules/")) && !rel.startsWith("memory-engine/")) return false;
          if (rel === ".venv" || rel.startsWith(".venv/")) return false;
          if (rel === "dist" || rel.startsWith("dist/")) return false;
          if (rel === "data" || rel.startsWith("data/")) return false;
          if (rel === "logs" || rel.startsWith("logs/")) return false;
          if (rel === ".git" || rel.startsWith(".git/")) return false;
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
      await showNotice("Install Location", "The selected directory does not contain a ThreadClaw package checkout.");
      return false;
    }
  }

  const freeDiskGb = getFreeDiskGb(platform, root);
  if (freeDiskGb !== null && freeDiskGb < 15) {
    const continueAnyway = await promptConfirm({
      title: "Low Disk Space",
      message: `Only about ${Math.round(freeDiskGb)}GB free disk space was detected on the selected install volume. Continue anyway?`,
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
    });
    if (!continueAnyway) return false;
  }

  const setupMode = await promptMenu({
    title: "Setup Style",
    message: gpu.detected
      ? `Detected GPU: ${gpu.name} (${gpu.vramTotalMb} MB VRAM)`
      : "No GPU detected.",
    items: [
      { label: "Recommended", value: "recommended", description: "Fast path with sensible defaults." },
      { label: "Advanced", value: "advanced", description: "Choose features during setup." },
      { label: "Cancel", value: "__back__", color: t.dim },
    ],
  });
  if (!setupMode || setupMode === "__back__") return false;
  const isRecommended = setupMode === "recommended";

  let embedChoice: ModelInfo | null;
  let rerankChoice: ModelInfo | null;

  if (isRecommended) {
    const tier = getRecommendedTier(gpu);
    const presetMap: Record<string, { embed: string; rerank: string }> = {
      lite: { embed: "sentence-transformers/all-MiniLM-L12-v2", rerank: "cross-encoder/ms-marco-MiniLM-L-6-v2" },
      standard: { embed: "BAAI/bge-large-en-v1.5", rerank: "BAAI/bge-reranker-large" },
      premium: { embed: "nvidia/omni-embed-nemotron-3b", rerank: "BAAI/bge-reranker-v2-gemma" },
    };
    embedChoice = EMBED_MODELS.find((model) => model.id === presetMap[tier].embed) ?? null;
    rerankChoice = RERANK_MODELS.find((model) => model.id === presetMap[tier].rerank) ?? null;
  } else {
    // Advanced: pick models individually — cancel offers exit
    while (true) {
      embedChoice = await selectModel("embed", gpu, 0, python);
      if (embedChoice) break;
      const retry = await promptConfirm({
        title: "Embedding Model",
        message: "No model selected. Try again?",
        confirmLabel: "Try Again",
        cancelLabel: "Cancel Install",
      });
      if (!retry) return false;
    }
    while (true) {
      rerankChoice = await selectModel("rerank", gpu, embedChoice.vramMb, python);
      if (rerankChoice) break;
      const retry = await promptConfirm({
        title: "Reranker Model",
        message: "No model selected. Try again?",
        confirmLabel: "Try Again",
        cancelLabel: "Cancel Install",
      });
      if (!retry) return false;
    }
  }
  if (!embedChoice || !rerankChoice) {
    await showNotice("Model Selection", "Unable to resolve the selected model preset.");
    return false;
  }

  const totalVram = embedChoice.vramMb + rerankChoice.vramMb;
  if (gpu.detected && gpu.vramTotalMb - totalVram < 0) {
    const forceModels = await promptConfirm({
      title: "VRAM Warning",
      message: `${embedChoice.name} + ${rerankChoice.name} needs about ${totalVram} MB VRAM, which exceeds the detected free budget. Continue anyway?`,
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
    });
    if (!forceModels) return false;
  }

  let parser = "off";
  let enableOcr = false;
  let enableAudio = false;
  let evidenceConfig: EvidenceConfig = OFF_EVIDENCE;
  let integrateOpenClaw = false;
  let enableObsidian = false;
  let installWindowsServices = false;

  if (isRecommended) {
    parser = "cpu";
    enableOcr = true;
    enableAudio = true;
    evidenceConfig = QUICK_EVIDENCE;
    if (openclawDir) integrateOpenClaw = true;

    // Offer to set up watch paths for document folders
    const docsFolder = resolve(homedir(), "Documents");
    const docsFolderExists = existsSync(docsFolder);
    const watchPrompt = docsFolderExists
      ? `Would you like ThreadClaw to watch your Documents folder (${docsFolder}) for new files to index? You can add more folders later from Configure.`
      : "Would you like ThreadClaw to watch any folders for documents? You can add more later from Configure.";
    const watchDocs = await promptConfirm({
      title: "Watch Paths",
      message: watchPrompt,
      confirmLabel: docsFolderExists ? "Watch Documents folder" : "Add a folder",
      cancelLabel: "Skip for now",
    });
    if (watchDocs) {
      if (docsFolderExists) {
        process.env.THREADCLAW_INSTALL_WATCH_PATHS = `${docsFolder}|documents`;
      } else {
        const customPath = await promptText({
          title: "Watch Path",
          message: "Enter the full path to a folder you'd like ThreadClaw to watch.",
          label: "Folder path",
        });
        if (customPath && existsSync(customPath)) {
          process.env.THREADCLAW_INSTALL_WATCH_PATHS = `${customPath}|documents`;
        }
      }
    }
  } else {
    ({ parser, enableOcr, enableAudio } = await promptDocumentSettings());
    evidenceConfig = await promptEvidenceSettings();

    if (openclawDir) {
      integrateOpenClaw = Boolean(await promptConfirm({
        title: "OpenClaw Integration",
        message: "OpenClaw was detected. Integrate it during setup?",
        confirmLabel: "Integrate now",
        cancelLabel: "Later",
      }));
    }

    const vaults = detectObsidianVaults();
    if (vaults.length > 0) {
      enableObsidian = Boolean(await promptConfirm({
        title: "Obsidian Vault",
        message: `Detected Obsidian vault: ${vaults[0]}. Enable indexing now?`,
        confirmLabel: "Enable",
        cancelLabel: "Skip",
      }));
    }

    if (platform === "windows") {
      installWindowsServices = Boolean(await promptConfirm({
        title: "Windows Services",
        message: "Install Windows services for auto-start?",
        confirmLabel: "Install services",
        cancelLabel: "Skip",
      }));
    }
  }

  let huggingFaceToken = "";
  if (embedChoice.gated || rerankChoice.gated) {
    huggingFaceToken = await promptText({
      title: "HuggingFace Login",
      message: "These models require HuggingFace authentication. Paste your token now or cancel to skip.",
      label: "Token",
      mask: "*",
      allowEmpty: true,
    }) ?? "";
  }

  const ready = await promptConfirm({
    title: "Ready to Install",
    message: [
      `Directory: ${root}`,
      `Mode: ${isRecommended ? "Recommended" : "Advanced"}`,
      `Embedding: ${embedChoice.name}`,
      `Reranker: ${rerankChoice.name}`,
      `Parser: ${parser === "off" ? "Standard" : `Docling (${parser})`}`,
      `OCR: ${enableOcr ? "Tesseract" : "Off"}`,
      `Audio: ${enableAudio ? "Whisper (base)" : "Off"}`,
      `NER: spaCy (en_core_web_sm)`,
      `Evidence: ${evidenceConfig.relationsEnabled ? "Enabled" : "Off"}`,
      integrateOpenClaw ? `OpenClaw: Integrate` : "",
    ].filter(Boolean).join("\n"),
    confirmLabel: "Install",
    cancelLabel: "Cancel",
  });
  if (!ready) return false;

  let installSuccess = false;
  while (!installSuccess) {
    try {
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
        integrateOpenClaw,
        enableObsidian,
        installWindowsServices,
        huggingFaceToken,
      } satisfies InstallPlan);
      installSuccess = true;
    } catch (error) {
      const fullError = error instanceof Error ? error.message : String(error);
      const action = await promptMenu({
        title: "Installation Failed",
        message: `${fullError}\n\nCheck the terminal output above for details.`,
        items: [
          { label: "Retry installation", value: "retry" },
          { label: "Continue to main menu (incomplete install)", value: "continue" },
        ],
      });
      if (action === "continue" || !action) break;
      // action === "retry" → loop continues
    }
  }
  if (!installSuccess) return false;

  const markerPath = resolve(root, ".install-complete");
  if (!existsSync(markerPath)) {
    await showNotice("Warning", "Install completion marker could not be written. Next launch may re-run installer.");
  }

  await promptMenu({
    title: "Installation Complete",
    message: "ThreadClaw is installed. Continue to the main menu to start services and finish setup.",
    items: [{ label: "Continue to main menu", value: "continue" }],
  });
  return true;
}

function validatePrerequisites(python: string): string | null {
  try {
    const nodeVersion = execFileSync("node", ["--version"], { stdio: "pipe" }).toString().trim();
    const nodeMajor = parseInt(nodeVersion.replace(/^v/, ""), 10);
    if (!Number.isFinite(nodeMajor) || nodeMajor < 22) return `Node.js ${nodeVersion} found, but v22+ is required.`;

    const pythonVersion = execFileSync(python, ["--version"], { stdio: "pipe" }).toString().trim();
    const pythonParts = pythonVersion.replace(/Python\s*/i, "").split(".");
    const pythonMajor = parseInt(pythonParts[0], 10);
    const pythonMinor = parseInt(pythonParts[1], 10);
    if (!Number.isFinite(pythonMajor) || pythonMajor < 3 || (pythonMajor === 3 && (!Number.isFinite(pythonMinor) || pythonMinor < 10)))
      return `${pythonVersion} found, but Python 3.10+ is required.`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

async function promptDocumentSettings(): Promise<{ parser: string; enableOcr: boolean; enableAudio: boolean }> {
  const mode = await promptMenu({
    title: "Document Processing",
    message: "Choose how much parsing and media extraction to enable during setup.",
    items: [
      { label: "Enable all", value: "all", description: "Docling CPU + OCR + audio transcription." },
      { label: "Configure individually", value: "configure", description: "Pick parser, OCR, and audio separately." },
      { label: "Skip for now", value: "skip", color: t.dim },
    ],
  });

  if (!mode || mode === "skip") return { parser: "off", enableOcr: false, enableAudio: false };
  if (mode === "all") return { parser: "cpu", enableOcr: true, enableAudio: true };

  const parser = await promptMenu({
    title: "Document Parser",
    items: [
      { label: "Standard only", value: "off" },
      { label: "Docling CPU", value: "cpu" },
      { label: "Docling GPU", value: "gpu" },
    ],
  });
  const ocr = await promptConfirm({
    title: "Image OCR",
    message: "Enable Tesseract OCR for screenshots and scanned images?",
    confirmLabel: "Enable OCR",
    cancelLabel: "Skip",
  });
  const audio = await promptConfirm({
    title: "Audio Transcription",
    message: "Enable Whisper transcription for supported audio files?",
    confirmLabel: "Enable audio",
    cancelLabel: "Skip",
  });

  return {
    parser: parser ?? "off",
    enableOcr: Boolean(ocr),
    enableAudio: Boolean(audio),
  };
}

async function promptEvidenceSettings(): Promise<EvidenceConfig> {
  const tier = await promptMenu({
    title: "Evidence OS",
    message: "Choose how much graph-aware memory and context compilation to enable during install.",
    items: [
      { label: "Quick Start", value: "quick", description: "Entity awareness + context compiler." },
      { label: "Off", value: "off", description: "Search only." },
      { label: "Custom", value: "custom", description: "Choose features individually." },
    ],
  });

  if (!tier || tier === "off") return OFF_EVIDENCE;
  if (tier === "quick") return QUICK_EVIDENCE;

  const awareness = await promptConfirm({
    title: "Awareness Notes",
    message: "Enable entity awareness notes in the compiled context?",
    confirmLabel: "Enable",
    cancelLabel: "Skip",
  });
  const claims = await promptConfirm({
    title: "Claim Extraction",
    message: "Enable claim extraction from results and notes?",
    confirmLabel: "Enable",
    cancelLabel: "Skip",
  });
  const attempts = await promptConfirm({
    title: "Attempt Tracking",
    message: "Enable tool attempt tracking and failure-memory capture?",
    confirmLabel: "Enable",
    cancelLabel: "Skip",
  });

  const deep = await promptConfirm({
    title: "Deep Extraction",
    message: "Use an LLM to extract richer entities and relationships from text. Requires a local or cloud chat model (Ollama, LM Studio, OpenAI, etc.). Only runs when you call cc_ask — never automatic.",
    confirmLabel: "Enable",
    cancelLabel: "Skip",
  });

  let deepProvider = "";
  let deepModel = "";
  if (deep) {
    const deepProviderVal = await promptText({
      title: "Deep Extraction Provider",
      message: "Examples: ollama, lmstudio, openai, anthropic. Leave blank for summary model.",
      label: "Provider",
      allowEmpty: true,
    });
    deepProvider = deepProviderVal ?? "";

    const deepModelVal = await promptText({
      title: "Deep Extraction Model",
      message: "Examples: llama3.1:8b, gpt-4o-mini, claude-sonnet-4-20250514.",
      label: "Model",
      allowEmpty: true,
    });
    deepModel = deepModelVal ?? "";
  }

  if (deep && (deepProvider || deepModel)) {
    if (deepProvider) process.env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER = deepProvider;
    if (deepModel) process.env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL = deepModel;
  }

  return {
    relationsEnabled: Boolean(awareness || claims || attempts || deep),
    awarenessEnabled: Boolean(awareness),
    claimExtraction: Boolean(claims),
    attemptTracking: Boolean(attempts),
    deepExtraction: Boolean(deep),
  };
}

async function selectModel(
  type: "embed" | "rerank",
  gpu: GpuInfo,
  otherModelVram: number,
  python: string,
): Promise<ModelInfo | null> {
  const catalog = type === "embed" ? EMBED_MODELS : RERANK_MODELS;

  const value = await promptMenu({
    title: type === "embed" ? "Embedding Model" : "Reranker Model",
    message: "Pick a model from the catalog or use a custom HuggingFace model.",
    items: [
      ...catalog.map((model) => {
        const recommendation = getRecommendation(model, gpu, otherModelVram);
        const badge = recommendation === "recommended"
          ? "[recommended]"
          : recommendation === "fits"
            ? "[fits]"
            : recommendation === "tight"
              ? "[tight]"
              : recommendation === "too-large"
                ? "[too large]"
                : "";
        return {
          label: `${model.name} ${badge}`.trim(),
          value: model.id,
          description: `${model.vramMb} MB VRAM | ${model.tier} | ${model.notes}`,
        };
      }),
      { label: "── Other ──────────────────────", value: "__sep__", color: t.dim },
      { label: "Cloud provider", value: "__cloud__", color: t.ok, description: "OpenAI, Cohere, Voyage AI, or other API-compatible provider." },
      { label: "Custom HuggingFace model", value: "__custom__", color: t.ok, description: "Enter any model ID from huggingface.co." },
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!value || value === "__back__" || value === "__sep__") return null;
  if (value === "__cloud__") return promptCloudModel(type);
  if (value === "__custom__") return promptCustomModel(python, type);
  return catalog.find((model) => model.id === value) ?? null;
}

async function promptCustomModel(python: string, type: "embed" | "rerank"): Promise<ModelInfo | null> {
  const modelId = await promptText({
    title: "Custom HuggingFace Model",
    message: "Enter any model ID from huggingface.co.",
    label: "Model ID",
  });
  if (!modelId) return null;

  try {
    if (type === "embed") {
      // Use sys.argv[1] for model ID — never interpolate user input into Python code
      const script = "import sys; from sentence_transformers import SentenceTransformer; model = SentenceTransformer(sys.argv[1], trust_remote_code=True); print(model.get_sentence_embedding_dimension())";
      const tmpScript = resolve(tmpdir(), `threadclaw_check_${randomUUID()}.py`);
      writeFileSync(tmpScript, script);
      let output: string;
      try {
        output = execFileSync(python, [tmpScript, modelId], { stdio: "pipe", timeout: 600000 }).toString().trim();
      } finally { try { unlinkSync(tmpScript); } catch {} }
      const dims = parseInt(output, 10) || 0;
      return {
        id: modelId,
        name: modelId.split("/").pop() ?? modelId,
        dims,
        vramMb: 0,
        sizeMb: 0,
        tier: "Custom",
        qualityScore: 5,
        languages: "Unknown",
        trustRemoteCode: true,
        gated: false,
        notes: "Custom model",
      };
    }

    // Use sys.argv[1] for model ID — never interpolate user input into Python code
    const rerankScript = "import sys; from sentence_transformers import CrossEncoder; CrossEncoder(sys.argv[1], trust_remote_code=True)";
    const tmpRerankScript = resolve(tmpdir(), `threadclaw_check_${randomUUID()}.py`);
    writeFileSync(tmpRerankScript, rerankScript);
    try {
      execFileSync(python, [tmpRerankScript, modelId], { stdio: "pipe", timeout: 600000 });
    } finally { try { unlinkSync(tmpRerankScript); } catch {} }
    return {
      id: modelId,
      name: modelId.split("/").pop() ?? modelId,
      dims: 0,
      vramMb: 0,
      sizeMb: 0,
      tier: "Custom",
      qualityScore: 5,
      languages: "Unknown",
      trustRemoteCode: true,
      gated: false,
      notes: "Custom model",
    };
  } catch {
    await showNotice("Custom Model", `${modelId} failed to load.`);
    return null;
  }
}

async function promptCloudModel(type: "embed" | "rerank"): Promise<ModelInfo | null> {
  const providers = type === "embed" ? CLOUD_EMBED_PROVIDERS : CLOUD_RERANK_PROVIDERS;

  const providerName = await promptMenu({
    title: "Cloud Provider",
    message: "Pick the provider backing this model.",
    items: [
      ...providers.map((p) => ({ label: p.name, value: p.name, description: p.hint })),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });
  if (!providerName || providerName === "__back__") return null;
  const provider = providers.find((p) => p.name === providerName);
  if (!provider) return null;

  const apiUrl = await promptText({
    title: "API Endpoint",
    message: provider.hint,
    label: "API URL",
    initial: provider.apiUrl || "https://",
  });
  if (!apiUrl) return null;

  const modelName = await promptText({
    title: "Model Name",
    message: "Model ID from the provider.",
    label: "Model",
  });
  if (!modelName) return null;

  let dims = 1536;
  if (type === "embed") {
    const dimsVal = await promptText({
      title: "Embedding Dimensions",
      message: "Check the provider docs for the correct output dimension.",
      label: "Dimensions",
      initial: "1536",
    });
    if (!dimsVal) return null;
    dims = parseInt(dimsVal, 10) || 1536;
  }

  const apiKey = await promptText({
    title: "API Key",
    message: `Enter the API key for ${providerName}. This will be saved locally in your .env file.`,
    label: "API Key",
    mask: "*",
    allowEmpty: true,
  }) ?? "";

  // Store cloud config in env during install (performInstallPlan handles .env writing)
  // Set env vars so config.ts picks them up
  if (type === "embed") {
    process.env.EMBEDDING_URL = apiUrl.replace(/\/+$/, "");
    process.env.EMBEDDING_MODEL = modelName;
    process.env.EMBEDDING_DIMENSIONS = String(dims);
    if (apiKey) process.env.EMBEDDING_API_KEY = apiKey;
  } else {
    process.env.RERANKER_URL = apiUrl.replace(/\/+$/, "");
    process.env.RERANKER_MODEL = modelName;
    if (apiKey) process.env.RERANKER_API_KEY = apiKey;
  }

  return {
    id: `${providerName}/${modelName}`,
    name: `${providerName}/${modelName}`,
    dims,
    vramMb: 0,
    sizeMb: 0,
    tier: "Cloud",
    qualityScore: 7,
    languages: "Varies",
    trustRemoteCode: false,
    gated: false,
    notes: `Cloud: ${providerName}`,
  };
}

async function showNotice(title: string, message: string): Promise<void> {
  await promptMenu({
    title,
    message,
    items: [{ label: "Continue", value: "continue" }],
  });
}

