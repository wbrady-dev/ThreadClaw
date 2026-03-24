/**
 * Google Drive Source Adapter
 *
 * Uses the Google Drive API directly via googleapis npm package.
 * No external CLI dependency required.
 *
 * Auth flow:
 * 1. User provides a Google Cloud OAuth client ID/secret (or uses ClawCore's default)
 * 2. First-time: opens browser for OAuth consent, saves refresh token
 * 3. Subsequent: uses saved refresh token (auto-refreshes access tokens)
 *
 * Polling-based: checks for changes on a configurable interval.
 * Read-only: ClawCore NEVER writes, modifies, or deletes Drive files.
 */
import { google, type drive_v3 } from "googleapis";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, createWriteStream } from "fs";
import { resolve, join, extname } from "path";
import { homedir } from "os";
import { createServer } from "http";
import { ingestFile } from "../../ingest/pipeline.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { getDb } from "../../storage/index.js";
import { deleteDocument } from "../../storage/collections.js";
import type { SourceAdapter, SourceConfig, SourceStatus, ChangeSet, StagedFile } from "../types.js";

// ── Constants ──
const CREDENTIALS_DIR = resolve(homedir(), ".clawcore", "credentials");
const CREDENTIALS_FILE = resolve(CREDENTIALS_DIR, "gdrive-tokens.json");
const STAGING_DIR = resolve(homedir(), ".clawcore", "staging", "gdrive");

// ClawCore's OAuth client — read-only Drive scope
const DEFAULT_CLIENT_ID = ""; // Set during setup or via env
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
const REDIRECT_PORT = 18801;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

const SUPPORTED_MIME_TYPES = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["text/plain", ".txt"],
  ["text/markdown", ".md"],
  ["text/html", ".html"],
  ["text/csv", ".csv"],
  ["application/json", ".json"],
]);

// Google Docs/Sheets/Slides export as these formats
const EXPORT_MIME_MAP = new Map<string, { mimeType: string; ext: string }>([
  ["application/vnd.google-apps.document", { mimeType: "text/markdown", ext: ".md" }],
  ["application/vnd.google-apps.spreadsheet", { mimeType: "text/csv", ext: ".csv" }],
  ["application/vnd.google-apps.presentation", { mimeType: "text/plain", ext: ".txt" }],
]);

/** Sync manifest entry */
interface ManifestEntry {
  fileId: string;
  name: string;
  modifiedTime: string;
  size: number;
}

/** Saved OAuth tokens */
interface SavedTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  client_id: string;
  client_secret: string;
}

export class GDriveAdapter implements SourceAdapter {
  id = "gdrive";
  name = "Google Drive";
  type = "polling" as const;

  private status: SourceStatus = { state: "idle", docCount: 0 };
  private syncTimer: NodeJS.Timeout | null = null;
  private manifest = new Map<string, ManifestEntry>();
  private cfg: SourceConfig | null = null;
  private drive: drive_v3.Drive | null = null;
  private unavailableReason = "";

  async isAvailable(): Promise<boolean> {
    // Check if credentials exist (user has completed OAuth)
    if (existsSync(CREDENTIALS_FILE)) {
      try {
        const tokens = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8")) as SavedTokens;
        if (tokens.refresh_token && tokens.client_id) {
          return true;
        }
      } catch {}
    }

    // Check if client ID is configured via env (user can authenticate from TUI)
    const clientId = process.env.GDRIVE_CLIENT_ID || DEFAULT_CLIENT_ID;
    if (clientId) {
      this.unavailableReason = "Google Drive not connected. Use Sources > Configure Google Drive to authenticate.";
      return false;
    }

    this.unavailableReason = "Google Drive requires OAuth setup. Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in .env, then authenticate from the TUI.";
    return false;
  }

  availabilityReason(): string {
    return this.unavailableReason;
  }

  defaultConfig(): SourceConfig {
    return {
      enabled: false,
      syncInterval: 300,
      collections: [],
      maxFileSize: 52_428_800,
    };
  }

  getStatus(): SourceStatus {
    return { ...this.status };
  }

  async start(cfg: SourceConfig): Promise<void> {
    this.cfg = cfg;

    if (!cfg.enabled || cfg.collections.length === 0) {
      this.status = { state: "disabled", docCount: 0 };
      return;
    }

    logger.warn("Google Drive manifest is in-memory — full re-sync will occur on restart");

    // Initialize Drive client
    try {
      this.drive = await initDriveClient();
    } catch (err) {
      this.status = { state: "error", docCount: 0, error: `Auth failed: ${err}` };
      return;
    }

    mkdirSync(STAGING_DIR, { recursive: true });

    // Initial sync
    try {
      await this.sync();
    } catch (err) {
      logger.error({ source: "gdrive", error: String(err) }, "Initial Drive sync failed");
      this.status = { state: "error", docCount: 0, error: `Initial sync failed: ${err}` };
    }

    // Start polling
    const intervalMs = (cfg.syncInterval || 300) * 1000;
    this.syncTimer = setInterval(() => {
      this.sync().catch((err) => {
        logger.error({ source: "gdrive", error: String(err) }, "Drive sync failed");
        this.status = { ...this.status, state: "error", error: String(err) };
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.drive = null;
    this.status = { state: "idle", docCount: 0 };
  }

  async detectChanges(): Promise<ChangeSet> {
    if (!this.cfg || !this.drive) return { added: [], modified: [], removed: [] };

    const changes: ChangeSet = { added: [], modified: [], removed: [] };
    const allCurrentIds = new Set<string>();

    for (let ci = 0; ci < this.cfg.collections.length; ci++) {
      const collCfg = this.cfg.collections[ci];
      const folderName = collCfg.path;
      const collection = collCfg.collection;

      // Rate limit: avoid exhausting Drive API quota (12k req/100s)
      if (ci > 0) await new Promise((r) => setTimeout(r, 100));

      let files: drive_v3.Schema$File[];
      try {
        files = await listFolderFiles(this.drive, folderName);
      } catch (err) {
        logger.error({ folder: folderName, error: String(err) }, "Failed to list Drive folder");
        continue;
      }

      for (const file of files) {
        if (!file.id || !file.name) continue;

        // Check if it's a supported type
        const mimeType = file.mimeType ?? "";
        const isNativeDoc = EXPORT_MIME_MAP.has(mimeType);
        const ext = isNativeDoc
          ? EXPORT_MIME_MAP.get(mimeType)!.ext
          : extname(file.name).toLowerCase();

        if (!isNativeDoc && !SUPPORTED_MIME_TYPES.has(mimeType) && !isSupportedExt(ext)) continue;

        const fileSize = parseInt(file.size ?? "0", 10);
        if (fileSize > (this.cfg.maxFileSize ?? 52_428_800)) continue;

        allCurrentIds.add(file.id);
        const existing = this.manifest.get(file.id);
        const modifiedTime = file.modifiedTime ?? "";

        if (!existing) {
          changes.added.push({
            sourceId: file.id,
            localPath: "",
            collection,
            tags: ["gdrive", folderName.toLowerCase().replace(/\s+/g, "-")],
            remoteTimestamp: modifiedTime,
          });
        } else if (existing.modifiedTime !== modifiedTime) {
          changes.modified.push({
            sourceId: file.id,
            localPath: "",
            collection,
            tags: ["gdrive", folderName.toLowerCase().replace(/\s+/g, "-")],
            remoteTimestamp: modifiedTime,
          });
        }
      }
    }

    // Detect removals AFTER iterating all folders to avoid cross-collection false positives
    for (const [fileId] of this.manifest) {
      if (!allCurrentIds.has(fileId)) {
        changes.removed.push(fileId);
      }
    }

    return changes;
  }

  async downloadToStaging(changes: ChangeSet): Promise<StagedFile[]> {
    if (!this.drive) return [];
    const staged: StagedFile[] = [];
    const toDownload = [...changes.added, ...changes.modified];

    for (const file of toDownload) {
      try {
        const localPath = await downloadFile(this.drive, file.sourceId, STAGING_DIR);
        staged.push({ ...file, localPath });
      } catch (err) {
        logger.error({ fileId: file.sourceId, error: String(err) }, "Failed to download Drive file");
      }
    }

    return staged;
  }

  cleanup(staged: StagedFile[]): void {
    for (const file of staged) {
      try {
        if (file.localPath && existsSync(file.localPath)) unlinkSync(file.localPath);
      } catch {}
    }
  }

  /** Run a full sync cycle */
  private async sync(): Promise<void> {
    if (!this.drive) return;

    this.status = { ...this.status, state: "syncing" };

    const changes = await this.detectChanges();
    const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;

    if (totalChanges === 0) {
      logger.info({ source: "gdrive" }, "Drive sync: no changes");
      this.status = {
        ...this.status,
        state: "idle",
        lastSync: new Date(),
        nextSync: new Date(Date.now() + (this.cfg?.syncInterval ?? 300) * 1000),
      };
      return;
    }

    logger.info(
      { source: "gdrive", added: changes.added.length, modified: changes.modified.length, removed: changes.removed.length },
      "Drive sync: changes detected",
    );

    // Process removals — delete staging files, DB docs, and remove from manifest
    for (const fileId of changes.removed) {
      const entry = this.manifest.get(fileId);
      if (entry) {
        // Try both possible staging paths: binary files use fileId, native docs use file name
        const binaryPath = join(STAGING_DIR, `${fileId}${extname(entry.name) || ".bin"}`);
        const nativePath = join(STAGING_DIR, entry.name);
        for (const p of [binaryPath, nativePath]) {
          try { if (existsSync(p)) unlinkSync(p); } catch {}
        }

        // Clean up DB documents/chunks/vectors to prevent orphans.
        // Use LIKE with staging dir prefix + fileId OR file name to match
        // regardless of which download path was used during ingestion.
        try {
          const db = getDb(resolve(config.dataDir, "clawcore.db"));
          const stagingPrefix = STAGING_DIR.replace(/\\/g, "/");
          const docs = db.prepare(
            "SELECT id FROM documents WHERE source_path LIKE ? OR source_path LIKE ?",
          ).all(`%${fileId}%`, `%${stagingPrefix}/${entry.name}%`) as { id: string }[];
          for (const doc of docs) {
            deleteDocument(db, doc.id);
            logger.info({ source: "gdrive", fileId, docId: doc.id }, "Deleted orphaned document from DB");
          }
        } catch (dbErr) {
          logger.error({ source: "gdrive", fileId, error: String(dbErr) }, "Failed to clean up DB on removal");
        }

        this.manifest.delete(fileId);
      }
      logger.info({ source: "gdrive", fileId }, "Drive file removed");
    }

    const staged = await this.downloadToStaging(changes);

    let ingested = 0;
    for (const file of staged) {
      try {
        await ingestFile(file.localPath, {
          collection: file.collection,
          tags: file.tags,
        });
        ingested++;

        this.manifest.set(file.sourceId, {
          fileId: file.sourceId,
          name: file.localPath.split(/[/\\]/).pop() ?? file.sourceId,
          modifiedTime: file.remoteTimestamp ?? new Date().toISOString(),
          size: 0,
        });
      } catch (err) {
        logger.error({ file: file.localPath, error: String(err) }, "Failed to ingest Drive file");
      }
    }

    this.cleanup(staged);

    this.status = {
      state: "idle",
      lastSync: new Date(),
      nextSync: new Date(Date.now() + (this.cfg?.syncInterval ?? 300) * 1000),
      docCount: this.manifest.size,
    };

    logger.info({ source: "gdrive", ingested, total: this.manifest.size }, "Drive sync complete");
  }
}

// ────────────────────────────────────────────
// Google Drive API helpers
// ────────────────────────────────────────────

function isSupportedExt(ext: string): boolean {
  return [".pdf", ".docx", ".pptx", ".xlsx", ".md", ".txt", ".html", ".csv", ".json",
    ".py", ".ts", ".js", ".go", ".rs"].includes(ext);
}

/** Initialize an authenticated Drive client from saved credentials */
async function initDriveClient(): Promise<drive_v3.Drive> {
  if (!existsSync(CREDENTIALS_FILE)) {
    throw new Error("No Google Drive credentials. Authenticate via TUI first.");
  }

  const tokens = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8")) as SavedTokens;
  const oauth2 = new google.auth.OAuth2(tokens.client_id, tokens.client_secret, REDIRECT_URI);

  oauth2.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });

  // Auto-refresh and persist new tokens
  oauth2.on("tokens", (newTokens) => {
    const updated: SavedTokens = {
      ...tokens,
      access_token: newTokens.access_token ?? tokens.access_token,
      expiry_date: newTokens.expiry_date ?? tokens.expiry_date,
    };
    mkdirSync(CREDENTIALS_DIR, { recursive: true });
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(updated, null, 2));
  });

  return google.drive({ version: "v3", auth: oauth2 });
}

/** Find a folder by name and list its files */
async function listFolderFiles(drive: drive_v3.Drive, folderName: string): Promise<drive_v3.Schema$File[]> {
  // Find the folder
  const folderRes = await drive.files.list({
    q: `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 5,
  });

  const folder = folderRes.data.files?.[0];
  if (!folder?.id) {
    logger.warn({ folder: folderName }, "Drive folder not found");
    return [];
  }

  // List files in the folder
  const allFiles: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folder.id}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
      pageSize: 100,
      pageToken,
    });

    if (res.data.files) allFiles.push(...res.data.files);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return allFiles;
}

/** Download a file from Drive to the staging directory */
async function downloadFile(drive: drive_v3.Drive, fileId: string, destDir: string): Promise<string> {
  // Get file metadata first
  const meta = await drive.files.get({ fileId, fields: "id, name, mimeType, size" });
  const mimeType = meta.data.mimeType ?? "";
  const name = meta.data.name ?? fileId;

  // Google native docs → export
  if (EXPORT_MIME_MAP.has(mimeType)) {
    const exportInfo = EXPORT_MIME_MAP.get(mimeType)!;
    const outPath = join(destDir, `${name}${exportInfo.ext}`);

    const res = await drive.files.export(
      { fileId, mimeType: exportInfo.mimeType },
      { responseType: "stream" },
    );

    await streamToFile(res.data as NodeJS.ReadableStream, outPath);
    return outPath;
  }

  // Binary files → download
  const ext = extname(name) || ".bin";
  const outPath = join(destDir, `${fileId}${ext}`);

  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" },
  );

  await streamToFile(res.data as NodeJS.ReadableStream, outPath);
  return outPath;
}

function streamToFile(stream: NodeJS.ReadableStream, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(path);
    stream.on("error", reject);
    stream.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}

// ────────────────────────────────────────────
// OAuth flow (called from TUI)
// ────────────────────────────────────────────

/**
 * Run the OAuth2 consent flow.
 * Opens the user's browser, starts a local HTTP server to receive the callback.
 * Returns true on success.
 */
export async function runGDriveOAuth(clientId: string, clientSecret: string): Promise<boolean> {
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // Force refresh token
  });

  console.log(`\n  Opening browser for Google sign-in...`);
  console.log(`  If browser doesn't open, visit:\n  ${authUrl}\n`);

  // Open browser
  const { exec } = await import("child_process");
  if (process.platform === "win32") {
    exec(`start "" "${authUrl}"`);
  } else if (process.platform === "darwin") {
    exec(`open "${authUrl}"`);
  } else {
    exec(`xdg-open "${authUrl}"`);
  }

  // Wait for OAuth callback
  const code = await waitForOAuthCallback();
  if (!code) return false;

  // Exchange code for tokens
  try {
    const { tokens } = await oauth2.getToken(code);

    const saved: SavedTokens = {
      access_token: tokens.access_token ?? "",
      refresh_token: tokens.refresh_token ?? "",
      expiry_date: tokens.expiry_date ?? 0,
      client_id: clientId,
      client_secret: clientSecret,
    };

    mkdirSync(CREDENTIALS_DIR, { recursive: true });
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(saved, null, 2));

    // Restrict permissions on Unix
    if (process.platform !== "win32") {
      const { chmodSync } = await import("fs");
      chmodSync(CREDENTIALS_FILE, 0o600);
    }

    return true;
  } catch (err) {
    console.error(`  OAuth failed: ${err}`);
    return false;
  }
}

/** Start a temporary HTTP server to receive the OAuth callback */
function waitForOAuthCallback(): Promise<string | null> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authentication cancelled</h1><p>You can close this window.</p>");
        server.close();
        resolve(null);
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>ClawCore connected to Google Drive!</h1><p>You can close this window and return to the TUI.</p>");
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(400);
      res.end("Missing code parameter");
    });

    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      console.log(`  Waiting for Google sign-in on port ${REDIRECT_PORT}...`);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      resolve(null);
    }, 120_000);
  });
}

/** Check if Drive credentials exist */
export function hasGDriveCredentials(): boolean {
  return existsSync(CREDENTIALS_FILE);
}

/** Remove Drive credentials */
export function removeGDriveCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) unlinkSync(CREDENTIALS_FILE);
}

/** List top-level folders in the user's Drive (for TUI browser) */
export async function listDriveFolders(): Promise<{ id: string; name: string }[]> {
  if (!existsSync(CREDENTIALS_FILE)) return [];

  try {
    const drive = await initDriveClient();
    const res = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents",
      fields: "files(id, name)",
      pageSize: 100,
      orderBy: "name",
    });
    return (res.data.files ?? []).map((f) => ({ id: f.id!, name: f.name! }));
  } catch {
    return [];
  }
}


