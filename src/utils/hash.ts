import xxhash from "xxhash-wasm";

let initPromise: ReturnType<typeof xxhash> | null = null;

// Reuse a single TextEncoder instance (they are stateless and safe to share)
const _textEncoder = new TextEncoder();

async function getHasher() {
  if (!initPromise) {
    initPromise = xxhash().catch((err) => {
      // Reset so the next call retries instead of returning a cached rejection
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

/**
 * Hash text content. Returns xxhash64 as a zero-padded 16-char hex string.
 * Same format as contentHashBytes — both return zero-padded hex.
 *
 * Note: a synchronous hash variant is not provided because xxhash-wasm
 * requires async initialization. Use Node's crypto.createHash for sync needs.
 */
export async function contentHash(text: string): Promise<string> {
  const { h64Raw } = await getHasher();
  return h64Raw(_textEncoder.encode(text)).toString(16).padStart(16, "0");
}

/**
 * Hash binary content. Returns xxhash64 as a zero-padded 16-char hex string.
 */
export async function contentHashBytes(data: Uint8Array): Promise<string> {
  const { h64Raw } = await getHasher();
  return h64Raw(data).toString(16).padStart(16, "0");
}
