/**
 * Token usage tracker for RSMA local models.
 * Uses a JSON file as the backing store so all module instances
 * share the same counters (tsx can create isolated module graphs).
 *
 * Writes are buffered in memory and flushed every 5 seconds
 * to avoid excessive file I/O during high-throughput ingestion.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { resolve } from "path";
import { homedir } from "os";
import { logger } from "./logger.js";

interface TokenCounts {
  ingest: number;
  embed: number;
  rerank: number;
  queryExpansion: number;
}

const TRACKER_FILE = resolve(homedir(), ".threadclaw", "token-counts.json");
const FLUSH_INTERVAL_MS = 5000;

// In-memory buffer for pending increments
const pending: TokenCounts = { ingest: 0, embed: 0, rerank: 0, queryExpansion: 0 };
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function ensureDir(): void {
  try {
    mkdirSync(resolve(homedir(), ".threadclaw"), { recursive: true });
  } catch {}
}

function readCounts(): TokenCounts {
  try {
    const raw = readFileSync(TRACKER_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    // Validate shape — corrupt JSON returns defaults with a warning
    if (typeof parsed !== "object" || parsed === null) {
      logger.warn("[token-tracker] Corrupt token-counts.json (not an object), resetting to zero");
      return { ingest: 0, embed: 0, rerank: 0, queryExpansion: 0 };
    }
    return parsed;
  } catch (err) {
    // Log warning for parse errors (not just missing file)
    if (err instanceof SyntaxError) {
      logger.warn("[token-tracker] Corrupt JSON in token-counts.json, resetting to zero");
    }
    return { ingest: 0, embed: 0, rerank: 0, queryExpansion: 0 };
  }
}

function writeCounts(counts: TokenCounts): void {
  ensureDir();
  // Atomic write: write to tmp file then rename to prevent corruption on crash
  const tmpPath = TRACKER_FILE + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(counts));
  renameSync(tmpPath, TRACKER_FILE);
}

/** Async flush — non-blocking, used by the periodic timer. */
async function flushAsync(): Promise<void> {
  const hasPending = pending.ingest || pending.embed || pending.rerank || pending.queryExpansion;
  if (!hasPending) return;

  const snapshot = { ...pending };

  try {
    await mkdir(resolve(homedir(), ".threadclaw"), { recursive: true });
    let counts: TokenCounts = { ingest: 0, embed: 0, rerank: 0, queryExpansion: 0 };
    try {
      const raw = await readFile(TRACKER_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) counts = parsed;
    } catch {}

    counts.ingest += snapshot.ingest;
    counts.embed += snapshot.embed;
    counts.rerank += snapshot.rerank;
    counts.queryExpansion += snapshot.queryExpansion;

    const tmpPath = TRACKER_FILE + ".tmp";
    await writeFile(tmpPath, JSON.stringify(counts));
    await rename(tmpPath, TRACKER_FILE);

    pending.ingest -= snapshot.ingest;
    pending.embed -= snapshot.embed;
    pending.rerank -= snapshot.rerank;
    pending.queryExpansion -= snapshot.queryExpansion;
  } catch {
    // Non-fatal — tokens stay in pending and will be retried next flush
  }
}

/** Sync flush — used only on shutdown where we must block. */
function flushSync(): void {
  const hasPending = pending.ingest || pending.embed || pending.rerank || pending.queryExpansion;
  if (!hasPending) return;

  const snapshot = { ...pending };

  const counts = readCounts();
  counts.ingest += snapshot.ingest;
  counts.embed += snapshot.embed;
  counts.rerank += snapshot.rerank;
  counts.queryExpansion += snapshot.queryExpansion;
  writeCounts(counts);

  pending.ingest -= snapshot.ingest;
  pending.embed -= snapshot.embed;
  pending.rerank -= snapshot.rerank;
  pending.queryExpansion -= snapshot.queryExpansion;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAsync().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  // Don't prevent process exit
  if (flushTimer.unref) flushTimer.unref();
}

export function trackTokens(category: keyof TokenCounts, tokens: number): void {
  // Validate tokens parameter to prevent NaN/Infinity from corrupting counts
  if (!Number.isFinite(tokens) || tokens < 0) return;
  pending[category] += tokens;
  scheduleFlush();
}

export function getTokenCounts(): TokenCounts {
  // Merge persisted + pending for accurate reads
  const persisted = readCounts();
  return {
    ingest: persisted.ingest + pending.ingest,
    embed: persisted.embed + pending.embed,
    rerank: persisted.rerank + pending.rerank,
    queryExpansion: persisted.queryExpansion + pending.queryExpansion,
  };
}

/** Force flush pending tokens to disk synchronously (call on shutdown). */
export function flushTokens(): void {
  flushSync();
}
