import { Command } from "commander";
import chalk from "chalk";
import { performServiceAction } from "../../tui/service-actions.js";

export const startCommand = new Command("start")
  .description("Start ThreadClaw services in the background")
  .action(async () => {
    console.log(chalk.bold("\n  THREADCLAW START\n"));
    try {
      const result = await performServiceAction("start", {
        onStatus: (status) => {
          console.log(`  ${status}`);
        },
      });
      if (!result.success) {
        console.error(chalk.red(`\n  Failed to start: ${result.message}\n`));
        process.exit(1);
      }
      console.log(chalk.green("\n  Services started successfully.\n"));
    } catch (err: any) {
      console.error(chalk.red(`\n  Failed to start: ${err.message}\n`));
      process.exit(1);
    }
  });
