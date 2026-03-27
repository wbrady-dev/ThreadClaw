import type { FastifyInstance } from "fastify";
import { registerIngestRoutes } from "./ingest.routes.js";
import { registerQueryRoutes } from "./query.routes.js";
import { registerCollectionRoutes } from "./collection.routes.js";
import { registerHealthRoutes } from "./health.routes.js";
import { registerSourceRoutes } from "./sources.routes.js";
import { registerReindexRoutes } from "./reindex.routes.js";
import { registerAnalyticsRoutes, registerDiagnosticsRoute } from "./analytics.routes.js";
import { registerDocumentRoutes } from "./document.routes.js";
import { registerResetRoutes } from "./reset.routes.js";
import { registerGraphRoutes } from "./graph.routes.js";
import { registerEventStreamRoute } from "./event-stream.routes.js";

// All routes are registered at the root prefix (no /api/v1 prefix).
// If versioning is needed in the future, add a Fastify prefix option here.
export async function registerRoutes(server: FastifyInstance, onShutdown?: () => Promise<void>) {
  registerHealthRoutes(server, onShutdown);
  registerIngestRoutes(server);
  registerQueryRoutes(server);
  registerCollectionRoutes(server);
  registerSourceRoutes(server);
  registerReindexRoutes(server);
  registerAnalyticsRoutes(server);
  registerDiagnosticsRoute(server);
  registerDocumentRoutes(server);
  registerResetRoutes(server);
  registerGraphRoutes(server);
  registerEventStreamRoute(server);
}
