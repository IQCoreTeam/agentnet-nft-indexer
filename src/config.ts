// All env reads in one place. The DAS RPC url is built exactly like iq-gateway
// (HELIUS_API_KEY / HELIUS_API_KEYS → https://{cluster}.helius-rpc.com/?api-key),
// so a key that works for the gateway works here unchanged.

const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";

const HELIUS_BASE: string | null =
  CLUSTER === "mainnet-beta" ? "https://mainnet.helius-rpc.com"
  : CLUSTER === "devnet" ? "https://devnet.helius-rpc.com"
  : null;

const HELIUS_KEYS: string[] =
  process.env.HELIUS_API_KEYS?.split(",").map((k) => k.trim()).filter(Boolean) ??
  (process.env.HELIUS_API_KEY ? [process.env.HELIUS_API_KEY] : []);

/** Every DAS RPC url we can rotate through (key fallback on 429), in order.
 *  Helius keys first, then an explicit DAS_RPC_ENDPOINT as a final option. */
export const DAS_RPC_URLS: string[] = [
  ...(HELIUS_BASE ? HELIUS_KEYS.map((k) => `${HELIUS_BASE}/?api-key=${k}`) : []),
  ...(process.env.DAS_RPC_ENDPOINT ? [process.env.DAS_RPC_ENDPOINT] : []),
];

export function isDasConfigured(): boolean {
  return DAS_RPC_URLS.length > 0;
}

/** Each entry the ingest job scans: a collection mint + the type label that
 *  becomes part of every item's identity (skill vs workflow). AgentNet has
 *  exactly two today (plans/onchain-format/tables.md §1). */
export interface CollectionConfig {
  type: "skill" | "workflow";
  collection: string; // the umbrella collection mint
}

export const COLLECTIONS: CollectionConfig[] = [
  ...(process.env.SKILLS_COLLECTION ? [{ type: "skill" as const, collection: process.env.SKILLS_COLLECTION }] : []),
  ...(process.env.WORKFLOWS_COLLECTION ? [{ type: "workflow" as const, collection: process.env.WORKFLOWS_COLLECTION }] : []),
];

export const INGEST_INTERVAL_MS = Number(process.env.INGEST_INTERVAL_MS) || 10 * 60 * 1000;
// 3009 = this service's assigned host port on iqlabs-prod-01. WORKDIR is /app,
// so the relative DB path resolves to /app/data/index.db — the mounted volume.
export const PORT = Number(process.env.PORT) || 3009;
export const DB_PATH = process.env.DB_PATH || "./data/index.db";
export const CLUSTER_NAME = CLUSTER;
