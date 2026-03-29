/**
 * Microsoft OneDrive Source Adapter
 *
 * Uses the Microsoft Graph API directly via native fetch().
 * No external npm dependencies required.
 *
 * Auth flow:
 * 1. User provides an Azure App Registration Client ID (no secret needed — PKCE)
 * 2. First-time: opens browser for OAuth consent with PKCE, saves refresh token
 * 3. Subsequent: uses saved refresh token (auto-refreshes access tokens)
 *
 * Polling-based: checks for changes on a configurable interval using delta queries.
 * Read-only: ThreadClaw NEVER writes, modifies, or deletes OneDrive files.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync } from "fs";
import { resolve, join, extname } from "path";
import { homedir } from "os";
import { createServer } from "http";
import { createHash, randomBytes } from "crypto";
import { logger } from "../../utils/logger.js";
import { PollingAdapterBase, type RemoteItem } from "./polling-base.js";
import type { SourceConfig } from "../types.js";

// ── Constants ──
const CREDENTIALS_DIR = resolve(homedir(), ".threadclaw", "credentials");
const TOKENS_FILE = resolve(CREDENTIALS_DIR, "onedrive-tokens.json");
const DELTA_FILE = resolve(CREDENTIALS_DIR, "onedrive-delta.json");
const STAGING_DIR = resolve(homedir(), ".threadclaw", "staging", "onedrive");
const REDIRECT_PORT = 18802;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const AUTH_BASE = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES = "Files.Read.All offline_access";

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md",
  ".html", ".csv", ".json", ".eml", ".epub",
]);

/** Saved OAuth tokens (PKCE — no client secret needed).
 * NOTE: Stored as plaintext JSON in ~/.threadclaw/credentials/onedrive-tokens.json.
 * On Unix, file permissions are restricted to 0o600. On Windows, no equivalent protection.
 * Future enhancement: use DPAPI (Windows) or Keychain (macOS) for encrypted storage.
 */
interface SavedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
}

/** Saved delta token for incremental sync */
interface SavedDelta {
  deltaLink: string;
}

export class OneDriveAdapter extends PollingAdapterBase {
  private clientId = "";

  constructor() {
    super({
      id: "onedrive",
      name: "Microsoft OneDrive",
      stagingDir: STAGING_DIR,
      defaultSyncInterval: 300,
    });
  }

  async checkAvailability(): Promise<boolean> {
    if (existsSync(TOKENS_FILE)) {
      try {
        const tokens = JSON.parse(readFileSync(TOKENS_FILE, "utf-8")) as SavedTokens;
        if (tokens.refreshToken && tokens.clientId) {
          return true;
        }
      } catch {
        if (process.env.DEBUG) console.warn("[onedrive] Credentials file corrupted, re-authenticate with threadclaw configure");
      }
    }

    const clientId = process.env.ONEDRIVE_CLIENT_ID ?? "";
    if (clientId) {
      this.unavailableReason = "OneDrive not connected. Use Sources > Configure OneDrive to authenticate.";
      return false;
    }

    this.unavailableReason = "OneDrive requires OAuth setup. Set ONEDRIVE_CLIENT_ID in .env, then authenticate from the TUI.";
    return false;
  }

  async initClient(): Promise<void> {
    if (!existsSync(TOKENS_FILE)) {
      throw new Error("No OneDrive credentials. Authenticate via TUI first.");
    }

    const tokens = JSON.parse(readFileSync(TOKENS_FILE, "utf-8")) as SavedTokens;
    if (!tokens.refreshToken) {
      throw new Error("OneDrive tokens missing refresh_token. Re-authenticate via TUI.");
    }
    this.clientId = tokens.clientId;
  }

  protected onStop(): void {
    this.clientId = "";
  }

  defaultConfig(): SourceConfig {
    return {
      enabled: false,
      syncInterval: 300,
      collections: [],
      maxFileSize: 52_428_800,
    };
  }

  async listRemoteItems(): Promise<RemoteItem[]> {
    if (!this.cfg) return [];

    const token = await this.ensureAccessToken();
    const deltaLink = this.loadDeltaToken();

    // If we have configured folders, use folder-based listing
    // If we have a delta link, use delta sync for efficiency
    if (this.cfg.collections.length > 0 && !deltaLink) {
      return this.listFolderItems(token);
    }

    return this.listDeltaItems(token, deltaLink);
  }

  /** List items from configured folders */
  private async listFolderItems(token: string): Promise<RemoteItem[]> {
    if (!this.cfg) return [];
    const items: RemoteItem[] = [];

    for (let ci = 0; ci < this.cfg.collections.length; ci++) {
      const collCfg = this.cfg.collections[ci];
      const folderName = collCfg.path;
      const collection = collCfg.collection;

      // Rate limit: avoid exhausting Graph API limits
      if (ci > 0) await new Promise((r) => setTimeout(r, 100));

      try {
        const folderItems = await this.listOneDriveFolderFiles(token, folderName);
        for (const item of folderItems) {
          items.push({
            id: item.id,
            name: item.name,
            lastModified: item.lastModified,
            collection,
            tags: ["onedrive", folderName.toLowerCase().replace(/\s+/g, "-")],
          });
        }
      } catch (err) {
        logger.error({ folder: folderName, error: String(err) }, "Failed to list OneDrive folder");
      }
    }

    return items;
  }

  /** List items using delta query for incremental sync */
  private async listDeltaItems(token: string, deltaLink: string | null): Promise<RemoteItem[]> {
    let url: string = deltaLink ?? `${GRAPH_BASE}/me/drive/root/delta`;
    const items: RemoteItem[] = [];

    while (url) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });

      if (res.status === 410) {
        // Delta token expired — full resync
        this.clearDeltaToken();
        return this.listDeltaItems(token, null);
      }

      if (!res.ok) throw new Error(`OneDrive API: ${res.status} ${res.statusText}`);

      const data = (await res.json()) as {
        value?: Array<{
          id: string;
          name: string;
          file?: Record<string, unknown>;
          deleted?: { state: string };
          lastModifiedDateTime?: string;
          size?: number;
          parentReference?: { path?: string };
        }>;
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };

      for (const item of data.value ?? []) {
        if (item.deleted) continue;
        if (!item.file) continue;
        const ext = extname(item.name).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
        if ((item.size ?? 0) > (this.cfg?.maxFileSize ?? 50_000_000)) continue;

        items.push({
          id: item.id,
          name: item.name,
          lastModified: item.lastModifiedDateTime ?? "",
          collection: this.getCollectionForPath(item.parentReference?.path ?? ""),
        });
      }

      url = data["@odata.nextLink"] ?? "";
      if (data["@odata.deltaLink"]) {
        this.saveDeltaToken(data["@odata.deltaLink"]);
      }
    }

    return items;
  }

  /** List files in a specific OneDrive folder by name */
  private async listOneDriveFolderFiles(
    token: string,
    folderName: string,
  ): Promise<Array<{ id: string; name: string; lastModified: string }>> {
    // Search for the folder
    const searchUrl = `${GRAPH_BASE}/me/drive/root/children?$filter=name eq '${encodeURIComponent(folderName)}'&$select=id,name,folder`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!searchRes.ok) {
      // Fallback: try accessing by path directly
      return this.listOneDriveFolderByPath(token, folderName);
    }

    const searchData = (await searchRes.json()) as {
      value?: Array<{ id: string; name: string; folder?: Record<string, unknown> }>;
    };
    const folder = (searchData.value ?? []).find((f) => f.folder);
    if (!folder) {
      logger.warn({ folder: folderName }, "OneDrive folder not found");
      return [];
    }

    return this.listFolderChildren(token, folder.id);
  }

  /** List files in a folder accessed by path */
  private async listOneDriveFolderByPath(
    token: string,
    folderName: string,
  ): Promise<Array<{ id: string; name: string; lastModified: string }>> {
    const pathUrl = `${GRAPH_BASE}/me/drive/root:/${encodeURIComponent(folderName)}`;
    const pathRes = await fetch(pathUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!pathRes.ok) {
      logger.warn({ folder: folderName }, "OneDrive folder not found by path");
      return [];
    }

    const folderData = (await pathRes.json()) as { id: string };
    return this.listFolderChildren(token, folderData.id);
  }

  /** List all children of a folder by ID */
  private async listFolderChildren(
    token: string,
    folderId: string,
  ): Promise<Array<{ id: string; name: string; lastModified: string }>> {
    const results: Array<{ id: string; name: string; lastModified: string }> = [];
    let url: string | null = `${GRAPH_BASE}/me/drive/items/${folderId}/children?$select=id,name,file,lastModifiedDateTime,size&$top=200`;

    while (url) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) throw new Error(`OneDrive folder list failed: ${res.status}`);

      const data = (await res.json()) as {
        value?: Array<{
          id: string;
          name: string;
          file?: Record<string, unknown>;
          lastModifiedDateTime?: string;
          size?: number;
        }>;
        "@odata.nextLink"?: string;
      };

      for (const item of data.value ?? []) {
        if (!item.file) continue;
        const ext = extname(item.name).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
        if ((item.size ?? 0) > (this.cfg?.maxFileSize ?? 52_428_800)) continue;

        results.push({
          id: item.id,
          name: item.name,
          lastModified: item.lastModifiedDateTime ?? "",
        });
      }

      url = data["@odata.nextLink"] ?? null;
    }

    return results;
  }

  async downloadItem(item: RemoteItem): Promise<string> {
    const token = await this.ensureAccessToken();
    const res = await fetch(`${GRAPH_BASE}/me/drive/items/${item.id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60000),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    mkdirSync(STAGING_DIR, { recursive: true });
    const ext = extname(item.name) || ".bin";
    const outPath = join(STAGING_DIR, `${item.id}${ext}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, buffer);
    return outPath;
  }

  protected getStagingPathsForRemoval(id: string, name: string): string[] {
    const binaryPath = join(STAGING_DIR, `${id}${extname(name) || ".bin"}`);
    return [binaryPath];
  }

  protected getRemovalDbQuery(id: string, _name: string): { sql: string; params: string[] } {
    return {
      sql: "SELECT id FROM documents WHERE source_path LIKE ?",
      params: [`%${id}%`],
    };
  }

  // ── Token management ──

  private loadTokens(): SavedTokens | null {
    if (!existsSync(TOKENS_FILE)) return null;
    try {
      return JSON.parse(readFileSync(TOKENS_FILE, "utf-8")) as SavedTokens;
    } catch {
      return null;
    }
  }

  private saveTokens(tokens: SavedTokens): void {
    mkdirSync(CREDENTIALS_DIR, { recursive: true });
    writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    if (process.platform !== "win32") {
      try { chmodSync(TOKENS_FILE, 0o600); } catch {}
    }
  }

  private async ensureAccessToken(): Promise<string> {
    const tokens = this.loadTokens();
    if (!tokens) throw new Error("Not authenticated with OneDrive");
    if (Date.now() < tokens.expiresAt - 60000) return tokens.accessToken;

    // Refresh the token
    const res = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: tokens.clientId,
        redirect_uri: REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OneDrive token refresh failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const updated: SavedTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      clientId: tokens.clientId,
    };

    this.saveTokens(updated);
    logger.debug("OneDrive access token refreshed");
    return updated.accessToken;
  }

  // ── Delta token management ──

  private loadDeltaToken(): string | null {
    if (!existsSync(DELTA_FILE)) return null;
    try {
      const data = JSON.parse(readFileSync(DELTA_FILE, "utf-8")) as SavedDelta;
      return data.deltaLink || null;
    } catch {
      return null;
    }
  }

  private saveDeltaToken(deltaLink: string): void {
    mkdirSync(CREDENTIALS_DIR, { recursive: true });
    writeFileSync(DELTA_FILE, JSON.stringify({ deltaLink }, null, 2));
  }

  private clearDeltaToken(): void {
    if (existsSync(DELTA_FILE)) {
      try { unlinkSync(DELTA_FILE); } catch {}
    }
  }

  // ── Collection mapping ──

  private getCollectionForPath(parentPath: string): string {
    if (!this.cfg) return "onedrive";

    // parentPath looks like "/drive/root:/FolderName/SubFolder"
    // Extract the first folder name after root:
    const match = parentPath.match(/\/root:\/([^/]+)/);
    const folderName = match?.[1] ?? "";

    // Check if any configured collection maps to this folder
    for (const coll of this.cfg.collections) {
      if (coll.path.toLowerCase() === folderName.toLowerCase()) {
        return coll.collection;
      }
    }

    return this.cfg.collections[0]?.collection ?? "onedrive";
  }
}

// ────────────────────────────────────────────
// OAuth flow (called from TUI)
// ────────────────────────────────────────────

/** Generate a PKCE code verifier (43-128 chars, base64url) */
function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** Generate a PKCE code challenge from a verifier (SHA-256, base64url) */
function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Run the OAuth2 consent flow with PKCE (no client secret needed).
 * Opens the user's browser, starts a local HTTP server to receive the callback.
 * Returns true on success.
 */
export async function runOneDriveOAuth(clientId: string): Promise<boolean> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${AUTH_BASE}/authorize?${params.toString()}`;

  console.log(`\n  Opening browser for Microsoft sign-in...`);
  console.log(`  If browser doesn't open, visit:\n  ${authUrl}\n`);

  // Open browser — Windows needs special handling because `start` treats
  // `&` in URLs as a command separator. Use rundll32 which takes the URL
  // as a single argument with no shell interpretation issues.
  const { execFile } = await import("child_process");
  if (process.platform === "win32") {
    execFile("rundll32", ["url.dll,FileProtocolHandler", authUrl]);
  } else if (process.platform === "darwin") {
    execFile("open", [authUrl]);
  } else {
    execFile("xdg-open", [authUrl]);
  }

  // Wait for OAuth callback
  const code = await waitForOAuthCallback();
  if (!code) return false;

  // Exchange code for tokens using PKCE
  try {
    const res = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`  OAuth token exchange failed: ${res.status} ${body}`);
      return false;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const saved: SavedTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      clientId,
    };

    mkdirSync(CREDENTIALS_DIR, { recursive: true });
    writeFileSync(TOKENS_FILE, JSON.stringify(saved, null, 2));

    // Restrict permissions on Unix
    if (process.platform !== "win32") {
      chmodSync(TOKENS_FILE, 0o600);
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
        res.end("<h1>ThreadClaw connected to OneDrive!</h1><p>You can close this window and return to the TUI.</p>");
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(400);
      res.end("Missing code parameter");
    });

    server.on("error", (err) => {
      console.error(`  OAuth server error: ${err.message}`);
      resolve(null);
    });

    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      console.log(`  Waiting for Microsoft sign-in on port ${REDIRECT_PORT}...`);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      resolve(null);
    }, 120_000);
  });
}

/** Check if OneDrive credentials exist */
export function hasOneDriveCredentials(): boolean {
  if (!existsSync(TOKENS_FILE)) return false;
  try {
    const tokens = JSON.parse(readFileSync(TOKENS_FILE, "utf-8")) as SavedTokens;
    return !!tokens.refreshToken;
  } catch {
    return false;
  }
}

/** Remove OneDrive credentials and delta token */
export function removeOneDriveCredentials(): void {
  if (existsSync(TOKENS_FILE)) unlinkSync(TOKENS_FILE);
  if (existsSync(DELTA_FILE)) unlinkSync(DELTA_FILE);
}

/** List top-level folders in the user's OneDrive (for TUI browser) */
export async function listOneDriveFolders(): Promise<{ id: string; name: string }[]> {
  if (!existsSync(TOKENS_FILE)) {
    console.error("[onedrive] No credentials file found at", TOKENS_FILE);
    return [];
  }

  try {
    // Load tokens and ensure fresh access token
    const tokens = JSON.parse(readFileSync(TOKENS_FILE, "utf-8")) as SavedTokens;
    let accessToken = tokens.accessToken;

    // Refresh if expired
    if (Date.now() >= tokens.expiresAt - 60000) {
      const res = await fetch(`${AUTH_BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: tokens.clientId,
          redirect_uri: REDIRECT_URI,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);

      const data = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      accessToken = data.access_token;

      // Persist refreshed tokens
      const updated: SavedTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? tokens.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        clientId: tokens.clientId,
      };
      mkdirSync(CREDENTIALS_DIR, { recursive: true });
      writeFileSync(TOKENS_FILE, JSON.stringify(updated, null, 2));
      if (process.platform !== "win32") {
        try { chmodSync(TOKENS_FILE, 0o600); } catch {}
      }
    }

    const res = await fetch(`${GRAPH_BASE}/me/drive/root/children?$filter=folder ne null&$select=id,name&$orderby=name&$top=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`Graph API: ${res.status}`);

    const data = (await res.json()) as {
      value?: Array<{ id: string; name: string; folder?: Record<string, unknown> }>;
    };

    const folders = (data.value ?? [])
      .filter((f) => f.folder)
      .map((f) => ({ id: f.id, name: f.name }));

    if (folders.length === 0) {
      console.warn("[onedrive] API returned 0 folders — OneDrive may have no top-level folders");
    }
    return folders;
  } catch (err) {
    console.error("[onedrive] Failed to list OneDrive folders:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
