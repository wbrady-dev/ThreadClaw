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
      // Derive repo URL from git remote if available, fall back to generic message
      let repoUrl = "";
      try {
        repoUrl = execFileSync("git", ["remote", "get-url", "origin"], {
          cwd: root, stdio: "pipe", timeout: 5000,
        }).toString().trim();
      } catch {}

      console.error(`Update script not found: ${script}`);
      if (repoUrl) {
        console.error(`Your installation may be incomplete. Try: git pull && npm install && npm run build`);
      } else {
        console.error("Your installation may be incomplete. Try re-cloning and running npm install && npm run build.");
      }
      process.exit(1);
    }

    try {
      // Note: on macOS with old system bash (3.x), the update.sh script should use
      // #!/usr/bin/env bash to pick up a newer bash from Homebrew if available.
      if (isWindows) {
        execFileSync("cmd", ["/c", script], { stdio: "inherit", cwd: root, timeout: 300000 });
      } else {
        execFileSync("bash", [script], { stdio: "inherit", cwd: root, timeout: 300000 });
      }
    } catch (error) {
      console.error("Update failed: " + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });
