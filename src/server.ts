// AgentNet NFT indexer — a standalone, NFT-only service. It scans the Token-2022
// skill/workflow collections via DAS and serves standard marketplace reads
// (filter by trait, sort by supply). It owns nothing: the index is derived and
// rebuildable, the chain is the source of truth. Deploys like iq-gateway (Bun +
// Hono, GHCR image, docker compose on the prod host).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { PORT } from "./config";
import { getDb } from "./store/db";
import { startIngestJob } from "./ingest";
import { startStatsJob } from "./stats";
import { itemsRouter } from "./routes/items";
import { fallbackRouter } from "./routes/fallback";
import { healthRouter } from "./routes/health";
import { workLinksRouter } from "./routes/workLinks";

getDb(); // open + migrate the index before serving

const app = new Hono();
app.use("*", cors());
app.use("*", logger());

app.route("/", healthRouter);
app.route("/items", itemsRouter);
app.route("/fallback", fallbackRouter);
app.route("/work-links", workLinksRouter);
app.get("/", (c) => c.json({ service: "agentnet-nft-indexer", endpoints: ["/health", "/items", "/items/:mint", "/items/:mint/repos", "/items/facets/:trait_type", "/items/creators/ranking", "/work-links", "/work-links/stars", "/fallback/scan"] }));

startIngestJob();
startStatsJob();

console.log(`agentnet-nft-indexer on :${PORT}`);

// hostname 0.0.0.0 so the container is reachable from Caddy on the compose
// network (Bun defaults to all interfaces, but pin it so it's never lost).
export default { port: PORT, hostname: "0.0.0.0", fetch: app.fetch, idleTimeout: 120 };
