import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Menu, Section, Separator, KV, t, useInterval, type MenuItem } from "../components.js";
import { getApiBaseUrl, getApiPort } from "../../platform.js";
import { isPortReachable } from "../../runtime-status.js";

/* ── Types ────────────────────────────────────────────────────────── */

interface GraphStats {
  entities: number;
  mentions: number;
  evidenceEvents: number;
  graphDbSizeMB: number;
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

/* ── Screen ───────────────────────────────────────────────────────── */

type Level = "overview" | "entity-detail" | "terms";

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
  const [, setTick] = useState(0);

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
    } catch {}
  };

  useEffect(() => { fetchData(); }, []);
  useInterval(() => { if (level === "overview") fetchData(); }, 5000);

  const fetchEntityDetail = async (entity: EntityRow) => {
    setSelectedEntity(entity);
    setMentions([]);
    setLevel("entity-detail");
    try {
      const res = await fetch(`${getApiBaseUrl()}/graph/entities/${entity.id}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as { mentions: MentionRow[] };
        setMentions(data.mentions);
      }
    } catch {}
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
    } catch {
      setStatus(`Failed to remove "${term}"`);
    }
  };

  // ── Overview ──
  if (level === "overview") {
    if (!online) {
      return (
        <Box flexDirection="column">
          <Section title="Evidence OS" />
          <Text>{"  " + t.dim("Start services to view Evidence OS data")}</Text>
          <Separator />
          <Menu items={[{ label: "← Back", value: "back" }]} onSelect={onBack} />
        </Box>
      );
    }

    if (!relationsEnabled) {
      return (
        <Box flexDirection="column">
          <Section title="Evidence OS" />
          <Text>{"  " + t.warn("Relations are not enabled.")}</Text>
          <Text>{"  " + t.dim("Enable in Configure → Evidence OS, or set CLAWCORE_RELATIONS_ENABLED=true in .env")}</Text>
          <Separator />
          <Menu items={[{ label: "← Back", value: "back" }]} onSelect={onBack} />
        </Box>
      );
    }

    const items: MenuItem[] = [];

    // Entity list
    for (const ent of entities.slice(0, 20)) {
      const typeTag = ent.entity_type ? t.dim(` [${ent.entity_type}]`) : "";
      items.push({
        label: `${ent.display_name}${typeTag}`,
        value: `entity:${ent.id}`,
        description: `${ent.mention_count} mentions`,
      });
    }

    if (entities.length > 20) {
      items.push({ label: t.dim(`... and ${entities.length - 20} more`), value: "__noop__" });
    }

    items.push({ label: "Terms List", value: "terms", description: `${terms.length} terms` });
    items.push({ label: "← Back", value: "back" });

    return (
      <Box flexDirection="column">
        <Section title="Evidence OS" />
        {graphStats ? (
          <>
            <KV label="Entities" value={String(graphStats.entities)} />
            <KV label="Mentions" value={String(graphStats.mentions)} />
            <KV label="Evidence Events" value={String(graphStats.evidenceEvents)} />
            <KV label="Graph DB Size" value={`${graphStats.graphDbSizeMB} MB`} />
          </>
        ) : (
          <Text>{"  " + t.dim("Loading...")}</Text>
        )}
        {status && <Text>{"  " + (status.startsWith("Failed") ? t.err(status) : t.ok(status))}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "back") return onBack();
          if (value === "terms") { setLevel("terms"); return; }
          if (value === "__noop__") return;
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
    const items: MenuItem[] = [{ label: "← Back", value: "back" }];

    return (
      <Box flexDirection="column">
        <Section title={selectedEntity.display_name} />
        <KV label="Name" value={selectedEntity.name} />
        {selectedEntity.entity_type && <KV label="Type" value={selectedEntity.entity_type} />}
        <KV label="Mentions" value={String(selectedEntity.mention_count)} />
        <KV label="First Seen" value={selectedEntity.first_seen_at} />
        <KV label="Last Seen" value={selectedEntity.last_seen_at} />

        {mentions.length > 0 && (
          <>
            <Text>{" "}</Text>
            <Text>{"  " + t.title("Recent Mentions")}</Text>
            {mentions.slice(0, 15).map((m) => {
              const source = m.source_detail
                ? `${m.source_type}:${m.source_id} (${m.source_detail})`
                : `${m.source_type}:${m.source_id}`;
              return (
                <Text key={m.id}>{"    " + t.dim("•") + " " + t.value(source) + "  " + t.dim(m.created_at.slice(0, 10))}</Text>
              );
            })}
            {mentions.length > 15 && <Text>{"    " + t.dim(`... and ${mentions.length - 15} more`)}</Text>}
          </>
        )}
        <Separator />
        <Menu items={items} onSelect={() => setLevel("overview")} />
      </Box>
    );
  }

  // ── Terms List ──
  if (level === "terms") {
    const items: MenuItem[] = terms.map((term) => ({
      label: term,
      value: `remove:${term}`,
      description: "select to remove",
    }));
    items.push({ label: "← Back", value: "back" });

    return (
      <Box flexDirection="column">
        <Section title="Entity Terms List" />
        <Text>{"  " + t.dim("Terms are matched with high confidence (0.9) during entity extraction.")}</Text>
        <Text>{"  " + t.dim(`File: ~/.clawcore/relations-terms.json`)}</Text>
        <KV label="Terms" value={String(terms.length)} />
        {status && <Text>{"  " + (status.startsWith("Failed") ? t.err(status) : t.ok(status))}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "back") { setStatus(""); setLevel("overview"); return; }
          if (value.startsWith("remove:")) {
            removeTerm(value.slice(7));
          }
        }} />
      </Box>
    );
  }

  return null;
}
