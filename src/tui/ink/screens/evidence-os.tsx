import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { Menu, Section, Separator, KV, Spinner, t, useInterval, type MenuItem } from "../components.js";
import { getApiBaseUrl, getApiPort } from "../../platform.js";
import { isPortReachable } from "../../runtime-status.js";

/* ── Types ────────────────────────────────────────────────────────── */

interface GraphStats {
  entities: number;
  relations: number;
  mentions: number;
  claims: number;
  decisions: number;
  loops: number;
  attempts: number;
  evidence_events: number;
  dbSizeBytes: number;
}

interface EntityRow {
  id: number;
  name: string;
  display_name: string;
  entity_type: string | null;
  mention_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

interface MentionRow {
  id: number;
  source_type: string;
  source_id: string;
  source_detail: string | null;
  context_terms: string | null;
  actor: string;
  created_at: string;
}

interface TermsData {
  terms: string[];
}

/* ── Module-level cache ───────────────────────────────────────────── */

let cachedGraphStats: GraphStats | null = null;
let cachedEntities: EntityRow[] = [];
let cachedTerms: string[] = [];

/* ── Helpers ──────────────────────────────────────────────────────── */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Screen ───────────────────────────────────────────────────────── */

type Level = "overview" | "entity-detail" | "terms";

const ENTITIES_PER_PAGE = 20;
const MENTIONS_PER_PAGE = 15;

export function EvidenceOsScreen({ onBack }: { onBack: () => void }) {
  const [level, setLevel] = useState<Level>("overview");
  const [graphStats, setGraphStats] = useState<GraphStats | null>(cachedGraphStats);
  const [entities, setEntities] = useState<EntityRow[]>(cachedEntities);
  const [terms, setTerms] = useState<string[]>(cachedTerms);
  const [selectedEntity, setSelectedEntity] = useState<EntityRow | null>(null);
  const [mentions, setMentions] = useState<MentionRow[]>([]);
  const [status, setStatus] = useState("");
  const [online, setOnline] = useState(false);
  const [relationsEnabled, setRelationsEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination
  const [entityPage, setEntityPage] = useState(0);
  const [mentionPage, setMentionPage] = useState(0);

  // Add term
  const [addingTerm, setAddingTerm] = useState(false);
  const [newTermText, setNewTermText] = useState("");

  // Confirm removal
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // Entity detail loading
  const [entityLoading, setEntityLoading] = useState(false);

  const fetchData = async () => {
    const up = await isPortReachable(getApiPort());
    setOnline(up);
    if (!up) return;

    try {
      // Fetch stats
      const statsRes = await fetch(`${getApiBaseUrl()}/stats`, { signal: AbortSignal.timeout(3000) });
      if (statsRes.ok) {
        const data = await statsRes.json() as { graphStats?: GraphStats | null };
        if (data.graphStats) {
          cachedGraphStats = data.graphStats;
          setGraphStats(data.graphStats);
          setRelationsEnabled(true);
        } else {
          setRelationsEnabled(false);
        }
      }

      // Fetch entities
      const entRes = await fetch(`${getApiBaseUrl()}/graph/entities?limit=50`, { signal: AbortSignal.timeout(3000) });
      if (entRes.ok) {
        const data = await entRes.json() as { entities: EntityRow[] };
        cachedEntities = data.entities;
        setEntities(data.entities);
      }

      // Fetch terms
      const termsRes = await fetch(`${getApiBaseUrl()}/graph/terms`, { signal: AbortSignal.timeout(3000) });
      if (termsRes.ok) {
        const data = await termsRes.json() as TermsData;
        cachedTerms = data.terms;
        setTerms(data.terms);
      }
    } catch (err) {
      setError(`Failed to fetch data: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => { fetchData(); }, []);
  useInterval(() => { if (level === "overview") fetchData(); }, 5000);

  const fetchEntityDetail = async (entity: EntityRow) => {
    setSelectedEntity(entity);
    setMentions([]);
    setMentionPage(0);
    setEntityLoading(true);
    setLevel("entity-detail");
    try {
      const res = await fetch(`${getApiBaseUrl()}/graph/entities/${entity.id}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as { mentions: MentionRow[] };
        setMentions(data.mentions);
      }
    } catch (err) {
      setError(`Failed to fetch entity details: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setEntityLoading(false);
    }
  };

  const removeTerm = async (term: string) => {
    const updated = terms.filter((t) => t !== term);
    try {
      const res = await fetch(`${getApiBaseUrl()}/graph/terms`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms: updated }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        cachedTerms = updated;
        setTerms(updated);
        setStatus(`Removed "${term}"`);
      } else {
        setStatus(`Failed to remove "${term}"`);
      }
    } catch (err) {
      setError(`Failed to remove term: ${err instanceof Error ? err.message : String(err)}`);
      setStatus(`Failed to remove "${term}"`);
    }
  };

  const addTerm = async (term: string) => {
    const trimmed = term.trim();
    if (!trimmed || terms.includes(trimmed)) {
      setAddingTerm(false);
      setNewTermText("");
      return;
    }
    const updated = [...terms, trimmed];
    try {
      const res = await fetch(`${getApiBaseUrl()}/graph/terms`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms: updated }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        cachedTerms = updated;
        setTerms(updated);
        setStatus(`Added "${trimmed}"`);
      } else {
        setStatus(`Failed to add "${trimmed}"`);
      }
    } catch (err) {
      setError(`Failed to add term: ${err instanceof Error ? err.message : String(err)}`);
      setStatus(`Failed to add "${trimmed}"`);
    }
    setAddingTerm(false);
    setNewTermText("");
  };

  // ── Overview ──
  if (level === "overview") {
    if (!online) {
      return (
        <Box flexDirection="column">
          <Section title="Evidence OS" />
          <Text>{"  " + t.dim("Start services to view Evidence OS data")}</Text>
          {error && <Text>{"  " + t.err(error)}</Text>}
          <Separator />
          <Menu items={[{ label: "Back", value: "__back__", color: t.dim }]} onSelect={onBack} />
        </Box>
      );
    }

    if (!relationsEnabled) {
      return (
        <Box flexDirection="column">
          <Section title="Evidence OS" />
          <Text>{"  " + t.warn("Relations are not enabled.")}</Text>
          <Text>{"  " + t.dim("Enable in Configure \u2192 Evidence OS, or set THREADCLAW_RELATIONS_ENABLED=true in .env")}</Text>
          {error && <Text>{"  " + t.err(error)}</Text>}
          <Separator />
          <Menu items={[{ label: "Back", value: "__back__", color: t.dim }]} onSelect={onBack} />
        </Box>
      );
    }

    const totalEntityPages = Math.max(1, Math.ceil(entities.length / ENTITIES_PER_PAGE));
    const pageStart = entityPage * ENTITIES_PER_PAGE;
    const pageEnd = pageStart + ENTITIES_PER_PAGE;
    const pageEntities = entities.slice(pageStart, pageEnd);
    const remainingAfterPage = entities.length - pageEnd;

    const items: MenuItem[] = [];

    // Entity list (paginated)
    for (const ent of pageEntities) {
      const typeTag = ent.entity_type ? t.dim(` [${ent.entity_type}]`) : "";
      items.push({
        label: `${ent.display_name}${typeTag}`,
        value: `entity:${ent.id}`,
        description: `${ent.mention_count} mentions`,
      });
    }

    // Pagination controls
    if (entityPage > 0) {
      items.push({ label: "\u2190 Previous page", value: "__prev_entity_page__" });
    }
    if (entityPage < totalEntityPages - 1) {
      items.push({ label: "Next page \u2192", value: "__next_entity_page__" });
    }

    items.push({ label: "Terms List", value: "terms", description: `${terms.length} terms` });
    items.push({ label: "Back", value: "__back__", color: t.dim });

    return (
      <Box flexDirection="column">
        <Section title="Evidence OS" />
        {graphStats ? (
          <Box flexDirection="row" gap={4}>
            <Box flexDirection="column">
              <KV label="Entities" value={String(graphStats.entities)} />
              <KV label="Relations" value={String(graphStats.relations)} />
              <KV label="Mentions" value={String(graphStats.mentions)} />
              <KV label="Claims" value={String(graphStats.claims)} />
              <KV label="Decisions" value={String(graphStats.decisions)} />
            </Box>
            <Box flexDirection="column">
              <KV label="Loops" value={String(graphStats.loops)} />
              <KV label="Attempts" value={String(graphStats.attempts)} />
              <KV label="Evidence Events" value={String(graphStats.evidence_events)} />
              <KV label="DB Size" value={formatBytes(graphStats.dbSizeBytes)} />
            </Box>
          </Box>
        ) : (
          <Text>{"  " + t.dim("Loading...")}</Text>
        )}
        {entities.length > ENTITIES_PER_PAGE && (
          <Text>{"  " + t.dim(`Page ${entityPage + 1} of ${totalEntityPages}`)}</Text>
        )}
        {error && <Text>{"  " + t.err(error)}</Text>}
        {status && <Text>{"  " + (status.startsWith("Failed") ? t.err(status) : t.ok(status))}</Text>}
        {remainingAfterPage > 0 && entityPage === totalEntityPages - 1 ? null : null}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "__back__") return onBack();
          if (value === "terms") { setLevel("terms"); return; }
          if (value === "__prev_entity_page__") { setEntityPage(Math.max(0, entityPage - 1)); return; }
          if (value === "__next_entity_page__") { setEntityPage(Math.min(totalEntityPages - 1, entityPage + 1)); return; }
          if (value.startsWith("entity:")) {
            const id = parseInt(value.slice(7), 10);
            const ent = entities.find((e) => e.id === id);
            if (ent) fetchEntityDetail(ent);
          }
        }} />
      </Box>
    );
  }

  // ── Entity Detail ──
  if (level === "entity-detail" && selectedEntity) {
    const totalMentionPages = Math.max(1, Math.ceil(mentions.length / MENTIONS_PER_PAGE));
    const mStart = mentionPage * MENTIONS_PER_PAGE;
    const mEnd = mStart + MENTIONS_PER_PAGE;
    const pageMentions = mentions.slice(mStart, mEnd);

    const items: MenuItem[] = [];
    if (mentionPage > 0) {
      items.push({ label: "\u2190 Previous page", value: "__prev_mention_page__" });
    }
    if (mentionPage < totalMentionPages - 1) {
      items.push({ label: "Next page \u2192", value: "__next_mention_page__" });
    }
    items.push({ label: "Back", value: "__back__", color: t.dim });

    return (
      <Box flexDirection="column">
        <Section title={selectedEntity.display_name} />
        {entityLoading ? (
          <Spinner label="Loading..." />
        ) : (
          <>
            <KV label="Name" value={selectedEntity.name} />
            {selectedEntity.entity_type && <KV label="Type" value={selectedEntity.entity_type} />}
            <KV label="Mentions" value={String(selectedEntity.mention_count)} />
            <KV label="First Seen" value={selectedEntity.first_seen_at} />
            <KV label="Last Seen" value={selectedEntity.last_seen_at} />

            {mentions.length > 0 && (
              <>
                <Text>{" "}</Text>
                <Text>{"  " + t.title("Recent Mentions")}</Text>
                {pageMentions.map((m) => {
                  const source = m.source_detail
                    ? `${m.source_type}:${m.source_id} (${m.source_detail})`
                    : `${m.source_type}:${m.source_id}`;
                  return (
                    <Text key={m.id}>{"    " + t.dim("\u2022") + " " + t.value(source) + "  " + t.dim(m.created_at.slice(0, 10))}</Text>
                  );
                })}
                {mentions.length > MENTIONS_PER_PAGE && (
                  <Text>{"  " + t.dim(`Page ${mentionPage + 1} of ${totalMentionPages}`)}</Text>
                )}
              </>
            )}
          </>
        )}
        {error && <Text>{"  " + t.err(error)}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "__back__") { setLevel("overview"); return; }
          if (value === "__prev_mention_page__") { setMentionPage(Math.max(0, mentionPage - 1)); return; }
          if (value === "__next_mention_page__") { setMentionPage(Math.min(totalMentionPages - 1, mentionPage + 1)); return; }
        }} />
      </Box>
    );
  }

  // ── Terms List ──
  if (level === "terms") {
    // Adding a new term
    if (addingTerm) {
      return (
        <Box flexDirection="column">
          <Section title="Add Term" />
          <Text>{"  " + t.dim("Enter a new term and press Enter:")}</Text>
          <Box marginLeft={2}>
            <Text>{"  > "}</Text>
            <TextInput
              value={newTermText}
              onChange={setNewTermText}
              onSubmit={(value: string) => addTerm(value)}
            />
          </Box>
          <Text>{"  " + t.dim("Press Escape or submit empty to cancel")}</Text>
        </Box>
      );
    }

    // Confirm removal
    if (confirmRemove) {
      const confirmItems: MenuItem[] = [
        { label: `Yes, remove "${confirmRemove}"`, value: "confirm" },
        { label: "Cancel", value: "cancel" },
      ];
      return (
        <Box flexDirection="column">
          <Section title="Confirm Removal" />
          <Text>{"  " + t.warn(`Remove term "${confirmRemove}"?`)}</Text>
          <Separator />
          <Menu items={confirmItems} onSelect={(value) => {
            if (value === "confirm") {
              removeTerm(confirmRemove);
            }
            setConfirmRemove(null);
          }} />
        </Box>
      );
    }

    const items: MenuItem[] = [
      { label: "+ Add Term", value: "__add_term__" },
    ];
    for (const term of terms) {
      items.push({
        label: term,
        value: `remove:${term}`,
        description: "select to remove",
      });
    }
    items.push({ label: "Back", value: "__back__", color: t.dim });

    return (
      <Box flexDirection="column">
        <Section title="Entity Terms List" />
        <Text>{"  " + t.dim("Terms are matched with high confidence (0.9) during entity extraction.")}</Text>
        <Text>{"  " + t.dim(`File: ~/.threadclaw/relations-terms.json`)}</Text>
        <KV label="Terms" value={String(terms.length)} />
        {error && <Text>{"  " + t.err(error)}</Text>}
        {status && <Text>{"  " + (status.startsWith("Failed") ? t.err(status) : t.ok(status))}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "__back__") { setStatus(""); setLevel("overview"); return; }
          if (value === "__add_term__") { setAddingTerm(true); setNewTermText(""); return; }
          if (value.startsWith("remove:")) {
            setConfirmRemove(value.slice(7));
          }
        }} />
      </Box>
    );
  }

  return null;
}
