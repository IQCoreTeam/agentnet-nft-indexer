// Scan a whole Token-2022 collection via DAS getAssetsByGroup and map each
// asset onto our flat IndexedItem. This is the canonical "index every NFT in a
// collection" pattern (groupKey: "collection", paginated 1000/page, stop when a
// page returns fewer than the limit) — the same shape NFT marketplaces use.

import type { IndexedItem, ScanPage, ScanResult, Trait } from "../types";
import { dasRpc } from "./client";

const PAGE_LIMIT = 1000;

// The slice of the DAS asset response we read. DAS resolves the mint's uri
// (our code-in JSON) into content.metadata, so attributes/name/description
// arrive already merged — we don't fetch the inscription ourselves.
interface DasAsset {
  id: string;
  content?: {
    metadata?: { name?: string; description?: string; attributes?: Trait[] };
    links?: { image?: string };
    files?: { uri?: string; cdn_uri?: string }[];
  };
  authorities?: { address: string; scopes?: string[] }[];
  creators?: { address: string; verified?: boolean }[];
  token_info?: { supply?: number; decimals?: number };
  supply?: { print_current_supply?: number } | null;
}

interface DasGroupResult {
  items: DasAsset[];
  total?: number;
  limit?: number;
  // Response-level freshness: "all data up to and including this slot is
  // indexed". DAS exposes no per-asset slot, so this is our only staleness
  // signal — used to skip a scan that's older than what we already stored.
  last_indexed_slot?: number;
}

/** The creator = the mint's update authority (json §4: "recoverable as the
 *  mint's update authority, never a stored trait"). DAS exposes it as the
 *  authority with the "full" scope; fall back to the first verified creator. */
function creatorOf(a: DasAsset): string | null {
  const fullAuth = a.authorities?.find((x) => x.scopes?.includes("full")) ?? a.authorities?.[0];
  if (fullAuth?.address) return fullAuth.address;
  const verified = a.creators?.find((c) => c.verified) ?? a.creators?.[0];
  return verified?.address ?? null;
}

/** supply is the ranking signal (+1 per buy). For a semi-fungible Token-2022
 *  mint DAS reports it under token_info.supply; mpl-style editions use
 *  print_current_supply. Take whichever is present, default 0. */
function supplyOf(a: DasAsset): number {
  if (typeof a.token_info?.supply === "number") return a.token_info.supply;
  if (typeof a.supply?.print_current_supply === "number") return a.supply.print_current_supply;
  return 0;
}

function imageOf(a: DasAsset): string | null {
  return a.content?.links?.image ?? a.content?.files?.[0]?.cdn_uri ?? a.content?.files?.[0]?.uri ?? null;
}

function toItem(a: DasAsset, collection: string, type: IndexedItem["type"]): IndexedItem {
  const m = a.content?.metadata;
  return {
    mint: a.id,
    collection,
    type,
    name: m?.name?.trim() || a.id,
    description: m?.description ?? "",
    image: imageOf(a),
    creator: creatorOf(a),
    supply: supplyOf(a),
    attributes: Array.isArray(m?.attributes)
      ? m.attributes.filter((t): t is Trait => !!t && typeof t.trait_type === "string" && typeof t.value === "string")
      : [],
  };
}

/** Fetch one page of a collection. `urls` is passed through to dasRpc so the
 *  same scan can run against a user's own RPC (the fallback path). */
export async function scanCollectionPage(
  collection: string,
  type: IndexedItem["type"],
  page: number,
  urls?: string[],
): Promise<ScanPage> {
  const result = await dasRpc<DasGroupResult>(
    "getAssetsByGroup",
    { groupKey: "collection", groupValue: collection, page, limit: PAGE_LIMIT },
    urls,
  );
  const items = (result.items ?? []).map((a) => toItem(a, collection, type));
  // Stop when a short page comes back — the standard DAS exhaustion check.
  const nextPage = items.length < PAGE_LIMIT ? null : page + 1;
  return { items, nextPage, slot: result.last_indexed_slot ?? 0 };
}

/** Walk every page of a collection into one array + the freshness slot. Used by
 *  the ingest backfill and reusable as-is for a one-shot fallback scan. The slot
 *  is the MIN across pages: the whole scan is only consistent up to its
 *  earliest-indexed page. 0 means the RPC didn't report a slot (guard disabled). */
export async function scanCollection(
  collection: string,
  type: IndexedItem["type"],
  urls?: string[],
): Promise<ScanResult> {
  const all: IndexedItem[] = [];
  let slot = Infinity;
  let page: number | null = 1;
  while (page !== null) {
    const p: ScanPage = await scanCollectionPage(collection, type, page, urls);
    all.push(...p.items);
    if (p.slot > 0) slot = Math.min(slot, p.slot);
    page = p.nextPage;
  }
  return { items: all, slot: Number.isFinite(slot) ? slot : 0 };
}
