import { embed } from "./client.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

// Read config values inline to support hot-reload (not captured at module load)
function getBatchSize(): number { return config.embedding.batchSize; }
function getMaxConcurrent(): number { return config.extraction.embeddingMaxConcurrent; }

export interface BatchProgress {
  completed: number;
  total: number;
}

/**
 * Embed texts in batches with concurrency control and adaptive retry.
 * If a batch fails, retries with halved batch size (32 → 16 → 8 → 4 → 1).
 */
export async function embedBatch(
  texts: string[],
  type: "passage" | "query" = "passage",
  onProgress?: (progress: BatchProgress) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const batchSize = getBatchSize();
  const batches: { texts: string[]; startIdx: number }[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push({ texts: texts.slice(i, i + batchSize), startIdx: i });
  }

  const results: number[][] = new Array(texts.length);
  let completed = 0;

  // Process batches with limited concurrency
  const queue = [...batches];
  const running = new Set<Promise<void>>();

  let aborted = false;
  async function processBatch(batch: { texts: string[]; startIdx: number }) {
    if (aborted) return;
    let embeddings: number[][];
    try {
      embeddings = await embedWithRetry(batch.texts, type);
    } catch (err) {
      aborted = true;
      throw err;
    }
    for (let i = 0; i < embeddings.length; i++) {
      results[batch.startIdx + i] = embeddings[i];
    }
    completed += batch.texts.length;
    onProgress?.({ completed, total: texts.length });
  }

  for (const item of queue) {
    const p = processBatch(item).finally(() => running.delete(p));
    running.add(p);

    if (running.size >= getMaxConcurrent()) {
      await Promise.race(running);
    }
  }

  await Promise.all(running);

  logger.info(
    { texts: texts.length, batches: batches.length },
    "Batch embedding complete",
  );

  return results;
}

/**
 * Embed with adaptive retry — if a batch fails, split it in half and retry.
 * Goes from batchSize → batchSize/2 → ... → 1 before giving up.
 */
async function embedWithRetry(
  texts: string[],
  type: "passage" | "query",
  batchSize: number = texts.length,
): Promise<number[][]> {
  try {
    return await embed(texts, type);
  } catch (err) {
    // If circuit breaker is open or request is invalid (4xx), don't retry — fail immediately
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("circuit breaker")) {
      throw err;
    }
    const status = (err as any)?.status ?? (err as any)?.statusCode ?? 0;
    if (status >= 400 && status < 500) {
      throw err;
    }

    if (batchSize <= 1) {
      throw err;
    }

    const halfSize = Math.ceil(batchSize / 2);
    logger.warn(
      { batchSize, halfSize, error: String(err) },
      "Embedding batch failed, retrying with smaller batches",
    );

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += halfSize) {
      const sub = texts.slice(i, i + halfSize);
      const subResults = await embedWithRetry(sub, type, halfSize);
      results.push(...subResults);
    }
    return results;
  }
}
