import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Menu, Section, Separator, KV, t, useInterval, formatAge, type MenuItem } from "../components.js";
import { getApiBaseUrl, getApiPort } from "../../platform.js";
import { isPortReachable } from "../../runtime-status.js";

/* ── Types ────────────────────────────────────────────────────────── */

interface CollectionData {
  id: string;
  name: string;
  documentCount?: number;
  documents?: number;
}

interface DocumentData {
  id: string;
  source_path: string;
  collection: string;
  chunk_count?: number;
  size?: number;
  created_at?: string;
}

/* ── Constants ────────────────────────────────────────────────────── */

const DOCS_PER_PAGE = 20;

/* ── Module-level cache ───────────────────────────────────────────── */

let cachedCollections: CollectionData[] = [];
const cachedDocuments: Record<string, DocumentData[]> = {};

/* ── Helpers ──────────────────────────────────────────────────────── */

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

function formatSize(bytes: number | undefined): string {
  if (bytes == null || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Screen ───────────────────────────────────────────────────────── */

type Level = "collections" | "documents" | "doc-action";

export function DocumentsScreen({ onBack }: { onBack: () => void }) {
  const [level, setLevel] = useState<Level>("collections");
  const [collections, setCollections] = useState<CollectionData[]>(cachedCollections);
  const [documents, setDocuments] = useState<DocumentData[]>([]);
  const [selectedCollection, setSelectedCollection] = useState<CollectionData | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<DocumentData | null>(null);
  const [apiReachable, setApiReachable] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  /* ── Fetch collections ──────────────────────────────────────────── */

  const fetchCollections = async () => {
    try {
      const up = await isPortReachable(getApiPort());
      setApiReachable(up);
      if (!up) return;

      const res = await fetch(`${getApiBaseUrl()}/collections`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const payload = (await res.json()) as {
          collections?: CollectionData[];
        };
        const cols = payload.collections ?? [];
        cachedCollections = cols;
        setCollections(cols);
      }
    } catch {
      setApiReachable(false);
    }
  };

  /* ── Fetch documents for a collection ───────────────────────────── */

  const fetchDocuments = async (collectionName: string) => {
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/documents?collection=${encodeURIComponent(collectionName)}`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (res.ok) {
        const payload = (await res.json()) as {
          documents?: DocumentData[];
        };
        const docs = payload.documents ?? [];
        cachedDocuments[collectionName] = docs;
        setDocuments(docs);
      }
    } catch {
      setApiReachable(false);
      setStatusMessage(t.err("Failed to fetch documents"));
      // Use cached if available
      setDocuments(cachedDocuments[collectionName] ?? []);
    }
  };

  /* ── Initial load & auto-refresh ────────────────────────────────── */

  useEffect(() => {
    fetchCollections();
  }, []);

  useInterval(async () => {
    if (level === "collections") {
      await fetchCollections();
    } else if (level === "documents" && selectedCollection) {
      await fetchDocuments(selectedCollection.name);
    }
  }, 5000);

  /* ── Actions ────────────────────────────────────────────────────── */

  const deleteDocument = async (doc: DocumentData) => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/documents/${doc.id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        setStatusMessage(t.ok(`Deleted ${basename(doc.source_path)}`));
      } else {
        setStatusMessage(t.err(`Failed to delete: ${res.statusText}`));
      }
    } catch (err) {
      setStatusMessage(t.err(`Delete error: ${String(err)}`));
    }
    if (selectedCollection) await fetchDocuments(selectedCollection.name);
    await fetchCollections();
  };

  const reingestDocument = async (doc: DocumentData) => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: doc.source_path }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        setStatusMessage(t.ok(`Re-ingesting ${basename(doc.source_path)}`));
      } else {
        setStatusMessage(t.err(`Re-ingest failed: ${res.statusText}`));
      }
    } catch (err) {
      setStatusMessage(t.err(`Re-ingest error: ${String(err)}`));
    }
  };

  const deleteCollection = async (collection: CollectionData) => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/collections/${collection.id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        setStatusMessage(t.ok(`Deleted collection ${collection.name}`));
      } else {
        setStatusMessage(t.err(`Failed to delete collection: ${res.statusText}`));
      }
    } catch (err) {
      setStatusMessage(t.err(`Delete error: ${String(err)}`));
    }
    await fetchCollections();
  };

  /* ── Offline state ──────────────────────────────────────────────── */

  if (!apiReachable) {
    return (
      <Box flexDirection="column">
        <Section title="Documents" />
        <Text>{"  " + t.warn("Start services to manage documents")}</Text>
        <Text> </Text>
        <Menu
          items={[{ label: "Back", value: "__back__", color: t.dim }]}
          onSelect={() => onBack()}
        />
      </Box>
    );
  }

  /* ── Level 1: Collections list ──────────────────────────────────── */

  if (level === "collections") {
    const totalDocs = collections.reduce(
      (sum, c) => sum + (c.documentCount ?? c.documents ?? 0),
      0,
    );

    const menuItems: MenuItem[] = collections.map((col) => {
      const count = col.documentCount ?? col.documents ?? 0;
      return {
        label: `${col.name} (${count} docs)`,
        value: col.id,
      };
    });
    menuItems.push({ label: "Back", value: "__back__", color: t.dim });

    const handleSelect = (value: string) => {
      setStatusMessage(null);
      if (value === "__back__") {
        onBack();
        return;
      }
      const col = collections.find((c) => c.id === value);
      if (col) {
        setSelectedCollection(col);
        fetchDocuments(col.name);
        setLevel("documents");
      }
    };

    return (
      <Box flexDirection="column">
        <Section title="Documents" />
        <Text>{"  " + t.dim("Manage documents across your knowledge collections.")}</Text>
        <Text> </Text>

        {collections.length === 0 && (
          <Text>{"  " + t.dim("No collections found. Add a source to get started.")}</Text>
        )}

        {collections.length > 0 && (
          <KV label="Total documents" value={t.value(String(totalDocs))} />
        )}

        {statusMessage && <Text>{"  " + statusMessage}</Text>}
        <Text> </Text>

        <Menu items={menuItems} onSelect={handleSelect} />
      </Box>
    );
  }

  /* ── Level 2: Documents in collection ───────────────────────────── */

  if (level === "documents" && selectedCollection) {
    /* ── Confirm: delete-all ────────────────────────────────────── */
    if (confirmAction === "delete-all") {
      const confirmItems: MenuItem[] = [
        {
          label: `Yes, delete all ${documents.length} documents`,
          value: "confirm",
          color: t.err,
        },
        { label: "Cancel", value: "cancel", color: t.dim },
      ];

      return (
        <Box flexDirection="column">
          <Section title="Confirm Delete All" />
          <Text>{"  " + t.warn(`Delete all documents in "${selectedCollection.name}"?`)}</Text>
          <Text>{"  " + t.dim("This cannot be undone.")}</Text>
          <Text> </Text>
          <Menu
            items={confirmItems}
            onSelect={async (value) => {
              if (value === "confirm") {
                await deleteCollection(selectedCollection);
                setConfirmAction(null);
                setSelectedCollection(null);
                setLevel("collections");
              } else {
                setConfirmAction(null);
              }
            }}
          />
        </Box>
      );
    }

    const totalPages = Math.max(1, Math.ceil(documents.length / DOCS_PER_PAGE));
    const currentPage = Math.min(page, totalPages - 1);
    const pageStart = currentPage * DOCS_PER_PAGE;
    const pageDocs = documents.slice(pageStart, pageStart + DOCS_PER_PAGE);

    const menuItems: MenuItem[] = pageDocs.map((doc) => {
      const name = basename(doc.source_path);
      const chunks = doc.chunk_count != null ? ` [${doc.chunk_count} chunks]` : "";
      const size = doc.size ? ` ${formatSize(doc.size)}` : "";
      const age = doc.created_at ? ` ${formatAge(doc.created_at)}` : "";
      return {
        label: `${name}${chunks}${size}${t.dim(age)}`,
        value: `doc:${doc.id}`,
      };
    });
    if (currentPage < totalPages - 1) {
      menuItems.push({ label: "Next page \u2192", value: "__next_page__", color: t.dim });
    }
    if (currentPage > 0) {
      menuItems.push({ label: "\u2190 Previous page", value: "__prev_page__", color: t.dim });
    }
    menuItems.push({
      label: "Delete all in collection",
      value: "delete-all",
      color: t.err,
    });
    menuItems.push({ label: "Back", value: "__back__", color: t.dim });

    const handleSelect = (value: string) => {
      setStatusMessage(null);
      if (value === "__back__") {
        setSelectedCollection(null);
        setPage(0);
        setLevel("collections");
        return;
      }
      if (value === "__next_page__") {
        setPage((p) => Math.min(p + 1, totalPages - 1));
        return;
      }
      if (value === "__prev_page__") {
        setPage((p) => Math.max(p - 1, 0));
        return;
      }
      if (value === "delete-all") {
        setConfirmAction("delete-all");
        return;
      }
      if (value.startsWith("doc:")) {
        const docId = value.slice(4);
        const doc = documents.find((d) => d.id === docId);
        if (doc) {
          setSelectedDoc(doc);
          setLevel("doc-action");
        }
      }
    };

    const docCount = selectedCollection.documentCount ?? selectedCollection.documents ?? 0;

    return (
      <Box flexDirection="column">
        <Section title={`${selectedCollection.name}`} />
        <KV label="Documents" value={t.value(String(docCount))} />
        {documents.length > DOCS_PER_PAGE && (
          <Text>{"  " + t.dim(`Page ${currentPage + 1} of ${totalPages}`)}</Text>
        )}
        {statusMessage && <Text>{"  " + statusMessage}</Text>}
        <Text> </Text>

        {documents.length === 0 && (
          <Text>{"  " + t.dim("No documents in this collection.")}</Text>
        )}

        <Separator width={60} />
        <Menu items={menuItems} onSelect={handleSelect} />
      </Box>
    );
  }

  /* ── Level 3: Document actions ──────────────────────────────────── */

  if (level === "doc-action" && selectedDoc && selectedCollection) {
    /* ── Confirm: delete document ───────────────────────────────── */
    if (confirmAction === "delete-doc") {
      const confirmItems: MenuItem[] = [
        {
          label: `Yes, delete "${basename(selectedDoc.source_path)}"`,
          value: "confirm",
          color: t.err,
        },
        { label: "Cancel", value: "cancel", color: t.dim },
      ];

      return (
        <Box flexDirection="column">
          <Section title="Confirm Delete" />
          <Text>{"  " + t.warn(`Delete "${basename(selectedDoc.source_path)}"?`)}</Text>
          <Text>{"  " + t.dim("This removes the document and all its chunks.")}</Text>
          <Text> </Text>
          <Menu
            items={confirmItems}
            onSelect={async (value) => {
              if (value === "confirm") {
                await deleteDocument(selectedDoc);
                setConfirmAction(null);
                setSelectedDoc(null);
                setLevel("documents");
              } else {
                setConfirmAction(null);
              }
            }}
          />
        </Box>
      );
    }

    /* ── Confirm: re-ingest document ──────────────────────────── */
    if (confirmAction === "reingest-doc") {
      const confirmItems: MenuItem[] = [
        {
          label: `Yes, re-ingest "${basename(selectedDoc.source_path)}"`,
          value: "confirm",
          color: t.value,
        },
        { label: "Cancel", value: "cancel", color: t.dim },
      ];

      return (
        <Box flexDirection="column">
          <Section title="Confirm Re-ingest" />
          <Text>{"  " + t.warn(`Re-ingest "${basename(selectedDoc.source_path)}"?`)}</Text>
          <Text>{"  " + t.dim("This will re-parse and re-chunk the document.")}</Text>
          <Text> </Text>
          <Menu
            items={confirmItems}
            onSelect={async (value) => {
              if (value === "confirm") {
                await reingestDocument(selectedDoc);
                setConfirmAction(null);
                setSelectedDoc(null);
                setLevel("documents");
              } else {
                setConfirmAction(null);
              }
            }}
          />
        </Box>
      );
    }

    const docName = basename(selectedDoc.source_path);
    const menuItems: MenuItem[] = [
      { label: "Delete document", value: "delete", color: t.err },
      { label: "Re-ingest document", value: "reingest" },
      { label: "Back", value: "__back__", color: t.dim },
    ];

    const handleSelect = async (value: string) => {
      setStatusMessage(null);
      if (value === "__back__") {
        setSelectedDoc(null);
        setLevel("documents");
        return;
      }
      if (value === "delete") {
        setConfirmAction("delete-doc");
        return;
      }
      if (value === "reingest") {
        setConfirmAction("reingest-doc");
      }
    };

    return (
      <Box flexDirection="column">
        <Section title={docName} />
        <KV label="Path" value={t.dim(selectedDoc.source_path)} />
        <KV label="Collection" value={t.dim(selectedDoc.collection)} />
        {selectedDoc.chunk_count != null && (
          <KV label="Chunks" value={t.value(String(selectedDoc.chunk_count))} />
        )}
        {selectedDoc.size != null && (
          <KV label="Size" value={t.value(formatSize(selectedDoc.size))} />
        )}
        {selectedDoc.created_at && (
          <KV label="Added" value={t.dim(formatAge(selectedDoc.created_at))} />
        )}
        {statusMessage && <Text>{"  " + statusMessage}</Text>}
        <Text> </Text>

        <Menu items={menuItems} onSelect={handleSelect} />
      </Box>
    );
  }

  /* ── Fallback: should not reach here ────────────────────────────── */
  return (
    <Box flexDirection="column">
      <Section title="Documents" />
      <Text>{"  " + t.dim("Loading...")}</Text>
    </Box>
  );
}
