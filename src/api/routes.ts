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

export function registerRoutes(server: FastifyInstance) {
  registerHealthRoutes(server);
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
}
