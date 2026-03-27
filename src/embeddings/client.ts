import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { EmbeddingError } from "../utils/errors.js";

// Circuit breaker: when embedding server is unreachable, stop trying for a cooldown
let circuitOpen = false;
let circuitOpenedAt = 0;
// Read inline to support hot-reload of config (not captured at module load)
function getCircuitCooldownMs(): number { return config.extraction.embeddingCircuitCooldownMs; }

/** Shared helper: check and reset circuit breaker if cooldown elapsed */
function maybeResetCircuit(): boolean {
  if (circuitOpen && Date.now() - circuitOpenedAt > getCircuitCooldownMs()) {
    circuitOpen = false;
    logger.info("Embedding circuit breaker reset — retrying server");
    return true; // was reset
  }
  return false;
}

function checkCircuit(): void {
  maybeResetCircuit();
  if (circuitOpen) {
    throw new EmbeddingError("Embedding server unreachable (circuit breaker open — will retry in " +
      Math.ceil((getCircuitCooldownMs() - (Date.now() - circuitOpenedAt)) / 1000) + "s)");
  }
}

/** Check if the embedding circuit breaker is currently open. */
export function isCircuitBreakerOpen(): boolean {
  maybeResetCircuit();
  return circuitOpen;
}

function tripCircuit(): void {
  if (!circuitOpen) {
    circuitOpen = true;
    circuitOpenedAt = Date.now();
    logger.error("Embedding server unreachable — circuit breaker tripped, pausing for 30s");
  }
}

export interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Embed text using the model server's OpenAI-compatible endpoint.
 * Some models (e.g., NVIDIA Nemotron, E5) use
 * "passage: " and "query: " prefixes.
 */
export async function embed(
  texts: string[],
  type: "passage" | "query" = "passage",
): Promise<number[][]> {
  // Prefix mode: "auto" detects NVIDIA models, "always"/"never" override
  const prefixMode = config.embedding.prefixMode;
  const needsPrefix = prefixMode === "always" ||
    (prefixMode === "auto" && (
      config.embedding.model.includes("nemotron") ||
      config.embedding.model.includes("nv-embed")
    ));
  const input = needsPrefix ? texts.map((t) => `${type}: ${t}`) : texts;

  checkCircuit();

  const url = `${config.embedding.url}/embeddings`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.EMBEDDING_API_KEY;
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify({ model: config.embedding.model, input });

  // Retry with exponential backoff
  const MAX_RETRIES = config.extraction.embeddingMaxRetries;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = 500 * Math.pow(2, attempt - 1);
      logger.warn({ attempt: attempt + 1, delayMs: delay }, "Retrying embedding request");
      await new Promise((r) => setTimeout(r, delay));
    }

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.extraction.embeddingTimeoutMs);
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      lastError = new EmbeddingError(
        `Failed to connect to embedding server at ${url}: ${err}`,
      );
      continue; // retry
    }
    clearTimeout(timeout);

    if (response.status === 429 || response.status >= 500) {
      const text = await response.text().catch(() => "");
      lastError = new EmbeddingError(`Embedding error (${response.status}): ${text}`);
      continue; // retry on rate limit or server error
    }

    if (!response.ok) {
      const text = await response.text();
      throw new EmbeddingError(`Embedding error (${response.status}): ${text}`);
    }

    // Success
    const data = (await response.json()) as EmbeddingResponse;

    // Validate response structure
    if (!data?.data || !Array.isArray(data.data)) {
      throw new EmbeddingError(`Embedding response missing data array`);
    }

    logger.debug(
      { count: texts.length, tokens: data.usage?.total_tokens },
      "Embedded texts",
    );

    const sorted = data.data.sort((a, b) => a.index - b.index);

    // Validate dimension of returned embeddings
    const expectedDim = config.embedding.dimensions;
    for (const item of sorted) {
      if (item.embedding.length !== expectedDim) {
        throw new EmbeddingError(
          `Embedding dimension mismatch: expected ${expectedDim}, got ${item.embedding.length}. Check embedding model configuration.`,
        );
      }
    }

    return sorted.map((d) => d.embedding);
  }

  // If all retries failed with connection errors, trip the circuit breaker
  if (lastError && lastError.message.includes("Failed to connect")) {
    tripCircuit();
  }
  throw lastError ?? new EmbeddingError("Embedding failed after retries");

}

// LRU cache for query embeddings — eliminates redundant model server calls
const EMBED_CACHE_MAX = config.extraction.embeddingCacheMax;
const queryEmbedCache = new Map<string, number[]>();

// NOTE: Cache key includes the full text, which uses more memory for long queries.
// Consider using a hash (sha256) for very long texts. For typical query lengths (<500 chars),
// the overhead is negligible and the full-text key avoids hash collision risks.
function embedCacheKey(text: string): string {
  return `${config.embedding.model}:${config.embedding.prefixMode}:${text}`;
}

/**
 * Embed a single text for query. Results are LRU-cached (200 entries).
 */
export async function embedQuery(text: string): Promise<number[]> {
  const key = embedCacheKey(text);
  const cached = queryEmbedCache.get(key);
  if (cached) {
    // Move to end (most recently used)
    queryEmbedCache.delete(key);
    queryEmbedCache.set(key, cached);
    return cached.slice();
  }
  const [embedding] = await embed([text], "query");
  // Evict oldest if at capacity
  if (queryEmbedCache.size >= EMBED_CACHE_MAX) {
    const oldest = queryEmbedCache.keys().next().value;
    if (oldest !== undefined) queryEmbedCache.delete(oldest);
  }
  queryEmbedCache.set(key, embedding);
  return embedding.slice();
}
