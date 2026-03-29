import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Section, Separator, Menu, t, useInterval, formatAge, type MenuItem } from "../components.js";
import { getApiBaseUrl } from "../../platform.js";

interface SourceData {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  status: {
    state: string;
    lastSync?: string;
    nextSync?: string;
    docCount: number;
    error?: string;
  };
  collections: { path: string; collection: string }[];
}

interface CollectionStats {
  [name: string]: number;
}

function stateIcon(state: string): string {
  switch (state) {
    case "watching":
      return t.ok("●");
    case "syncing":
      return t.ok("●");
    case "idle":
      return t.dim("○");
    case "error":
      return t.err("○");
    case "disabled":
      return t.dim("-");
    default:
      return t.dim("○");
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "watching":
      return t.ok("watching");
    case "syncing":
      return t.ok("syncing");
    case "idle":
      return t.dim("idle");
    case "error":
      return t.err("error");
    case "disabled":
      return t.dim("disabled");
    default:
      return t.dim(state);
  }
}

export function SourcesScreen({ onBack, onLegacy }: { onBack: () => void; onLegacy?: (action: string) => void }) {
  const [sources, setSources] = useState<SourceData[]>([]);
  const [collStats, setCollStats] = useState<CollectionStats>({});
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const [apiReachable, setApiReachable] = useState(true);

  const fetchData = async () => {
    try {
      const [sourceResponse, collectionResponse] = await Promise.all([
        fetch(`${getApiBaseUrl()}/sources`, { signal: AbortSignal.timeout(3000) }),
        fetch(`${getApiBaseUrl()}/collections`, { signal: AbortSignal.timeout(3000) }),
      ]);

      if (sourceResponse.ok) {
        const payload = await sourceResponse.json() as { sources?: SourceData[] };
        setSources(payload.sources ?? []);
        setApiReachable(true);
      }

      if (collectionResponse.ok) {
        const payload = await collectionResponse.json() as { collections?: Array<{ name: string; documentCount?: number; documents?: number }> };
        const stats: CollectionStats = {};
        for (const collection of payload.collections ?? []) {
          stats[collection.name] = collection.documentCount ?? collection.documents ?? 0;
        }
        setCollStats(stats);
      }
    } catch {
      setApiReachable(false);
    }

    setLastRefresh(Date.now());
  };

  useEffect(() => {
    fetchData();
  }, []);

  useInterval(fetchData, 5000);

  let totalDocs = 0;
  let activeCount = 0;
  for (const source of sources) {
    if (source.enabled) activeCount++;
    for (const collection of source.collections) {
      totalDocs += collStats[collection.collection] ?? 0;
    }
  }

  const menuItems: MenuItem[] = [
    { label: "Configure Obsidian", value: "obsidian", description: "Add or change Obsidian vault" },
    { label: "Configure Google Drive", value: "gdrive", description: "Add or change Drive folders" },
    { label: "Configure OneDrive", value: "onedrive", description: "Sync files from OneDrive" },
    { label: "Configure Notion", value: "notion", description: "Add or change Notion databases" },
    ...(process.platform === "darwin"
      ? [{ label: "Configure Apple Notes", value: "apple-notes", description: "Add or change Notes folders" }]
      : []),
    { label: "Configure Web URLs", value: "web", description: "Monitor web pages for changes" },
    { label: "Back", value: "__back__", color: t.dim },
  ];

  const handleSelect = (value: string) => {
    if (value === "__back__") {
      onBack();
      return;
    }
    onLegacy?.(`sources-${value}`);
  };

  return (
    <Box flexDirection="column">
      <Section title="Knowledge Sources" />
      <Text>{t.dim("  All indexing runs locally - zero cloud tokens.")}</Text>
      {!apiReachable && <Text>{"  " + t.warn("ThreadClaw API is offline. Showing last known source state.")}</Text>}
      <Text> </Text>

      {sources.map((source) => (
        <SourceRow key={source.id} source={source} collStats={collStats} />
      ))}

      {sources.length === 0 && (
        <Text>{"  " + t.dim("No sources reported yet. Start the API or configure one from the menu.")}</Text>
      )}

      <Separator width={60} />
      <Text>{"  " + t.value(String(totalDocs)) + " documents  " + t.dim("|") + "  " + t.value(String(activeCount)) + " active sources  " + t.dim("|") + "  " + t.ok("0 cloud tokens")}</Text>
      <Text>{"  " + t.dim("Auto-refreshing - last update " + formatAge(new Date(lastRefresh).toISOString()))}</Text>
      <Text> </Text>

      <Menu items={menuItems} onSelect={handleSelect} />
    </Box>
  );
}

function SourceRow({ source, collStats }: { source: SourceData; collStats: CollectionStats }) {
  const state = !source.enabled && source.status.state !== "error" ? "disabled" : source.status.state;
  const icon = stateIcon(state);

  let statusText = stateLabel(state);
  if (source.status.lastSync) {
    statusText += t.dim(` - synced ${formatAge(source.status.lastSync)}`);
  }
  if (source.status.nextSync && state !== "syncing" && state !== "watching") {
    const deltaMs = new Date(source.status.nextSync).getTime() - Date.now();
    const nextLabel = deltaMs <= 0 ? "soon" : deltaMs < 60_000 ? `in ${Math.round(deltaMs / 1000)}s` : deltaMs < 3_600_000 ? `in ${Math.round(deltaMs / 60_000)}m` : `in ${Math.round(deltaMs / 3_600_000)}h`;
    statusText += t.dim(` - next ${nextLabel}`);
  }

  let docCount = 0;
  for (const collection of source.collections) {
    docCount += collStats[collection.collection] ?? 0;
  }
  const docsLabel = docCount > 0 ? t.value(`${docCount} docs`) : "";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{"  " + icon + " " + t.label(source.name) + "  " + statusText + "  " + docsLabel}</Text>

      {source.collections.map((collection) => {
        const count = collStats[collection.collection] ?? 0;
        const countLabel = count > 0 ? t.dim(` (${count})`) : "";
        const pathLabel = collection.path ? t.dim(collection.path) + " → " : "";
        return (
          <Text key={`${source.id}:${collection.collection}`}>{"      " + t.dim("->") + " " + pathLabel + t.dim(collection.collection) + countLabel}</Text>
        );
      })}

      {source.status.error && (
        <Text>{"      " + t.err(source.status.error)}</Text>
      )}
    </Box>
  );
}

