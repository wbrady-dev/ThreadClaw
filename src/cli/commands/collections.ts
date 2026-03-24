import { Command } from "commander";
import { getInitializedDb } from "../../storage/index.js";
import {
  listCollections,
  createCollection,
  deleteCollection,
  getCollectionStats,
} from "../../storage/collections.js";

let _db: ReturnType<typeof getInitializedDb> | null = null;
function db() {
  if (!_db) {
    _db = getInitializedDb();
  }
  return _db;
}

export const collectionsCommand = new Command("collections")
  .description("Manage collections");

collectionsCommand
  .command("list")
  .description("List all collections")
  .action(() => {
    const collections = listCollections(db());
    if (collections.length === 0) {
      console.log("No collections.");
      return;
    }

    for (const c of collections) {
      const stats = getCollectionStats(db(), c.id);
      console.log(
        `  ${c.name} — ${stats?.documentCount ?? 0} docs, ${stats?.chunkCount ?? 0} chunks, ${stats?.totalTokens ?? 0} tokens`,
      );
    }
  });

collectionsCommand
  .command("create <name>")
  .description("Create a new collection")
  .option("-d, --description <text>", "Collection description")
  .action((name: string, opts: { description?: string }) => {
    const collection = createCollection(db(), name, opts.description);
    console.log(`Created collection: ${collection.name} (${collection.id})`);
  });

collectionsCommand
  .command("delete <name>")
  .description("Delete a collection and all its data")
  .action((name: string) => {
    const d = db();
    const collections = listCollections(d);
    const match = collections.find((c) => c.name === name || c.id === name);

    if (!match) {
      console.error(`Collection not found: ${name}`);
      process.exit(1);
    }

    deleteCollection(d, match.id);
    console.log(`Deleted collection: ${match.name}`);
  });

collectionsCommand
  .command("stats <name>")
  .description("Show collection statistics")
  .action((name: string) => {
    const d = db();
    const collections = listCollections(d);
    const match = collections.find((c) => c.name === name || c.id === name);

    if (!match) {
      console.error(`Collection not found: ${name}`);
      process.exit(1);
    }

    const stats = getCollectionStats(d, match.id);
    if (!stats) {
      console.error("Could not get stats");
      process.exit(1);
    }

    console.log(`Collection: ${stats.name}`);
    console.log(`  Documents: ${stats.documentCount}`);
    console.log(`  Chunks: ${stats.chunkCount}`);
    console.log(`  Tokens: ${stats.totalTokens}`);
    console.log(`  Last updated: ${stats.lastUpdated ?? "never"}`);

    // Tag breakdown
    const tags = d
      .prepare(
        `SELECT mi.value, COUNT(DISTINCT mi.document_id) as count
         FROM metadata_index mi
         JOIN documents d ON d.id = mi.document_id
         WHERE d.collection_id = ? AND mi.key LIKE 'tag:%'
         GROUP BY mi.value
         ORDER BY count DESC`,
      )
      .all(match.id) as { value: string; count: number }[];

    if (tags.length > 0) {
      console.log(`  Tags:`);
      for (const tag of tags) {
        console.log(`    ${tag.value} (${tag.count} docs)`);
      }
    }

    // File type breakdown
    const types = d
      .prepare(
        `SELECT mi.value, COUNT(DISTINCT mi.document_id) as count
         FROM metadata_index mi
         JOIN documents d ON d.id = mi.document_id
         WHERE d.collection_id = ? AND mi.key = 'fileType'
         GROUP BY mi.value
         ORDER BY count DESC`,
      )
      .all(match.id) as { value: string; count: number }[];

    if (types.length > 0) {
      console.log(`  File types:`);
      for (const t of types) {
        console.log(`    ${t.value} (${t.count} docs)`);
      }
    }
  });
