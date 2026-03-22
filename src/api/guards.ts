import type { FastifyRequest } from "fastify";

/** Check if request originates from localhost. */
export function isLocalRequest(req: FastifyRequest): boolean {
  const ip = req.ip ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
