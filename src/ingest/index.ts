// Ingest: scan every configured collection via the GATE PROGRAM into the index,
// then prune anything that left it. Mirrors iq-gateway's catalog backfill job —
// a delayed first pass on boot, then a periodic refresh (supply changes on every
// buy, so re-scanning keeps the supply ranking fresh). Idempotent; safe to run
// while serving (upserts are transactional).
//
// Enumeration source = the gate program's ItemConfig PDAs (one per published
// item, authority-independent), NOT DAS searchAssets(authority) — the authority
// scan misses every item whose update authority was migrated to the gate PDA and
// every skill published by a non-seed wallet. One gate scan covers ALL configured
// collections at once, so we fan its result out per collection for upsert+prune.

import { COLLECTIONS, INGEST_INTERVAL_MS, isDasConfigured } from "../config";
import { scanViaGate } from "../chain/gateScan";
import type { IndexedItem } from "../types";
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
  // One authority-independent pass over the gate program → items for every
  // configured collection. (If this read fails, it throws and the whole pass is
  // skipped by the caller — we never prune on a partial scan.)
  const scan = await scanViaGate();

  // Fan the flat result out by collection so each gets its own slot guard +
  // prune. A collection absent from the scan ends up with an empty list.
  const byCollection = new Map<string, IndexedItem[]>(COLLECTIONS.map((c) => [c.collection, []]));
  for (const it of scan.items) byCollection.get(it.collection)?.push(it);

  let items = 0;
  let pruned = 0;
  let skipped = 0;
  for (const c of COLLECTIONS) {
    const list = byCollection.get(c.collection) ?? [];
    if (scan.slot > 0 && scan.slot < getCollectionSlot(c.collection)) {
      skipped++;
      continue;
    }
    upsertItems(list);
    pruned += pruneCollection(c.collection, new Set(list.map((s) => s.mint)));
    if (scan.slot > 0) setCollectionSlot(c.collection, scan.slot);
    items += list.length;
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
