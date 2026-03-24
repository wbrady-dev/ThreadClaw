import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { Section, Separator, KV, Spinner, Menu, t, type MenuItem } from "../components.js";
import { getApiBaseUrl } from "../../platform.js";

/* ── Types ────────────────────────────────────────────────────────── */

interface SearchResult {
  source: string;
  content: string;
  score: number;
  collection: string;
  highlighted?: string;
}

interface SearchScreenProps {
  onBack: () => void;
}

/* ── Constants ────────────────────────────────────────────────────── */

const RESULTS_PER_PAGE = 10;

/* ── Helpers ──────────────────────────────────────────────────────── */

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

function truncate(text: string, maxLen: number): string {
  if (!text) return "";
  const clean = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen) + "...";
}

function formatScore(score: number): string {
  return (score * 100).toFixed(1) + "%";
}

/* ── Screen ───────────────────────────────────────────────────────── */

type View = "input" | "results" | "detail";

function SearchScreen({ onBack }: SearchScreenProps) {
  const [view, setView] = useState<View>("input");
  const [queryText, setQueryText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [page, setPage] = useState(0);
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);

  /* ── Query execution ────────────────────────────────────────────── */

  const executeSearch = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    setResults([]);
    setPage(0);

    try {
      const res = await fetch(`${getApiBaseUrl()}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim(), top_k: 20 }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
        setView("input");
        setLoading(false);
        return;
      }

      const payload = (await res.json()) as {
        context?: string;
        highlighted?: string;
        sources?: Array<{
          source: string;
          chunkCount?: number;
          avgScore?: number;
          collection?: string;
        }>;
        queryInfo?: {
          confidence?: number;
          chunksReturned?: number;
        };
      };

      const sources = payload.sources ?? [];
      const mapped: SearchResult[] = sources.map((s) => ({
        source: s.source,
        content: payload.context ?? "",
        score: s.avgScore ?? 0,
        collection: s.collection ?? "default",
        highlighted: payload.highlighted,
      }));

      setResults(mapped);
      setView(mapped.length > 0 ? "results" : "input");
      if (mapped.length === 0) {
        // Check if the knowledge base is empty (0 documents indexed)
        try {
          const statsRes = await fetch(`${getApiBaseUrl()}/stats`, {
            signal: AbortSignal.timeout(5000),
          });
          if (statsRes.ok) {
            const stats = (await statsRes.json()) as { documents?: number };
            if (typeof stats.documents === "number" && stats.documents === 0) {
              setError("Knowledge base is empty. Add documents from Sources first, then start services.");
            } else {
              setError("No results found.");
            }
          } else {
            setError("No results found.");
          }
        } catch {
          setError("No results found.");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("timeout")) {
        setError("Cannot reach ThreadClaw API. Are services running?");
      } else {
        setError(`Search failed: ${msg}`);
      }
      setView("input");
    } finally {
      setLoading(false);
    }
  }, []);

  /* ── Input handling ─────────────────────────────────────────────── */

  useInput((input, key) => {
    if (view === "detail") {
      if (key.escape) {
        setSelectedResult(null);
        setView("results");
      }
      return;
    }

    if (view === "results") {
      if (key.escape) {
        setView("input");
      }
      return;
    }

    // view === "input"
    if (key.escape) {
      onBack();
    }
  }, { isActive: !loading });

  /* ── Submit handler ─────────────────────────────────────────────── */

  const handleSubmit = (value: string) => {
    if (value.trim()) {
      executeSearch(value);
    }
  };

  /* ── Loading state ──────────────────────────────────────────────── */

  if (loading) {
    return (
      <Box flexDirection="column">
        <Section title="Search" />
        <Text>{"  " + t.dim(`Searching: "${queryText}"`)}</Text>
        <Text> </Text>
        <Spinner label="Querying knowledge base..." />
      </Box>
    );
  }

  /* ── Detail view ────────────────────────────────────────────────── */

  if (view === "detail" && selectedResult) {
    return (
      <Box flexDirection="column">
        <Section title="Result Detail" />
        <KV label="Source" value={t.value(selectedResult.source)} />
        <KV label="Collection" value={t.dim(selectedResult.collection)} />
        <KV label="Confidence" value={t.value(formatScore(selectedResult.score))} />
        <Text> </Text>
        <Separator width={60} />
        <Box marginLeft={2} flexDirection="column">
          <Text wrap="wrap">{selectedResult.highlighted ?? selectedResult.content}</Text>
        </Box>
        <Separator width={60} />
        <Text> </Text>
        <Text>{"  " + t.dim("Press Escape to go back")}</Text>
      </Box>
    );
  }

  /* ── Results list ───────────────────────────────────────────────── */

  if (view === "results" && results.length > 0) {
    const totalPages = Math.ceil(results.length / RESULTS_PER_PAGE);
    const start = page * RESULTS_PER_PAGE;
    const pageResults = results.slice(start, start + RESULTS_PER_PAGE);

    const menuItems: MenuItem[] = pageResults.map((r, i) => ({
      label: `${basename(r.source)}  ${t.dim(formatScore(r.score))}  ${t.dim(truncate(r.content, 80))}`,
      value: `result:${start + i}`,
      description: r.collection,
    }));

    if (totalPages > 1) {
      if (page < totalPages - 1) {
        menuItems.push({ label: "Next page", value: "__next__", color: t.dim });
      }
      if (page > 0) {
        menuItems.push({ label: "Previous page", value: "__prev__", color: t.dim });
      }
    }

    menuItems.push({ label: "New search", value: "__new__", color: t.dim });
    menuItems.push({ label: "Back", value: "__back__", color: t.dim });

    const handleSelect = (value: string) => {
      if (value === "__back__" || value === "exit") {
        onBack();
        return;
      }
      if (value === "__new__") {
        setResults([]);
        setQueryText("");
        setView("input");
        return;
      }
      if (value === "__next__") {
        setPage((p) => Math.min(p + 1, totalPages - 1));
        return;
      }
      if (value === "__prev__") {
        setPage((p) => Math.max(p - 1, 0));
        return;
      }
      if (value.startsWith("result:")) {
        const idx = parseInt(value.slice(7), 10);
        if (results[idx]) {
          setSelectedResult(results[idx]);
          setView("detail");
        }
      }
    };

    return (
      <Box flexDirection="column">
        <Section title="Search Results" />
        <KV label="Query" value={t.value(`"${queryText}"`)} />
        <KV label="Results" value={t.value(`${results.length} sources`)} />
        {totalPages > 1 && (
          <KV label="Page" value={t.value(`${page + 1} of ${totalPages}`)} />
        )}
        <Text> </Text>
        <Separator width={60} />
        <Menu items={menuItems} onSelect={handleSelect} />
      </Box>
    );
  }

  /* ── Input view (default) ───────────────────────────────────────── */

  return (
    <Box flexDirection="column">
      <Section title="Search" />
      <Text>{"  " + t.dim("Query your knowledge base. Press Enter to search, Escape to go back.")}</Text>
      <Text> </Text>

      <Box marginLeft={2}>
        <Text>{t.label("Query: ")}</Text>
        <TextInput
          value={queryText}
          onChange={setQueryText}
          onSubmit={handleSubmit}
          placeholder="Type your search query..."
        />
      </Box>

      {error && (
        <>
          <Text> </Text>
          <Text>{"  " + t.err(error)}</Text>
        </>
      )}

      <Text> </Text>
      <Text>{"  " + t.dim("Enter: search  |  Escape: back")}</Text>
    </Box>
  );
}

export default SearchScreen;
export { SearchScreen };
