import type { FastifyRequest } from "fastify";
import { logger } from "../utils/logger.js";

/**
 * Check if request originates from localhost.
 *
 * Design note: This is used as a per-route guard rather than global middleware
 * because some routes (e.g. /health) intentionally allow non-local access.
 */
export function isLocalRequest(req: FastifyRequest): boolean {
  const ip = req.ip ?? "";
  const local =
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "0.0.0.0";
  if (!local) {
    logger.debug({ ip, url: req.url, method: req.method }, "Rejected non-local request");
  }
  return local;
}
