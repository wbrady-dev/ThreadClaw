import { Command } from "commander";
import { resolve } from "path";
import { config } from "../../config.js";
import { getDb, runMigrations, deleteVectors } from "../../storage/index.js";

export const deleteCommand = new Command("delete")
  .description("Delete a document from the knowledge base")
  .option("-c, --collection <name>", "Collection to delete from")
  .option("--source <path>", "Delete by source file path (partial match)")
  .option("--id <id>", "Delete by document ID")
  .option("--all-collection <name>", "Delete ALL documents in a collection")
  .action(
    async (opts: {
      collection?: string;
      source?: string;
      id?: string;
      allCollection?: string;
    }) => {
      try {
        const dbPath = resolve(config.dataDir, "clawcore.db");
        const db = getDb(dbPath);
        runMigrations(db);

        if (opts.allCollection) {
          // Delete entire collection
          const coll = db
            .prepare("SELECT id, name FROM collections WHERE name = ? OR id = ?")
            .get(opts.allCollection, opts.allCollection) as
            | { id: string; name: string }
            | undefined;

          if (!coll) {
            console.error(`Collection not found: ${opts.allCollection}`);
            process.exit(1);
          }

          const docs = db
            .prepare("SELECT id FROM documents WHERE collection_id = ?")
            .all(coll.id) as { id: string }[];

          let chunksDeleted = 0;
          for (const doc of docs) {
            chunksDeleted += await deleteDocument(db, doc.id);
          }

          console.log(
            `Deleted ${docs.length} documents (${chunksDeleted} chunks) from "${coll.name}"`,
          );
          return;
        }

        if (opts.id) {
          // Delete by document ID
          const doc = db
            .prepare("SELECT id, source_path FROM documents WHERE id = ?")
            .get(opts.id) as { id: string; source_path: string } | undefined;

          if (!doc) {
            console.error(`Document not found: ${opts.id}`);
            process.exit(1);
          }

          const chunks = await deleteDocument(db, doc.id);
          console.log(`Deleted: ${doc.source_path} (${chunks} chunks)`);
          return;
        }

        if (opts.source) {
          // Delete by source path (partial match) — search both slash styles
          const searchTerm = opts.source.replace(/[\\/]/g, "%");
          let query = "SELECT id, source_path, collection_id FROM documents WHERE (source_path LIKE ? OR source_path LIKE ?)";
          const params: string[] = [`%${opts.source}%`, `%${searchTerm}%`];

          if (opts.collection) {
            const coll = db
              .prepare("SELECT id FROM collections WHERE name = ?")
              .get(opts.collection) as { id: string } | undefined;
            if (coll) {
              query += " AND collection_id = ?";
              params.push(coll.id);
            }
          }

          const docs = db.prepare(query).all(...params) as {
            id: string;
            source_path: string;
          }[];

          if (docs.length === 0) {
            console.log(`No documents found matching: ${opts.source}`);
            return;
          }

          if (docs.length > 1) {
            console.log(`Found ${docs.length} matching documents:`);
            for (const doc of docs) {
              const name = doc.source_path.replace(/\\/g, "/").split("/").pop();
              console.log(`  ${doc.id.slice(0, 8)}... ${name}`);
            }
            console.log("");
            console.log(
              "Use --id <id> to delete a specific one, or re-run with a more specific --source path.",
            );
            return;
          }

          const chunks = await deleteDocument(db, docs[0].id);
          const name = docs[0].source_path.replace(/\\/g, "/").split("/").pop();
          console.log(`Deleted: ${name} (${chunks} chunks)`);
          return;
        }

        console.error(
          "Specify what to delete: --source <path>, --id <id>, or --all-collection <name>",
        );
        process.exit(1);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    },
  );

async function deleteDocument(
  db: ReturnType<typeof getDb>,
  documentId: string,
): Promise<number> {
  const chunkIds = db
    .prepare("SELECT id FROM chunks WHERE document_id = ?")
    .all(documentId) as { id: string }[];

  if (chunkIds.length > 0) {
    deleteVectors(
      db,
      chunkIds.map((c) => c.id),
    );
  }

  db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);

  // Clean up graph data (mentions, orphaned entities) if relations enabled
  try {
    if (config.relations?.graphDbPath) {
      const { getGraphDb } = await import("../../storage/graph-sqlite.js");
      const { deleteSourceData } = await import("../../relations/ingest-hook.js");
      const graphDb = getGraphDb(config.relations.graphDbPath);
      deleteSourceData(graphDb, "document", documentId);
    }
  } catch {}

  return chunkIds.length;
}
