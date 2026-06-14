// Scan a whole AgentNet collection via DAS searchAssets(authorityAddress) and map
// each asset onto our flat IndexedItem.
//
// Why authority and not collection: our items are Token-2022 TokenGroup members,
// which are NOT Metaplex collections — getAssetsByGroup(collection) returns 0 for
// them, forever. searchAssets by the collection's update authority is the only key
// that finds them, and it's stable across buys (the buyer becomes the owner, the
// authority never changes). Paginated 1000/page, stop when a page is short.
//
// Traits don't arrive from DAS: each item's json_uri is a code-in tx signature,
// not an http url, so DAS leaves attributes empty. We resolve them through the
// IQLabs gateway (GATEWAY_URL/data/{sig} → the standard NFT JSON), one fetch per
// item, merged in during the scan.

import type { IndexedItem, ScanPage, ScanResult, Trait } from "../types";
import { dasRpc } from "./client";
import { GATEWAY_URL } from "../config";

const PAGE_LIMIT = 1000;
// Cap concurrent gateway fetches: a full page maps to one /data/{sig} call per
// item, and firing all of them at once throttles the gateway (some return empty,
// dropping traits). 8 is gentle and still fast for our catalog size.
const GATEWAY_CONCURRENCY = 8;

/** Map `items` through async `fn` with at most `limit` in flight at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// The slice of the DAS asset response we read. DAS resolves the mint's uri
// (our code-in JSON) into content.metadata, so attributes/name/description
// arrive already merged — we don't fetch the inscription ourselves.
interface DasAsset {
  id: string;
  content?: {
    json_uri?: string; // the code-in tx signature — resolved via the gateway for traits
    metadata?: { name?: string; description?: string; attributes?: Trait[] };
    links?: { image?: string };
    files?: { uri?: string; cdn_uri?: string }[];
  };
  authorities?: { address: string; scopes?: string[] }[];
  creators?: { address: string; verified?: boolean }[];
  token_info?: { supply?: number; decimals?: number };
  supply?: { print_current_supply?: number } | null;
  // The raw Token-2022 TokenGroupMember.group — the ACTUAL collection this mint
  // belongs to. We scan by authority (one wallet may author several collections),
  // so we must filter the page down to the collection we asked for using this.
  // (DAS's top-level `grouping.group_value` is a derived/encoded form, not the
  // raw group mint — don't use it; read token_group_member.group instead.)
  mint_extensions?: { token_group_member?: { group?: string } };
}

/** The mint's real collection = its TokenGroupMember.group (raw), or null. */
function groupOf(a: DasAsset): string | null {
  return a.mint_extensions?.token_group_member?.group ?? null;
}

/** The standard NFT JSON a code-in inscription holds (skill-nft-json.md §2). */
interface CodeInJson {
  name?: string;
  description?: string;
  image?: string;
  attributes?: Trait[];
}

/** Resolve an item's code-in inscription (json_uri = a tx signature) into its
 *  standard NFT JSON via the gateway. Returns null on any failure — the item is
 *  still indexed with whatever DAS gave us, just without enriched traits. */
async function resolveCodeIn(jsonUri: string): Promise<CodeInJson | null> {
  try {
    const res = await fetch(`${GATEWAY_URL}/data/${jsonUri}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: string | null };
    if (!body.data) return null;
    return JSON.parse(body.data) as CodeInJson;
  } catch {
    return null;
  }
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

function cleanTraits(attrs: unknown): Trait[] {
  return Array.isArray(attrs)
    ? attrs.filter((t): t is Trait => !!t && typeof t.trait_type === "string" && typeof t.value === "string")
    : [];
}

/** Map a DAS asset to an IndexedItem, enriching name/description/image/traits
 *  from the code-in inscription (resolved via the gateway). The gateway JSON is
 *  the source of truth for traits (DAS can't read code-in uris); DAS supplies
 *  supply + creator. Falls back to DAS metadata if the gateway is unavailable. */
async function toItem(a: DasAsset, collection: string, type: IndexedItem["type"]): Promise<IndexedItem> {
  const m = a.content?.metadata;
  const code = a.content?.json_uri ? await resolveCodeIn(a.content.json_uri) : null;
  const attributes = cleanTraits(code?.attributes ?? m?.attributes);
  return {
    mint: a.id,
    collection,
    type,
    name: (code?.name ?? m?.name)?.trim() || a.id,
    description: code?.description ?? m?.description ?? "",
    image: code?.image ?? imageOf(a),
    creator: creatorOf(a),
    supply: supplyOf(a),
    attributes,
  };
}

/** Fetch one page of a collection by its update authority. `collection` is the
 *  collection mint we want; `authority` is the DAS scan key (its update authority).
 *  Because one authority may have minted SEVERAL collections (ours all share the
 *  seed wallet), the raw page mixes them — we keep only the assets whose real
 *  TokenGroupMember.group equals `collection`. `urls` is passed through to dasRpc
 *  so the same scan can run against a user's own RPC (the fallback path). Traits
 *  are enriched per item via the gateway. */
export async function scanCollectionPage(
  collection: string,
  authority: string,
  type: IndexedItem["type"],
  page: number,
  urls?: string[],
): Promise<ScanPage> {
  const result = await dasRpc<DasGroupResult>(
    "searchAssets",
    { authorityAddress: authority, page, limit: PAGE_LIMIT },
    urls,
  );
  const raw = result.items ?? [];
  // Keep only this collection's members (same authority can mint several).
  const mine = raw.filter((a) => groupOf(a) === collection);
  const items = await mapLimit(mine, GATEWAY_CONCURRENCY, (a) => toItem(a, collection, type));
  // Exhaustion is judged on the RAW page length, not the filtered count — a page
  // can be full of other-collection items and still have more pages to come.
  const nextPage = raw.length < PAGE_LIMIT ? null : page + 1;
  return { items, nextPage, slot: result.last_indexed_slot ?? 0 };
}

/** Walk every page of a collection (by authority) into one array + the freshness
 *  slot. Used by the ingest backfill and reusable as-is for a one-shot fallback
 *  scan. The slot is the MIN across pages: the whole scan is only consistent up
 *  to its earliest-indexed page. 0 means the RPC didn't report a slot. */
export async function scanCollection(
  collection: string,
  authority: string,
  type: IndexedItem["type"],
  urls?: string[],
): Promise<ScanResult> {
  const all: IndexedItem[] = [];
  let slot = Infinity;
  let page: number | null = 1;
  while (page !== null) {
    const p: ScanPage = await scanCollectionPage(collection, authority, type, page, urls);
    all.push(...p.items);
    if (p.slot > 0) slot = Math.min(slot, p.slot);
    page = p.nextPage;
  }
  return { items: all, slot: Number.isFinite(slot) ? slot : 0 };
}
