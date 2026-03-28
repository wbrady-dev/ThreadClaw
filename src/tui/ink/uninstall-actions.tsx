import { promptConfirm, promptMenu } from "./prompts.js";
import { performUninstall } from "../uninstall-helpers.js";

export async function runInkUninstall(): Promise<boolean> {
  const confirm = await promptConfirm({
    title: "Uninstall ThreadClaw",
    message: "This removes ThreadClaw runtime files, integration changes, and the global command. Source files remain so you can reinstall later.",
    confirmLabel: "Continue",
    cancelLabel: "Cancel",
  });
  if (!confirm) return false;

  const deleteData = await promptConfirm({
    title: "Delete Data",
    message: "Delete the local database, ingested documents, evidence graph, and saved runtime data too?",
    confirmLabel: "Delete data",
    cancelLabel: "Keep data",
  });
  if (deleteData == null) return false;

  await performUninstall({ deleteData });

  await promptMenu({
    title: "Uninstall Complete",
    message: "ThreadClaw has been removed. You can close the TUI now.",
    items: [{ label: "Exit", value: "exit" }],
  });
  return true;
}
