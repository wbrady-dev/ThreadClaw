import { readFile } from "fs/promises";
import { basename } from "path";
import type { ParsedDocument, StructureHint, DocMetadata } from "./index.js";

/**
 * Parse Obsidian Canvas files (.canvas).
 *
 * JSON Canvas format (jsoncanvas.org):
 * - nodes: text, file, link, or group
 * - edges: connections between nodes with optional labels
 *
 * Extracts text content from text nodes, file references as links,
 * and URL references. Edge labels provide connecting context.
 */
export async function parseCanvas(filePath: string): Promise<ParsedDocument> {
  const raw = await readFile(filePath, "utf-8");
  const metadata: DocMetadata = {
    fileType: "canvas",
    title: basename(filePath, ".canvas"),
    source: filePath,
  };
  const structure: StructureHint[] = [];

  let canvas: { nodes?: CanvasNode[]; edges?: CanvasEdge[] };
  try {
    canvas = JSON.parse(raw);
  } catch {
    return { text: "", structure, metadata };
  }

  const nodes = canvas.nodes ?? [];
  const edges = canvas.edges ?? [];
  const textParts: string[] = [];
  const links: Array<{ target: string; display?: string }> = [];

  // Process nodes
  for (const node of nodes) {
    if (node.type === "text" && node.text) {
      textParts.push(node.text.trim());
    } else if (node.type === "file" && node.file) {
      links.push({ target: node.file, display: node.file });
      textParts.push(`[Linked file: ${node.file}]`);
    } else if (node.type === "link" && node.url) {
      textParts.push(`[Link: ${node.url}]`);
    } else if (node.type === "group" && node.label) {
      textParts.push(`--- ${node.label} ---`);
    }
  }

  // Process edges (connections with optional labels)
  for (const edge of edges) {
    if (edge.label) {
      textParts.push(`[Connection: ${edge.label}]`);
    }
  }

  if (links.length > 0) metadata.links = links;

  const text = textParts.join("\n\n");

  // Add a structure hint for the overall canvas
  if (text.length > 0) {
    structure.push({
      type: "section",
      startOffset: 0,
      endOffset: text.length,
    });
  }

  return { text, structure, metadata };
}

// ── Types ───────────────────────────────────────────────────────────

interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
}
