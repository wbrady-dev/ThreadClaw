import React, { useState } from "react";
import { Box, Text } from "ink";
import { getRootDir, readConfig } from "../../platform.js";
import { Menu, Section, KV, Separator, t, useInterval, type MenuItem } from "../components.js";
import { formatDoclingDevice, getExpansionStatus, getWatchPaths } from "../../screens/configure.js";
import { readEnvMap } from "../../env.js";

export function ConfigureScreen({
  onBack,
  onAction,
}: {
  onBack: () => void;
  onAction: (action: string) => void;
}) {
  const [tick, setTick] = useState(0);
  useInterval(() => setTick((value) => value + 1), 4000);

  const root = getRootDir();
  const config = readConfig();
  const env = readEnvMap(root);
  const watchPaths = getWatchPaths(root);
  const relationsEnabled = env.THREADCLAW_MEMORY_RELATIONS_ENABLED === "true";
  const deepEnabled = env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED === "true";
  const evidenceSummary = !relationsEnabled
    ? t.dim("disabled")
    : t.ok(
      [
        "entities",
        env.THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED === "true" ? "awareness" : "",
        env.THREADCLAW_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED === "true" ? "claims" : "",
        env.THREADCLAW_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED === "true" ? "attempts" : "",
        deepEnabled ? "deep" : "",
      ].filter(Boolean).join(", "),
    );

  const menuItems: MenuItem[] = [
    // ── Models (required) ──
    { label: "── Models (required) ──────────────", value: "__sep_models__", color: t.dim },
    { label: "  Embedding model", value: "configure-embed", description: "Vector model for search" },
    { label: "  Reranker model", value: "configure-rerank", description: "Cross-encoder for result ranking" },

    // ── Retrieval ──
    { label: "", value: "__sep_blank1__" },
    { label: "── Retrieval ─────────────────────", value: "__sep_retrieval__", color: t.dim },
    { label: "  Search & ranking", value: "configure-search-ranking", description: "Reranking thresholds, hybrid weights, caching" },
    { label: "  Query expansion", value: "configure-expansion", description: "LLM-powered query rewriting (optional)" },

    // ── Ingestion ──
    { label: "", value: "__sep_blank2__" },
    { label: "── Ingestion ─────────────────────", value: "__sep_ingestion__", color: t.dim },
    { label: "  Watch paths", value: "configure-watch", description: "Folders to auto-index" },
    { label: "  Chunking & parsing", value: "configure-chunking", description: "Chunk sizes, overlap, dedup, file limits" },
    { label: "  Document parser", value: "configure-parser", description: "Docling off/CPU/GPU" },
    { label: "  OCR & media", value: "configure-ocr-media", description: "Tesseract, Whisper, spaCy NER" },

    // ── Knowledge Graph ──
    { label: "", value: "__sep_blank3__" },
    { label: "── Knowledge Graph ───────────────", value: "__sep_graph__", color: t.dim },
    { label: "  Evidence OS", value: "configure-evidence", description: "Relations, awareness, extraction, claims" },
    { label: "  Memory & summary", value: "configure-memory-summary", description: "Compaction model, context tier" },

    // ── Advanced ──
    { label: "", value: "__sep_blank4__" },
    { label: "── Advanced ──────────────────────", value: "__sep_advanced__", color: t.dim },
    { label: "  Embedding tuning", value: "configure-embedding-tuning", description: "API key, retries, circuit breaker, cache" },
    { label: "  Watch tuning", value: "configure-watch-tuning", description: "Exclude patterns, concurrency, queue" },
    { label: "  Rate limiting", value: "configure-rate-limiting", description: "API rate limits" },
    { label: "  Network & ports", value: "configure-network", description: "API port, model server URL, data directory" },

    // ── Back ──
    { label: "", value: "__sep_blank5__" },
    { label: "Back", value: "__back__", color: t.dim },
  ];

  return (
    <Box flexDirection="column">
      <Section title="Configuration" />
      <KV label="Embed" value={config?.embed_model?.split("/").pop() ?? "not configured"} />
      <KV label="Rerank" value={config?.rerank_model?.split("/").pop() ?? "not configured"} />
      <KV label="Query Expansion" value={getExpansionStatus(root)} />
      <KV label="Document Parser" value={formatDoclingDevice(config?.docling_device)} />

      <Section title="Automation" />
      <KV label="Watch Paths" value={watchPaths.length > 0 ? t.ok(`${watchPaths.length} active`) : t.dim("none")} />
      <KV label="Watch Debounce" value={`${env.WATCH_DEBOUNCE_MS ?? "3000"}ms`} />
      <KV label="Data Directory" value={env.THREADCLAW_DATA_DIR ?? "./data"} />

      <Section title="Defaults" />
      <KV label="Collection" value={env.DEFAULT_COLLECTION ?? "default"} />
      <KV label="Results / Query" value={env.QUERY_TOP_K ?? "10"} />
      <KV label="Token Budget" value={env.QUERY_TOKEN_BUDGET ?? "4000"} />
      <KV label="API Port" value={env.THREADCLAW_PORT ?? "18800"} />

      <Section title="Evidence OS" />
      <KV label="Status" value={evidenceSummary} />
      <KV label="Context Tier" value={relationsEnabled ? t.value(env.THREADCLAW_MEMORY_RELATIONS_CONTEXT_TIER ?? "standard") : t.dim("n/a")} />
      <KV
        label="Deep Model"
        value={
          deepEnabled
            ? t.value(
              env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL
                ? `${env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER ?? "default"}/${env.THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL}`
                : "summary/OpenClaw default",
            )
            : t.dim("off")
        }
      />

      <Text>{"  " + t.dim("Selecting a section keeps the Ink shell and then opens the specific config flow.")}</Text>
      <Separator width={64} />
      <Menu
        items={menuItems}
        onSelect={(value) => {
          if (value === "__back__") onBack();
          else onAction(value);
        }}
      />
    </Box>
  );
}
