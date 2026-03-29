import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface SynthesisInput {
  query: string;
  chunks: Array<{ text: string; sourcePath?: string; score: number }>;
  maxTokens?: number;
}

export interface SynthesisResult {
  answer: string;
  citations: string[];
}

const SYSTEM_PROMPT = `You are a precise research assistant. Answer the user's question using ONLY the provided sources. Cite sources using [1], [2], etc. If the sources don't contain enough information to answer fully, say so clearly. Be concise and factual.`;

export async function synthesizeAnswer(input: SynthesisInput): Promise<SynthesisResult> {
  const { query, chunks, maxTokens = config.synthesis.maxTokens } = input;

  // Build numbered source context
  const numberedSources = chunks.map((c, i) =>
    `[${i + 1}] (${c.sourcePath ?? "unknown"})\n${c.text}`
  ).join("\n\n---\n\n");

  const userPrompt = `Sources:\n${numberedSources}\n\nQuestion: ${query}`;

  // Use synthesis LLM config, falling back to deep extraction config
  const url = config.synthesis.url
    || process.env.DEEP_EXTRACT_LLM_URL
    || process.env.SYNTHESIS_LLM_URL
    || "https://api.openai.com/v1/chat/completions";
  const model = config.synthesis.model
    || process.env.DEEP_EXTRACT_MODEL
    || process.env.SYNTHESIS_MODEL
    || "gpt-4o-mini";

  // Warn when falling back to external API (no local synthesis URL configured)
  if (!config.synthesis.url && !process.env.DEEP_EXTRACT_LLM_URL && !process.env.SYNTHESIS_LLM_URL) {
    logger.warn({ url, model }, "No local synthesis LLM configured — falling back to external OpenAI API");
  }
  const apiKey = process.env.SYNTHESIS_API_KEY
    || process.env.OPENAI_API_KEY
    || "";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(config.synthesis.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Synthesis LLM returned ${response.status}`);
  }

  // Guard against unexpectedly large responses (max 2 MB)
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    throw new Error(`Synthesis response too large: ${contentLength} bytes`);
  }

  let data: any;
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`Synthesis response body too large: ${text.length} chars`);
    }
    data = JSON.parse(text);
  } catch (err) {
    if (err instanceof Error && err.message.includes("too large")) throw err;
    throw new Error("Synthesis LLM returned invalid JSON");
  }
  const answer = data.choices?.[0]?.message?.content ?? "";

  // Extract citation references from answer
  const citationMatches = answer.match(/\[(\d+)\]/g) ?? [];
  const citations = [...new Set(citationMatches.map((m: string) => {
    const idx = parseInt(m.slice(1, -1), 10) - 1;
    return idx >= 0 && idx < chunks.length ? (chunks[idx].sourcePath ?? "unknown") : null;
  }).filter(Boolean))] as string[];

  return { answer, citations };
}
