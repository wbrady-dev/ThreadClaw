/**
 * End-to-end ingest pipeline test.
 *
 * Ingests a real text file through the full pipeline (parsing, chunking,
 * embedding, dedup, storage) with only the embedding server mocked.
 * Verifies documents + chunks are persisted and survive orphan cleanup.
 *
 * Regression coverage:
 * - Orphan cleanup bug (commit e22c7b2): DELETE FROM chunks WHERE id NOT IN
 *   (SELECT chunk_id FROM chunk_vectors) would wipe all chunks because
 *   chunk_id was compared against rowid (integer vs text mismatch).
 * - Path security bug (commit f6eb2d7): ingest rejected all files outside
 *   the service root directory, silently returning 0 chunks.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { resolve, join } from "path";
import { tmpdir, homedir } from "os";

// ── Mocks (must be before any src/ imports) ────────────────────────────────

// vi.mock factories are hoisted — cannot reference module-scoped variables.
// Compute paths inline using the same logic as above.
vi.mock("../../src/config.js", async () => {
  const { tmpdir } = await import("os");
  const { resolve, join } = await import("path");
  const testDir = resolve(tmpdir(), `threadclaw-e2e-test-${process.pid}`);
  const dataDir = join(testDir, "data");
  return { config: {
    dataDir,
    rootDir: testDir,
    port: 0,
    host: "127.0.0.1",
    apiKey: "",
    embedding: {
      url: "http://localhost:0/v1",
      model: "test-model",
      dimensions: 1024,
      prefixMode: "auto",
      batchSize: 32,
      similarityThreshold: 0.7,
    },
    reranker: { url: "", model: "", timeoutMs: 5000, scoreThreshold: 0, disabled: true, topK: 10, smartSkip: false },
    queryExpansion: { enabled: false, url: "", model: "", apiKey: "", temperature: 0.3, maxTokens: 512, timeoutMs: 15000 },
    query: { cacheMaxEntries: 0, cacheTtlMs: 0, hybridRrfK: 60, hybridVectorWeight: 1, hybridBm25Weight: 1, maxLength: 2000, retrieveMultiplier: 2, lowConfidenceThreshold: 0.3 },
    extraction: {
      ingestMaxFileSizeMb: 100,
      dedupSimilarityThreshold: 0.95,
      dedupMaxPairwise: 500,
      chunkOverlapRatio: 0.2,
      chunkTableRows: 20,
      embeddingMaxConcurrent: 2,
      embeddingMaxRetries: 1,
      embeddingTimeoutMs: 5000,
      embeddingCircuitCooldownMs: 1000,
      embeddingCacheMax: 0,
      ocrLanguage: "eng",
      ocrTimeoutMs: 5000,
      doclingTimeoutMs: 5000,
    },
    watch: { paths: "", debounceMs: 3000, excludePatterns: "", maxConcurrent: 5, maxQueue: 1000 },
    defaults: {
      collection: "default",
      chunkMinTokens: 50,
      chunkMaxTokens: 512,
      chunkTargetTokens: 256,
      queryTopK: 10,
      queryTokenBudget: 4000,
    },
    relations: { enabled: false, graphDbPath: "" },
    brief: { enabled: false, url: "", model: "", apiKey: "", maxTokens: 1024, timeoutMs: 15000, maxSentences: 5, diversitySources: 3 },
  }};
});

// Mock embedding — return deterministic fake vectors
vi.mock("../../src/embeddings/batch.js", () => ({
  embedBatch: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1)))
  ),
}));

// Mock metadata enrichment — passthrough
vi.mock("../../src/ingest/metadata.js", () => ({
  enrichMetadata: vi.fn(async (_text: string, _path: string, meta: any) => meta ?? {}),
}));

// Mock relations — no-op
vi.mock("../../src/relations/ingest-hook.js", () => ({
  extractEntitiesFromDocument: vi.fn(async () => {}),
  deleteSourceData: vi.fn(() => {}),
}));
vi.mock("../../src/storage/graph-sqlite.js", () => ({
  getGraphDb: vi.fn(() => null),
}));

// Mock query cache invalidation — no-op
vi.mock("../../src/query/cache.js", () => ({
  invalidateCollection: vi.fn(),
}));

// Mock logger — silent
vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// Mock token tracker — no-op
vi.mock("../../src/utils/token-tracker.js", () => ({
  trackTokens: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { ingestFile } from "../../src/ingest/pipeline.js";
import { getDb, runMigrations } from "../../src/storage/index.js";
import { _resetForTesting } from "../../src/storage/sqlite.js";

// ── Paths (must match the inline values in the config mock) ────────────────

const TEST_DIR = resolve(tmpdir(), `threadclaw-e2e-test-${process.pid}`);
const DATA_DIR = join(TEST_DIR, "data");

// ── Test content ───────────────────────────────────────────────────────────

const TEST_CONTENT = `ThreadClaw Integration Test Document

This is the first section of the test document. It discusses knowledge graphs
and entity extraction as core components of the Evidence OS system. Named
entities like organizations, people, and locations are identified during the
ingestion pipeline and stored in the graph database for later retrieval.

The second section covers the semantic chunking pipeline. Documents are split
into overlapping chunks based on token count and semantic boundaries. Each chunk
is embedded using a sentence transformer model and stored in a vec0 virtual
table for efficient approximate nearest neighbor search.

The third section describes the retrieval-augmented generation pipeline. When a
user submits a query, the system performs hybrid search combining BM25 keyword
matching with vector similarity. Results are reranked using a cross-encoder
model and packed into a context window for the language model.

The fourth section covers the RSMA memory ontology. Memory objects are stored
with provenance links that track the source, confidence, and temporal context
of each fact. This enables the system to reason about conflicting claims,
track decision history, and maintain an audit trail of knowledge evolution.

This final section ensures the document is long enough to produce multiple
chunks during semantic splitting. The chunker uses a target of roughly 256
tokens per chunk with 20% overlap between adjacent chunks. This test document
should produce at least two chunks given the default configuration settings.`;

// ── Test suite ─────────────────────────────────────────────────────────────

describe("end-to-end ingest pipeline", () => {
  let testFilePath: string;
  let dbPath: string;

  beforeAll(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    testFilePath = join(TEST_DIR, "test-document.txt");
    writeFileSync(testFilePath, TEST_CONTENT);
    dbPath = resolve(DATA_DIR, "threadclaw.db");

    // Initialize DB and run migrations (normally done at server startup)
    const db = getDb(dbPath);
    runMigrations(db);
  });

  afterAll(() => {
    _resetForTesting();
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it("ingests a text file and creates documents + chunks", async () => {
    const result = await ingestFile(testFilePath, { collection: "test-collection" });

    expect(result.documentsAdded).toBe(1);
    expect(result.chunksCreated).toBeGreaterThan(0);
    // duplicatesSkipped may be > 0 due to intra-batch dedup (overlapping chunks)

    // Verify via direct DB queries
    const db = getDb(dbPath);
    const docCount = db.prepare("SELECT COUNT(*) as cnt FROM documents").get() as { cnt: number };
    const chunkCount = db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
    const vectorCount = db.prepare("SELECT COUNT(*) as cnt FROM chunk_vectors").get() as { cnt: number };

    expect(docCount.cnt).toBe(1);
    expect(chunkCount.cnt).toBe(result.chunksCreated);
    expect(vectorCount.cnt).toBe(result.chunksCreated);
  });

  it("chunks contain expected content", () => {
    const db = getDb(dbPath);
    const chunks = db.prepare("SELECT text FROM chunks").all() as { text: string }[];

    expect(chunks.length).toBeGreaterThan(0);
    const allText = chunks.map((c) => c.text).join(" ");
    expect(allText).toContain("knowledge graphs");
    expect(allText).toContain("semantic chunking");
  });

  it("survives orphan cleanup (restart simulation)", () => {
    const db = getDb(dbPath);

    const beforeChunks = (db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }).cnt;
    expect(beforeChunks).toBeGreaterThan(0);

    // Run the exact orphan cleanup SQL from server.ts
    // This is the query that previously wiped all chunks due to chunk_id vs rowid mismatch
    db.exec("DELETE FROM chunks WHERE id NOT IN (SELECT chunk_id FROM chunk_vectors)");

    const afterChunks = (db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }).cnt;
    expect(afterChunks).toBe(beforeChunks);

    // Documents should also survive
    const docCount = (db.prepare("SELECT COUNT(*) as cnt FROM documents").get() as { cnt: number }).cnt;
    expect(docCount).toBe(1);
  });

  it("re-ingest with same content is a no-op (dedup)", async () => {
    const result = await ingestFile(testFilePath, { collection: "test-collection" });

    expect(result.documentsAdded).toBe(0);
    expect(result.documentsUpdated).toBe(0);
    expect(result.chunksCreated).toBe(0);
  });

  it("forced re-ingest replaces the document", async () => {
    const db = getDb(dbPath);
    const beforeChunks = (db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }).cnt;

    const result = await ingestFile(testFilePath, { collection: "test-collection", force: true });

    expect(result.documentsUpdated).toBe(1);
    expect(result.chunksCreated).toBeGreaterThan(0);

    // Chunk count should be the same (same content, just re-embedded)
    const afterChunks = (db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }).cnt;
    expect(afterChunks).toBe(beforeChunks);
  });
});
