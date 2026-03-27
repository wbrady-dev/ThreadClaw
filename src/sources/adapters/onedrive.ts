/**
 * Microsoft OneDrive Source Adapter (stub)
 *
 * Not yet implemented. Placeholder for future OneDrive integration.
 */

import type { SourceAdapter, SourceConfig, SourceStatus } from "../types.js";

// ── Stub exports (referenced by TUI, no-op until implemented) ──

export function detectOneDriveFolder(): string | null { return null; }
export function hasOneDriveCredentials(): boolean { return false; }
export function removeOneDriveCredentials(): void {}
export async function runOneDriveOAuth(_clientId: string, _clientSecret: string): Promise<boolean> { return false; }

// ── Adapter class ──

export class OneDriveAdapter implements SourceAdapter {
  id = "onedrive";
  name = "Microsoft OneDrive";
  type: "polling" = "polling";

  async isAvailable() { return false; }
  availabilityReason() { return "OneDrive sync is not yet implemented. Use the Local Directories adapter with your OneDrive sync folder as a workaround."; }

  defaultConfig(): SourceConfig {
    return {
      enabled: false,
      syncInterval: 300,
      collections: [],
      maxFileSize: 50 * 1024 * 1024,
    };
  }

  getStatus(): SourceStatus {
    return { state: "idle", docCount: 0 };
  }

  async start() {}
  async stop() {}
}
