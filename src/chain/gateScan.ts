// Authoritative collection scan via the gate program — NOT DAS searchAssets.
//
// Why this replaces the authority scan: searchAssets(authorityAddress) only
// finds mints whose UPDATE AUTHORITY is the scan key. AgentNet migrated most
// items' update authority to the gate PDA (PDA-signed collection enrollment),
// so an authority scan sees only the pre-migration handful (and never a skill
// published by a *different* wallet). The gate program's ItemConfig PDA, by
// contrast, holds one record per published item regardless of who minted it —
// it is the complete, authority-independent catalog.
//
// Pipeline:
//   1. getProgramAccounts(GATE, dataSize=ItemConfig) → every ItemConfig PDA.
//      Decode {item_mint, creator, price} straight from the account bytes.
//   2. getMultipleAccounts(jsonParsed) on those mints → each mint's supply +
//      Token-2022 tokenMetadata (name, uri) + tokenGroupMember (group).
//   3. Keep only mints whose group is one of OUR configured collections (the
//      gate also holds items of old/other collections); assign skill/workflow
//      by which collection the group matches.
//   4. Enrich name/description/image/traits from the code-in inscription via
//      the gateway (same resolver the DAS path uses). creator+price come from
//      the ItemConfig; supply from the mint.

import { PublicKey } from "@solana/web3.js";
import { COLLECTIONS, WORKFLOW_GATE_PROGRAM_ID } from "../config";
import { rpcCall } from "../das/client";
import { resolveCodeIn, cleanTraits } from "../das/collection";
import type { IndexedItem, ScanResult } from "../types";

// ItemConfig (Anchor): disc(8) + bump(1) + item_mint(32) + creator(32) + price(u64 LE) + …
const ITEM_CONFIG_SIZE = 597;
const ITEM_CONFIG_DISC = "698e3c32e6c8af4b"; // sha256("account:ItemConfig")[..8], observed on-chain
const OFF_MINT = 8 + 1; // 9
const OFF_CREATOR = OFF_MINT + 32; // 41
const OFF_PRICE = OFF_CREATOR + 32; // 73

const MGA_BATCH = 100; // getMultipleAccounts caps at 100 addresses per call
const GATEWAY_CONCURRENCY = 8; // gentle on the gateway (one /data/{sig} per item)

interface GateItem {
  mint: string;
  creator: string;
  price: string; // u64 lamports, decimal string
}

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

interface GpaAccount {
  account: { data: [string, string] }; // [base64, "base64"]
}

/** Enumerate every ItemConfig PDA on the gate program and decode the fields we
 *  store from raw bytes. Returns the items + the slot the read is consistent to. */
async function listGateItems(urls?: string[]): Promise<{ items: GateItem[]; slot: number }> {
  const res = await rpcCall<{ context: { slot: number }; value: GpaAccount[] }>(
    "getProgramAccounts",
    [
      WORKFLOW_GATE_PROGRAM_ID,
      { encoding: "base64", withContext: true, filters: [{ dataSize: ITEM_CONFIG_SIZE }] },
    ],
    urls,
  );
  const items: GateItem[] = [];
  for (const a of res.value ?? []) {
    const buf = Buffer.from(a.account.data[0], "base64");
    if (buf.length < OFF_PRICE + 8) continue;
    if (buf.subarray(0, 8).toString("hex") !== ITEM_CONFIG_DISC) continue; // skip non-ItemConfig (e.g. a global config of the same size)
    items.push({
      mint: new PublicKey(buf.subarray(OFF_MINT, OFF_MINT + 32)).toBase58(),
      creator: new PublicKey(buf.subarray(OFF_CREATOR, OFF_CREATOR + 32)).toBase58(),
      price: buf.readBigUInt64LE(OFF_PRICE).toString(),
    });
  }
  return { items, slot: res.context?.slot ?? 0 };
}

interface ParsedMint {
  supply: number;
  name: string | null;
  uri: string | null;
  group: string | null;
}

interface MgaValue {
  data?: {
    parsed?: {
      info?: {
        supply?: string | number;
        extensions?: { extension: string; state?: Record<string, unknown> }[];
      };
    };
  };
}

/** Read each mint's supply + Token-2022 metadata/group via jsonParsed, batched.
 *  Throws if a batch RPC fails — the caller must NOT prune on a partial read. */
async function readMints(mints: string[], urls?: string[]): Promise<Map<string, ParsedMint>> {
  const out = new Map<string, ParsedMint>();
  for (let i = 0; i < mints.length; i += MGA_BATCH) {
    const slice = mints.slice(i, i + MGA_BATCH);
    const res = await rpcCall<{ value: (MgaValue | null)[] }>(
      "getMultipleAccounts",
      [slice, { encoding: "jsonParsed" }],
      urls,
    );
    const vals = res.value ?? [];
    slice.forEach((mint, j) => {
      const info = vals[j]?.data?.parsed?.info;
      if (!info) return;
      const exts = info.extensions ?? [];
      const md = exts.find((e) => e.extension === "tokenMetadata")?.state as { name?: string; uri?: string } | undefined;
      const gm = exts.find((e) => e.extension === "tokenGroupMember")?.state as { group?: string } | undefined;
      out.set(mint, {
        supply: Number(info.supply ?? 0) || 0,
        name: md?.name?.trim() || null,
        uri: md?.uri || null,
        group: gm?.group || null,
      });
    });
  }
  return out;
}

/**
 * Scan ALL configured collections in one pass via the gate program. Returns the
 * items (across every configured collection) + the freshness slot. Items whose
 * group is not a configured collection (old/other umbrellas the gate also holds)
 * are dropped. Trait enrichment is best-effort per item; a mint-account read
 * failure throws so the ingest skips the pass rather than pruning a half-read.
 */
export async function scanViaGate(urls?: string[]): Promise<ScanResult> {
  const byGroup = new Map(COLLECTIONS.map((c) => [c.collection, c.type] as const));

  const { items: gateItems, slot } = await listGateItems(urls);
  const parsed = await readMints(gateItems.map((g) => g.mint), urls);

  // Keep only items in a configured collection (skills / workflows we serve).
  const inScope = gateItems.filter((g) => {
    const group = parsed.get(g.mint)?.group;
    return group != null && byGroup.has(group);
  });

  const items = await mapLimit(inScope, GATEWAY_CONCURRENCY, async (g): Promise<IndexedItem> => {
    const p = parsed.get(g.mint)!;
    const group = p.group!;
    const code = p.uri ? await resolveCodeIn(p.uri) : null;
    return {
      mint: g.mint,
      collection: group,
      type: byGroup.get(group)!,
      name: (code?.name ?? p.name)?.trim() || g.mint,
      description: code?.description ?? "",
      image: code?.image ?? null,
      creator: g.creator, // ItemConfig.creator = the true publisher (NOT the migrated mint authority)
      supply: p.supply,
      price: g.price,
      attributes: cleanTraits(code?.attributes),
      stars: 0, // live fallback scan has no work_link data; stars is a read-time join
    };
  });

  return { items, slot };
}
