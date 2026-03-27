/**
 * Type declarations for untyped npm packages used by ThreadClaw.
 */

// prompts typing is intentionally loose — the library's API uses dynamic
// question objects with varying shapes. Tightening would require a full
// re-typing effort that's better done upstream.
declare module "prompts" {
  function prompts(
    questions: Record<string, any> | Record<string, any>[],
    options?: { onCancel?: () => void; onSubmit?: (...args: any[]) => void },
  ): Promise<Record<string, any>>;

  export default prompts;
}

declare module "mailparser" {
  interface AddressObject {
    text: string;
    html?: string;
    value: Array<{ address: string; name: string }>;
  }

  interface Attachment {
    filename?: string;
    contentType: string;
    size: number;
    content?: Buffer;
  }

  interface ParsedMail {
    subject?: string;
    from?: AddressObject;
    to?: AddressObject;
    date?: Date;
    text?: string;
    textAsHtml?: string;
    html?: string;
    attachments: Attachment[];
  }

  export function simpleParser(source: string | Buffer): Promise<ParsedMail>;
}

declare module "mammoth" {
  interface ConvertResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  function convertToHtml(input: { buffer: Buffer } | { path: string }): Promise<ConvertResult>;
  function convertToMarkdown(input: { buffer: Buffer } | { path: string }): Promise<ConvertResult>;
  function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<ConvertResult>;

  // mammoth's default export is typed loosely as an object literal.
  // A more precise typing would require enumerating all mammoth methods.
  export default { convertToHtml, convertToMarkdown, extractRawText };
}
