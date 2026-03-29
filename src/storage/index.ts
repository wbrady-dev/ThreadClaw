export { getDb, closeDb, checkpoint } from "./sqlite.js";
export { runMigrations } from "./schema.js";
import { resolve } from "path";
import { config } from "../config.js";
import { getDb as _getDb } from "./sqlite.js";
import { runMigrations as _runMigrations } from "./schema.js";

/** Open the default ThreadClaw DB and run migrations. Convenience for CLI commands. */
export function getInitializedDb(): ReturnType<typeof _getDb> {
  const db = _getDb(resolve(config.dataDir, "threadclaw.db"));
  _runMigrations(db);
  return db;
}

/** Get the main ThreadClaw DB (cached singleton via getDb). No migrations. For API route handlers. */
export function getMainDb(): ReturnType<typeof _getDb> {
  return _getDb(resolve(config.dataDir, "threadclaw.db"));
}
export { insertVector, searchVectors, deleteVectors } from "./vectors.js";
export type { VectorSearchResult } from "./vectors.js";
export { searchBm25 } from "./bm25.js";
export type { BM25SearchResult } from "./bm25.js";
export {
  createCollection,
  getCollection,
  getCollectionByName,
  listCollections,
  deleteCollection,
  getCollectionStats,
  ensureCollection,
  deleteDocument,
  listDocuments,
  resetKnowledgeBase,
} from "./collections.js";
export type { Collection, CollectionStats, DocumentInfo } from "./collections.js";
export type { MetadataFilter } from "./metadata.js";
export { getGraphDb, closeGraphDb } from "./graph-sqlite.js";
