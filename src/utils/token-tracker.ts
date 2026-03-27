/**
 * Token usage tracker for RSMA local models.
 * Uses a JSON file as the backing store so all module instances
 * share the same counters (tsx can create isolated module graphs).
 *
 * Writes are buffered in memory and flushed every 5 seconds
 * to avoid excessive file I/O during high-throughput ingestion.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

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
      console.warn("[token-tracker] Corrupt token-counts.json (not an object), resetting to zero");
      return { ingest: 0, embed: 0, rerank: 0, queryExpansion: 0 };
    }
    return parsed;
  } catch (err) {
    // Log warning for parse errors (not just missing file)
    if (err instanceof SyntaxError) {
      console.warn("[token-tracker] Corrupt JSON in token-counts.json, resetting to zero");
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

function flush(): void {
  const hasPending = pending.ingest || pending.embed || pending.rerank || pending.queryExpansion;
  if (!hasPending) return;

  const counts = readCounts();
  counts.ingest += pending.ingest;
  counts.embed += pending.embed;
  counts.rerank += pending.rerank;
  counts.queryExpansion += pending.queryExpansion;
  writeCounts(counts);

  // Reset pending
  pending.ingest = 0;
  pending.embed = 0;
  pending.rerank = 0;
  pending.queryExpansion = 0;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
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

/** Force flush pending tokens to disk (call on shutdown). */
export function flushTokens(): void {
  flush();
}
