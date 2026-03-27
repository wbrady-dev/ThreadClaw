/**
 * Shared CLI utilities — extracted to avoid duplication across commands.
 */

/**
 * Returns a helpful hint string when an error message suggests the services are unreachable.
 * Returns empty string if the error doesn't match connection patterns.
 */
export function formatConnectionHint(errorMessage: string): string {
  if (
    errorMessage.includes("ECONNREFUSED") ||
    errorMessage.includes("fetch failed") ||
    errorMessage.includes("Failed to fetch")
  ) {
    return "Are services running? Start with 'threadclaw start' or 'threadclaw serve'.";
  }
  return "";
}

// TODO: Add --verbose/--quiet flags to commands in a future pass.
// These would control log level output across all CLI commands.
