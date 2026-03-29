/**
 * Web URL Source Adapter
 *
 * Fetches and extracts text from web pages on a configurable interval.
 * Uses jsdom for HTML text extraction. Content hash comparison for change detection.
 *
 * Config via .env:
 *   WEB_URLS=https://example.com|my-collection,https://other.com|docs
 *   WEB_POLL_INTERVAL=3600  (seconds, default 1 hour)
 *
 * Security:
 *   - Rejects file://, localhost, 127.0.0.1, private IP ranges
 *   - 10MB response limit
 *   - 30s fetch timeout
 */
import { createHash } from "crypto";
import { lookup } from "dns/promises";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { JSDOM } from "jsdom";
import { logger } from "../../utils/logger.js";
import { PollingAdapterBase, type RemoteItem } from "./polling-base.js";
import type { SourceConfig } from "../types.js";

// ── Constants ──
const STAGING_DIR = resolve(homedir(), ".threadclaw", "staging", "web");
const MANIFEST_FILE = resolve(homedir(), ".threadclaw", "staging", "web", ".content-hashes.json");
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "ThreadClaw/1.0";

// Private/reserved IP patterns (reject for SSRF protection)
const BLOCKED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
];

interface ParsedUrl {
  url: string;
  collection: string;
}

/** Check if an IP address is in a private/reserved range */
function isPrivateIP(ip: string): boolean {
  const ipMatch = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const first = parseInt(ipMatch[1], 10);
    const second = parseInt(ipMatch[2], 10);
    if (first === 10) return true;                           // 10.0.0.0/8
    if (first === 172 && second >= 16 && second <= 31) return true; // 172.16.0.0/12
    if (first === 192 && second === 168) return true;        // 192.168.0.0/16
    if (first === 169 && second === 254) return true;        // 169.254.0.0/16 (link-local)
    if (first === 127) return true;                          // 127.0.0.0/8 (loopback)
    if (first === 0) return true;                            // 0.0.0.0/8
  }
  // IPv6 loopback
  if (ip === "::1" || ip === "::") return true;
  return false;
}

/** Check if a hostname string is private (fast, no DNS) */
function isPrivateHost(hostname: string): boolean {
  if (BLOCKED_HOSTS.includes(hostname.toLowerCase())) return true;
  return isPrivateIP(hostname);
}

/** Resolve hostname and verify the resolved IP is not private (SSRF protection) */
async function assertPublicHost(hostname: string): Promise<void> {
  // Skip DNS lookup for raw IP addresses — already checked by isPrivateHost
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return;
  if (hostname.startsWith("[")) return; // IPv6 literal already checked

  try {
    const { address } = await lookup(hostname);
    if (isPrivateIP(address)) {
      throw new Error(`Blocked host (${hostname} resolves to private IP ${address}): SSRF protection`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("SSRF")) throw err;
    // DNS failure — let fetch handle it
  }
}

/** Validate a URL for safety */
function validateUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked protocol (${parsed.protocol}): only http:// and https:// allowed`);
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`Blocked host (${parsed.hostname}): private/reserved addresses not allowed`);
  }

  return parsed;
}

/** Parse WEB_URLS env var: "https://a.com|coll1,https://b.com|coll2" */
function parseWebUrls(raw: string): ParsedUrl[] {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((entry) => {
      const pipe = entry.lastIndexOf("|");
      const url = pipe > 0 ? entry.slice(0, pipe).trim() : entry.trim();
      const parsed = validateUrl(url);
      const collection = pipe > 0
        ? entry.slice(pipe + 1).trim()
        : parsed.hostname.replace(/^www\./, "");
      return { url, collection };
    });
}

/** Hash content for change detection */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MAX_REDIRECTS = 5;

/**
 * Fetch with SSRF-safe redirect handling.
 * Uses redirect: "manual" and validates each redirect target against private IP ranges.
 */
async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const parsed = validateUrl(currentUrl);
    await assertPublicHost(parsed.hostname);

    const res = await fetch(currentUrl, { ...init, redirect: "manual" });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect ${res.status} with no Location header from ${currentUrl}`);
      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).href;
      if (i === MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${url}`);
      continue;
    }

    return res;
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${url}`);
}

/** Sanitize URL into a safe filename */
function urlToFilename(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .slice(0, 200);
}

/** Load persisted content hashes from disk */
function loadContentHashes(): Map<string, string> {
  try {
    if (existsSync(MANIFEST_FILE)) {
      const data = JSON.parse(readFileSync(MANIFEST_FILE, "utf-8")) as Record<string, string>;
      return new Map(Object.entries(data));
    }
  } catch {
    // Corrupted file — start fresh
  }
  return new Map();
}

/** Persist content hashes to disk */
function saveContentHashes(hashes: Map<string, string>): void {
  try {
    mkdirSync(resolve(MANIFEST_FILE, ".."), { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of hashes) obj[k] = v;
    writeFileSync(MANIFEST_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    logger.error({ error: String(err) }, "Failed to save web content hashes");
  }
}

export class WebAdapter extends PollingAdapterBase {
  private urls: ParsedUrl[] = [];
  private contentHashes: Map<string, string> = new Map();

  constructor() {
    super({
      id: "web",
      name: "Web URLs",
      stagingDir: STAGING_DIR,
      defaultSyncInterval: 3600,
    });
  }

  async checkAvailability(): Promise<boolean> {
    const raw = process.env.WEB_URLS ?? "";
    if (!raw.trim()) {
      this.unavailableReason = "No web URLs configured. Set WEB_URLS in .env or configure from the TUI.";
      return false;
    }
    return true;
  }

  async initClient(): Promise<void> {
    const raw = process.env.WEB_URLS ?? "";
    this.urls = parseWebUrls(raw);
    this.contentHashes = loadContentHashes();
    logger.info({ urlCount: this.urls.length }, "Web adapter initialized");
  }

  protected onStop(): void {
    this.urls = [];
  }

  defaultConfig(): SourceConfig {
    return {
      enabled: false,
      syncInterval: 3600,
      collections: [],
    };
  }

  async listRemoteItems(): Promise<RemoteItem[]> {
    if (!this.cfg || this.urls.length === 0) return [];

    const items: RemoteItem[] = [];

    for (const entry of this.urls) {
      const itemId = urlToFilename(entry.url);

      try {
        // Use HEAD to check if content might have changed
        const headRes = await safeFetch(entry.url, {
          method: "HEAD",
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!headRes.ok) {
          logger.warn({ url: entry.url, status: headRes.status }, "Web URL HEAD request failed");
          continue;
        }

        // Use Last-Modified or ETag for change detection hint
        const lastModified = headRes.headers.get("last-modified") ?? "";
        const etag = headRes.headers.get("etag") ?? "";
        const changeHint = lastModified || etag || new Date().toISOString();

        items.push({
          id: itemId,
          name: entry.url,
          lastModified: changeHint,
          collection: entry.collection,
          tags: ["web", new URL(entry.url).hostname],
        });
      } catch (err) {
        logger.error({ url: entry.url, error: String(err) }, "Failed to check web URL");
      }
    }

    return items;
  }

  async downloadItem(item: RemoteItem): Promise<string> {
    // Find the matching URL entry
    const entry = this.urls.find((u) => urlToFilename(u.url) === item.id);
    const url = entry?.url ?? item.name;

    const res = await safeFetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }

    // Enforce size limit
    const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new Error(`Response too large (${contentLength} bytes) for ${url}`);
    }

    const rawBuffer = await res.arrayBuffer();
    if (rawBuffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error(`Response too large (${rawBuffer.byteLength} bytes) for ${url}`);
    }

    const html = new TextDecoder().decode(rawBuffer);

    // Extract text from HTML using jsdom
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Strip scripts and styles before extracting text
    for (const el of doc.querySelectorAll("script, style, noscript")) {
      el.remove();
    }

    const text = doc.body?.textContent ?? "";
    const trimmed = text.replace(/\s+/g, " ").trim();

    if (!trimmed) {
      throw new Error(`No text content extracted from ${url}`);
    }

    // Check content hash — skip if unchanged
    const hash = hashContent(trimmed);
    const prevHash = this.contentHashes.get(item.id);
    if (prevHash === hash) {
      // Content hasn't changed despite header hints — skip re-ingestion
      logger.debug({ url }, "Web content unchanged (hash match), skipping");
      return null;
    }

    // Save hash for future comparisons
    this.contentHashes.set(item.id, hash);
    saveContentHashes(this.contentHashes);

    // Save extracted text to staging
    mkdirSync(STAGING_DIR, { recursive: true });
    const filename = `${item.id}.txt`;
    const outPath = join(STAGING_DIR, filename);
    writeFileSync(outPath, trimmed, "utf-8");

    return outPath;
  }

  protected getStagingPathsForRemoval(id: string, _name: string): string[] {
    return [join(STAGING_DIR, `${id}.txt`)];
  }

  protected getRemovalDbQuery(id: string, _name: string): { sql: string; params: string[] } {
    return {
      sql: "SELECT id FROM documents WHERE source_path LIKE ?",
      params: [`%${STAGING_DIR}%${id}%`],
    };
  }
}
