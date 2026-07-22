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

/** Each entry the ingest job scans: a collection mint + its update authority +
 *  the type label that becomes part of every item's identity (skill vs workflow).
 *  AgentNet has exactly two today (plans/onchain-format/tables.md §1).
 *
 *  We scan by `authority`, NOT by `collection`: our items are Token-2022
 *  TokenGroup members, which are NOT Metaplex collections, so DAS
 *  getAssetsByGroup(collection) returns nothing. searchAssets(authorityAddress)
 *  is the only key that finds them — and it's stable across buys (the buyer
 *  becomes the owner, but the update authority never changes). The `collection`
 *  mint is kept only as the item's umbrella label. */
export interface CollectionConfig {
  type: "skill" | "workflow";
  collection: string; // the umbrella collection mint (label only)
  authority: string;  // the collection's update authority — the DAS scan key
}

// These defaults now target MAINNET (devnet retired 2026-07-17). They stay a
// matched set — SOLANA_CLUSTER (env → mainnet-beta), GATEWAY_URL below, the gate
// program id, and the four SKILLS_*/WORKFLOWS_* env values (collection mints +
// authorities) must all be one network: a devnet authority won't resolve on a
// mainnet gateway, etc. The collections are env-only (no default) — set them on
// the deploy host.
export const COLLECTIONS: CollectionConfig[] = [
  ...(process.env.SKILLS_COLLECTION && process.env.SKILLS_AUTHORITY
    ? [{ type: "skill" as const, collection: process.env.SKILLS_COLLECTION, authority: process.env.SKILLS_AUTHORITY }]
    : []),
  ...(process.env.WORKFLOWS_COLLECTION && process.env.WORKFLOWS_AUTHORITY
    ? [{ type: "workflow" as const, collection: process.env.WORKFLOWS_COLLECTION, authority: process.env.WORKFLOWS_AUTHORITY }]
    : []),
];

// The IQLabs gateway that resolves a code-in inscription (the item's json_uri =
// a tx signature) into the standard NFT JSON. DAS doesn't fetch code-in uris
// (they're tx sigs, not http urls), so the indexer reads traits through here.
// Mainnet gateway (env override wins). See the matched-set note above.
export const GATEWAY_URL = process.env.GATEWAY_URL || "https://gateway.iqlabs.dev";

// 5 min default: a full re-scan is one DAS call per ~1000 items and carries
// supply + traits, so it's cheap; supply ranking is fine being up to 5 min
// stale. No notify/webhook path — pull-only keeps the attack surface zero and
// the RPC cost fixed (independent of buy/publish traffic). Override via env.
export const INGEST_INTERVAL_MS = Number(process.env.INGEST_INTERVAL_MS) || 5 * 60 * 1000;

// Verified-work (src/routes/workLinks, src/stats): a service GitHub token for
// PUBLIC repo reads only — it raises the rate limit for the `.agentnet` marker
// check + star/fork refresh. Optional (unauthenticated reads work at a lower
// limit). The user's own PAT is NEVER sent here. Stars move slowly and are only
// a display hint, so the refresh runs on a slow cadence (default 12h).
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const STATS_INTERVAL_MS = Number(process.env.STATS_INTERVAL_MS) || 12 * 60 * 60 * 1000;

// The agent-workflow-nft gate program. Its ItemConfig PDA (["item", itemMint])
// holds each item's price in lamports — the on-chain source of truth buy_item
// charges. DAS / the code-in JSON don't carry price, so ingest reads this PDA.
// Mainnet default (env override wins). Must match AgentNet seed.ts.
export const WORKFLOW_GATE_PROGRAM_ID =
  process.env.WORKFLOW_GATE_PROGRAM_ID || "8YmcHuCx323RtqC8mzTJ5CH4oVT8mPKJ7xarcPKbdgof";
// Public base of THIS service, baked into /metadata responses as the absolute
// image URL (marketplaces resolve image against nothing, so it must be
// absolute). Env override for local runs.
export const PUBLIC_URL = (process.env.PUBLIC_URL || "https://nft-index.iqlabs.dev").replace(/\/+$/, "");

// 3009 = this service's assigned host port on iqlabs-prod-01. WORKDIR is /app,
// so the relative DB path resolves to /app/data/index.db — the mounted volume.
export const PORT = Number(process.env.PORT) || 3009;
export const DB_PATH = process.env.DB_PATH || "./data/index.db";
export const CLUSTER_NAME = CLUSTER;
