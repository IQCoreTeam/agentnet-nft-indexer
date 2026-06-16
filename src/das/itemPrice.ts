// Read each item's on-chain price from the gate program's ItemConfig PDA.
//
// Price is NOT in DAS or the code-in JSON — it lives in the agent-workflow-nft
// program's config account at PDA ["item", itemMint]. buy_item charges exactly
// this, so it's the source of truth the marketplace must show. We derive the PDA
// per mint and batch-read the accounts via getMultipleAccounts (100/req), then
// decode the u64 `price` field by its fixed offset.
//
// ItemConfig layout (Anchor): disc(8) + bump(1) + item_mint(32) + creator(32)
// + price(u64 LE, 8) + … → price starts at byte 73. We read only that u64; the
// rest (required_skills) isn't needed for pricing.

import { PublicKey } from "@solana/web3.js";
import { WORKFLOW_GATE_PROGRAM_ID, DAS_RPC_URLS } from "../config";

const ITEM_SEED = Buffer.from("item");
const PRICE_OFFSET = 8 + 1 + 32 + 32; // 73 — start of the u64 price field
const RPC_BATCH = 100; // getMultipleAccounts caps at 100 addresses per call

function programId(): PublicKey {
  return new PublicKey(WORKFLOW_GATE_PROGRAM_ID);
}

/** The ItemConfig PDA for an item mint = ["item", itemMint] under the gate program. */
function itemConfigPda(itemMint: string): PublicKey {
  return PublicKey.findProgramAddressSync([ITEM_SEED, new PublicKey(itemMint).toBuffer()], programId())[0];
}

/** Decode the u64 price (lamports) from a base64 ItemConfig account, as a decimal
 *  string. Returns null if the account is missing or too short (not a config). */
function decodePrice(base64: string | null | undefined): string | null {
  if (!base64) return null;
  const buf = Buffer.from(base64, "base64");
  if (buf.length < PRICE_OFFSET + 8) return null;
  return buf.readBigUInt64LE(PRICE_OFFSET).toString();
}

/** One getMultipleAccounts call (≤100 pubkeys) → base64 data per address, in order. */
async function fetchAccounts(pdas: string[], urls: string[]): Promise<(string | null)[]> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "agentnet-indexer-price",
    method: "getMultipleAccounts",
    params: [pdas, { encoding: "base64" }],
  });
  let lastErr: unknown;
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i], { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (res.status === 429 && i < urls.length - 1) continue;
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const json = (await res.json()) as {
        result?: { value: ({ data: [string, string] } | null)[] };
        error?: { message?: string };
      };
      if (json.error) throw new Error(`RPC error: ${json.error.message ?? "unknown"}`);
      const value = json.result?.value ?? [];
      return value.map((a) => a?.data?.[0] ?? null);
    } catch (e) {
      lastErr = e;
      if (i === urls.length - 1) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("getMultipleAccounts failed");
}

/**
 * Resolve prices (lamports, as decimal strings) for a list of item mints. Returns
 * a Map mint→price; a mint with no config (or unreadable) is absent. Best-effort:
 * an RPC failure for a batch leaves those mints unpriced rather than aborting the
 * whole scan. `urls` overridable so a user-RPC fallback can run the same read.
 */
export async function fetchItemPrices(
  mints: string[],
  urls: string[] = DAS_RPC_URLS,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (mints.length === 0 || urls.length === 0) return out;

  for (let i = 0; i < mints.length; i += RPC_BATCH) {
    const slice = mints.slice(i, i + RPC_BATCH);
    const pdas = slice.map((m) => itemConfigPda(m).toBase58());
    try {
      const datas = await fetchAccounts(pdas, urls);
      slice.forEach((mint, j) => {
        const price = decodePrice(datas[j]);
        if (price !== null) out.set(mint, price);
      });
    } catch {
      // leave this batch unpriced — the items still index, just without a price
    }
  }
  return out;
}
