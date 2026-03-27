import type { Stats } from "fs";
import type { DocMetadata } from "./parsers/index.js";

export interface FullMetadata extends DocMetadata {
  sizeBytes?: number;
  modifiedAt?: string;
}

/**
 * Enrich parsed metadata with filesystem stats and user-provided tags.
 *
 * NOTE: This module is intentionally thin — future enrichment (language detection,
 * content classification, auto-summarization) should be added here.
 *
 * @param fileStats - Optional pre-computed file stats from the pipeline (avoids double stat())
 */
export async function enrichMetadata(
  parsedMeta: DocMetadata,
  filePath: string,
  userTags?: string[],
  fileStats?: Stats | null,
): Promise<FullMetadata> {
  const meta: FullMetadata = { ...parsedMeta };

  // Use pre-computed stats if available, otherwise stat() the file
  let stats = fileStats;
  if (stats === undefined) {
    const { stat } = await import("fs/promises");
    try {
      stats = await stat(filePath);
    } catch {
      stats = null;
    }
  }

  if (stats) {
    meta.sizeBytes = stats.size;
    meta.modifiedAt = stats.mtime.toISOString();
  }

  if (userTags && userTags.length > 0) {
    // Deduplicate tags with a Set
    meta.tags = [...new Set([...(meta.tags ?? []), ...userTags])];
  }

  return meta;
}
