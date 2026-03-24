import { Command } from "commander";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { existsSync } from "fs";
import { getRootDir } from "../../tui/platform.js";

export const updateCommand = new Command("update")
  .description("Update ThreadClaw from GitHub (pull, deps, build, migrate)")
  .action(() => {
    const root = getRootDir();
    const isWindows = process.platform === "win32";
    const script = isWindows
      ? resolve(root, "scripts", "update.bat")
      : resolve(root, "scripts", "update.sh");

    if (!existsSync(script)) {
      console.error(`Update script not found: ${script}`);
      console.error("Your installation may be incomplete. Try re-installing: git clone https://github.com/anthropics/threadclaw && cd threadclaw && npm install && npm run build");
      process.exit(1);
    }

    try {
      if (isWindows) {
        execFileSync("cmd", ["/c", script], { stdio: "inherit", cwd: root });
      } else {
        execFileSync("bash", [script], { stdio: "inherit", cwd: root });
      }
    } catch (error) {
      console.error("Update failed: " + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });
