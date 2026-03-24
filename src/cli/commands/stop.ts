import { Command } from "commander";
import chalk from "chalk";
import { performServiceAction } from "../../tui/service-actions.js";

export const stopCommand = new Command("stop")
  .description("Stop ThreadClaw services")
  .action(async () => {
    console.log(chalk.bold("\n  THREADCLAW STOP\n"));
    try {
      const result = await performServiceAction("stop", {
        onStatus: (status) => {
          console.log(`  ${status}`);
        },
      });
      if (!result.success) {
        console.error(chalk.red(`\n  Failed to stop: ${result.message}\n`));
        process.exit(1);
      }
      console.log(chalk.green("\n  Services stopped successfully.\n"));
    } catch (err: any) {
      console.error(chalk.red(`\n  Failed to stop: ${err.message}\n`));
      process.exit(1);
    }
  });
