# MCP Server

ThreadClaw includes a Model Context Protocol (MCP) server that exposes RAG functionality as native tools for AI agents. Instead of spawning CLI processes, agents can call ThreadClaw tools directly over stdio.

## How It Works

The MCP server runs as a stdio transport process. It bootstraps its own database connection, runs migrations, and registers tools that agents can invoke natively.

## Enabling the MCP Server

Register in your `openclaw.json` under the ACPX plugin config:

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "config": {
          "mcpServers": {
            "threadclaw": {
              "command": "node",
              "args": ["--import", "tsx", "src/mcp.ts"]
            }
          }
        }
      }
    }
  }
}
```

Or run standalone:

```bash
node --import tsx src/mcp.ts
```

## Available Tools

### `threadclaw_query`

Search the knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural language search query |
| `collection` | string | No | Collection to search (default: `"default"`, use `"all"` for everything) |
| `mode` | `"brief"` \| `"titles"` \| `"full"` | No | Output mode: `brief` (~200 tokens, default), `titles` (~30 tokens), `full` (~1500 tokens) |
| `topK` | number | No | Max results (default: 3, max: 100) |

Returns matching documents with query metadata (strategy, tokens used, confidence, elapsed time).

### `threadclaw_ingest`

Ingest a file into the knowledge base. The file watcher handles workspace files automatically -- use this for files the user explicitly shares.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Absolute path to the file |
| `collection` | string | No | Target collection (default: `"default"`) |
| `tags` | string[] | No | Optional tags for the document |

Path validation is enforced: `.env`, `.ssh/`, `.git/`, credentials, and private keys are blocked.

### `threadclaw_collections`

List all collections with document and chunk counts. Takes no parameters.

## Configuration

The MCP server uses the same configuration as the main ThreadClaw process (`.env` file, environment variables). It reads `THREADCLAW_DATA_DIR` to locate the database. See [Configuration Guide](configuration.md) for all options.

## Security

- **Path validation** -- the same blocklist used by the HTTP API is enforced for `threadclaw_ingest`
- **Local only** -- MCP runs over stdio, so it is inherently local (no network exposure)
- **Graceful shutdown** -- handles SIGINT and SIGTERM, closing the database cleanly
