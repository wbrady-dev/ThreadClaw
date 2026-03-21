import { Command } from "commander";
import { detectTerminalCapabilities, setTerminalCapabilities } from "../../tui/capabilities.js";
import { runInstall } from "../../tui/screens/install.js";

export const installCommand = new Command("install")
  .description("Launch the guided ClawCore installer")
  .option("--plain", "Use the plain installer instead of the Ink UI")
  .option("--non-interactive", "Use recommended defaults with no prompts")
  .action(async (options: { plain?: boolean; nonInteractive?: boolean }) => {
    if (options.plain) process.env.CLAWCORE_TUI_PLAIN = "true";
    if (options.nonInteractive) process.env.CLAWCORE_NON_INTERACTIVE = "true";

    const capabilities = detectTerminalCapabilities();
    setTerminalCapabilities(capabilities);

    if (options.nonInteractive) {
      // Non-interactive: skip TUI, run recommended install directly
      const { runNonInteractiveInstall } = await import("../../tui/screens/install.js");
      await runNonInteractiveInstall();
      return;
    }

    if (capabilities.rich && !options.plain) {
      const { runInkInstall } = await import("../../tui/ink/install-actions.js");
      await runInkInstall();
      return;
    }

    await runInstall();
  });
