import { existsSync } from "fs";
import { resolve } from "path";
import { detectObsidianVaults } from "../../sources/adapters/obsidian.js";
import { hasGDriveCredentials, listDriveFolders, removeGDriveCredentials, runGDriveOAuth } from "../../sources/adapters/gdrive.js";
import { hasOneDriveCredentials, listOneDriveFolders, removeOneDriveCredentials, runOneDriveOAuth } from "../../sources/adapters/onedrive.js";
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
  else if (action === "sources-web") await configureWeb();
}

async function configureObsidian(): Promise<void> {
  const root = getRootDir();
  ensureEnvFile(root);
  const env = readEnvMap(root);
  const currentPath = env.OBSIDIAN_VAULT_PATH ?? "";
  const currentEnabled = env.OBSIDIAN_ENABLED === "true";
  const templateDir = env.OBSIDIAN_TEMPLATE_DIR ?? "templates";
  const detected = detectObsidianVaults();

  // Quick vault stats if configured
  let vaultInfo = "";
  if (currentPath && existsSync(currentPath)) {
    try {
      const { readdirSync } = await import("fs");
      let mdCount = 0;
      let canvasCount = 0;
      const walk = (dir: string) => {
        try {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith(".") || e.name === "node_modules") continue;
            const full = resolve(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".md")) mdCount++;
            else if (e.name.endsWith(".canvas")) canvasCount++;
          }
        } catch {}
      };
      walk(currentPath);
      vaultInfo = ` (${mdCount} notes${canvasCount > 0 ? `, ${canvasCount} canvases` : ""})`;
    } catch {}
  }

  const action = await promptMenu({
    title: "Obsidian Vault",
    message: currentPath
      ? `Current vault: ${currentPath}${vaultInfo} | ${currentEnabled ? "enabled" : "disabled"}`
      : detected.length > 0
        ? `${detected.length} vault(s) detected. Select one to enable.`
        : "No vault detected. Enter the path to your vault manually.",
    items: [
      ...detected.map((vault) => ({
        label: `Use ${vault.replace(/\\/g, "/").split("/").pop() ?? vault}${vault === currentPath ? " (current)" : ""}`,
        value: `set:${vault}`,
      })),
      { label: "Enter vault path manually", value: "manual", description: "Type the full path to your .obsidian vault" },
      ...(currentPath && currentEnabled ? [{ label: "Disable ingestion", value: "disable" }] : []),
      ...(currentPath && !currentEnabled ? [{ label: "Enable ingestion", value: "enable" }] : []),
      ...(currentPath ? [{ label: `Template folder: ${templateDir}`, value: "template", description: "Folder to exclude from ingestion" }] : []),
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
    // ObsidianAdapter watches the vault independently — don't add to WATCH_PATHS
    await triggerSourcesReload();
    await showNotice("Obsidian", "Obsidian ingestion enabled.");
    return;
  }

  if (action === "manual") {
    const manualPath = await promptText({
      title: "Obsidian Vault Path",
      message: "Enter the full path to your Obsidian vault folder (the one containing .obsidian/).",
      label: "Path",
      initial: currentPath,
    });
    if (!manualPath) return;
    const trimmed = manualPath.trim();
    if (!existsSync(trimmed)) {
      await showNotice("Obsidian", "That path does not exist.");
      return;
    }
    if (!existsSync(resolve(trimmed, ".obsidian"))) {
      await showNotice("Obsidian", "No .obsidian/ folder found at that path. Are you sure this is a vault?");
      // Still allow it — user might know what they're doing
    }
    updateEnvValues(root, {
      OBSIDIAN_ENABLED: "true",
      OBSIDIAN_VAULT_PATH: trimmed,
      OBSIDIAN_COLLECTION: "obsidian",
    });
    // ObsidianAdapter watches the vault independently — don't add to WATCH_PATHS
    await triggerSourcesReload();
    await showNotice("Obsidian", `Vault set to ${trimmed}.`);
    return;
  }

  if (action === "template") {
    const newDir = await promptText({
      title: "Template Folder",
      message: "Name of the folder to exclude from ingestion (e.g., templates, _templates).",
      label: "Folder name",
      initial: templateDir,
    });
    if (!newDir) return;
    updateEnvValues(root, { OBSIDIAN_TEMPLATE_DIR: newDir.trim() });
    await showNotice("Obsidian", `Template folder set to "${newDir.trim()}". Restart services to apply.`);
    return;
  }

  if (action.startsWith("set:")) {
    const vaultPath = action.slice(4);
    updateEnvValues(root, {
      OBSIDIAN_ENABLED: "true",
      OBSIDIAN_VAULT_PATH: vaultPath,
      OBSIDIAN_COLLECTION: "obsidian",
    });
    // ObsidianAdapter watches the vault independently — don't add to WATCH_PATHS
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
  const currentFolders = parseRemoteEntries(env.ONEDRIVE_FOLDERS);
  const currentInterval = env.ONEDRIVE_SYNC_INTERVAL ?? "300";
  const clientId = env.ONEDRIVE_CLIENT_ID ?? "";
  const connected = hasOneDriveCredentials();

  let effectiveClientId = clientId;

  const action = await promptMenu({
    title: "Microsoft OneDrive",
    message: connected
      ? `${currentFolders.length} configured folder(s), sync every ${currentInterval}s.`
      : effectiveClientId
        ? "Client ID set. Connect your Microsoft account to start syncing."
        : "Set your Azure App Registration Client ID, then connect. No client secret needed (PKCE).",
    items: [
      ...(!effectiveClientId ? [{ label: "Set Client ID", value: "credentials", description: "Enter Client ID from Azure App Registrations" }] : []),
      ...(effectiveClientId && !connected ? [{ label: "Connect Microsoft account", value: "auth" }] : []),
      ...(effectiveClientId && connected ? [{ label: "Update Client ID", value: "credentials", description: "Change Azure Client ID" }] : []),
      ...(connected ? [{
        label: currentEnabled ? "Disable ingestion" : "Enable ingestion",
        value: currentEnabled ? "disable" : "enable",
      }] : []),
      ...(connected ? [{ label: "Add folder", value: "add" }] : []),
      ...(connected && currentFolders.length > 0 ? [{ label: "Remove folder", value: "remove" }] : []),
      ...(connected ? [{ label: "Change sync interval", value: "interval" }] : []),
      ...(connected ? [{ label: "Disconnect Microsoft account", value: "disconnect" }] : []),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;

  if (action === "credentials") {
    const newClientId = await promptText({
      title: "OneDrive — Azure Client ID",
      message: "From portal.azure.com > App Registrations > Your App > Application (client) ID",
      label: "Client ID",
      initial: effectiveClientId,
    });
    if (!newClientId) return;

    updateEnvValues(root, {
      ONEDRIVE_CLIENT_ID: newClientId,
    });
    effectiveClientId = newClientId;
    await showNotice("OneDrive", "Client ID saved. Use 'Connect Microsoft account' to authenticate.");
    return;
  }

  if (action === "auth") {
    const success = await runOneDriveOAuth(effectiveClientId);
    await showNotice("OneDrive", success ? "Microsoft account connected." : "Authentication failed.");
    return;
  }

  if (action === "enable") {
    if (currentFolders.length === 0) {
      const folder = await promptOneDriveFolder();
      if (!folder) return;
      updateEnvValues(root, {
        ONEDRIVE_FOLDERS: folder,
        ONEDRIVE_ENABLED: "true",
      });
    } else {
      updateEnvValues(root, { ONEDRIVE_ENABLED: "true" });
    }
    await triggerSourcesReload();
    await showNotice("OneDrive", "OneDrive ingestion enabled.");
    return;
  }

  if (action === "disable") {
    updateEnvValues(root, { ONEDRIVE_ENABLED: "false" });
    await triggerSourcesReload();
    await showNotice("OneDrive", "OneDrive ingestion disabled.");
    return;
  }

  if (action === "add") {
    const folder = await promptOneDriveFolder();
    if (!folder) return;
    updateEnvValues(root, {
      ONEDRIVE_FOLDERS: [...currentFolders, folder].join(","),
      ONEDRIVE_ENABLED: "true",
    });
    await triggerSourcesReload();
    await showNotice("OneDrive", "OneDrive folder added.");
    return;
  }

  if (action === "remove") {
    const selected = await promptMenu({
      title: "Remove OneDrive Folder",
      items: [
        ...currentFolders.map((entry) => ({ label: entry, value: entry })),
        { label: "Cancel", value: "__back__", color: t.dim },
      ],
    });
    if (!selected || selected === "__back__") return;

    const remaining = currentFolders.filter((entry) => entry !== selected);
    updateEnvValues(root, {
      ONEDRIVE_FOLDERS: remaining.join(","),
      ONEDRIVE_ENABLED: remaining.length > 0 ? env.ONEDRIVE_ENABLED ?? "true" : "false",
    });
    await triggerSourcesReload();
    await showNotice("OneDrive", "OneDrive folder removed.");
    return;
  }

  if (action === "interval") {
    const interval = await promptText({
      title: "Sync Interval",
      message: "How often to sync OneDrive, in seconds.",
      label: "Seconds",
      initial: currentInterval,
    });
    if (!interval) return;
    updateEnvValues(root, { ONEDRIVE_SYNC_INTERVAL: interval });
    await triggerSourcesReload();
    await showNotice("OneDrive", `Sync interval set to ${interval}s.`);
    return;
  }

  if (action === "disconnect") {
    removeOneDriveCredentials();
    updateEnvValues(root, { ONEDRIVE_ENABLED: "false" });
    await showNotice("OneDrive", "Microsoft account disconnected.");
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
  console.log(t.dim("  Fetching folders from Google Drive..."));
  const folders = await listDriveFolders();
  if (folders.length === 0) {
    console.log(t.dim("  Could not list folders — check console output above for errors."));
    const name = await promptText({
      title: "Drive Folder Name",
      message: "Could not fetch folder list. Type the exact folder name from your Drive.",
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

  console.log(t.ok(`  Found ${folders.length} folder(s) in your Drive.`));
  const picked = await promptMenu({
    title: "Select a Google Drive Folder",
    message: `${folders.length} top-level folder(s) found.`,
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

async function promptOneDriveFolder(): Promise<string | null> {
  console.log(t.dim("  Fetching folders from OneDrive..."));
  const folders = await listOneDriveFolders();
  if (folders.length === 0) {
    console.log(t.dim("  Could not list folders — check console output above for errors."));
    const name = await promptText({
      title: "OneDrive Folder Name",
      message: "Could not fetch folder list. Type the exact folder name from your OneDrive.",
      label: "Folder",
    });
    if (!name) return null;
    const collection = await promptText({
      title: "Collection Name",
      message: "Collection name for this OneDrive folder.",
      label: "Collection",
      initial: `onedrive-${slugify(name)}`,
    });
    if (!collection) return null;
    return `${name}|${collection}`;
  }

  console.log(t.ok(`  Found ${folders.length} folder(s) in your OneDrive.`));
  const picked = await promptMenu({
    title: "Select a OneDrive Folder",
    message: `${folders.length} top-level folder(s) found.`,
    items: [
      ...folders.map((folder) => ({ label: folder.name, value: folder.name })),
      { label: "Type manually", value: "__manual__" },
      { label: "Cancel", value: "__back__", color: t.dim },
    ],
  });
  if (!picked || picked === "__back__") return null;

  const folderName = picked === "__manual__"
    ? await promptText({
        title: "OneDrive Folder Name",
        label: "Folder",
      })
    : picked;
  if (!folderName) return null;

  const collection = await promptText({
    title: "Collection Name",
    label: "Collection",
    initial: `onedrive-${slugify(folderName)}`,
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

async function configureWeb(): Promise<void> {
  const root = getRootDir();
  ensureEnvFile(root);
  const env = readEnvMap(root);
  const currentUrls = parseRemoteEntries(env.WEB_URLS);
  const currentInterval = env.WEB_POLL_INTERVAL ?? "3600";
  const enabled = (env.WEB_ENABLED === "true") || currentUrls.length > 0;

  const action = await promptMenu({
    title: "Web URLs",
    message: currentUrls.length > 0
      ? `${currentUrls.length} URL(s) configured, poll every ${currentInterval}s.`
      : "Monitor web pages for changes. Add URLs to start ingesting.",
    items: [
      { label: "Add URL", value: "add" },
      ...(currentUrls.length > 0 ? [{ label: "Remove URL", value: "remove" }] : []),
      ...(currentUrls.length > 0 ? [{ label: "Change poll interval", value: "interval" }] : []),
      ...(currentUrls.length > 0 && enabled ? [{ label: "Disable ingestion", value: "disable" }] : []),
      ...(currentUrls.length > 0 && !enabled ? [{ label: "Enable ingestion", value: "enable" }] : []),
      { label: "Back", value: "__back__", color: t.dim },
    ],
  });

  if (!action || action === "__back__") return;

  if (action === "add") {
    const url = await promptText({
      title: "Web URL",
      message: "Enter the full URL (must start with http:// or https://).",
      label: "URL",
    });
    if (!url) return;

    // Validate URL
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        await showNotice("Web URLs", "Only http:// and https:// URLs are allowed.");
        return;
      }
    } catch {
      await showNotice("Web URLs", "Invalid URL format.");
      return;
    }

    const defaultCollection = new URL(url).hostname.replace(/^www\./, "");
    const collection = await promptText({
      title: "Collection Name",
      message: "Collection name for this web source.",
      label: "Collection",
      initial: `web-${slugify(defaultCollection)}`,
    });
    if (!collection) return;

    const newEntry = `${url}|${collection}`;
    updateEnvValues(root, {
      WEB_URLS: [...currentUrls, newEntry].join(","),
      WEB_ENABLED: "true",
    });
    await triggerSourcesReload();
    await showNotice("Web URLs", "Web URL added.");
    return;
  }

  if (action === "remove") {
    const selected = await promptMenu({
      title: "Remove Web URL",
      items: [
        ...currentUrls.map((entry) => ({ label: entry, value: entry })),
        { label: "Cancel", value: "__back__", color: t.dim },
      ],
    });
    if (!selected || selected === "__back__") return;

    const remaining = currentUrls.filter((entry) => entry !== selected);
    updateEnvValues(root, {
      WEB_URLS: remaining.join(","),
      ...(remaining.length === 0 ? { WEB_ENABLED: "false" } : {}),
    });
    await triggerSourcesReload();
    await showNotice("Web URLs", "Web URL removed.");
    return;
  }

  if (action === "interval") {
    const interval = await promptText({
      title: "Poll Interval",
      message: "How often to check web URLs for changes, in seconds.",
      label: "Seconds",
      initial: currentInterval,
    });
    if (!interval) return;
    updateEnvValues(root, { WEB_POLL_INTERVAL: interval });
    await triggerSourcesReload();
    await showNotice("Web URLs", `Poll interval set to ${interval}s.`);
    return;
  }

  if (action === "enable") {
    updateEnvValues(root, { WEB_ENABLED: "true" });
    await triggerSourcesReload();
    await showNotice("Web URLs", "Web URL ingestion enabled.");
    return;
  }

  if (action === "disable") {
    updateEnvValues(root, { WEB_ENABLED: "false" });
    await triggerSourcesReload();
    await showNotice("Web URLs", "Web URL ingestion disabled.");
  }
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
