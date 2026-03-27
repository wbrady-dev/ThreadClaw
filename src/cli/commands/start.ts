import { Command } from "commander";
import { t } from "../../tui/theme.js";
import { performServiceAction } from "../../tui/service-actions.js";
import { getApiPort, getModelPort } from "../../tui/platform.js";

export const startCommand = new Command("start")
  .description("Start ThreadClaw services in the background")
  .action(async () => {
    console.log(t.brand("\n  THREADCLAW START\n"));
    try {
      const result = await performServiceAction("start", {
        onStatus: (status) => {
          console.log(`  ${status}`);
        },
      });
      if (!result.success) {
        console.error(t.err(`\n  Failed to start: ${result.message}\n`));
        process.exit(1);
      }
      console.log(t.ok("\n  Services started successfully."));
      console.log(t.dim(`  Model server: http://localhost:${getModelPort()}`));
      console.log(t.dim(`  RAG API:      http://localhost:${getApiPort()}\n`));
    } catch (err: any) {
      console.error(t.err(`\n  Failed to start: ${err.message}\n`));
      process.exit(1);
    }
  });
