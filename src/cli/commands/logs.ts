import { Command } from "commander";
import { watchFile, unwatchFile } from "fs";
import { t } from "../../tui/theme.js";
import { readServiceLogTail, getServiceLogPath, type ServiceLogName } from "../../tui/service-logs.js";

function colorLine(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("traceback") || lower.includes("exception")) {
    return t.err(line);
  }
  if (lower.includes("warn")) {
    return t.warn(line);
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
  .option("-s, --service <name>", "Filter by service: models, api, or threadclaw (alias for api)", "")
  .option("-n, --lines <count>", "Number of lines to show", "50")
  .option("-f, --follow", "Follow log output (live tail)")
  .action(async (opts) => {
    const lineCount = Math.max(1, parseInt(opts.lines, 10) || 50);
    const serviceFilter = opts.service?.toLowerCase() ?? "";

    const showModels = !serviceFilter || serviceFilter === "models";
    const showApi = !serviceFilter || serviceFilter === "api" || serviceFilter === "threadclaw";

    console.log(t.brand("\n  THREADCLAW LOGS\n"));

    // Show tail of each log
    if (showModels) {
      const lines = readServiceLogTail("models", lineCount);
      if (lines.length > 0) {
        console.log(t.tag("  ── models ──"));
        printLogLines(lines, t.tag("[models]"));
      } else {
        console.log(t.dim("  No model server logs found."));
      }
      console.log("");
    }

    if (showApi) {
      const lines = readServiceLogTail("threadclaw", lineCount);
      if (lines.length > 0) {
        console.log(t.ok("  ── api ──"));
        printLogLines(lines, t.ok("[api]   "));
      } else {
        console.log(t.dim("  No API logs found."));
      }
      console.log("");
    }

    // Follow mode
    if (opts.follow) {
      console.log(t.dim("  Following logs... Press Ctrl+C to stop.\n"));

      const trackers = new Map<ServiceLogName, string[]>();
      const watchedFiles: string[] = [];

      const setupWatcher = (name: ServiceLogName, prefix: string, show: boolean): void => {
        if (!show) return;
        // Seed with current content to detect new lines
        trackers.set(name, readServiceLogTail(name, 10000));

        const logPath = getServiceLogPath(name);
        watchedFiles.push(logPath);
        // fs.watchFile polling at 500ms is a trade-off: it works reliably across
        // platforms (including networked/virtual filesystems) where fs.watch may
        // miss events. The 500ms interval keeps CPU usage minimal while providing
        // near-real-time log tailing.
        watchFile(logPath, { interval: 500 }, () => {
          const allLines = readServiceLogTail(name, 10000);
          const prev = trackers.get(name) ?? [];
          // Detect log truncation/rotation: if new content is shorter, treat it as fresh
          const newLines = allLines.length < prev.length
            ? allLines
            : allLines.slice(prev.length);
          trackers.set(name, allLines);
          for (const line of newLines) {
            console.log(`  ${prefix} ${colorLine(line)}`);
          }
        });
      }

      setupWatcher("models", t.tag("[models]"), showModels);
      setupWatcher("threadclaw", t.ok("[api]   "), showApi);

      // Keep alive until Ctrl+C
      process.on("SIGINT", () => {
        // Only unwatch files that were actually watched
        for (const filePath of watchedFiles) {
          unwatchFile(filePath);
        }
        console.log("");
        process.exit(0);
      });

      await new Promise(() => {});
    }
  });
