#!/usr/bin/env node

import { Command } from "commander";
import { ingestCommand } from "./commands/ingest.js";
import { queryCommand } from "./commands/query.js";
import { collectionsCommand } from "./commands/collections.js";
import { searchCommand } from "./commands/search.js";
import { deleteCommand } from "./commands/delete.js";
import { chunksCommand } from "./commands/chunks.js";
import { watchCommand } from "./commands/watch.js";
import { serveCommand } from "./commands/serve.js";
import { statusCommand } from "./commands/status.js";
import { relationsCommand } from "./commands/relations.js";
import { doctorCommand } from "./commands/doctor.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { updateCommand } from "./commands/update.js";
import { integrateCommand } from "./commands/integrate.js";
import { installCommand } from "./commands/install.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { getAppVersion } from "../version.js";

// If no arguments provided, launch the interactive TUI
if (process.argv.length <= 2) {
  import("../tui/index.js").catch((err) => {
    console.error("Failed to launch TUI:", err.message);
    process.exit(1);
  });
} else {
  const program = new Command();

  program
    .name("clawcore")
    .description("State-of-the-art RAG system for OpenClaw")
    .version(getAppVersion());

  program.addCommand(ingestCommand);
  program.addCommand(queryCommand);
  program.addCommand(searchCommand);
  program.addCommand(deleteCommand);
  program.addCommand(chunksCommand);
  program.addCommand(collectionsCommand);
  program.addCommand(watchCommand);
  program.addCommand(serveCommand);
  program.addCommand(statusCommand);
  program.addCommand(relationsCommand);
  program.addCommand(doctorCommand);
  program.addCommand(upgradeCommand);
  program.addCommand(updateCommand);
  program.addCommand(integrateCommand);
  program.addCommand(installCommand);
  program.addCommand(uninstallCommand);

  program.parse();
}
