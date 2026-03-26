# Invariants

## Overview

Invariants are durable constraints -- rules that must be respected across all operations. They represent contract memory: things the agent should always or never do. Stored as MemoryObjects with kind='invariant' in the unified `memory_objects` table.

## Extraction

Invariants are extracted using **LLM-primary extraction** with regex patterns as fallback. In smart extraction mode, "invariant" is a recognized LLM event type -- the model identifies constraints from natural language (e.g., "never force push to main", "always run tests before deploy") and classifies them by severity and enforcement mode. When no LLM is available, regex patterns detect invariant signals from structured text.

## Properties

Invariant-specific properties are stored in the `structured_json` field:

| Field | Values | Description |
|-------|--------|-------------|
| invariant_key | string | Unique identifier (e.g., "no-force-push") -- also stored as canonical_key |
| category | string | Grouping (e.g., "git", "deploy", "security") |
| description | string | Human-readable rule (also in the content field) |
| severity | critical, error, warning, info | Impact level |
| enforcement_mode | advisory, warn, block | How strictly enforced |
| status | active, suspended, retired | Lifecycle state (also in the MO status field) |

## Severity Ordering

Invariants are always returned ordered by severity (most critical first):
1. **critical** — Must never be violated
2. **error** — Should not be violated
3. **warning** — Prefer to avoid
4. **info** — Good to know

## Enforcement Modes

- **strict**: Always surfaced in CCL with score 1.0 (never filtered out by token budget)
- **advisory**: Surfaced in context based on ROI scoring but not enforced

Strict invariants are guaranteed to appear in every compiled context. Advisory invariants compete for token budget like other capsules.

## Context Compilation

Invariants are compiled into context capsules with severity-based scoring:
- critical: score 1.0
- error: score 0.9
- warning: score 0.7
- info: score 0.4

They appear after anti-runbooks but before decisions and claims in the compiled context.

## Promotion Policy

Invariants require the most conservative promotion:
- Minimum confidence: 0.7
- Requires user confirmation OR auto-promote at confidence >= 0.9
- One evidence row minimum
- No automatic expiry
