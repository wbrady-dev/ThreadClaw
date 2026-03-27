/**
 * Image parser — extracts text via OCR (Tesseract).
 *
 * Supports: .png, .jpg, .jpeg, .gif, .webp, .bmp, .tiff
 * Requires: tesseract installed and on PATH
 *   Windows: choco install tesseract / download from GitHub
 *   Linux: apt install tesseract-ocr
 *   macOS: brew install tesseract
 *
 * Falls back to metadata-only if Tesseract is not available.
 */

import { basename } from "path";
// TODO: execFileSync blocks the event loop. Consider using execFile (async) with
// util.promisify for better server responsiveness during OCR operations.
import { execFileSync } from "child_process";
import { config } from "../../config.js";
import type { ParsedDocument, DocMetadata } from "./index.js";

let _tesseractAvailable: boolean | null = null;

function isTesseractAvailable(): boolean {
  if (_tesseractAvailable !== null) return _tesseractAvailable;
  try {
    execFileSync("tesseract", ["--version"], { stdio: "pipe", timeout: 5000 });
    _tesseractAvailable = true;
  } catch {
    _tesseractAvailable = false;
  }
  return _tesseractAvailable;
}

export async function parseImage(filePath: string): Promise<ParsedDocument> {
  const metadata: DocMetadata = {
    fileType: "image",
    title: basename(filePath),
    source: filePath,
  };

  // Removed existsSync check — TOCTOU race. The file could disappear between
  // check and execFileSync anyway, so let Tesseract report the error directly.

  if (!isTesseractAvailable()) {
    return {
      text: `[Image: ${basename(filePath)} — OCR unavailable (install Tesseract for text extraction)]`,
      structure: [],
      metadata,
    };
  }

  try {
    // Run Tesseract OCR — use execFileSync with args array to prevent shell injection
    const result = execFileSync(
      "tesseract", [filePath, "stdout", "-l", config.extraction.ocrLanguage, "--psm", "3"],
      { stdio: ["pipe", "pipe", "pipe"], timeout: config.extraction.ocrTimeoutMs, maxBuffer: 10 * 1024 * 1024 },
    ).toString().trim();

    if (!result || result.length < 3) {
      return {
        text: `[Image: ${basename(filePath)} — no text detected by OCR]`,
        structure: [],
        metadata,
      };
    }

    return { text: result, structure: [], metadata };
  } catch (err: any) {
    return {
      text: `[Image: ${basename(filePath)} — OCR failed: ${err.message?.substring(0, 100) ?? "unknown error"}]`,
      structure: [],
      metadata,
    };
  }
}
