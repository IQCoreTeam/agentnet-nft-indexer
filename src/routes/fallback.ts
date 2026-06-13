// Fallback live-scan. When the index is empty (collections not minted yet, DAS
// not configured here, or the user simply distrusts our index) a caller can ask
// the service to scan a collection live against *their own* RPC and get the
// same supply-sorted shape — without us having pre-warmed anything.
//
// This is the "indexer is just an accelerator, never a gate" guarantee: the
// on-chain format stands alone (AgentNet plans/onchain-format/skill-nft-json.md
// §0), so anyone with a DAS-capable RPC reproduces the listing. We sort here so
// even a cold caller gets popularity order; if their RPC has no DAS, they can
// still run the same scanCollection() client-side themselves.

import { Hono } from "hono";
import { scanCollection } from "../das/collection";
import type { IndexedItem } from "../types";

export const fallbackRouter = new Hono();

// POST /fallback/scan  { collection, type?, rpc, sort? }
// rpc = the caller's own DAS RPC url. We never store it; it's used for this
// request only. Returns the full collection, supply-sorted by default.
fallbackRouter.post("/scan", async (c) => {
  let body: { collection?: string; type?: string; rpc?: string; sort?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const { collection, rpc } = body;
  if (!collection) return c.json({ error: "collection (mint) required" }, 400);
  if (!rpc) return c.json({ error: "rpc (your own DAS RPC url) required for a live scan" }, 400);
  const type: IndexedItem["type"] = body.type === "workflow" ? "workflow" : "skill";

  let items: IndexedItem[];
  try {
    ({ items } = await scanCollection(collection, type, [rpc]));
  } catch (e) {
    return c.json({ error: `scan failed: ${e instanceof Error ? e.message : "unknown"}` }, 502);
  }

  if (body.sort === "name") items.sort((a, b) => a.name.localeCompare(b.name));
  else items.sort((a, b) => b.supply - a.supply || a.name.localeCompare(b.name));

  return c.json({ source: "live", count: items.length, items });
});
