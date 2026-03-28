/**
 * Configure helpers — pure functions extracted from screens/configure.ts.
 * Used by both the Ink configure screen and configure-actions.
 */

import type { EnvMap } from "./env.js";

export type ConfigureAction =
  | "embed"
  | "rerank"
  | "expansion"
  | "search"
  | "parser"
  | "ocr"
  | "audio"
  | "ner"
  | "evidence"
  | "watch"
  | "general"
  | "embedding-tuning"
  | "watch-tuning"
  | "rate-limiting"
  | "search-ranking"
  | "chunking"
  | "ocr-media"
  | "memory-summary"
  | "network";

export function getExpansionStatus(env: EnvMap): string {
  const enabled = env.QUERY_EXPANSION_ENABLED;
  const model = env.QUERY_EXPANSION_MODEL?.trim();
  if (enabled === "true" && model) return model;
  return "off";
}

export function formatDoclingDevice(device?: string): string {
  if (!device || device === "off") return "Standard (built-in)";
  if (device === "cpu") return "Docling (CPU)";
  return "Docling (GPU)";
}

export function getWatchPaths(env: EnvMap): { path: string; collection: string }[] {
  const raw = env.WATCH_PATHS?.trim();
  if (!raw) return [];
  return raw.split(",").filter(Boolean).map((entry) => {
    const pipeIdx = entry.lastIndexOf("|");
    return {
      path: pipeIdx > 0 ? entry.slice(0, pipeIdx) : entry,
      collection: pipeIdx > 0 ? entry.slice(pipeIdx + 1) : "default",
    };
  });
}
