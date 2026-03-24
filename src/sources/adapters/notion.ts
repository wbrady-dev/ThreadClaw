/**
 * Notion Source Adapter
 *
 * Uses the @notionhq/client to poll Notion databases for changes.
 * Pages are exported as Markdown and ingested into ThreadClaw.
 *
 * Prerequisites:
 * - Notion Integration API key (NOTION_API_KEY in env)
 * - Databases shared with the integration
 *
 * Read-only: ThreadClaw never writes to Notion.
 */
import { Client } from "@notionhq/client";
import { writeFileSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { logger } from "../../utils/logger.js";
import { PollingAdapterBase, type RemoteItem } from "./polling-base.js";
import type { SourceConfig } from "../types.js";

const STAGING_DIR = resolve(homedir(), ".threadclaw", "staging", "notion");

export class NotionAdapter extends PollingAdapterBase {
  private client: Client | null = null;

  constructor() {
    super({
      id: "notion",
      name: "Notion",
      stagingDir: STAGING_DIR,
      defaultSyncInterval: 600,
    });
  }

  async checkAvailability(): Promise<boolean> {
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
      this.unavailableReason = `Notion API error: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  async initClient(): Promise<void> {
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) throw new Error("NOTION_API_KEY not set. Get an integration key at https://www.notion.so/my-integrations and add NOTION_API_KEY=<your-key> to your .env file.");
    this.client = new Client({ auth: apiKey });
  }

  protected onStop(): void {
    this.client = null;
  }

  defaultConfig(): SourceConfig {
    return {
      enabled: false,
      syncInterval: 600, // 10 minutes (Notion rate limits)
      collections: [],
    };
  }

  async listRemoteItems(): Promise<RemoteItem[]> {
    if (!this.client || !this.cfg) return [];

    const items: RemoteItem[] = [];

    for (const collCfg of this.cfg.collections) {
      const dbId = collCfg.path; // database ID
      const collection = collCfg.collection;

      try {
        const pages = await queryDatabase(this.client, dbId);

        for (const page of pages) {
          const pageId = page.id;
          const lastEdited = (page as any).last_edited_time ?? "";

          items.push({
            id: pageId,
            name: pageId,
            lastModified: lastEdited,
            collection,
            tags: ["notion"],
          });
        }
      } catch (err) {
        logger.error({ database: dbId, error: String(err) }, "Failed to query Notion database");
      }
    }

    return items;
  }

  async downloadItem(item: RemoteItem): Promise<string> {
    if (!this.client) throw new Error("Notion client not initialized");
    const markdown = await exportPageAsMarkdown(this.client, item.id);
    const outPath = join(STAGING_DIR, `${item.id}.md`);
    writeFileSync(outPath, markdown, "utf-8");
    return outPath;
  }

  protected getStagingPathsForRemoval(id: string, _name: string): string[] {
    return [join(STAGING_DIR, `${id}.md`)];
  }

  protected getRemovalDbQuery(id: string, _name: string): { sql: string; params: string[] } {
    const stagingPath = join(STAGING_DIR, `${id}.md`);
    return {
      sql: "SELECT id FROM documents WHERE source_path = ?",
      params: [stagingPath],
    };
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
    const res = await (client.databases as any).query({
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
