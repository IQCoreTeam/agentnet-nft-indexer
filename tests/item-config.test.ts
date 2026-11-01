import { test, expect } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { decodeItemConfig, fetchItemConfigs } from "../src/chain/itemConfig";
import { WORKFLOW_GATE_PROGRAM_ID } from "../src/config";

function config(mint = Keypair.generate().publicKey, creator = Keypair.generate().publicKey) {
  const data = Buffer.alloc(597);
  Buffer.from("698e3c32e6c8af4b", "hex").copy(data);
  mint.toBuffer().copy(data, 9);
  creator.toBuffer().copy(data, 41);
  data.writeBigUInt64LE(100_000_000n, 73);
  return { mint, creator, data };
}

test("creator rotation is read from ItemConfig while price and mint stay stable", () => {
  const a = config();
  const next = Keypair.generate().publicKey;
  const before = decodeItemConfig(a.data);
  next.toBuffer().copy(a.data, 41);
  expect(decodeItemConfig(a.data)).toEqual({ mint: a.mint.toBase58(), creator: next.toBase58(), price: before!.price });
});

test("wrong discriminator and truncated config are rejected", () => {
  const a = config();
  expect(decodeItemConfig(a.data.subarray(0, 80))).toBeNull();
  a.data[0] ^= 1;
  expect(decodeItemConfig(a.data)).toBeNull();
});

test("one batch returns config creator; wrong owners and mismatched mints stay unverified", async () => {
  const a = config(), b = config(), c = config();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ result: { value: [
      { owner: WORKFLOW_GATE_PROGRAM_ID, data: [a.data.toString("base64"), "base64"] },
      { owner: "11111111111111111111111111111111", data: [b.data.toString("base64"), "base64"] },
      { owner: WORKFLOW_GATE_PROGRAM_ID, data: [a.data.toString("base64"), "base64"] },
    ] } }));
  }) as typeof fetch;
  try {
    const result = await fetchItemConfigs([a.mint.toBase58(), b.mint.toBase58(), c.mint.toBase58()], ["https://example.invalid"]);
    expect(calls).toBe(1);
    expect(result.size).toBe(1);
    expect(result.get(a.mint.toBase58())?.creator).toBe(a.creator.toBase58());
  } finally { globalThis.fetch = original; }
});
