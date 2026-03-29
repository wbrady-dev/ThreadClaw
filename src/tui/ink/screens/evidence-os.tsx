import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { Menu, Section, Separator, KV, Spinner, t, useInterval, type MenuItem } from "../components.js";
import { getApiBaseUrl, getApiPort } from "../../platform.js";
import { isPortReachable } from "../../runtime-status.js";
import * as store from "../../store.js";

/* ── Types ────────────────────────────────────────────────────────── */

interface GraphStats {
  entities: number;
  relations: number;
  mentions: number;
  claims: number;
  decisions: number;
  loops: number;
  attempts: number;
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
  source_ref: string;
  source_detail: string | null;
  context_terms: string | null;
  actor: string;
  created_at: string;
}

interface TermsData {
  terms: string[];
}

interface ClaimRow {
  id: number;
  composite_id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  status: string;
  scope_id: string | null;
  created_at: string;
  last_observed_at: string;
}

interface DecisionRow {
  id: number;
  composite_id: string;
  title: string;
  outcome: string;
  rationale: string | null;
  scope_id: string | null;
  created_at: string;
  last_observed_at: string;
}

interface LoopRow {
  id: number;
  composite_id: string;
  question: string;
  status: string;
  opened_by: string | null;
  resolution: string | null;
  created_at: string;
  last_observed_at: string;
}

interface ProvenanceRow {
  id: number;
  subject_id: string;
  predicate: string;
  object_id: string;
  confidence: number;
  created_at: string;
}

/* ── Store-backed cache ───────────────────────────────────────────── */

/* ── Screen ───────────────────────────────────────────────────────── */

type Level = "overview" | "entity-detail" | "terms"
  | "claims" | "claim-detail"
  | "decisions" | "decision-detail"
  | "loops" | "loop-detail";

const ENTITIES_PER_PAGE = 20;
const MENTIONS_PER_PAGE = 15;
const ITEMS_PER_PAGE = 20;

export function EvidenceOsScreen({ onBack }: { onBack: () => void }) {
  const [level, setLevel] = useState<Level>("overview");
  const [graphStats, setGraphStats] = useState<GraphStats | null>(store.get<GraphStats>("graphStats") ?? null);
  const [entities, setEntities] = useState<EntityRow[]>(store.get<EntityRow[]>("entities") ?? []);
  const [terms, setTerms] = useState<string[]>(store.get<string[]>("terms") ?? []);
  const [selectedEntity, setSelectedEntity] = useState<EntityRow | null>(null);
  const [mentions, setMentions] = useState<MentionRow[]>([]);
  const [status, setStatus] = useState("");
  const [online, setOnline] = useState(false);
  const [relationsEnabled, setRelationsEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Entity pagination
  const [entityPage, setEntityPage] = useState(0);
  const [entityOffset, setEntityOffset] = useState(0);
  const [entityTotal, setEntityTotal] = useState(0);
  const [mentionPage, setMentionPage] = useState(0);

  // Add term
  const [addingTerm, setAddingTerm] = useState(false);
  const [newTermText, setNewTermText] = useState("");

  // Confirm removal
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // Entity detail loading
  const [entityLoading, setEntityLoading] = useState(false);

  // Claims state
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [claimPage, setClaimPage] = useState(0);
  const [claimOffset, setClaimOffset] = useState(0);
  const [claimTotal, setClaimTotal] = useState(0);
  const [selectedClaim, setSelectedClaim] = useState<ClaimRow | null>(null);
  const [claimProvenance, setClaimProvenance] = useState<ProvenanceRow[]>([]);
  const [claimLoading, setClaimLoading] = useState(false);

  // Decisions state
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [decisionPage, setDecisionPage] = useState(0);
  const [decisionOffset, setDecisionOffset] = useState(0);
  const [decisionTotal, setDecisionTotal] = useState(0);
  const [selectedDecision, setSelectedDecision] = useState<DecisionRow | null>(null);
  const [decisionProvenance, setDecisionProvenance] = useState<ProvenanceRow[]>([]);
  const [decisionLoading, setDecisionLoading] = useState(false);

  // Loops state
  const [loops, setLoops] = useState<LoopRow[]>([]);
  const [loopPage, setLoopPage] = useState(0);
  const [loopOffset, setLoopOffset] = useState(0);
  const [loopTotal, setLoopTotal] = useState(0);
  const [selectedLoop, setSelectedLoop] = useState<LoopRow | null>(null);
  const [loopProvenance, setLoopProvenance] = useState<ProvenanceRow[]>([]);
  const [loopLoading, setLoopLoading] = useState(false);

  // Escape key cancels "Add Term" input
  useInput((_input, key) => {
    if (key.escape && addingTerm) {
      setAddingTerm(false);
      setNewTermText("");
    }
  });

  const fetchData = async () => {
    const up = await isPortReachable(getApiPort());
    setOnline(up);
    if (!up) return;

    try {
      setError(null);

      // Fetch stats
      const statsRes = await fetch(`${getApiBaseUrl()}/stats`, { signal: AbortSignal.timeout(3000) });
      if (statsRes.ok) {
        const data = await statsRes.json() as { graphStats?: GraphStats | null };
        if (data.graphStats) {
          store.set("graphStats", data.graphStats);
          setGraphStats(data.graphStats);
          setRelationsEnabled(true);
        } else {
          setRelationsEnabled(false);
        }
      }

      // Fetch entities (server-side pagination)
      const entLimit = ENTITIES_PER_PAGE;
      const entOffset = entityOffset;
      const entRes = await fetch(`${getApiBaseUrl()}/graph/entities?limit=${entLimit}&offset=${entOffset}`, { signal: AbortSignal.timeout(3000) });
      if (entRes.ok) {
        const data = await entRes.json() as { entities: EntityRow[]; total: number };
        store.set("entities", data.entities);
        setEntities(data.entities);
        if (typeof data.total === "number") setEntityTotal(data.total);
      }

      // Fetch terms
      const termsRes = await fetch(`${getApiBaseUrl()}/graph/terms`, { signal: AbortSignal.timeout(3000) });
      if (termsRes.ok) {
        const data = await termsRes.json() as TermsData;
        store.set("terms", data.terms);
        setTerms(data.terms);
      }
    } catch (err) {
      setError(`Failed to fetch data: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => { fetchData(); }, []);
  useEffect(() => { fetchData(); }, [entityOffset]);
  useInterval(() => { if (level === "overview") fetchData(); }, 5000);

  const fetchEntityDetail = async (entity: EntityRow) => {
    setSelectedEntity(entity);
    setMentions([]);
    setMentionPage(0);
    setEntityLoading(true);
    setLevel("entity-detail");
    try {
      setError(null);
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

  /* ── Claims fetch ── */

  const fetchClaims = async () => {
    try {
      setError(null);
      const res = await fetch(`${getApiBaseUrl()}/graph/claims?limit=${ITEMS_PER_PAGE}&offset=${claimOffset}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as { claims: ClaimRow[]; total: number };
        setClaims(data.claims);
        if (typeof data.total === "number") setClaimTotal(data.total);
      }
    } catch (err) {
      setError(`Failed to fetch claims: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const fetchClaimDetail = async (claim: ClaimRow) => {
    setSelectedClaim(claim);
    setClaimProvenance([]);
    setClaimLoading(true);
    setLevel("claim-detail");
    try {
      setError(null);
      const res = await fetch(`${getApiBaseUrl()}/graph/claims/${claim.id}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as { provenance: ProvenanceRow[] };
        setClaimProvenance(data.provenance ?? []);
      }
    } catch (err) {
      setError(`Failed to fetch claim details: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClaimLoading(false);
    }
  };

  /* ── Decisions fetch ── */

  const fetchDecisions = async () => {
    try {
      setError(null);
      const res = await fetch(`${getApiBaseUrl()}/graph/decisions?limit=${ITEMS_PER_PAGE}&offset=${decisionOffset}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as { decisions: DecisionRow[]; total: number };
        setDecisions(data.decisions);
        if (typeof data.total === "number") setDecisionTotal(data.total);
      }
    } catch (err) {
      setError(`Failed to fetch decisions: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const fetchDecisionDetail = async (decision: DecisionRow) => {
    setSelectedDecision(decision);
    setDecisionProvenance([]);
    setDecisionLoading(true);
    setLevel("decision-detail");
    try {
      setError(null);
      const res = await fetch(`${getApiBaseUrl()}/graph/decisions/${decision.id}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as { provenance: ProvenanceRow[] };
        setDecisionProvenance(data.provenance ?? []);
      }
    } catch (err) {
      setError(`Failed to fetch decision details: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDecisionLoading(false);
    }
  };

  /* ── Loops fetch ── */

  const fetchLoops = async () => {
    try {
      setError(null);
      const res = await fetch(`${getApiBaseUrl()}/graph/loops?limit=${ITEMS_PER_PAGE}&offset=${loopOffset}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as { loops: LoopRow[]; total: number };
        setLoops(data.loops);
        if (typeof data.total === "number") setLoopTotal(data.total);
      }
    } catch (err) {
      setError(`Failed to fetch loops: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const fetchLoopDetail = async (loop: LoopRow) => {
    setSelectedLoop(loop);
    setLoopProvenance([]);
    setLoopLoading(true);
    setLevel("loop-detail");
    try {
      setError(null);
      const res = await fetch(`${getApiBaseUrl()}/graph/loops/${loop.id}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as { provenance: ProvenanceRow[] };
        setLoopProvenance(data.provenance ?? []);
      }
    } catch (err) {
      setError(`Failed to fetch loop details: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoopLoading(false);
    }
  };

  // Refetch claims/decisions/loops when their offsets change
  useEffect(() => { if (level === "claims") fetchClaims(); }, [claimOffset]);
  useEffect(() => { if (level === "decisions") fetchDecisions(); }, [decisionOffset]);
  useEffect(() => { if (level === "loops") fetchLoops(); }, [loopOffset]);

  const removeTerm = async (term: string) => {
    const updated = terms.filter((item) => item !== term);
    try {
      const res = await fetch(`${getApiBaseUrl()}/graph/terms`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms: updated }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        store.set("terms", updated);
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
        store.set("terms", updated);
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

    const totalEntityPages = Math.max(1, Math.ceil(entityTotal / ENTITIES_PER_PAGE));

    const items: MenuItem[] = [];

    // Entity list (already server-paginated)
    for (const ent of entities) {
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

    items.push({ label: "Claims", value: "claims", description: `${graphStats?.claims ?? 0}` });
    items.push({ label: "Decisions", value: "decisions", description: `${graphStats?.decisions ?? 0}` });
    items.push({ label: "Loops", value: "loops", description: `${graphStats?.loops ?? 0}` });
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
              <KV label="Evidence Events" value={String(graphStats.evidenceEvents)} />
              <KV label="DB Size" value={`${(graphStats.graphDbSizeMB ?? 0).toFixed(1)} MB`} />
            </Box>
          </Box>
        ) : (
          <Text>{"  " + t.dim("Loading...")}</Text>
        )}
        {entityTotal > ENTITIES_PER_PAGE && (
          <Text>{"  " + t.dim(`Page ${entityPage + 1} of ${totalEntityPages} (${entityTotal} entities)`)}</Text>
        )}
        {error && <Text>{"  " + t.err(error)}</Text>}
        {status && <Text>{"  " + (status.startsWith("Failed") ? t.err(status) : t.ok(status))}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "__back__") return onBack();
          if (value === "claims") { setError(null); setStatus(""); setClaimPage(0); setClaimOffset(0); fetchClaims(); setLevel("claims"); return; }
          if (value === "decisions") { setError(null); setStatus(""); setDecisionPage(0); setDecisionOffset(0); fetchDecisions(); setLevel("decisions"); return; }
          if (value === "loops") { setError(null); setStatus(""); setLoopPage(0); setLoopOffset(0); fetchLoops(); setLevel("loops"); return; }
          if (value === "terms") { setError(null); setStatus(""); setLevel("terms"); return; }
          if (value === "__prev_entity_page__") {
            const newPage = Math.max(0, entityPage - 1);
            setEntityPage(newPage);
            setEntityOffset(newPage * ENTITIES_PER_PAGE);
            return;
          }
          if (value === "__next_entity_page__") {
            const newPage = Math.min(totalEntityPages - 1, entityPage + 1);
            setEntityPage(newPage);
            setEntityOffset(newPage * ENTITIES_PER_PAGE);
            return;
          }
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
                    ? `${m.source_ref} (${m.source_detail})`
                    : m.source_ref;
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

  // ── Claims List ──
  if (level === "claims") {
    const totalClaimPages = Math.max(1, Math.ceil(claimTotal / ITEMS_PER_PAGE));

    const items: MenuItem[] = [];
    for (const claim of claims) {
      const conf = claim.confidence != null ? t.dim(` [${(claim.confidence * 100).toFixed(0)}%]`) : "";
      items.push({
        label: `${claim.subject} ${claim.predicate} ${claim.object}${conf}`,
        value: `claim:${claim.id}`,
        description: claim.status,
      });
    }

    if (claimPage > 0) {
      items.push({ label: "\u2190 Previous page", value: "__prev_claim_page__" });
    }
    if (claimPage < totalClaimPages - 1) {
      items.push({ label: "Next page \u2192", value: "__next_claim_page__" });
    }
    items.push({ label: "Back", value: "__back__", color: t.dim });

    return (
      <Box flexDirection="column">
        <Section title="Claims" />
        <KV label="Total" value={String(claimTotal)} />
        {claimTotal > ITEMS_PER_PAGE && (
          <Text>{"  " + t.dim(`Page ${claimPage + 1} of ${totalClaimPages}`)}</Text>
        )}
        {error && <Text>{"  " + t.err(error)}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "__back__") { setLevel("overview"); return; }
          if (value === "__prev_claim_page__") {
            const newPage = Math.max(0, claimPage - 1);
            setClaimPage(newPage);
            setClaimOffset(newPage * ITEMS_PER_PAGE);
            return;
          }
          if (value === "__next_claim_page__") {
            const newPage = Math.min(totalClaimPages - 1, claimPage + 1);
            setClaimPage(newPage);
            setClaimOffset(newPage * ITEMS_PER_PAGE);
            return;
          }
          if (value.startsWith("claim:")) {
            const id = parseInt(value.slice(6), 10);
            const claim = claims.find((c) => c.id === id);
            if (claim) fetchClaimDetail(claim);
          }
        }} />
      </Box>
    );
  }

  // ── Claim Detail ──
  if (level === "claim-detail" && selectedClaim) {
    const items: MenuItem[] = [];
    items.push({ label: "Back", value: "__back__", color: t.dim });

    return (
      <Box flexDirection="column">
        <Section title="Claim Detail" />
        {claimLoading ? (
          <Spinner label="Loading..." />
        ) : (
          <>
            <KV label="Subject" value={selectedClaim.subject} />
            <KV label="Predicate" value={selectedClaim.predicate} />
            <KV label="Object" value={selectedClaim.object} />
            <KV label="Confidence" value={selectedClaim.confidence != null ? `${(selectedClaim.confidence * 100).toFixed(0)}%` : "unknown"} />
            <KV label="Status" value={selectedClaim.status} />
            {selectedClaim.scope_id && <KV label="Scope" value={selectedClaim.scope_id} />}
            <KV label="Created" value={selectedClaim.created_at} />
            <KV label="Last Observed" value={selectedClaim.last_observed_at} />

            {claimProvenance.length > 0 && (
              <>
                <Text>{" "}</Text>
                <Text>{"  " + t.title("Provenance")}</Text>
                {claimProvenance.map((p) => (
                  <Text key={p.id}>{"    " + t.dim("\u2022") + " " + t.value(`${p.subject_id} ${p.predicate} ${p.object_id}`) + "  " + t.dim(`conf=${p.confidence != null ? (p.confidence * 100).toFixed(0) : "?"}%`) + "  " + t.dim(p.created_at.slice(0, 10))}</Text>
                ))}
              </>
            )}
          </>
        )}
        {error && <Text>{"  " + t.err(error)}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "__back__") { setLevel("claims"); return; }
        }} />
      </Box>
    );
  }

  // ── Decisions List ──
  if (level === "decisions") {
    const totalDecisionPages = Math.max(1, Math.ceil(decisionTotal / ITEMS_PER_PAGE));

    const items: MenuItem[] = [];
    for (const decision of decisions) {
      const preview = decision.outcome.length > 60 ? decision.outcome.slice(0, 57) + "..." : decision.outcome;
      items.push({
        label: decision.title,
        value: `decision:${decision.id}`,
        description: preview,
      });
    }

    if (decisionPage > 0) {
      items.push({ label: "\u2190 Previous page", value: "__prev_decision_page__" });
    }
    if (decisionPage < totalDecisionPages - 1) {
      items.push({ label: "Next page \u2192", value: "__next_decision_page__" });
    }
    items.push({ label: "Back", value: "__back__", color: t.dim });

    return (
      <Box flexDirection="column">
        <Section title="Decisions" />
        <KV label="Total" value={String(decisionTotal)} />
        {decisionTotal > ITEMS_PER_PAGE && (
          <Text>{"  " + t.dim(`Page ${decisionPage + 1} of ${totalDecisionPages}`)}</Text>
        )}
        {error && <Text>{"  " + t.err(error)}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "__back__") { setLevel("overview"); return; }
          if (value === "__prev_decision_page__") {
            const newPage = Math.max(0, decisionPage - 1);
            setDecisionPage(newPage);
            setDecisionOffset(newPage * ITEMS_PER_PAGE);
            return;
          }
          if (value === "__next_decision_page__") {
            const newPage = Math.min(totalDecisionPages - 1, decisionPage + 1);
            setDecisionPage(newPage);
            setDecisionOffset(newPage * ITEMS_PER_PAGE);
            return;
          }
          if (value.startsWith("decision:")) {
            const id = parseInt(value.slice(9), 10);
            const dec = decisions.find((d) => d.id === id);
            if (dec) fetchDecisionDetail(dec);
          }
        }} />
      </Box>
    );
  }

  // ── Decision Detail ──
  if (level === "decision-detail" && selectedDecision) {
    const items: MenuItem[] = [];
    items.push({ label: "Back", value: "__back__", color: t.dim });

    return (
      <Box flexDirection="column">
        <Section title="Decision Detail" />
        {decisionLoading ? (
          <Spinner label="Loading..." />
        ) : (
          <>
            <KV label="Title" value={selectedDecision.title} />
            <KV label="Outcome" value={selectedDecision.outcome} />
            {selectedDecision.rationale && <KV label="Rationale" value={selectedDecision.rationale} />}
            {selectedDecision.scope_id && <KV label="Scope" value={selectedDecision.scope_id} />}
            <KV label="Created" value={selectedDecision.created_at} />
            <KV label="Last Observed" value={selectedDecision.last_observed_at} />

            {decisionProvenance.length > 0 && (
              <>
                <Text>{" "}</Text>
                <Text>{"  " + t.title("Provenance")}</Text>
                {decisionProvenance.map((p) => (
                  <Text key={p.id}>{"    " + t.dim("\u2022") + " " + t.value(`${p.subject_id} ${p.predicate} ${p.object_id}`) + "  " + t.dim(`conf=${p.confidence != null ? (p.confidence * 100).toFixed(0) : "?"}%`) + "  " + t.dim(p.created_at.slice(0, 10))}</Text>
                ))}
              </>
            )}
          </>
        )}
        {error && <Text>{"  " + t.err(error)}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "__back__") { setLevel("decisions"); return; }
        }} />
      </Box>
    );
  }

  // ── Loops List ──
  if (level === "loops") {
    const totalLoopPages = Math.max(1, Math.ceil(loopTotal / ITEMS_PER_PAGE));

    const items: MenuItem[] = [];
    for (const loop of loops) {
      items.push({
        label: loop.question,
        value: `loop:${loop.id}`,
        description: loop.status,
      });
    }

    if (loopPage > 0) {
      items.push({ label: "\u2190 Previous page", value: "__prev_loop_page__" });
    }
    if (loopPage < totalLoopPages - 1) {
      items.push({ label: "Next page \u2192", value: "__next_loop_page__" });
    }
    items.push({ label: "Back", value: "__back__", color: t.dim });

    return (
      <Box flexDirection="column">
        <Section title="Loops" />
        <KV label="Total" value={String(loopTotal)} />
        {loopTotal > ITEMS_PER_PAGE && (
          <Text>{"  " + t.dim(`Page ${loopPage + 1} of ${totalLoopPages}`)}</Text>
        )}
        {error && <Text>{"  " + t.err(error)}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "__back__") { setLevel("overview"); return; }
          if (value === "__prev_loop_page__") {
            const newPage = Math.max(0, loopPage - 1);
            setLoopPage(newPage);
            setLoopOffset(newPage * ITEMS_PER_PAGE);
            return;
          }
          if (value === "__next_loop_page__") {
            const newPage = Math.min(totalLoopPages - 1, loopPage + 1);
            setLoopPage(newPage);
            setLoopOffset(newPage * ITEMS_PER_PAGE);
            return;
          }
          if (value.startsWith("loop:")) {
            const id = parseInt(value.slice(5), 10);
            const lp = loops.find((l) => l.id === id);
            if (lp) fetchLoopDetail(lp);
          }
        }} />
      </Box>
    );
  }

  // ── Loop Detail ──
  if (level === "loop-detail" && selectedLoop) {
    const items: MenuItem[] = [];
    items.push({ label: "Back", value: "__back__", color: t.dim });

    return (
      <Box flexDirection="column">
        <Section title="Loop Detail" />
        {loopLoading ? (
          <Spinner label="Loading..." />
        ) : (
          <>
            <KV label="Question" value={selectedLoop.question} />
            <KV label="Status" value={selectedLoop.status} />
            {selectedLoop.opened_by && <KV label="Opened By" value={selectedLoop.opened_by} />}
            {selectedLoop.resolution && <KV label="Resolution" value={selectedLoop.resolution} />}
            <KV label="Created" value={selectedLoop.created_at} />
            <KV label="Last Observed" value={selectedLoop.last_observed_at} />

            {loopProvenance.length > 0 && (
              <>
                <Text>{" "}</Text>
                <Text>{"  " + t.title("Provenance")}</Text>
                {loopProvenance.map((p) => (
                  <Text key={p.id}>{"    " + t.dim("\u2022") + " " + t.value(`${p.subject_id} ${p.predicate} ${p.object_id}`) + "  " + t.dim(`conf=${p.confidence != null ? (p.confidence * 100).toFixed(0) : "?"}%`) + "  " + t.dim(p.created_at.slice(0, 10))}</Text>
                ))}
              </>
            )}
          </>
        )}
        {error && <Text>{"  " + t.err(error)}</Text>}
        <Separator />
        <Menu items={items} onSelect={(value) => {
          if (value === "__back__") { setLevel("loops"); return; }
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
        { label: `Yes, remove "${confirmRemove}"`, value: "confirm", color: t.err },
        { label: "Cancel", value: "cancel", color: t.dim },
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
