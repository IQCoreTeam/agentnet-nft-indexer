// DAS JSON-RPC client. One chokepoint for every outbound DAS call, with the
// same key-rotation-on-429 behaviour as iq-gateway's Helius helper. Plain
// fetch — no web3.js/SDK dependency, because DAS is a pure HTTP JSON-RPC API.

import { DAS_RPC_URLS } from "../config";

/** Call a DAS method against the first configured RPC url, rotating to the
 *  next on a 429 (rate limit). `urls` is overridable so a request can run the
 *  same call against a user-supplied RPC instead (the client-side fallback). */
export async function dasRpc<T>(
  method: string,
  params: Record<string, unknown>,
  urls: string[] = DAS_RPC_URLS,
): Promise<T> {
  if (urls.length === 0) throw new Error("no DAS RPC configured");

  const body = JSON.stringify({ jsonrpc: "2.0", id: "agentnet-indexer", method, params });
  let lastErr: unknown;

  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.status === 429 && i < urls.length - 1) continue;
      if (!res.ok) throw new Error(`DAS HTTP ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error) throw new Error(`DAS error: ${json.error.message ?? "unknown"}`);
      if (json.result === undefined) throw new Error("DAS empty result");
      return json.result;
    } catch (e) {
      lastErr = e;
      if (i === urls.length - 1) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("DAS request failed");
}
