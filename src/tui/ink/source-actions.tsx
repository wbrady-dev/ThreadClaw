import { existsSync } from "fs";
import { resolve } from "path";
import { detectObsidianVaults } from "../../sources/adapters/obsidian.js";
import { hasGDriveCredentials, listDriveFolders, removeGDriveCredentials, runGDriveOAuth } from "../../sources/adapters/gdrive.js";
import { detectOneDriveFolder, hasOneDriveCredentials, removeOneDriveCredentials, runOneDriveOAuth } from "../../sources/adapters/onedrive.js";
import { hasNotionApiKey, listNotionDatabases } from "../../sources/adapters/notion.js";
import { listNotesFolders } from "../../sources/adapters/apple-notes.js";
import { ensureEnvFile, readEnvMap, updateEnvValues } from "../env.js";
import { getRootDir, getApiBaseUrl } from "../platform.js";
import { t } from "./components.js";
import { promptMenu, promptText } from "./prompts.js";

export async function runInkSourceAction(action: string): Promise<void> {
  if (action === "sources-obsidian") await configureObsidian();
  else if (action === "sources-gdrive") await configureGDrive();
  else if (action === "sources-onedrive") await configureOneDrive();
  else if (action === "sources-notion") await configureNotion();
  else if (action === "sources-apple-notes") await configureAppleNotes();
}

async function configureObsidian(): Promise<void> {
  const root = getRootDir();
  ensureEnvFile(root);
  const env = readEnvMap(root);
  const currentPath = env.OBSIDIAN_VAULT_PATH ?? "";
  const currentEnabled = env.OBSIDIAN_ENABLED === "true";
  const detected = detectObsidianVaults();

  const action = await promptMenu({
    title: "Obsidian Vault",
    message: currentPath
      ? `Current vault: ${currentPath} | ${currentEnabled ? "enabled" : "disabled"}`
      : "No vault configured yet.",
    items: [
      ...detected.map((vault) => ({
        label: `Use ${vault.replace(/\\/g, "/").split("/").pop() ?? vault}${vault === currentPath ? " (current)" : ""}`,
        value: `set:${vault}`,
      })),
      ...(currentPath && currentEnabled ? [{ label: "Disable ingestion", value: "disable" }] : []),
      ...(currentPath && !currentEnabled ? [{ label: "Enable ingestion", value: "enable" }] : []),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;

  if (action === "disable") {
    updateEnvValues(root, { OBSIDIAN_ENABLED: "false" });
    await triggerSourcesReload();
    await showNotice("Obsidian", "Obsidian ingestion disabled.");
    return;
  }

  if (action === "enable") {
    updateEnvValues(root, { OBSIDIAN_ENABLED: "true" });
    appendWatchPath(root, currentPath, "obsidian");
    await triggerSourcesReload();
    await showNotice("Obsidian", "Obsidian ingestion enabled.");
    return;
  }

  if (action.startsWith("set:")) {
    const vaultPath = action.slice(4);
    updateEnvValues(root, {
      OBSIDIAN_ENABLED: "true",
      OBSIDIAN_VAULT_PATH: vaultPath,
      OBSIDIAN_COLLECTION: "obsidian",
    });
    appendWatchPath(root, vaultPath, "obsidian");
    await triggerSourcesReload();
    await showNotice("Obsidian", `Vault set to ${vaultPath}.`);
  }
}

async function configureGDrive(): Promise<void> {
  const root = getRootDir();
  ensureEnvFile(root);
  const env = readEnvMap(root);
  const currentEnabled = env.GDRIVE_ENABLED === "true";
  const currentFolders = parseRemoteEntries(env.GDRIVE_FOLDERS);
  const currentInterval = env.GDRIVE_SYNC_INTERVAL ?? "300";
  const clientId = env.GDRIVE_CLIENT_ID ?? "";
  const clientSecret = env.GDRIVE_CLIENT_SECRET ?? "";
  const connected = hasGDriveCredentials();

  let effectiveClientId = clientId;
  let effectiveClientSecret = clientSecret;

  const action = await promptMenu({
    title: "Google Drive",
    message: connected
      ? `${currentFolders.length} configured folder(s), sync every ${currentInterval}s.`
      : effectiveClientId && effectiveClientSecret
        ? "Credentials set. Connect your Google account to start syncing."
        : "Set OAuth credentials from Google Cloud Console, then connect.",
    items: [
      ...(!effectiveClientId || !effectiveClientSecret ? [{ label: "Set OAuth credentials", value: "credentials", description: "Enter Client ID and Secret from console.cloud.google.com" }] : []),
      ...(effectiveClientId && effectiveClientSecret && !connected ? [{ label: "Connect Google account", value: "auth" }] : []),
      ...(effectiveClientId && effectiveClientSecret && connected ? [{ label: "Update OAuth credentials", value: "credentials", description: "Change Client ID or Secret" }] : []),
      ...(connected ? [{
        label: currentEnabled ? "Disable ingestion" : "Enable ingestion",
        value: currentEnabled ? "disable" : "enable",
      }] : []),
      ...(connected ? [{ label: "Add folder", value: "add" }] : []),
      ...(connected && currentFolders.length > 0 ? [{ label: "Remove folder", value: "remove" }] : []),
      ...(connected ? [{ label: "Change sync interval", value: "interval" }] : []),
      ...(connected ? [{ label: "Disconnect Google account", value: "disconnect" }] : []),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;

  if (action === "credentials") {
    const newClientId = await promptText({
      title: "Google Drive — OAuth Client ID",
      message: "From console.cloud.google.com > APIs > Credentials > OAuth 2.0 Client ID",
      label: "Client ID",
      initial: effectiveClientId,
    });
    if (!newClientId) return;

    const newClientSecret = await promptText({
      title: "Google Drive — OAuth Client Secret",
      message: "The secret associated with your OAuth client",
      label: "Client Secret",
      initial: effectiveClientSecret,
      mask: "*",
    });
    if (!newClientSecret) return;

    updateEnvValues(root, {
      GDRIVE_CLIENT_ID: newClientId,
      GDRIVE_CLIENT_SECRET: newClientSecret,
    });
    effectiveClientId = newClientId;
    effectiveClientSecret = newClientSecret;
    await showNotice("Google Drive", "OAuth credentials saved. Use 'Connect Google account' to authenticate.");
    return;
  }

  if (action === "auth") {
    const success = await runGDriveOAuth(effectiveClientId, effectiveClientSecret);
    await showNotice("Google Drive", success ? "Google account connected." : "Authentication failed.");
    return;
  }

  if (action === "enable") {
    if (currentFolders.length === 0) {
      const folder = await promptDriveFolder();
      if (!folder) return;
      updateEnvValues(root, {
        GDRIVE_FOLDERS: folder,
        GDRIVE_ENABLED: "true",
      });
    } else {
      updateEnvValues(root, { GDRIVE_ENABLED: "true" });
    }
    await triggerSourcesReload();
    await showNotice("Google Drive", "Google Drive ingestion enabled.");
    return;
  }

  if (action === "disable") {
    updateEnvValues(root, { GDRIVE_ENABLED: "false" });
    await triggerSourcesReload();
    await showNotice("Google Drive", "Google Drive ingestion disabled.");
    return;
  }

  if (action === "add") {
    const folder = await promptDriveFolder();
    if (!folder) return;
    updateEnvValues(root, {
      GDRIVE_FOLDERS: [...currentFolders, folder].join(","),
      GDRIVE_ENABLED: "true",
    });
    await triggerSourcesReload();
    await showNotice("Google Drive", "Drive folder added.");
    return;
  }

  if (action === "remove") {
    const selected = await promptMenu({
      title: "Remove Drive Folder",
      items: [
        ...currentFolders.map((entry) => ({ label: entry, value: entry })),
        { label: "Cancel", value: "__back__", color: t.dim },
      ],
    });
    if (!selected || selected === "__back__") return;

    const remaining = currentFolders.filter((entry) => entry !== selected);
    updateEnvValues(root, {
      GDRIVE_FOLDERS: remaining.join(","),
      GDRIVE_ENABLED: remaining.length > 0 ? env.GDRIVE_ENABLED ?? "true" : "false",
    });
    await triggerSourcesReload();
    await showNotice("Google Drive", "Drive folder removed.");
    return;
  }

  if (action === "interval") {
    const interval = await promptText({
      title: "Sync Interval",
      message: "How often to sync Google Drive, in seconds.",
      label: "Seconds",
      initial: currentInterval,
    });
    if (!interval) return;
    updateEnvValues(root, { GDRIVE_SYNC_INTERVAL: interval });
    await triggerSourcesReload();
    await showNotice("Google Drive", `Sync interval set to ${interval}s.`);
    return;
  }

  if (action === "disconnect") {
    removeGDriveCredentials();
    updateEnvValues(root, { GDRIVE_ENABLED: "false" });
    await showNotice("Google Drive", "Google account disconnected.");
  }
}

async function configureOneDrive(): Promise<void> {
  const root = getRootDir();
  ensureEnvFile(root);
  const env = readEnvMap(root);
  const currentEnabled = env.ONEDRIVE_ENABLED === "true";
  const localPath = env.ONEDRIVE_LOCAL_PATH ?? "";
  const detectedFolder = detectOneDriveFolder();
  const clientId = env.ONEDRIVE_CLIENT_ID ?? "";
  const clientSecret = env.ONEDRIVE_CLIENT_SECRET ?? "";
  const cloudConnected = hasOneDriveCredentials();

  const action = await promptMenu({
    title: "Microsoft OneDrive",
    message: localPath
      ? `Local path: ${localPath} | ${currentEnabled ? "enabled" : "disabled"}`
      : cloudConnected
        ? "Cloud API connected."
        : "Use a local synced folder or connect the cloud API.",
    items: [
      ...(detectedFolder ? [{ label: `Use local folder: ${detectedFolder}`, value: "local-auto" }] : []),
      { label: "Set custom local folder", value: "local-custom" },
      { label: "Connect via cloud API", value: "cloud" },
      ...(currentEnabled ? [{ label: "Disable OneDrive", value: "disable" }] : []),
      ...(cloudConnected ? [{ label: "Disconnect cloud API", value: "disconnect" }] : []),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;

  if (action === "local-auto" && detectedFolder) {
    updateEnvValues(root, {
      ONEDRIVE_ENABLED: "true",
      ONEDRIVE_LOCAL_PATH: detectedFolder,
    });
    appendWatchPath(root, detectedFolder, "onedrive");
    await triggerSourcesReload();
    await showNotice("OneDrive", "OneDrive enabled with the detected local folder.");
    return;
  }

  if (action === "local-custom") {
    const customPath = await promptText({
      title: "OneDrive Folder",
      message: "Path to your local OneDrive-synced folder.",
      label: "Directory",
      initial: detectedFolder ?? localPath,
    });
    if (!customPath) return;
    if (!existsSync(customPath)) {
      await showNotice("OneDrive", "That path was not found.");
      return;
    }
    updateEnvValues(root, {
      ONEDRIVE_ENABLED: "true",
      ONEDRIVE_LOCAL_PATH: customPath,
    });
    appendWatchPath(root, customPath, "onedrive");
    await triggerSourcesReload();
    await showNotice("OneDrive", "OneDrive enabled with the custom local folder.");
    return;
  }

  if (action === "cloud") {
    let effectiveClientId = clientId;
    let effectiveClientSecret = clientSecret;

    if (!effectiveClientId || !effectiveClientSecret) {
      effectiveClientId = await promptText({
        title: "Azure App Client ID",
        message: "Create an Azure app with redirect URI http://localhost:18802/oauth2callback.",
        label: "Client ID",
      }) ?? "";
      if (!effectiveClientId) return;

      effectiveClientSecret = await promptText({
        title: "Azure App Client Secret",
        message: "Store the secret locally for OneDrive API auth.",
        label: "Client Secret",
        mask: "*",
      }) ?? "";
      if (!effectiveClientSecret) return;

      updateEnvValues(root, {
        ONEDRIVE_CLIENT_ID: effectiveClientId,
        ONEDRIVE_CLIENT_SECRET: effectiveClientSecret,
      });
    }

    const success = await runOneDriveOAuth(effectiveClientId, effectiveClientSecret);
    if (success) {
      updateEnvValues(root, { ONEDRIVE_ENABLED: "true" });
      await triggerSourcesReload();
      await showNotice("OneDrive", "OneDrive cloud connection enabled.");
    } else {
      await showNotice("OneDrive", "OneDrive authorization failed or timed out.");
    }
    return;
  }

  if (action === "disable") {
    updateEnvValues(root, { ONEDRIVE_ENABLED: "false" });
    await triggerSourcesReload();
    await showNotice("OneDrive", "OneDrive disabled.");
    return;
  }

  if (action === "disconnect") {
    removeOneDriveCredentials();
    updateEnvValues(root, { ONEDRIVE_ENABLED: "false" });
    await showNotice("OneDrive", "OneDrive cloud connection removed.");
  }
}

async function configureNotion(): Promise<void> {
  const root = getRootDir();
  ensureEnvFile(root);
  const env = readEnvMap(root);
  const enabled = env.NOTION_ENABLED === "true";
  const databases = parseRemoteEntries(env.NOTION_DATABASES);
  const apiKey = env.NOTION_API_KEY ?? "";

  if (!hasNotionApiKey() && !apiKey) {
    const key = await promptText({
      title: "Notion API Key",
      message: "Paste the Internal Integration Token from notion.so/my-integrations.",
      label: "Token",
      mask: "*",
    });
    if (!key) return;
    updateEnvValues(root, { NOTION_API_KEY: key });
    process.env.NOTION_API_KEY = key;
  }

  const action = await promptMenu({
    title: "Notion",
    message: databases.length > 0
      ? `${databases.length} database(s) configured.`
      : "Share a database with your Notion integration, then add it here.",
    items: [
      { label: enabled ? "Disable ingestion" : "Enable ingestion", value: enabled ? "disable" : "enable" },
      { label: "Add database", value: "add" },
      ...(databases.length > 0 ? [{ label: "Remove database", value: "remove" }] : []),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;

  if (action === "enable") {
    if (databases.length === 0) {
      const database = await promptNotionDatabase();
      if (!database) return;
      updateEnvValues(root, {
        NOTION_DATABASES: database,
        NOTION_ENABLED: "true",
      });
    } else {
      updateEnvValues(root, { NOTION_ENABLED: "true" });
    }
    await triggerSourcesReload();
    await showNotice("Notion", "Notion ingestion enabled.");
    return;
  }

  if (action === "disable") {
    updateEnvValues(root, { NOTION_ENABLED: "false" });
    await triggerSourcesReload();
    await showNotice("Notion", "Notion ingestion disabled.");
    return;
  }

  if (action === "add") {
    const database = await promptNotionDatabase();
    if (!database) return;
    updateEnvValues(root, {
      NOTION_DATABASES: [...databases, database].join(","),
      NOTION_ENABLED: "true",
    });
    await triggerSourcesReload();
    await showNotice("Notion", "Notion database added.");
    return;
  }

  if (action === "remove") {
    const selected = await promptMenu({
      title: "Remove Notion Database",
      items: [
        ...databases.map((entry) => ({ label: entry, value: entry })),
        { label: "Cancel", value: "__back__", color: t.dim },
      ],
    });
    if (!selected || selected === "__back__") return;

    const remaining = databases.filter((entry) => entry !== selected);
    updateEnvValues(root, {
      NOTION_DATABASES: remaining.join(","),
      NOTION_ENABLED: remaining.length > 0 ? env.NOTION_ENABLED ?? "true" : "false",
    });
    await triggerSourcesReload();
    await showNotice("Notion", "Notion database removed.");
  }
}

async function configureAppleNotes(): Promise<void> {
  if (process.platform !== "darwin") {
    await showNotice("Apple Notes", "Apple Notes is only available on macOS.");
    return;
  }

  const root = getRootDir();
  ensureEnvFile(root);
  const env = readEnvMap(root);
  const enabled = env.APPLE_NOTES_ENABLED === "true";
  const folders = parseRemoteEntries(env.APPLE_NOTES_FOLDERS);

  const action = await promptMenu({
    title: "Apple Notes",
    message: folders.length > 0
      ? `${folders.length} folder(s) configured.`
      : "Choose which Notes folders should be ingested.",
    items: [
      { label: enabled ? "Disable ingestion" : "Enable ingestion", value: enabled ? "disable" : "enable" },
      { label: "Add folder", value: "add" },
      ...(folders.length > 0 ? [{ label: "Remove folder", value: "remove" }] : []),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;

  if (action === "enable") {
    if (folders.length === 0) {
      const folder = await promptAppleNotesFolder();
      if (!folder) return;
      updateEnvValues(root, {
        APPLE_NOTES_FOLDERS: folder,
        APPLE_NOTES_ENABLED: "true",
      });
    } else {
      updateEnvValues(root, { APPLE_NOTES_ENABLED: "true" });
    }
    await triggerSourcesReload();
    await showNotice("Apple Notes", "Apple Notes ingestion enabled.");
    return;
  }

  if (action === "disable") {
    updateEnvValues(root, { APPLE_NOTES_ENABLED: "false" });
    await triggerSourcesReload();
    await showNotice("Apple Notes", "Apple Notes ingestion disabled.");
    return;
  }

  if (action === "add") {
    const folder = await promptAppleNotesFolder();
    if (!folder) return;
    updateEnvValues(root, {
      APPLE_NOTES_FOLDERS: [...folders, folder].join(","),
      APPLE_NOTES_ENABLED: "true",
    });
    await triggerSourcesReload();
    await showNotice("Apple Notes", "Notes folder added.");
    return;
  }

  if (action === "remove") {
    const selected = await promptMenu({
      title: "Remove Notes Folder",
      items: [
        ...folders.map((entry) => ({ label: entry, value: entry })),
        { label: "Cancel", value: "__back__", color: t.dim },
      ],
    });
    if (!selected || selected === "__back__") return;

    const remaining = folders.filter((entry) => entry !== selected);
    updateEnvValues(root, {
      APPLE_NOTES_FOLDERS: remaining.join(","),
      APPLE_NOTES_ENABLED: remaining.length > 0 ? env.APPLE_NOTES_ENABLED ?? "true" : "false",
    });
    await triggerSourcesReload();
    await showNotice("Apple Notes", "Notes folder removed.");
  }
}

async function promptDriveFolder(): Promise<string | null> {
  const folders = await listDriveFolders();
  if (folders.length === 0) {
    const name = await promptText({
      title: "Drive Folder Name",
      message: "Type the exact folder name if it is not listed automatically.",
      label: "Folder",
    });
    if (!name) return null;
    const collection = await promptText({
      title: "Collection Name",
      message: "Collection name for this Drive folder.",
      label: "Collection",
      initial: `gdrive-${slugify(name)}`,
    });
    if (!collection) return null;
    return `${name}|${collection}`;
  }

  const picked = await promptMenu({
    title: "Google Drive Folder",
    items: [
      ...folders.map((folder) => ({ label: folder.name, value: folder.name })),
      { label: "Type manually", value: "__manual__" },
      { label: "Cancel", value: "__back__", color: t.dim },
    ],
  });
  if (!picked || picked === "__back__") return null;

  const folderName = picked === "__manual__"
    ? await promptText({
        title: "Drive Folder Name",
        label: "Folder",
      })
    : picked;
  if (!folderName) return null;

  const collection = await promptText({
    title: "Collection Name",
    label: "Collection",
    initial: `gdrive-${slugify(folderName)}`,
  });
  if (!collection) return null;
  return `${folderName}|${collection}`;
}

async function promptNotionDatabase(): Promise<string | null> {
  const databases = await listNotionDatabases();
  if (databases.length === 0) {
    const id = await promptText({
      title: "Notion Database ID",
      message: "Paste the database ID if it is not listed automatically.",
      label: "Database ID",
    });
    if (!id) return null;
    const collection = await promptText({
      title: "Collection Name",
      label: "Collection",
      initial: `notion-${id.slice(0, 8)}`,
    });
    if (!collection) return null;
    return `${id}|${collection}`;
  }

  const picked = await promptMenu({
    title: "Notion Database",
    items: [
      ...databases.map((database) => ({
        label: database.title,
        value: database.id,
        description: database.id.slice(0, 12) + "...",
      })),
      { label: "Paste ID manually", value: "__manual__" },
      { label: "Cancel", value: "__back__", color: t.dim },
    ],
  });
  if (!picked || picked === "__back__") return null;

  const databaseId = picked === "__manual__"
    ? await promptText({
        title: "Notion Database ID",
        label: "Database ID",
      })
    : picked;
  if (!databaseId) return null;

  const defaultName = picked === "__manual__"
    ? databaseId.slice(0, 8)
    : databases.find((database) => database.id === picked)?.title ?? databaseId.slice(0, 8);

  const collection = await promptText({
    title: "Collection Name",
    label: "Collection",
    initial: `notion-${slugify(defaultName)}`,
  });
  if (!collection) return null;
  return `${databaseId}|${collection}`;
}

async function promptAppleNotesFolder(): Promise<string | null> {
  const folders = listNotesFolders();
  if (folders.length === 0) {
    const name = await promptText({
      title: "Apple Notes Folder",
      label: "Folder",
    });
    if (!name) return null;
    const collection = await promptText({
      title: "Collection Name",
      label: "Collection",
      initial: `notes-${slugify(name)}`,
    });
    if (!collection) return null;
    return `${name}|${collection}`;
  }

  const picked = await promptMenu({
    title: "Apple Notes Folder",
    items: [
      ...folders.map((folder) => ({
        label: `${folder.name} (${folder.count} notes)`,
        value: folder.name,
      })),
      { label: "Type manually", value: "__manual__" },
      { label: "Cancel", value: "__back__", color: t.dim },
    ],
  });
  if (!picked || picked === "__back__") return null;

  const folderName = picked === "__manual__"
    ? await promptText({
        title: "Apple Notes Folder",
        label: "Folder",
      })
    : picked;
  if (!folderName) return null;

  const collection = await promptText({
    title: "Collection Name",
    label: "Collection",
    initial: `notes-${slugify(folderName)}`,
  });
  if (!collection) return null;
  return `${folderName}|${collection}`;
}

function parseRemoteEntries(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function appendWatchPath(root: string, path: string, collection: string): void {
  if (!path) return;
  const env = readEnvMap(root);
  const watchEntries = parseRemoteEntries(env.WATCH_PATHS);
  if (watchEntries.some((entry) => entry.split("|")[0] === path)) return;
  updateEnvValues(root, {
    WATCH_PATHS: [...watchEntries, `${path}|${collection}`].join(","),
  });
}

async function triggerSourcesReload(): Promise<void> {
  try {
    await fetch(`${getApiBaseUrl()}/sources/reload`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

async function showNotice(title: string, message: string): Promise<void> {
  await promptMenu({
    title,
    message,
    items: [{ label: "Continue", value: "continue" }],
  });
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}
