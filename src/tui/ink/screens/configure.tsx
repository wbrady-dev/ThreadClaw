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
  const relationsEnabled = env.CLAWCORE_MEMORY_RELATIONS_ENABLED === "true";
  const deepEnabled = env.CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED === "true";
  const evidenceSummary = !relationsEnabled
    ? t.dim("disabled")
    : t.ok(
      [
        "entities",
        env.CLAWCORE_MEMORY_RELATIONS_AWARENESS_ENABLED === "true" ? "awareness" : "",
        env.CLAWCORE_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED === "true" ? "claims" : "",
        env.CLAWCORE_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED === "true" ? "attempts" : "",
        deepEnabled ? "deep" : "",
      ].filter(Boolean).join(", "),
    );

  const menuItems: MenuItem[] = [
    { label: "Embedding model", value: "configure-embed", description: "Change vector model and rebuild requirements" },
    { label: "Reranker model", value: "configure-rerank", description: "Change reranking model" },
    { label: "Query expansion", value: "configure-expansion", description: "Local or cloud chat expansion" },
    { label: "Search tuning", value: "configure-search", description: "Top-K, token budget, chunking" },
    { label: "Document parser", value: "configure-parser", description: "Docling off, CPU, or GPU" },
    { label: "Image OCR", value: "configure-ocr", description: "Tesseract install and status" },
    { label: "Audio transcription", value: "configure-audio", description: "Whisper model and enablement" },
    { label: "NER (Entity Extraction)", value: "configure-ner", description: "spaCy model for named entity recognition" },
    { label: "Evidence OS", value: "configure-evidence", description: "Relations, awareness, claims, deep extraction" },
    { label: "Watch paths", value: "configure-watch", description: "Auto-ingest folders and collections" },
    { label: "Ports & defaults", value: "configure-general", description: "Ports, collection, data path" },
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
      <KV label="Data Directory" value={env.CLAWCORE_DATA_DIR ?? "./data"} />

      <Section title="Defaults" />
      <KV label="Collection" value={env.DEFAULT_COLLECTION ?? "default"} />
      <KV label="Results / Query" value={env.QUERY_TOP_K ?? "10"} />
      <KV label="Token Budget" value={env.QUERY_TOKEN_BUDGET ?? "4000"} />
      <KV label="API Port" value={env.CLAWCORE_PORT ?? "18800"} />

      <Section title="Evidence OS" />
      <KV label="Status" value={evidenceSummary} />
      <KV label="Context Tier" value={relationsEnabled ? t.value(env.CLAWCORE_MEMORY_RELATIONS_CONTEXT_TIER ?? "standard") : t.dim("n/a")} />
      <KV
        label="Deep Model"
        value={
          deepEnabled
            ? t.value(
              env.CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL
                ? `${env.CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER ?? "default"}/${env.CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL}`
                : "summary/OpenClaw default",
            )
            : t.dim("off")
        }
      />

      {tick < 0 && <Text />}
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

