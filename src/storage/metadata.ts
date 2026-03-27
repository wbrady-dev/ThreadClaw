import type Database from "better-sqlite3";

export function insertMetadata(
  db: Database.Database,
  documentId: string,
  metadata: Record<string, string>,
): void {
  const stmt = db.prepare(
    "INSERT INTO metadata_index (document_id, key, value) VALUES (?, ?, ?)",
  );
  const insertMany = db.transaction(
    (entries: [string, string, string][]) => {
      for (const [docId, key, value] of entries) {
        stmt.run(docId, key, value);
      }
    },
  );

  const entries = Object.entries(metadata).map(
    ([key, value]) => [documentId, key, value] as [string, string, string],
  );
  insertMany(entries);
}

export interface MetadataFilter {
  key: string;
  value: string;
}

export function getDocumentIdsByMetadata(
  db: Database.Database,
  filters: MetadataFilter[],
  collectionId?: string,
): string[] {
  if (filters.length === 0) return [];
  // NOTE: The self-join approach (one JOIN per filter) can cause query plan explosion
  // with many filters. A GROUP BY + HAVING COUNT approach would be more scalable:
  //   SELECT document_id FROM metadata_index WHERE (key, value) IN (...) GROUP BY document_id HAVING COUNT(*) = N
  // The max 20 limit keeps the current approach performant enough.
  if (filters.length > 20) throw new Error("Too many metadata filters (max 20)");

  const conditions = filters.map(
    (_, i) => `(mi${i}.key = ? AND mi${i}.value = ?)`,
  );
  // NOTE: Dynamic SQL construction for JOINs is safe here — the JOIN aliases (mi0, mi1, etc.)
  // are generated from array indices, not user input. Filter values are parameterized.
  const joins = filters.map(
    (_, i) =>
      `JOIN metadata_index mi${i} ON mi${i}.document_id = d.id`,
  );

  let sql = `SELECT DISTINCT d.id FROM documents d ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
  const params: string[] = [];

  for (const f of filters) {
    params.push(f.key, f.value);
  }

  if (collectionId) {
    sql += " AND d.collection_id = ?";
    params.push(collectionId);
  }

  const rows = db.prepare(sql).all(...params) as { id: string }[];
  return rows.map((r) => r.id);
}
