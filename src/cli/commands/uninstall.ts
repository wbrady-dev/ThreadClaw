import { Command } from "commander";
import { detectTerminalCapabilities, setTerminalCapabilities } from "../../tui/capabilities.js";
import { performUninstall } from "../../tui/uninstall-helpers.js";
import { runUninstall } from "../../tui/screens/uninstall.js";

export const uninstallCommand = new Command("uninstall")
  .description("Launch the guided ThreadClaw uninstaller")
  .option("--plain", "Use the plain uninstaller instead of the Ink UI")
  .option("--yes", "Skip prompts and uninstall immediately")
  .option("--delete-data", "Also delete local data when used with --yes")
  .action(async (options: { plain?: boolean; yes?: boolean; deleteData?: boolean }) => {
    try {
      if (options.deleteData && !options.yes) {
        console.warn("Warning: --delete-data only takes effect with --yes. Without --yes, the interactive uninstaller will prompt you.");
      }

      if (options.yes) {
        // Print summary even in --yes mode so the user knows what happened
        console.log(`Uninstalling ThreadClaw${options.deleteData ? " (including local data)" : ""}...`);
        await performUninstall({ deleteData: Boolean(options.deleteData) });
        console.log("Uninstall complete.");
        return;
      }

      if (options.plain) process.env.THREADCLAW_TUI_PLAIN = "true";

      const capabilities = detectTerminalCapabilities();
      setTerminalCapabilities(capabilities);

      if (capabilities.rich && !options.plain) {
        const { runInkUninstall } = await import("../../tui/ink/uninstall-actions.js");
        await runInkUninstall();
        return;
      }

      await runUninstall();
    } catch (err) {
      console.error(`Uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });
