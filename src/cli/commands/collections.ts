import { Command } from "commander";
import { getInitializedDb } from "../../storage/index.js";
import {
  listCollections,
  createCollection,
  deleteCollection,
  getCollectionStats,
} from "../../storage/collections.js";

function db() {
  return getInitializedDb();
}

/** Basic collection name validation */
function validateCollectionName(name: string): string | null {
  if (!name || name.trim().length === 0) return "Collection name cannot be empty";
  if (name.length > 128) return "Collection name too long (max 128 chars)";
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(name)) return "Collection name can only contain letters, numbers, spaces, hyphens, underscores, and dots";
  return null;
}

export const collectionsCommand = new Command("collections")
  .description("Manage collections")
  .addHelpText("after", `
Examples:
  $ threadclaw collections list                 Show all collections with stats
  $ threadclaw collections create myproject     Create a new collection
  $ threadclaw collections stats research       Detailed stats for a collection
  $ threadclaw collections delete old --force   Delete a collection`);

collectionsCommand
  .command("list")
  .description("List all collections")
  .action(() => {
    try {
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
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

collectionsCommand
  .command("create <name>")
  .description("Create a new collection")
  .option("-d, --description <text>", "Collection description")
  .action((name: string, opts: { description?: string }) => {
    try {
      const nameErr = validateCollectionName(name);
      if (nameErr) {
        console.error(`Error: ${nameErr}`);
        process.exit(1);
      }
      const collection = createCollection(db(), name, opts.description);
      console.log(`Created collection: ${collection.name} (${collection.id})`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

collectionsCommand
  .command("delete <name>")
  .description("Delete a collection and all its data (requires --force)")
  .option("--force", "Confirm deletion")
  .action((name: string, opts: { force?: boolean }) => {
    try {
      if (!opts.force) {
        console.error(`Deleting a collection removes all its documents and chunks permanently.`);
        console.error(`Re-run with --force to confirm: threadclaw collections delete ${name} --force`);
        process.exit(1);
      }

      const nameErr = validateCollectionName(name);
      if (nameErr) {
        console.error(`Error: ${nameErr}`);
        process.exit(1);
      }

      const d = db();
      const collections = listCollections(d);
      const match = collections.find((c) => c.name === name || c.id === name);

      if (!match) {
        console.error(`Collection not found: ${name}`);
        process.exit(1);
      }

      deleteCollection(d, match.id);
      console.log(`Deleted collection: ${match.name}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

collectionsCommand
  .command("stats <name>")
  .description("Show collection statistics")
  .action((name: string) => {
    try {
      const d = db();
      const collections = listCollections(d);
      const match = collections.find((c) => c.name === name || c.id === name);

      if (!match) {
        console.error(`Collection not found: ${name}`);
        process.exit(1);
      }

      const stats = getCollectionStats(d, match.id);
      if (!stats) {
        console.error("Could not get stats. Run 'threadclaw doctor' to check for database issues.");
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
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });
