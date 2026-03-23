/**
 * Notion Source Adapter
 *
 * Uses the @notionhq/client to poll Notion databases for changes.
 * Pages are exported as Markdown and ingested into ClawCore.
 *
 * Prerequisites:
 * - Notion Integration API key (NOTION_API_KEY in env)
 * - Databases shared with the integration
 *
 * Read-only: ClawCore never writes to Notion.
 */
import { Client } from "@notionhq/client";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { ingestFile } from "../../ingest/pipeline.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { getDb } from "../../storage/index.js";
import { deleteDocument } from "../../storage/collections.js";
import type { SourceAdapter, SourceConfig, SourceStatus, ChangeSet, StagedFile } from "../types.js";

const STAGING_DIR = resolve(homedir(), ".clawcore", "staging", "notion");

/** Sync manifest — tracks last_edited_time per page */
interface ManifestEntry {
  pageId: string;
  title: string;
  lastEdited: string;
}

export class NotionAdapter implements SourceAdapter {
  id = "notion";
  name = "Notion";
  type = "polling" as const;

  private status: SourceStatus = { state: "idle", docCount: 0 };
  private syncTimer: NodeJS.Timeout | null = null;
  private manifest = new Map<string, ManifestEntry>();
  private cfg: SourceConfig | null = null;
  private client: Client | null = null;
  private unavailableReason = "";

  async isAvailable(): Promise<boolean> {
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) {
      this.unavailableReason = "NOTION_API_KEY not set. Get one at notion.so/my-integrations";
      return false;
    }

    // Verify the key works
    try {
      const client = new Client({ auth: apiKey });
      await client.users.me({});
      return true;
    } catch (err) {
      this.unavailableReason = `Notion API key invalid: ${err}`;
      return false;
    }
  }

  availabilityReason(): string {
    return this.unavailableReason;
  }

  defaultConfig(): SourceConfig {
    return {
      enabled: false,
      syncInterval: 600, // 10 minutes (Notion rate limits)
      collections: [],
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

    logger.warn("Notion manifest is in-memory — full re-sync will occur on restart");

    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) {
      this.status = { state: "error", docCount: 0, error: "NOTION_API_KEY not set" };
      return;
    }

    this.client = new Client({ auth: apiKey });
    mkdirSync(STAGING_DIR, { recursive: true });

    // Initial sync
    try {
      await this.sync();
    } catch (err) {
      logger.error({ source: "notion", error: String(err) }, "Initial Notion sync failed");
      this.status = { state: "error", docCount: 0, error: `Initial sync failed: ${err}` };
    }

    // Start polling
    const intervalMs = (cfg.syncInterval || 600) * 1000;
    this.syncTimer = setInterval(() => {
      this.sync().catch((err) => {
        logger.error({ source: "notion", error: String(err) }, "Notion sync failed");
        this.status = { ...this.status, state: "error", error: String(err) };
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.client = null;
    this.status = { state: "idle", docCount: 0 };
  }

  async detectChanges(): Promise<ChangeSet> {
    if (!this.cfg || !this.client) return { added: [], modified: [], removed: [] };

    const changes: ChangeSet = { added: [], modified: [], removed: [] };
    const allCurrentIds = new Set<string>();

    for (const collCfg of this.cfg.collections) {
      const dbId = collCfg.path; // database ID
      const collection = collCfg.collection;

      try {
        const pages = await queryDatabase(this.client, dbId);

        for (const page of pages) {
          const pageId = page.id;
          const lastEdited = (page as any).last_edited_time ?? "";

          allCurrentIds.add(pageId);
          const existing = this.manifest.get(pageId);
          if (!existing) {
            changes.added.push({
              sourceId: pageId,
              localPath: "",
              collection,
              tags: ["notion"],
              remoteTimestamp: lastEdited,
            });
          } else if (existing.lastEdited !== lastEdited) {
            changes.modified.push({
              sourceId: pageId,
              localPath: "",
              collection,
              tags: ["notion"],
              remoteTimestamp: lastEdited,
            });
          }
        }
      } catch (err) {
        logger.error({ database: dbId, error: String(err) }, "Failed to query Notion database");
      }
    }

    // Detect removals AFTER iterating all databases to avoid cross-collection false positives
    for (const [pageId] of this.manifest) {
      if (!allCurrentIds.has(pageId)) {
        changes.removed.push(pageId);
      }
    }

    return changes;
  }

  async downloadToStaging(changes: ChangeSet): Promise<StagedFile[]> {
    if (!this.client) return [];
    const staged: StagedFile[] = [];
    const toProcess = [...changes.added, ...changes.modified];

    for (const file of toProcess) {
      try {
        const markdown = await exportPageAsMarkdown(this.client, file.sourceId);
        const outPath = join(STAGING_DIR, `${file.sourceId}.md`);
        writeFileSync(outPath, markdown, "utf-8");
        staged.push({ ...file, localPath: outPath });
      } catch (err) {
        logger.error({ pageId: file.sourceId, error: String(err) }, "Failed to export Notion page");
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
    if (!this.client) return;

    this.status = { ...this.status, state: "syncing" };

    const changes = await this.detectChanges();
    const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;

    if (totalChanges === 0) {
      logger.info({ source: "notion" }, "Notion sync: no changes");
      this.status = {
        ...this.status,
        state: "idle",
        lastSync: new Date(),
        nextSync: new Date(Date.now() + (this.cfg?.syncInterval ?? 600) * 1000),
      };
      return;
    }

    logger.info(
      { source: "notion", added: changes.added.length, modified: changes.modified.length, removed: changes.removed.length },
      "Notion sync: changes detected",
    );

    // Process removals — delete staging files, DB docs, and remove from manifest
    for (const pageId of changes.removed) {
      const stagingPath = join(STAGING_DIR, `${pageId}.md`);
      try { if (existsSync(stagingPath)) unlinkSync(stagingPath); } catch {}

      // Clean up DB documents/chunks/vectors to prevent orphans
      try {
        const db = getDb(resolve(config.dataDir, "clawcore.db"));
        const doc = db.prepare("SELECT id FROM documents WHERE source_path = ?").get(stagingPath) as { id: string } | undefined;
        if (doc) {
          deleteDocument(db, doc.id);
          logger.info({ source: "notion", pageId, docId: doc.id }, "Deleted orphaned document from DB");
        }
      } catch (dbErr) {
        logger.error({ source: "notion", pageId, error: String(dbErr) }, "Failed to clean up DB on removal");
      }

      this.manifest.delete(pageId);
      logger.info({ source: "notion", pageId }, "Notion page removed");
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
          pageId: file.sourceId,
          title: file.localPath.split(/[/\\]/).pop() ?? file.sourceId,
          lastEdited: file.remoteTimestamp ?? new Date().toISOString(),
        });
      } catch (err) {
        logger.error({ file: file.localPath, error: String(err) }, "Failed to ingest Notion page");
      }
    }

    this.cleanup(staged);

    this.status = {
      state: "idle",
      lastSync: new Date(),
      nextSync: new Date(Date.now() + (this.cfg?.syncInterval ?? 600) * 1000),
      docCount: this.manifest.size,
    };

    logger.info({ source: "notion", ingested, total: this.manifest.size }, "Notion sync complete");
  }
}

// ────────────────────────────────────────────
// Notion API helpers
// ────────────────────────────────────────────

/** Query all pages from a Notion database using the official client */
async function queryDatabase(client: Client, databaseId: string): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined;

  do {
    const res = await client.databases.query({
      database_id: databaseId,
      page_size: 100,
      start_cursor: cursor,
    });

    pages.push(...(res.results ?? []));
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;

    // Rate limit: ~3 req/s for Notion API
    await sleep(350);
  } while (cursor);

  return pages;
}

/** Extract page title from properties */
function extractPageTitle(page: any): string {
  const props = page.properties ?? {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && prop.title?.length > 0) {
      return prop.title.map((t: any) => t.plain_text).join("");
    }
  }
  return page.id;
}

/** Export a Notion page as Markdown by reading its blocks */
async function exportPageAsMarkdown(client: Client, pageId: string): Promise<string> {
  // Get page metadata for title
  const page = await client.pages.retrieve({ page_id: pageId });
  const title = extractPageTitle(page);

  // Get all blocks
  const blocks = await getAllBlocks(client, pageId);

  // Convert blocks to Markdown (with recursive child block expansion)
  const lines: string[] = [`# ${title}`, ""];

  for (const block of blocks) {
    const md = blockToMarkdown(block);
    if (md !== null) lines.push(md);

    // Recursively fetch and render child blocks
    if ((block as any).has_children) {
      const children = await getAllBlocks(client, block.id);
      for (const child of children) {
        const childMd = blockToMarkdown(child);
        if (childMd !== null) lines.push(`  ${childMd}`);
      }
    }
  }

  return lines.join("\n");
}

/** Retrieve all blocks from a page (handles pagination) */
async function getAllBlocks(client: Client, blockId: string): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;

  do {
    const res = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });

    blocks.push(...res.results);
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;

    await sleep(350); // rate limit
  } while (cursor);

  return blocks;
}

/** Convert a Notion block to Markdown */
function blockToMarkdown(block: any): string | null {
  const type = block.type;
  if (!type) return null;

  const data = block[type];
  if (!data) return null;

  switch (type) {
    case "paragraph":
      return richTextToMd(data.rich_text);
    case "heading_1":
      return `# ${richTextToMd(data.rich_text)}`;
    case "heading_2":
      return `## ${richTextToMd(data.rich_text)}`;
    case "heading_3":
      return `### ${richTextToMd(data.rich_text)}`;
    case "bulleted_list_item":
      return `- ${richTextToMd(data.rich_text)}`;
    case "numbered_list_item":
      return `1. ${richTextToMd(data.rich_text)}`;
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${richTextToMd(data.rich_text)}`;
    case "toggle":
      return `> ${richTextToMd(data.rich_text)}`;
    case "quote":
      return `> ${richTextToMd(data.rich_text)}`;
    case "callout":
      return `> ${richTextToMd(data.rich_text)}`;
    case "code":
      return `\`\`\`${data.language ?? ""}\n${richTextToMd(data.rich_text)}\n\`\`\``;
    case "divider":
      return "---";
    case "table_of_contents":
      return null; // skip
    case "image":
      return `![image](${data.file?.url ?? data.external?.url ?? ""})`;
    case "bookmark":
      return `[${data.url}](${data.url})`;
    case "link_preview":
      return `[${data.url}](${data.url})`;
    case "equation":
      return `$$${data.expression}$$`;
    case "child_page":
      return `**[${data.title}]**`;
    case "child_database":
      return `**[Database: ${data.title}]**`;
    default:
      // Unknown block type — try to extract text
      if (data.rich_text) return richTextToMd(data.rich_text);
      return null;
  }
}

/** Convert Notion rich text array to Markdown string */
function richTextToMd(richText: any[]): string {
  if (!richText || !Array.isArray(richText)) return "";

  return richText
    .map((t: any) => {
      let text = t.plain_text ?? "";
      const ann = t.annotations ?? {};

      if (ann.bold) text = `**${text}**`;
      if (ann.italic) text = `*${text}*`;
      if (ann.strikethrough) text = `~~${text}~~`;
      if (ann.code) text = `\`${text}\``;

      if (t.href) text = `[${text}](${t.href})`;

      return text;
    })
    .join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Check if NOTION_API_KEY is set */
export function hasNotionApiKey(): boolean {
  return !!process.env.NOTION_API_KEY;
}

/** List all databases shared with the integration (for TUI browser) */
export async function listNotionDatabases(): Promise<{ id: string; title: string }[]> {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { property: "object", value: "database" },
        page_size: 50,
      }),
    });

    if (!res.ok) return [];
    const data = await res.json() as any;

    return (data.results ?? []).map((db: any) => {
      const titleParts = db.title ?? [];
      const title = titleParts.map((t: any) => t.plain_text).join("") || "Untitled";
      return { id: db.id, title };
    });
  } catch {
    return [];
  }
}
