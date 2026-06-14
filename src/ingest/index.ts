// Ingest: scan every configured collection via DAS into the index, then prune
// anything that left it. Mirrors iq-gateway's catalog backfill job — a delayed
// first pass on boot, then a periodic refresh (supply changes on every buy, so
// re-scanning keeps the supply ranking fresh). Idempotent; safe to run while
// serving (upserts are transactional).

import { COLLECTIONS, INGEST_INTERVAL_MS, isDasConfigured } from "../config";
import { scanCollection } from "../das/collection";
import { getCollectionSlot, pruneCollection, setCollectionSlot, upsertItems } from "../store/items";

export interface IngestReport {
  collections: number;
  items: number;
  pruned: number;
  skipped: number; // collections skipped because the scan was stale (slot guard)
}

/** One full pass over all configured collections. A scan whose freshness slot
 *  is behind what we already stored is skipped (slot guard) — so a slow RPC
 *  returning an older snapshot can't overwrite fresher supply numbers. A scan
 *  with slot 0 (RPC didn't report one) always applies; the guard is opt-in on
 *  the data, not a hard requirement. */
export async function ingestAll(): Promise<IngestReport> {
  let items = 0;
  let pruned = 0;
  let skipped = 0;
  for (const c of COLLECTIONS) {
    const scan = await scanCollection(c.collection, c.authority, c.type);
    if (scan.slot > 0 && scan.slot < getCollectionSlot(c.collection)) {
      skipped++;
      continue;
    }
    upsertItems(scan.items);
    pruned += pruneCollection(c.collection, new Set(scan.items.map((s) => s.mint)));
    if (scan.slot > 0) setCollectionSlot(c.collection, scan.slot);
    items += scan.items.length;
  }
  return { collections: COLLECTIONS.length, items, pruned, skipped };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Schedule the backfill loop. No-op (with a clear log) when DAS or the
 *  collection list isn't configured — an empty index is a real, visible state,
 *  not a crash. Clients fall back to their own RPC in that case (see README). */
export function startIngestJob(intervalMs = INGEST_INTERVAL_MS): void {
  if (timer) return;
  if (!isDasConfigured()) {
    console.warn("[ingest] no DAS RPC configured (HELIUS_API_KEY / DAS_RPC_ENDPOINT) — index stays empty");
    return;
  }
  if (COLLECTIONS.length === 0) {
    console.warn("[ingest] no collections configured (SKILLS_COLLECTION / WORKFLOWS_COLLECTION) — index stays empty");
    return;
  }
  const run = (label: string) =>
    ingestAll()
      .then((r) => console.log(`[ingest] ${label}: ${r.items} items across ${r.collections} collections, ${r.pruned} pruned, ${r.skipped} stale-skipped`))
      .catch((e) => console.warn(`[ingest] ${label} failed:`, e instanceof Error ? e.message : e));

  setTimeout(() => run("backfill"), 3_000);
  timer = setInterval(() => run("refresh"), intervalMs);
}
