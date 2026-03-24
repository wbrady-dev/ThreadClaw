import { Command } from "commander";
import { resolve } from "path";
import { stat, readdir } from "fs/promises";
import { extname } from "path";
import { ingestFile, type IngestResult } from "../../ingest/pipeline.js";
import { getSupportedExtensions } from "../../ingest/parsers/index.js";
import { validateIngestPath } from "../../api/ingest.routes.js";

export const ingestCommand = new Command("ingest")
  .description("Ingest a file or folder into the knowledge base")
  .argument("<path>", "File or folder path to ingest")
  .option("-c, --collection <name>", "Target collection", "default")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("-r, --recursive", "Recursively ingest folders", false)
  .option("-f, --force", "Force re-ingestion even if unchanged", false)
  .addHelpText("after", `
Examples:
  $ threadclaw ingest ./docs                            Ingest all supported files in ./docs
  $ threadclaw ingest report.pdf --collection research  Ingest a single file into "research"
  $ threadclaw ingest ./notes -r --tags meeting,2026    Recursively ingest with tags`)
  .action(
    async (
      filePath: string,
      opts: { collection: string; tags?: string; recursive: boolean; force: boolean },
    ) => {
      try {
        const tags = opts.tags?.split(",").map((t) => t.trim()) ?? [];
        const absPath = resolve(filePath);

        // Validate path safety (same check the API route uses)
        const pathErr = validateIngestPath(absPath);
        if (pathErr) {
          console.error(`Error: ${pathErr}`);
          process.exit(1);
        }

        const stats = await stat(absPath);

        if (stats.isDirectory()) {
          await ingestFolder(absPath, opts.collection, tags, opts.recursive, opts.force);
        } else {
          console.log(`Ingesting: ${absPath}`);
          console.log(`Collection: ${opts.collection}`);
          if (tags.length > 0) console.log(`Tags: ${tags.join(", ")}`);
          console.log("");

          const result = await ingestFile(absPath, {
            collection: opts.collection,
            tags,
            force: opts.force,
          });

          printResult(result);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("Failed to fetch")) {
          console.error("Are services running? Start with 'threadclaw start' or 'threadclaw serve'.");
        }
        process.exit(1);
      }
    },
  );

async function ingestFolder(
  dirPath: string,
  collection: string,
  tags: string[],
  recursive: boolean,
  force: boolean,
) {
  const supported = new Set(getSupportedExtensions());
  const files = await collectFiles(dirPath, supported, recursive);

  if (files.length === 0) {
    console.log(`No supported files found in ${dirPath}`);
    return;
  }

  console.log(`Ingesting ${files.length} files from: ${dirPath}`);
  console.log(`Collection: ${collection}`);
  console.log("");

  let totalDocs = 0;
  let totalUpdated = 0;
  let totalChunks = 0;
  let totalSkipped = 0;
  let errors = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = file.replace(dirPath, "").replace(/^[/\\]/, "");
    process.stdout.write(`  [${i + 1}/${files.length}] ${name} ... `);

    const filePathErr = validateIngestPath(file);
    if (filePathErr) {
      console.log(`BLOCKED: ${filePathErr}`);
      errors++;
      continue;
    }

    try {
      const result = await ingestFile(file, { collection, tags, force });
      if (result.duplicatesSkipped > 0) {
        console.log("unchanged");
        totalSkipped++;
      } else if (result.documentsUpdated > 0) {
        console.log(`updated (${result.chunksCreated} chunks, ${result.elapsedMs}ms)`);
        totalUpdated++;
        totalChunks += result.chunksCreated;
      } else {
        console.log(`${result.chunksCreated} chunks (${result.elapsedMs}ms)`);
        totalDocs += result.documentsAdded;
        totalChunks += result.chunksCreated;
      }
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : err}`);
      errors++;
    }
  }

  console.log("");
  console.log(
    `Done: ${totalDocs} added, ${totalUpdated} updated, ${totalChunks} chunks, ${totalSkipped} unchanged, ${errors} errors`,
  );
}

async function collectFiles(
  dirPath: string,
  supportedExts: Set<string>,
  recursive: boolean,
): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry.name);
    if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (supportedExts.has(ext)) {
        files.push(fullPath);
      }
    } else if (entry.isDirectory() && recursive && !entry.name.startsWith(".")) {
      const subFiles = await collectFiles(fullPath, supportedExts, true);
      files.push(...subFiles);
    }
  }

  return files.sort();
}

function printResult(result: IngestResult) {
  if (result.duplicatesSkipped > 0) {
    console.log("Unchanged (skipped).");
  } else if (result.documentsUpdated > 0) {
    console.log(`Updated: ${result.chunksCreated} chunks, ${result.elapsedMs}ms`);
  } else {
    console.log(`Ingested: ${result.documentsAdded} doc, ${result.chunksCreated} chunks, ${result.elapsedMs}ms`);
  }
}
