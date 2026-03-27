import { startServer } from "./server.js";
import { logger } from "./utils/logger.js";

// Catch unhandled promise rejections so they don't silently crash the process
process.on("unhandledRejection", (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — shutting down");
  process.exit(1);
});

startServer().catch((err) => {
  logger.error(err, "Fatal error");
  console.error("ThreadClaw failed to start. Check logs/threadclaw.log or run 'threadclaw doctor'.");
  process.exit(1);
});
