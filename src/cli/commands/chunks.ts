import { Command } from "commander";
import { getInitializedDb } from "../../storage/index.js";

/** Escape LIKE special chars. Set keepPercent=true for patterns that use % as intentional wildcards. */
import { escapeLike } from "../../utils/sql.js";

export const chunksCommand = new Command("chunks")
  .description("Inspect chunks produced from a document")
  .argument("<source>", "Source file path or partial match")
  .option("-c, --collection <name>", "Filter by collection")
  .option("--full", "Show full chunk text (default: truncated to 200 chars)")
  .option("--json", "Output as JSON")
  .addHelpText("after", `
Examples:
  $ threadclaw chunks report.pdf                      Show chunks for a document
  $ threadclaw chunks auth -c backend                 Filter by collection
  $ threadclaw chunks report.pdf --full               Show full chunk text
  $ threadclaw chunks report.pdf --json               Machine-readable output`)
  .action(
    async (
      source: string,
      opts: { collection?: string; full: boolean; json: boolean },
    ) => {
      try {
        const db = getInitializedDb();

        const escaped = escapeLike(source);
        const searchTerm = source.replace(/[\\/]/g, "%");
        const searchTermEscaped = escapeLike(searchTerm, true);
        let query = `
          SELECT d.id as docId, d.source_path, d.content_hash, d.metadata_json,
                 col.name as collectionName
          FROM documents d
          JOIN collections col ON col.id = d.collection_id
          WHERE (d.source_path LIKE ? ESCAPE '\\' OR d.source_path LIKE ? ESCAPE '\\')`;
        const params: string[] = [`%${escaped}%`, `%${searchTermEscaped}%`];

        if (opts.collection) {
          query += ` AND col.name = ?`;
          params.push(opts.collection);
        }

        const docs = db.prepare(query).all(...params) as {
          docId: string;
          source_path: string;
          content_hash: string;
          metadata_json: string;
          collectionName: string;
        }[];

        if (docs.length === 0) {
          console.log(`No documents found matching: ${source}`);
          return;
        }

        if (opts.json) {
          const jsonOutput = [];
          for (const doc of docs) {
            const meta = JSON.parse(doc.metadata_json || "{}");
            const chunks = db
              .prepare(
                `SELECT id, text, context_prefix, position, token_count
                 FROM chunks
                 WHERE document_id = ?
                 ORDER BY position`,
              )
              .all(doc.docId) as {
              id: string;
              text: string;
              context_prefix: string | null;
              position: number;
              token_count: number;
            }[];
            jsonOutput.push({
              docId: doc.docId,
              sourcePath: doc.source_path,
              contentHash: doc.content_hash,
              collection: doc.collectionName,
              metadata: meta,
              chunks: chunks.map((c) => ({
                id: c.id,
                position: c.position,
                tokenCount: c.token_count,
                contextPrefix: c.context_prefix,
                text: opts.full ? c.text : c.text.slice(0, 200),
              })),
            });
          }
          console.log(JSON.stringify(jsonOutput, null, 2));
          return;
        }

        for (const doc of docs) {
          const fileName = doc.source_path.replace(/\\/g, "/").split("/").pop();
          const meta = JSON.parse(doc.metadata_json || "{}");
          // Guard: content_hash may be shorter than 16 chars
          const hashPreview = doc.content_hash.length > 16
            ? doc.content_hash.slice(0, 16) + "..."
            : doc.content_hash;

          console.log(`\n${"=".repeat(60)}`);
          console.log(`Document: ${fileName}`);
          console.log(`Collection: ${doc.collectionName}`);
          console.log(`ID: ${doc.docId}`);
          console.log(`Hash: ${hashPreview}`);
          if (meta.title) console.log(`Title: ${meta.title}`);
          if (meta.fileType) console.log(`Type: ${meta.fileType}`);
          if (meta.tags?.length) console.log(`Tags: ${meta.tags.join(", ")}`);

          const chunks = db
            .prepare(
              `SELECT id, text, context_prefix, position, token_count
               FROM chunks
               WHERE document_id = ?
               ORDER BY position`,
            )
            .all(doc.docId) as {
            id: string;
            text: string;
            context_prefix: string | null;
            position: number;
            token_count: number;
          }[];

          console.log(`Chunks: ${chunks.length}`);
          console.log(`${"=".repeat(60)}`);

          for (const chunk of chunks) {
            console.log(
              `\n  [${chunk.position}] ${chunk.token_count} tokens | ID: ${chunk.id.slice(0, 8)}...`,
            );

            if (chunk.context_prefix) {
              console.log(`  Section: ${chunk.context_prefix}`);
            }

            const text = opts.full
              ? chunk.text
              : chunk.text.length > 200
                ? chunk.text.slice(0, 200) + "..."
                : chunk.text;

            // Indent chunk text
            const lines = text.split("\n").slice(0, opts.full ? Infinity : 5);
            for (const line of lines) {
              console.log(`    ${line}`);
            }
            if (!opts.full && chunk.text.split("\n").length > 5) {
              console.log(`    ... (${chunk.text.split("\n").length} lines total)`);
            }
          }
        }

        console.log("");
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    },
  );
