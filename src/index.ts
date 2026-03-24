import { startServer } from "./server.js";
import { logger } from "./utils/logger.js";

startServer().catch((err) => {
  logger.error(err, "Fatal error");
  console.error("ThreadClaw failed to start. Check logs/threadclaw.log or run 'threadclaw doctor'.");
  process.exit(1);
});
