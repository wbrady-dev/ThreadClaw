import { readFile } from "fs/promises";
import type { ParsedDocument, DocMetadata } from "./index.js";

/**
 * Parse .eml email files using mailparser.
 */
export async function parseEml(filePath: string): Promise<ParsedDocument> {
  const raw = await readFile(filePath, "utf-8");
  const { simpleParser } = await import("mailparser");
  const parsed = await simpleParser(raw);

  const metadata: DocMetadata = {
    fileType: "email",
    source: filePath,
    title: parsed.subject ?? "Untitled Email",
    date: parsed.date?.toISOString(),
  };

  if (parsed.from?.text) {
    metadata.author = parsed.from.text;
  }

  // Build text from email parts
  const parts: string[] = [];

  parts.push(`Subject: ${parsed.subject ?? "(no subject)"}`);
  parts.push(`From: ${parsed.from?.text ?? "unknown"}`);
  // Use optional chaining for parsed.to — it can be undefined, string, or AddressObject[]
  const toText = Array.isArray(parsed.to)
    ? parsed.to.map((t: { text?: string }) => t?.text ?? "").join(", ")
    : parsed.to?.text ?? "unknown";
  parts.push(`To: ${toText}`);

  // Include CC/BCC if present (use any cast — mailparser types may not expose cc/bcc)
  const parsedAny = parsed as any;
  if (parsedAny.cc) {
    const ccText = Array.isArray(parsedAny.cc)
      ? parsedAny.cc.map((t: { text?: string }) => t?.text ?? "").join(", ")
      : parsedAny.cc?.text ?? "";
    if (ccText) parts.push(`CC: ${ccText}`);
  }
  if (parsedAny.bcc) {
    const bccText = Array.isArray(parsedAny.bcc)
      ? parsedAny.bcc.map((t: { text?: string }) => t?.text ?? "").join(", ")
      : parsedAny.bcc?.text ?? "";
    if (bccText) parts.push(`BCC: ${bccText}`);
  }

  if (parsed.date) parts.push(`Date: ${parsed.date.toISOString()}`);
  parts.push("");

  // Prefer plain text body, fall back to HTML-stripped text
  if (parsed.text) {
    parts.push(parsed.text);
  } else if (parsed.textAsHtml) {
    // Replace block tags with newlines first to preserve paragraph structure,
    // then strip remaining HTML tags
    const structured = parsed.textAsHtml
      .replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\n\s+/g, "\n")
      .trim();
    parts.push(structured);
  }

  // Note attachments in metadata
  // NOTE: Attachment content is not extracted — only filenames are listed.
  // Future enhancement: extract text from text/plain and text/html attachments.
  if (parsed.attachments && parsed.attachments.length > 0) {
    const attachNames = parsed.attachments.map((a: { filename?: string }) => a.filename ?? "unnamed").join(", ");
    parts.push(`\nAttachments: ${attachNames}`);
    metadata.tags = ["has-attachments"];
  }

  return { text: parts.join("\n"), structure: [], metadata };
}
