/**
 * Microsoft OneDrive Source Adapter
 *
 * Two modes:
 * 1. Local sync folder — auto-detects OneDrive desktop app folder, uses file watcher
 * 2. Cloud API — Microsoft Graph API with OAuth for cloud-only files
 *
 * Auth flow (cloud mode):
 * 1. User registers an Azure AD app (or uses ClawCore's default)
 * 2. First-time: opens browser for OAuth consent, saves refresh token
 * 3. Subsequent: uses saved refresh token (auto-refreshes access tokens)
 *
 * Read-only: ClawCore NEVER writes, modifies, or deletes OneDrive files.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, createWriteStream } from "fs";
import { resolve, join, extname } from "path";
import { homedir } from "os";
import { createServer } from "http";
import { URL } from "url";
import { ingestFile } from "../../ingest/pipeline.js";
import { logger } from "../../utils/logger.js";
import type { SourceAdapter, SourceConfig, SourceStatus, ChangeSet, StagedFile } from "../types.js";

// ── Constants ──
const CREDENTIALS_DIR = resolve(homedir(), ".clawcore", "credentials");
const CREDENTIALS_FILE = resolve(CREDENTIALS_DIR, "onedrive-tokens.json");
const STAGING_DIR = resolve(homedir(), ".clawcore", "staging", "onedrive");

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SCOPES = ["Files.Read.All", "offline_access"];
const REDIRECT_PORT = 18802;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md", ".html",
  ".csv", ".json", ".eml", ".epub", ".png", ".jpg", ".jpeg",
]);

// ── Local OneDrive folder detection ──

/**
 * Detect the local OneDrive sync folder.
 * Checks common locations on Windows, macOS, and Linux.
 */
export function detectOneDriveFolder(): string | null {
  const home = homedir();
  const candidates = [
    // Windows (default OneDrive locations)
    resolve(home, "OneDrive"),
    resolve(home, "OneDrive - Personal"),
    // Business/org accounts
    ...(() => {
      try {
        return readdirSync(home)
          .filter((d) => d.startsWith("OneDrive -"))
          .map((d) => resolve(home, d));
      } catch { return []; }
    })(),
    // macOS
    resolve(home, "Library", "CloudStorage", "OneDrive-Personal"),
    // Linux (rare, but possible via rclone or similar)
    resolve(home, ".onedrive", "data"),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

// ── OAuth helpers (for cloud mode) ──

interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function loadTokens(): TokenData | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch { return null; }
}

function saveTokens(tokens: TokenData): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<TokenData | null> {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: SCOPES.join(" "),
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;
    const tokens: TokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    saveTokens(tokens);
    return tokens;
  } catch { return null; }
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens) return null;

  if (Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }

  const refreshed = await refreshAccessToken(clientId, clientSecret, tokens.refresh_token);
  return refreshed?.access_token ?? null;
}

// ── OAuth flow (browser-based) ──

export async function runOneDriveOAuth(clientId: string, clientSecret: string): Promise<boolean> {
  return new Promise((resolveOAuth) => {
    const state = Math.random().toString(36).substring(2);
    const authUrl = `${AUTH_URL}?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES.join(" "))}&state=${state}&response_mode=query`;

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "", `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404); res.end(); return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400); res.end("Missing code"); server.close(); resolveOAuth(false); return;
      }

      try {
        const body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
          scope: SCOPES.join(" "),
        });

        const tokenRes = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });

        if (!tokenRes.ok) {
          res.writeHead(500); res.end("Token exchange failed"); server.close(); resolveOAuth(false); return;
        }

        const data = await tokenRes.json() as any;
        saveTokens({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
        });

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>OneDrive connected!</h2><p>You can close this window.</p>");
        server.close();
        resolveOAuth(true);
      } catch {
        res.writeHead(500); res.end("Error"); server.close(); resolveOAuth(false);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      logger.info(`OneDrive OAuth: open ${authUrl}`);
      // Try to open browser
      try {
        const { execFileSync } = require("child_process");
        const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
        const args = process.platform === "win32" ? ["/c", "start", "", authUrl] : [authUrl];
        execFileSync(cmd, args, { stdio: "ignore" });
      } catch {
        logger.info("Open this URL in your browser to connect OneDrive:");
        logger.info(authUrl);
      }
    });

    setTimeout(() => { server.close(); resolveOAuth(false); }, 120000);
  });
}

export function hasOneDriveCredentials(): boolean {
  return existsSync(CREDENTIALS_FILE);
}

export function removeOneDriveCredentials(): void {
  try { if (existsSync(CREDENTIALS_FILE)) require("fs").unlinkSync(CREDENTIALS_FILE); } catch {}
}

// ── Graph API helpers ──

interface DriveItem {
  id: string;
  name: string;
  lastModifiedDateTime: string;
  size?: number;
  file?: { mimeType: string };
  folder?: {};
}

async function listFolderContents(
  accessToken: string,
  folderId: string,
  maxFileSize: number,
): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let url = `${GRAPH_API_BASE}/me/drive/items/${folderId}/children?$top=200&$select=id,name,lastModifiedDateTime,size,file,folder`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) break;
    const data = await res.json() as any;

    for (const item of data.value ?? []) {
      if (item.file) {
        const ext = extname(item.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext) && (item.size ?? 0) <= maxFileSize) {
          items.push(item);
        }
      }
    }

    url = data["@odata.nextLink"] ?? "";
  }

  return items;
}

async function downloadFile(accessToken: string, itemId: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(`${GRAPH_API_BASE}/me/drive/items/${itemId}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(60000),
      redirect: "follow",
    });
    if (!res.ok || !res.body) return false;

    const { Writable } = await import("stream");
    const fileStream = createWriteStream(destPath);
    // @ts-ignore — Node 22 supports ReadableStream.pipeTo
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
    }
    fileStream.end();
    return true;
  } catch { return false; }
}

export async function listOneDriveFolders(clientId: string, clientSecret: string): Promise<Array<{ id: string; name: string }>> {
  const token = await getAccessToken(clientId, clientSecret);
  if (!token) return [];

  try {
    const res = await fetch(`${GRAPH_API_BASE}/me/drive/root/children?$filter=folder ne null&$select=id,name`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.value ?? []).map((f: any) => ({ id: f.id, name: f.name }));
  } catch { return []; }
}

// ── Adapter class ──

export class OneDriveAdapter implements SourceAdapter {
  id = "onedrive";
  name = "Microsoft OneDrive";
  type: "polling" = "polling";

  async isAvailable() { return false; }
  availabilityReason() { return "OneDrive sync is not yet implemented"; }

  defaultConfig(): SourceConfig {
    return {
      enabled: false,
      syncInterval: 300,
      collections: [],
      maxFileSize: 50 * 1024 * 1024,
    };
  }

  getStatus(): SourceStatus {
    return { state: "idle", docCount: 0 };
  }

  async start() {}
  async stop() {}
}
