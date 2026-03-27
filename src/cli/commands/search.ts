import { Command } from "commander";
import { query } from "../../query/pipeline.js";
import { formatConnectionHint } from "../cli-utils.js";

export const searchCommand = new Command("search")
  .description("Simple search (no reranking, faster)")
  .argument("<terms>", "Search terms")
  .option("-c, --collection <name>", "Collection to search", "default")
  .option("-k, --top-k <number>", "Number of results", "10")
  .option("--json", "Output as JSON")
  .addHelpText("after", `
Examples:
  $ threadclaw search "authentication tokens"             Basic keyword search
  $ threadclaw search "error handling" -c backend -k 5    Search specific collection
  $ threadclaw search "migration" --json                  Machine-readable output`)
  .action(
    async (
      terms: string,
      opts: { collection: string; topK: string; json: boolean },
    ) => {
      try {
        let topK = opts.topK != null ? parseInt(opts.topK, 10) : 10;
        if (!Number.isFinite(topK) || topK < 1) topK = 10;

        const result = await query(terms, {
          collection: opts.collection,
          topK,
          useReranker: false,
          useBm25: false,
          expand: false,
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.context) {
            console.log(result.context);
          } else {
            console.log("No results found.");
          }
          console.log("");
          console.log(
            `--- ${result.queryInfo.candidatesEvaluated ?? 0} candidates | ${result.queryInfo.chunksReturned ?? 0} chunks | ${result.queryInfo.elapsedMs ?? 0}ms ---`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        const hint = formatConnectionHint(msg);
        if (hint) console.error(hint);
        process.exit(1);
      }
    },
  );
