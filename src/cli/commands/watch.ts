import { Command } from "commander";
import { resolve } from "path";
import { existsSync } from "fs";
import { ThreadClawWatcher } from "../../watcher/index.js";

export const watchCommand = new Command("watch")
  .description("Watch directories for changes and auto-ingest")
  .argument("<paths...>", "Directories to watch")
  .option("-c, --collection <name>", "Target collection", "default")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("-d, --debounce <ms>", "Debounce delay in milliseconds", "2000")
  .option("--existing", "Ingest existing files on startup", false)
  .addHelpText("after", `
Examples:
  $ threadclaw watch ~/Documents                          Watch a directory for changes
  $ threadclaw watch --existing ./notes                   Ingest existing files then watch
  $ threadclaw watch ./src ./docs -c codebase --tags dev  Watch multiple dirs with tags`)
  .action(
    async (
      paths: string[],
      opts: {
        collection: string;
        tags?: string;
        debounce: string;
        existing: boolean;
      },
    ) => {
      const tags = opts.tags?.split(",").map((t) => t.trim()) ?? [];
      const resolvedPaths = paths.map((p) => resolve(p));

      // Warn about non-existent paths and filter them out
      const validPaths: string[] = [];
      for (const p of resolvedPaths) {
        if (!existsSync(p)) {
          console.warn(`Warning: path does not exist, skipping: ${p}`);
        } else {
          validPaths.push(p);
        }
      }

      if (validPaths.length === 0) {
        console.error("Error: no valid paths to watch.");
        process.exit(1);
      }

      // Default debounce is 2000ms (matches the CLI option default)
      const debounceMs = parseInt(opts.debounce, 10) || 2000;

      console.log(`Watching for changes:`);
      for (const p of validPaths) {
        console.log(`  ${p}`);
      }
      console.log(`Collection: ${opts.collection}`);
      console.log(`Debounce: ${debounceMs}ms`);
      if (opts.existing) console.log(`Ingesting existing files on startup`);
      console.log("");
      console.log("Press Ctrl+C to stop.");
      console.log("");

      const watcher = new ThreadClawWatcher([
        {
          paths: validPaths,
          collection: opts.collection,
          tags,
          debounceMs,
          ingestExisting: opts.existing,
        },
      ]);

      try {
        await watcher.start();
      } catch (err) {
        console.error(`Error starting watcher: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      // Keep the process alive — chokidar events are async
      // Without this, Node exits after the action resolves
      const keepAlive = setInterval(() => {}, 60000);

      const shutdown = async () => {
        console.log("\nStopping watcher...");
        clearInterval(keepAlive);
        await watcher.stop();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Never resolve — keep running until SIGINT/SIGTERM
      await new Promise(() => {});
    },
  );
