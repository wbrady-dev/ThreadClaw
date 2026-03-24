import { Command } from "commander";
import chalk from "chalk";
import { performServiceAction } from "../../tui/service-actions.js";

export const restartCommand = new Command("restart")
  .description("Restart ThreadClaw services")
  .action(async () => {
    console.log(chalk.bold("\n  THREADCLAW RESTART\n"));
    try {
      const result = await performServiceAction("restart", {
        onStatus: (status) => {
          console.log(`  ${status}`);
        },
      });
      if (!result.success) {
        console.error(chalk.red(`\n  Failed to restart: ${result.message}\n`));
        process.exit(1);
      }
      console.log(chalk.green("\n  Services restarted successfully.\n"));
    } catch (err: any) {
      console.error(chalk.red(`\n  Failed to restart: ${err.message}\n`));
      process.exit(1);
    }
  });
