/**
 * Lightweight PPTX text extractor.
 * PPTX files are ZIP archives containing XML slide files.
 * Uses Node.js built-in zlib for decompression.
 *
 * Extracts text from:
 * - ppt/slides/slide1.xml, slide2.xml, etc.
 * - Pulls text from <a:t> tags (PowerPoint text elements)
 * - Preserves slide order
 *
 * TODO: Speaker notes are not extracted (ppt/notesSlides/). Add as enhancement.
 * TODO: Consider migrating to AdmZip for more robust ZIP handling.
 * The current data descriptor scanning approach can produce false positives
 * when compressed data happens to contain the signature bytes.
 */

/** Maximum decompressed size (200 MB) to guard against zip bombs */
const MAX_DECOMPRESSED_SIZE = 200 * 1024 * 1024;
/** Maximum number of ZIP entries to prevent resource exhaustion */
const MAX_ENTRY_COUNT = 5000;

interface ZipEntry {
  filename: string;
  data: Buffer;
}

/**
 * Parse a PPTX buffer and return an array of slide text strings.
 */
export async function parseBuffer(buffer: Buffer): Promise<string[]> {
  const entries = await extractZipEntries(buffer);

  // Filter to only slide XML files before decompressing others
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.filename))
    .sort((a, b) => {
      const numA = parseInt(a.filename.match(/slide(\d+)/i)?.[1] ?? "0", 10);
      const numB = parseInt(b.filename.match(/slide(\d+)/i)?.[1] ?? "0", 10);
      return numA - numB;
    });

  const slides: string[] = [];

  for (const entry of slideEntries) {
    const xml = entry.data.toString("utf-8");
    const text = extractTextFromXml(xml);
    slides.push(text);
  }

  return slides;
}

/**
 * Decode common XML entities in text content.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Extract text content from PowerPoint XML.
 * Looks for <a:t> tags which contain the actual text.
 * Groups text by <a:p> (paragraph) tags.
 */
function extractTextFromXml(xml: string): string {
  const lines: string[] = [];

  // Split by paragraph tags
  const paragraphs = xml.split(/<a:p[\s>]/);

  for (const para of paragraphs) {
    // Extract all text elements within this paragraph
    const textMatches = para.match(/<a:t[^>]*>([^<]*)<\/a:t>/g);
    if (textMatches) {
      const lineText = textMatches
        .map((m) => {
          const match = m.match(/<a:t[^>]*>([^<]*)<\/a:t>/);
          return match ? decodeXmlEntities(match[1]) : "";
        })
        .join("")
        .trim();

      if (lineText) {
        lines.push(lineText);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Minimal ZIP file parser.
 * Reads local file headers and extracts entries.
 * Supports Store (no compression) and Deflate methods.
 *
 * Only extracts slide-related entries (ppt/slides/) to save memory.
 */
async function extractZipEntries(buffer: Buffer): Promise<ZipEntry[]> {
  const { inflateRawSync } = await import("zlib");
  const entries: ZipEntry[] = [];
  let offset = 0;
  let totalDecompressed = 0;

  while (offset < buffer.length - 4) {
    // Enforce entry count limit
    if (entries.length >= MAX_ENTRY_COUNT) {
      break;
    }

    // Look for local file header signature: PK\x03\x04
    if (
      buffer[offset] !== 0x50 ||
      buffer[offset + 1] !== 0x4b ||
      buffer[offset + 2] !== 0x03 ||
      buffer[offset + 3] !== 0x04
    ) {
      break; // No more local file headers
    }

    const generalPurposeFlags = buffer.readUInt16LE(offset + 6);
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    let compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const hasDataDescriptor = (generalPurposeFlags & 0x08) !== 0;

    const filenameStart = offset + 30;
    const filename = buffer
      .subarray(filenameStart, filenameStart + filenameLength)
      .toString("utf-8");

    const dataStart = filenameStart + filenameLength + extraLength;

    // Path traversal check — reject entries with .. components
    if (filename.includes("..") || filename.startsWith("/")) {
      // Skip this entry entirely
      offset = dataStart + compressedSize;
      if (hasDataDescriptor) offset += 12;
      continue;
    }

    // If bit 3 is set, sizes in the local header may be zero;
    // the real sizes follow the compressed data in a data descriptor.
    if (hasDataDescriptor && compressedSize === 0) {
      // Scan for the data descriptor signature (PK\x07\x08) or next local header.
      // Data descriptor: [optional sig 0x08074b50] crc32(4) compSize(4) uncompSize(4)
      let scanPos = dataStart;
      while (scanPos < buffer.length - 4) {
        if (
          buffer[scanPos] === 0x50 && buffer[scanPos + 1] === 0x4b &&
          ((buffer[scanPos + 2] === 0x07 && buffer[scanPos + 3] === 0x08) ||
           (buffer[scanPos + 2] === 0x03 && buffer[scanPos + 3] === 0x04))
        ) {
          break;
        }
        scanPos++;
      }
      compressedSize = scanPos - dataStart;
    }

    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    // Only decompress slide files (filter before decompressing to save resources)
    const isSlide = /^ppt\/slides\/slide\d+\.xml$/i.test(filename);

    if (isSlide && !filename.endsWith("/")) {
      let data: Buffer;
      if (compressionMethod === 0) {
        // Stored (no compression)
        data = Buffer.from(compressedData);
      } else if (compressionMethod === 8) {
        // Deflate
        try {
          data = inflateRawSync(compressedData);
        } catch {
          data = Buffer.alloc(0);
        }
      } else {
        data = Buffer.alloc(0);
      }

      // Zip bomb protection: check total decompressed size
      totalDecompressed += data.length;
      if (totalDecompressed > MAX_DECOMPRESSED_SIZE) {
        throw new Error(`PPTX decompressed size exceeds ${MAX_DECOMPRESSED_SIZE / 1024 / 1024}MB limit — possible zip bomb`);
      }

      entries.push({ filename, data });
    }

    let nextOffset = dataStart + compressedSize;
    // Skip past data descriptor if present
    if (hasDataDescriptor) {
      if (nextOffset + 4 <= buffer.length &&
          buffer[nextOffset] === 0x50 && buffer[nextOffset + 1] === 0x4b &&
          buffer[nextOffset + 2] === 0x07 && buffer[nextOffset + 3] === 0x08) {
        nextOffset += 16; // sig(4) + crc32(4) + compSize(4) + uncompSize(4)
      } else {
        nextOffset += 12; // crc32(4) + compSize(4) + uncompSize(4) (no sig)
      }
    }
    offset = nextOffset;
  }

  return entries;
}
