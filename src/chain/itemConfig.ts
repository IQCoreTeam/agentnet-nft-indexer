// Read each item's on-chain creator and price from the gate program's ItemConfig PDA.
//
// Price is NOT in DAS or the code-in JSON — it lives in the agent-workflow-nft
// program's config account at PDA ["item", itemMint]. buy_item charges exactly
// this, so it's the source of truth the marketplace must show. We derive the PDA
// per mint and batch-read the accounts via getMultipleAccounts (100/req), then
// decode the u64 `price` field by its fixed offset.
//
// ItemConfig layout (Anchor): disc(8) + bump(1) + item_mint(32) + creator(32)
// + price(u64 LE, 8) + … → price starts at byte 73. Creator and price come from this layout;
// metadata authority can rotate independently and is never a payout identity.

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

export interface ItemConfigFields {
  mint: string;
  creator: string;
  price: string;
}

/** Shared layout for both catalog scan paths. Metadata authority is not creator. */
export function decodeItemConfig(data: Buffer): ItemConfigFields | null {
  if (data.length < PRICE_OFFSET + 8 || data.subarray(0, 8).toString("hex") !== "698e3c32e6c8af4b") return null;
  return {
    mint: new PublicKey(data.subarray(9, 41)).toBase58(),
    creator: new PublicKey(data.subarray(41, 73)).toBase58(),
    price: data.readBigUInt64LE(PRICE_OFFSET).toString(),
  };
}

interface ConfigAccount { owner: string; data: [string, string] }

/** One getMultipleAccounts call (≤100 pubkeys) → base64 data per address, in order. */
async function fetchAccounts(pdas: string[], urls: string[]): Promise<(ConfigAccount | null)[]> {
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
        result?: { value: (ConfigAccount | null)[] };
        error?: { message?: string };
      };
      if (json.error) throw new Error(`RPC error: ${json.error.message ?? "unknown"}`);
      const value = json.result?.value ?? [];
      return value;
    } catch (e) {
      lastErr = e;
      if (i === urls.length - 1) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("getMultipleAccounts failed");
}

/**
 * Resolve creator and price (lamports, as decimal strings) for a list of item mints. Returns
 * a Map mint→config; a mint with no config (or unreadable) is absent. Best-effort:
 * an RPC failure for a batch leaves those mints unpriced rather than aborting the
 * whole scan. `urls` overridable so a user-RPC fallback can run the same read.
 */
export async function fetchItemConfigs(
  mints: string[],
  urls: string[] = DAS_RPC_URLS,
): Promise<Map<string, ItemConfigFields>> {
  const out = new Map<string, ItemConfigFields>();
  if (mints.length === 0 || urls.length === 0) return out;

  for (let i = 0; i < mints.length; i += RPC_BATCH) {
    const slice = mints.slice(i, i + RPC_BATCH);
    const pdas = slice.map((m) => itemConfigPda(m).toBase58());
    try {
      const datas = await fetchAccounts(pdas, urls);
      slice.forEach((mint, j) => {
        const account = datas[j];
        if (!account || account.owner !== WORKFLOW_GATE_PROGRAM_ID) return;
        const config = decodeItemConfig(Buffer.from(account.data[0], "base64"));
        if (config?.mint === mint) out.set(mint, config);
      });
    } catch {
      // leave this batch unpriced — the items still index, just without a price
    }
  }
  return out;
}
