import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { EmbeddingError } from "../utils/errors.js";

// Circuit breaker: when embedding server is unreachable, stop trying for a cooldown
let circuitOpen = false;
let circuitOpenedAt = 0;
const CIRCUIT_COOLDOWN_MS = 30_000; // 30 seconds

function checkCircuit(): void {
  if (circuitOpen && Date.now() - circuitOpenedAt > CIRCUIT_COOLDOWN_MS) {
    circuitOpen = false;
    logger.info("Embedding circuit breaker reset — retrying server");
  }
  if (circuitOpen) {
    throw new EmbeddingError("Embedding server unreachable (circuit breaker open — will retry in " +
      Math.ceil((CIRCUIT_COOLDOWN_MS - (Date.now() - circuitOpenedAt)) / 1000) + "s)");
  }
}

/** Check if the embedding circuit breaker is currently open. */
export function isCircuitBreakerOpen(): boolean {
  if (circuitOpen && Date.now() - circuitOpenedAt > CIRCUIT_COOLDOWN_MS) {
    circuitOpen = false;
  }
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

  // Retry with exponential backoff (3 attempts, 500ms -> 1s -> 2s)
  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = 500 * Math.pow(2, attempt - 1);
      logger.warn({ attempt: attempt + 1, delayMs: delay }, "Retrying embedding request");
      await new Promise((r) => setTimeout(r, delay));
    }

    let response: Response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch (err) {
      lastError = new EmbeddingError(
        `Failed to connect to embedding server at ${url}: ${err}`,
      );
      continue; // retry
    }

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
    logger.debug(
      { count: texts.length, tokens: data.usage?.total_tokens },
      "Embedded texts",
    );

    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  // If all retries failed with connection errors, trip the circuit breaker
  if (lastError && lastError.message.includes("Failed to connect")) {
    tripCircuit();
  }
  throw lastError ?? new EmbeddingError("Embedding failed after retries");

}

/**
 * Embed a single text for document storage.
 */
export async function embedPassage(text: string): Promise<number[]> {
  const [embedding] = await embed([text], "passage");
  return embedding;
}

/**
 * Embed a single text for query.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embed([text], "query");
  return embedding;
}
