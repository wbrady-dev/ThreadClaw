export { getDb, closeDb, checkpoint } from "./sqlite.js";
export { runMigrations } from "./schema.js";
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
export { insertMetadata, getDocumentIdsByMetadata } from "./metadata.js";
export type { MetadataFilter } from "./metadata.js";
export { getGraphDb, closeGraphDb } from "./graph-sqlite.js";
