import pino from "pino";

// Suppress logs in CLI mode (when not running as HTTP server).
// Check process.argv[1] specifically to avoid false positives from flags or subcommands.
const isCli = (() => {
  const entry = process.argv[1] ?? "";
  return entry.includes("threadclaw.ts") || entry.includes("threadclaw.js");
})();

// Log injection protection: pino outputs structured JSON by default, which
// prevents log injection attacks. Avoid switching to plain-text formatters
// in production. The structured format also enables centralized log analysis.
export const logger = pino({
  level: isCli ? "warn" : (process.env.LOG_LEVEL ?? "info"),
  // Transport to fd 1 (stdout) is the same as pino's default; explicit here
  // for clarity and to ensure consistent behavior across environments.
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino/file", options: { destination: 1 } },
});
