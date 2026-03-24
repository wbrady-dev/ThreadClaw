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

      for (const p of resolvedPaths) {
        if (!existsSync(p)) {
          console.warn(`Warning: path does not exist: ${p}`);
        }
      }

      console.log(`Watching for changes:`);
      for (const p of resolvedPaths) {
        console.log(`  ${p}`);
      }
      console.log(`Collection: ${opts.collection}`);
      console.log(`Debounce: ${opts.debounce}ms`);
      if (opts.existing) console.log(`Ingesting existing files on startup`);
      console.log("");
      console.log("Press Ctrl+C to stop.");
      console.log("");

      const watcher = new ThreadClawWatcher([
        {
          paths: resolvedPaths,
          collection: opts.collection,
          tags,
          debounceMs: parseInt(opts.debounce, 10) || 300,
          ingestExisting: opts.existing,
        },
      ]);

      await watcher.start();

      // Keep the process alive — chokidar events are async
      // Without this, Node exits after the action resolves
      const keepAlive = setInterval(() => {}, 60000);

      process.on("SIGINT", async () => {
        console.log("\nStopping watcher...");
        clearInterval(keepAlive);
        await watcher.stop();
        process.exit(0);
      });

      // Never resolve — keep running until SIGINT
      await new Promise(() => {});
    },
  );
