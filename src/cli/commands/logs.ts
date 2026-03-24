import { Command } from "commander";
import { watchFile, unwatchFile } from "fs";
import chalk from "chalk";
import { readServiceLogTail, getServiceLogPath, type ServiceLogName } from "../../tui/service-logs.js";

function colorLine(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("traceback") || lower.includes("exception")) {
    return chalk.red(line);
  }
  if (lower.includes("warn")) {
    return chalk.yellow(line);
  }
  return line;
}

function printLogLines(lines: string[], prefix: string): void {
  for (const line of lines) {
    console.log(`  ${prefix} ${colorLine(line)}`);
  }
}

export const logsCommand = new Command("logs")
  .description("Show ThreadClaw service logs")
  .option("-s, --service <name>", "Filter by service: models or api", "")
  .option("-n, --lines <count>", "Number of lines to show", "50")
  .option("-f, --follow", "Follow log output (live tail)")
  .action(async (opts) => {
    const lineCount = Math.max(1, parseInt(opts.lines, 10) || 50);
    const serviceFilter = opts.service?.toLowerCase() ?? "";

    const showModels = !serviceFilter || serviceFilter === "models";
    const showApi = !serviceFilter || serviceFilter === "api" || serviceFilter === "threadclaw";

    console.log(chalk.bold("\n  THREADCLAW LOGS\n"));

    // Show tail of each log
    if (showModels) {
      const lines = readServiceLogTail("models", lineCount);
      if (lines.length > 0) {
        console.log(chalk.magenta("  ── models ──"));
        printLogLines(lines, chalk.magenta("[models]"));
      } else {
        console.log(chalk.dim("  No model server logs found."));
      }
      console.log("");
    }

    if (showApi) {
      const lines = readServiceLogTail("threadclaw", lineCount);
      if (lines.length > 0) {
        console.log(chalk.green("  ── api ──"));
        printLogLines(lines, chalk.green("[api]   "));
      } else {
        console.log(chalk.dim("  No API logs found."));
      }
      console.log("");
    }

    // Follow mode
    if (opts.follow) {
      console.log(chalk.dim("  Following logs... Press Ctrl+C to stop.\n"));

      const trackers = new Map<ServiceLogName, string[]>();

      function setupWatcher(name: ServiceLogName, prefix: string, show: boolean): void {
        if (!show) return;
        // Seed with current content to detect new lines
        trackers.set(name, readServiceLogTail(name, 10000));

        const logPath = getServiceLogPath(name);
        watchFile(logPath, { interval: 500 }, () => {
          const allLines = readServiceLogTail(name, 10000);
          const prev = trackers.get(name) ?? [];
          const newLines = allLines.slice(prev.length);
          trackers.set(name, allLines);
          for (const line of newLines) {
            console.log(`  ${prefix} ${colorLine(line)}`);
          }
        });
      }

      setupWatcher("models", chalk.magenta("[models]"), showModels);
      setupWatcher("threadclaw", chalk.green("[api]   "), showApi);

      // Keep alive until Ctrl+C
      process.on("SIGINT", () => {
        unwatchFile(getServiceLogPath("models"));
        unwatchFile(getServiceLogPath("threadclaw"));
        console.log("");
        process.exit(0);
      });

      await new Promise(() => {});
    }
  });
