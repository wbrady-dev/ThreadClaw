import { Command } from "commander";
import { query } from "../../query/pipeline.js";
import { formatConnectionHint } from "../cli-utils.js";

export const queryCommand = new Command("query")
  .description("Query the knowledge base")
  .argument("<question>", "The query text")
  .option("-c, --collection <name>", 'Collection to search (use "all" for every collection)', "default")
  .option("-k, --top-k <number>", "Number of results", "3")
  .option("--brief", "Compressed output (~200 tokens) — best for agents")
  .option("--titles", "Return only matching document titles (~30 tokens)")
  .option("--full", "Return full chunks with rich citations")
  .option("--no-rerank", "Skip cross-encoder reranking")
  .option("--no-bm25", "Skip BM25 sparse search")
  .option("--expand", "Force query expansion (requires configured LLM)")
  .option("-b, --budget <tokens>", "Token budget for context", "1500")
  .option("--json", "Output as JSON")
  .addHelpText("after", `
Examples:
  $ threadclaw query "What is RSMA?"                        Default mode with reranking
  $ threadclaw query "summarize auth flow" --brief          Compressed output for agents
  $ threadclaw query "list all configs" --titles            Document titles only
  $ threadclaw query "explain caching" --full -k 5          Full chunks, top 5 results`)
  .action(
    async (
      question: string,
      opts: {
        collection: string;
        topK: string;
        brief: boolean;
        titles: boolean;
        full: boolean;
        rerank: boolean;
        bm25: boolean;
        expand: boolean;
        budget: string;
        json: boolean;
      },
    ) => {
      try {
        // Warn about mutually exclusive output flags
        const outputFlags = [opts.brief, opts.titles, opts.full].filter(Boolean);
        if (outputFlags.length > 1) {
          console.warn("Warning: --brief, --titles, and --full are mutually exclusive. Using highest precedence: --full > --brief > --titles.");
        }

        // --full overrides --brief and --titles (mutual exclusion)
        const brief = opts.brief && !opts.full;
        const titlesOnly = opts.titles && !opts.full && !opts.brief;

        let topK = opts.topK != null ? parseInt(opts.topK, 10) : 3;
        if (!Number.isFinite(topK) || topK < 1) topK = 3;
        let tokenBudget = opts.budget != null ? parseInt(opts.budget, 10) : 1500;
        if (!Number.isFinite(tokenBudget) || tokenBudget < 0) tokenBudget = 1500;

        const result = await query(question, {
          collection: opts.collection,
          topK,
          useReranker: opts.rerank,
          useBm25: opts.bm25,
          expand: opts.expand || undefined,
          tokenBudget,
          brief,
          titlesOnly,
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.context) {
            console.log(result.context);
          } else {
            console.log("No results found.");
          }

          const conf = Number.isFinite(result.queryInfo.confidence) ? Math.round(result.queryInfo.confidence * 100) : 0;
          const colls = result.queryInfo.collections.join(", ");
          const cached = result.queryInfo.cached ? " CACHED" : "";
          console.log("");

          if (result.queryInfo.lowConfidence) {
            console.log("[LOW CONFIDENCE] Try rephrasing or ingesting more documents.");
          }

          console.log(
            `--- ${result.queryInfo.strategy}${cached} | ${result.queryInfo.tokensUsed} tokens | ` +
            `${conf}% conf | ${result.queryInfo.elapsedMs}ms | [${colls}] ---`,
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
