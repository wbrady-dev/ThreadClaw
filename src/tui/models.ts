/**
 * Embedding and reranking model catalog for ThreadClaw RAG.
 * Every model verified on HuggingFace as of 2026-03-17.
 * Covers the full spectrum from Raspberry Pi to datacenter GPUs.
 */

import { execFileSync, execFile as ef } from "child_process";
import { promisify } from "util";

export interface ModelInfo {
  id: string;
  name: string;
  dims: number;
  vramMb: number;
  sizeMb: number;
  tier: string; // descriptive label: "Fast & Light", "Balanced", "High Accuracy", etc.
  qualityScore: number; // 1-10 for sorting/recommendations
  languages: string;
  trustRemoteCode: boolean;
  gated: boolean;
  notes: string;
  prefixRequired?: boolean;
  cloud?: {
    provider: string;
    apiUrl: string;
    requiresKey: boolean;
  };
}

// ═══════════════════════════════════════════
// EMBEDDING MODELS (sorted by VRAM ascending)
// ═══════════════════════════════════════════

export const EMBED_MODELS: ModelInfo[] = [
  // ── Tiny (CPU / Raspberry Pi / < 100MB) ──
  {
    id: "sentence-transformers/all-MiniLM-L6-v2",
    name: "MiniLM-L6",
    dims: 384, vramMb: 50, sizeMb: 80,
    tier: "Fast & Light", qualityScore: 4,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Most popular lightweight model. 5x faster than base.",
  },
  {
    id: "Supabase/gte-small",
    name: "GTE Small",
    dims: 384, vramMb: 50, sizeMb: 70,
    tier: "Fast & Light", qualityScore: 4,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Compact GTE variant. Production-tested.",
  },
  {
    id: "sentence-transformers/all-MiniLM-L12-v2",
    name: "MiniLM-L12",
    dims: 384, vramMb: 65, sizeMb: 120,
    tier: "Fast & Light", qualityScore: 5,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "12-layer MiniLM. Better quality than L6.",
  },
  {
    id: "intfloat/e5-small-v2",
    name: "E5 Small v2",
    dims: 384, vramMb: 65, sizeMb: 130,
    tier: "Fast & Light", qualityScore: 5,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Microsoft E5 family. Needs 'query:' / 'passage:' prefix.",
    prefixRequired: true,
  },

  // ── Small (Low VRAM / 100-500MB) ──
  {
    id: "intfloat/multilingual-e5-small",
    name: "E5 Small (Multi)",
    dims: 384, vramMb: 180, sizeMb: 450,
    tier: "Multilingual", qualityScore: 5,
    languages: "100 languages",
    trustRemoteCode: false, gated: false,
    notes: "Best lightweight multilingual. 100 languages.",
    prefixRequired: true,
  },
  {
    id: "nomic-ai/nomic-embed-text-v1.5",
    name: "Nomic Embed v1.5",
    dims: 768, vramMb: 200, sizeMb: 390,
    tier: "Balanced", qualityScore: 6,
    languages: "English",
    trustRemoteCode: true, gated: false,
    notes: "8K context. Matryoshka embeddings. Open source.",
  },

  // ── Medium (Consumer GPUs 4-8GB / 400MB-1.5GB) ──
  {
    id: "intfloat/e5-base-v2",
    name: "E5 Base v2",
    dims: 768, vramMb: 400, sizeMb: 440,
    tier: "Balanced", qualityScore: 6,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Strong baseline. Microsoft E5 family.",
    prefixRequired: true,
  },
  {
    id: "BAAI/bge-base-en-v1.5",
    name: "BGE Base v1.5",
    dims: 768, vramMb: 400, sizeMb: 440,
    tier: "Balanced", qualityScore: 6,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Industry standard. Great quality-speed balance.",
  },
  {
    id: "Alibaba-NLP/gte-base-en-v1.5",
    name: "GTE Base v1.5",
    dims: 768, vramMb: 500, sizeMb: 550,
    tier: "Balanced", qualityScore: 6,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Alibaba GTE family. Strong retrieval quality.",
  },
  {
    id: "mixedbread-ai/mxbai-embed-large-v1",
    name: "MxBai Embed Large",
    dims: 1024, vramMb: 700, sizeMb: 670,
    tier: "High Accuracy", qualityScore: 7,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Top open-source embed. Used by OpenClaw default.",
  },

  // ── Large (8-16GB GPUs / 1-3GB) ──
  {
    id: "intfloat/e5-large-v2",
    name: "E5 Large v2",
    dims: 1024, vramMb: 1400, sizeMb: 1350,
    tier: "High Accuracy", qualityScore: 7,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Top-tier Microsoft E5. Excellent accuracy.",
    prefixRequired: true,
  },
  {
    id: "BAAI/bge-large-en-v1.5",
    name: "BGE Large v1.5",
    dims: 1024, vramMb: 1400, sizeMb: 1340,
    tier: "High Accuracy", qualityScore: 7,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Excellent MTEB. Widely used in production.",
  },
  {
    id: "intfloat/multilingual-e5-large",
    name: "E5 Large (Multi)",
    dims: 1024, vramMb: 2200, sizeMb: 2000,
    tier: "Multilingual", qualityScore: 7,
    languages: "100 languages",
    trustRemoteCode: false, gated: false,
    notes: "Best large multilingual model.",
    prefixRequired: true,
  },
  {
    id: "BAAI/bge-m3",
    name: "BGE-M3",
    dims: 1024, vramMb: 2800, sizeMb: 1200,
    tier: "Multilingual+", qualityScore: 8,
    languages: "170+ languages",
    trustRemoteCode: false, gated: false,
    notes: "Dense + sparse retrieval. 8K context. 170+ languages.",
  },
  {
    id: "jinaai/jina-embeddings-v3",
    name: "Jina Embed v3",
    dims: 1024, vramMb: 2200, sizeMb: 1100,
    tier: "Multilingual", qualityScore: 8,
    languages: "89 languages",
    trustRemoteCode: true, gated: false,
    notes: "8K context. Task-specific LoRA. Multi-language.",
  },

  // ── Premium (16-24GB GPUs / 3-8GB) ──
  {
    id: "NovaSearch/stella_en_400M_v5",
    name: "Stella 400M v5",
    dims: 1024, vramMb: 3200, sizeMb: 1500,
    tier: "Reasoning", qualityScore: 8,
    languages: "English",
    trustRemoteCode: true, gated: false,
    notes: "Matryoshka. 128K context. Excellent reasoning.",
  },
  {
    id: "Alibaba-NLP/gte-Qwen2-1.5B-instruct",
    name: "GTE-Qwen2 1.5B",
    dims: 1536, vramMb: 4500, sizeMb: 3000,
    tier: "Instruction", qualityScore: 9,
    languages: "Multilingual",
    trustRemoteCode: true, gated: false,
    notes: "Qwen2-based. Instruction-tuned. Very strong.",
  },
  {
    id: "nvidia/omni-embed-nemotron-3b",
    name: "Omni-Embed Nemotron 3B",
    dims: 2048, vramMb: 6500, sizeMb: 6000,
    tier: "Reasoning", qualityScore: 9,
    languages: "English",
    trustRemoteCode: true, gated: false,
    notes: "NVIDIA 3B embedding. Strong reasoning benchmark scores.",
    prefixRequired: true,
  },
  {
    id: "NovaSearch/stella_en_1.5B_v5",
    name: "Stella 1.5B v5",
    dims: 1024, vramMb: 6200, sizeMb: 6000,
    tier: "Deep Context", qualityScore: 9,
    languages: "English",
    trustRemoteCode: true, gated: false,
    notes: "128K context. Flexible dimensions.",
  },

  // ── Elite (Datacenter / DGX) ──
  {
    id: "nvidia/llama-embed-nemotron-8b",
    name: "Nemotron Embed 8B",
    dims: 4096, vramMb: 18000, sizeMb: 16000,
    tier: "Research-Grade", qualityScore: 10,
    languages: "100+ languages",
    trustRemoteCode: true, gated: false,
    notes: "Top multilingual MTEB. 8B params. Datacenter-class.",
    prefixRequired: true,
  },

];

// ── Cloud Embedding Providers ──
export const CLOUD_EMBED_PROVIDERS = [
  { name: "OpenAI", apiUrl: "https://api.openai.com/v1", hint: "e.g., text-embedding-3-small, text-embedding-3-large" },
  { name: "Cohere", apiUrl: "https://api.cohere.com/v2", hint: "e.g., embed-v4.0, embed-multilingual-v3.0" },
  { name: "Voyage AI", apiUrl: "https://api.voyageai.com/v1", hint: "e.g., voyage-3.5, voyage-3.5-lite, voyage-code-3" },
  { name: "Google Gemini", apiUrl: "https://generativelanguage.googleapis.com/v1beta", hint: "e.g., gemini-embedding-001" },
  { name: "Together AI", apiUrl: "https://api.together.xyz/v1", hint: "e.g., togethercomputer/m2-bert-80M-8k-retrieval" },
  { name: "Other", apiUrl: "", hint: "Any OpenAI-compatible embedding endpoint" },
];

// ═══════════════════════════════════════════
// RERANKING MODELS (sorted by VRAM ascending)
// ═══════════════════════════════════════════

export const RERANK_MODELS: ModelInfo[] = [
  // ── Tiny ──
  {
    id: "cross-encoder/ms-marco-MiniLM-L-2-v2",
    name: "MiniLM Rerank (Tiny)",
    dims: 0, vramMb: 30, sizeMb: 50,
    tier: "Fastest", qualityScore: 3,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Fastest reranker. Minimal quality.",
  },
  {
    id: "cross-encoder/ms-marco-MiniLM-L-6-v2",
    name: "MiniLM Rerank (Small)",
    dims: 0, vramMb: 50, sizeMb: 80,
    tier: "Fast", qualityScore: 5,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Good balance for low-resource setups.",
  },

  // ── Medium ──
  {
    id: "cross-encoder/ms-marco-MiniLM-L-12-v2",
    name: "MiniLM Rerank (12-layer)",
    dims: 0, vramMb: 120, sizeMb: 130,
    tier: "Balanced", qualityScore: 6,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "12-layer cross-encoder. Good quality.",
  },
  {
    id: "cross-encoder/ms-marco-electra-base",
    name: "Electra Rerank",
    dims: 0, vramMb: 440, sizeMb: 440,
    tier: "Balanced", qualityScore: 6,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Electra-based. Better than MiniLM on complex queries.",
  },
  {
    id: "BAAI/bge-reranker-base",
    name: "BGE Reranker Base",
    dims: 0, vramMb: 500, sizeMb: 440,
    tier: "Balanced", qualityScore: 6,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "Production standard. Solid accuracy.",
  },

  // ── Large ──
  {
    id: "BAAI/bge-reranker-large",
    name: "BGE Reranker Large",
    dims: 0, vramMb: 1400, sizeMb: 1340,
    tier: "High Accuracy", qualityScore: 7,
    languages: "English",
    trustRemoteCode: false, gated: false,
    notes: "High accuracy. Top open-source English reranker.",
  },
  {
    id: "jinaai/jina-reranker-v2-base-multilingual",
    name: "Jina Reranker v2 (Multi)",
    dims: 0, vramMb: 1100, sizeMb: 1100,
    tier: "Multilingual", qualityScore: 7,
    languages: "100 languages",
    trustRemoteCode: true, gated: false,
    notes: "Multilingual reranking. 8K context.",
  },
  {
    id: "BAAI/bge-reranker-v2-m3",
    name: "BGE Reranker v2 M3",
    dims: 0, vramMb: 2200, sizeMb: 1200,
    tier: "Multilingual+", qualityScore: 8,
    languages: "100+ languages",
    trustRemoteCode: false, gated: false,
    notes: "Multilingual. Pairs perfectly with bge-m3.",
  },

  // ── Premium ──
  {
    id: "BAAI/bge-reranker-v2-gemma",
    name: "BGE Reranker Gemma",
    dims: 0, vramMb: 4500, sizeMb: 4500,
    tier: "Top Accuracy", qualityScore: 9,
    languages: "Multilingual",
    trustRemoteCode: false, gated: false,
    notes: "Gemma-based. Highest accuracy open-source reranker.",
  },
  {
    id: "nvidia/llama-nemotron-rerank-vl-1b-v2",
    name: "Nemotron Rerank VL",
    dims: 0, vramMb: 4500, sizeMb: 3400,
    tier: "Vision+Text", qualityScore: 9,
    languages: "English + Vision",
    trustRemoteCode: true, gated: true,
    notes: "NVIDIA. Text + visual document reranking.",
  },

];

// ── Cloud Reranking Providers ──
export const CLOUD_RERANK_PROVIDERS = [
  { name: "Cohere", apiUrl: "https://api.cohere.com/v2", hint: "e.g., rerank-v3.5, rerank-multilingual-v3.0" },
  { name: "Jina AI", apiUrl: "https://api.jina.ai/v1", hint: "e.g., jina-reranker-v2-base-multilingual" },
  { name: "Voyage AI", apiUrl: "https://api.voyageai.com/v1", hint: "e.g., rerank-2.5, rerank-2.5-lite" },
  { name: "Other", apiUrl: "", hint: "Any reranking API endpoint" },
];

// ═══════════════════════════════════════════
// GPU DETECTION
// ═══════════════════════════════════════════

export interface GpuInfo {
  name: string;
  vramTotalMb: number;
  vramUsedMb: number;
  vramFreeMb: number;
  detected: boolean;
}

const GPU_NONE: GpuInfo = { name: "None detected", vramTotalMb: 0, vramUsedMb: 0, vramFreeMb: 0, detected: false };

/** Module-level cache populated by detectGpuAsyncImpl, read by detectGpu. */
let _cachedGpuResult: GpuInfo | null = null;

/**
 * Sync GPU detection — thin wrapper.
 * Returns cached async result if available, otherwise does a minimal sync probe
 * (nvidia-smi only) to unblock the initial TUI render. The full async detection
 * should be kicked off early via detectGpuAsyncImpl().
 */
export function detectGpu(): GpuInfo {
  if (_cachedGpuResult) return _cachedGpuResult;

  // Minimal sync fallback — just nvidia-smi (fast) + platform hint
  try {
    const output = execFileSync(
      "nvidia-smi", ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
      { stdio: "pipe", timeout: 3000 },
    ).toString().trim();
    const [name, total, used, free] = output.split(",").map((s) => s.trim());
    if (name && total) {
      const result: GpuInfo = { name, vramTotalMb: parseInt(total), vramUsedMb: parseInt(used), vramFreeMb: parseInt(free), detected: true };
      _cachedGpuResult = result;
      return result;
    }
  } catch {}

  // On non-NVIDIA systems the sync path just returns a platform hint;
  // the full detection (AMD, Mac, Windows WMI, lspci) runs async.
  if (process.platform === "darwin") {
    return { name: "GPU (detecting...)", vramTotalMb: 0, vramUsedMb: 0, vramFreeMb: 0, detected: false };
  }
  return GPU_NONE;
}

const execAsync = promisify(ef);

/**
 * Canonical async GPU detection — the single source of truth.
 * Uses non-blocking execFile. Populates the module-level cache so that
 * subsequent sync detectGpu() calls return instantly.
 */
export async function detectGpuAsyncImpl(): Promise<GpuInfo> {
  // Always re-query to get live VRAM usage (nvidia-smi is fast, ~50ms)
  const result = await _detectGpuAsyncCore();
  _cachedGpuResult = result;
  return result;
}

async function _detectGpuAsyncCore(): Promise<GpuInfo> {
  // NVIDIA
  try {
    const { stdout } = await execAsync(
      "nvidia-smi", ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 3000 },
    );
    const [name, total, used, free] = stdout.trim().split(",").map((s) => s.trim());
    if (name && total) {
      return { name, vramTotalMb: parseInt(total), vramUsedMb: parseInt(used), vramFreeMb: parseInt(free), detected: true };
    }
  } catch {}

  // AMD ROCm
  try {
    const { stdout } = await execAsync("rocm-smi", ["--showmeminfo", "vram", "--csv"], { timeout: 3000 });
    const lines = stdout.trim().split("\n");
    if (lines.length >= 2) {
      let name = "AMD GPU";
      try {
        const n = await execAsync("rocm-smi", ["--showproductname", "--csv"], { timeout: 3000 });
        name = n.stdout.trim().split("\n")[1]?.split(",")[1]?.trim() ?? name;
      } catch {}
      const parts = lines[1].split(",");
      const totalMb = Math.round(parseInt(parts[1] ?? "0") / 1024 / 1024);
      const usedMb = Math.round(parseInt(parts[2] ?? "0") / 1024 / 1024);
      return { name, vramTotalMb: totalMb, vramUsedMb: usedMb, vramFreeMb: totalMb - usedMb, detected: true };
    }
  } catch {}

  // macOS
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execAsync("system_profiler", ["SPDisplaysDataType"], { timeout: 5000 });
      const nameMatch = stdout.match(/Chipset Model:\s*(.+)/i) ?? stdout.match(/Chip:\s*(.+)/i);
      if (nameMatch) {
        const gpuName = nameMatch[1].trim();
        let totalMb = 0;
        const memMatch = stdout.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
        if (memMatch) {
          totalMb = parseInt(memMatch[1]) * (memMatch[2].toUpperCase() === "GB" ? 1024 : 1);
        } else {
          try {
            const hw = await execAsync("sysctl", ["-n", "hw.memsize"], { timeout: 2000 });
            totalMb = Math.round((parseInt(hw.stdout.trim()) / 1024 / 1024) * 0.75);
          } catch {}
        }
        return { name: gpuName, vramTotalMb: totalMb, vramUsedMb: 0, vramFreeMb: totalMb, detected: true };
      }
    } catch {}
  }

  // Windows PowerShell (AMD/Intel fallback)
  if (process.platform === "win32") {
    try {
      const { stdout } = await execAsync(
        "powershell", ["-NoProfile", "-c", "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM | ConvertTo-Json"],
        { timeout: 3000 },
      );
      const gpus = JSON.parse(stdout.trim().startsWith("[") ? stdout.trim() : `[${stdout.trim()}]`);
      let best = { name: "", ram: 0 };
      for (const gpu of gpus) {
        const ram = parseInt(gpu.AdapterRAM ?? "0");
        const name: string = gpu.Name ?? "";
        if (ram > best.ram && !name.includes("Microsoft") && !name.includes("Basic")) {
          best = { name, ram };
        }
      }
      if (best.ram > 0) {
        const totalMb = Math.round(best.ram / 1024 / 1024);
        return { name: best.name, vramTotalMb: totalMb, vramUsedMb: 0, vramFreeMb: totalMb, detected: true };
      }
    } catch {}
  }

  // Linux lspci fallback
  if (process.platform === "linux") {
    try {
      const { stdout } = await execAsync("lspci", [], { timeout: 3000 });
      const line = stdout.split("\n").filter((l) => /vga|3d|display/i.test(l)).join("\n").trim();
      if (line) {
        const name = line.split(":").slice(-1)[0]?.trim() ?? "GPU";
        return { name, vramTotalMb: 0, vramUsedMb: 0, vramFreeMb: 0, detected: true };
      }
    } catch {}
  }

  return GPU_NONE;
}

export function getRecommendation(
  model: ModelInfo,
  gpu: GpuInfo,
  otherModelVram: number = 0,
): "recommended" | "fits" | "tight" | "too-large" | "unknown" {
  if (!gpu.detected) return "unknown";

  const available = gpu.vramTotalMb - otherModelVram - 500;
  const needed = model.vramMb;

  if (needed <= available * 0.5) return "recommended";
  if (needed <= available * 0.8) return "fits";
  if (needed <= available) return "tight";
  return "too-large";
}
