// HTTP client for the indexer read API. Pure fetch, no SDK/web3/bun deps — a
// consumer (the agent-sdk, a web UI) imports this to read the marketplace
// without re-implementing the query-string wiring. One IndexerClient instance
// per base URL; every method maps 1:1 to a route in src/routes.

import type { CreatorRank, IndexerItem, ItemPage, ItemQuery } from "./types.js";

export class IndexerClient {
  constructor(
    private readonly baseUrl: string,
    /** Per-request timeout. The caller's fallback (its own RPC full-scan) kicks
     *  in when these reject, so keep it short — a dead indexer shouldn't hang
     *  search. */
    private readonly timeoutMs = 4000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`indexer ${path} → HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  /** GET /items — filtered + sorted listing. Repeatable ?trait=type:value. */
  async listItems(query: ItemQuery = {}): Promise<ItemPage> {
    const p = new URLSearchParams();
    if (query.type) p.set("type", query.type);
    if (query.q) p.set("q", query.q);
    if (query.creator) p.set("creator", query.creator);
    if (query.sort) p.set("sort", query.sort);
    if (query.limit != null) p.set("limit", String(query.limit));
    if (query.offset != null) p.set("offset", String(query.offset));
    for (const t of query.traits ?? []) p.append("trait", `${t.trait_type}:${t.value}`);
    const qs = p.toString();
    return this.get<ItemPage>(`/items${qs ? `?${qs}` : ""}`);
  }

  /** GET /items/:mint — one item, or null if the indexer doesn't have it. */
  async getItem(mint: string): Promise<IndexerItem | null> {
    try {
      return await this.get<IndexerItem>(`/items/${encodeURIComponent(mint)}`);
    } catch (e) {
      if (e instanceof Error && /HTTP 404/.test(e.message)) return null;
      throw e;
    }
  }

  /** GET /items/facets/:trait_type — distinct trait values + counts (filter rail). */
  async facets(traitType: string, type?: "skill" | "workflow"): Promise<{ value: string; count: number }[]> {
    const qs = type ? `?type=${type}` : "";
    const r = await this.get<{ values: { value: string; count: number }[] }>(
      `/items/facets/${encodeURIComponent(traitType)}${qs}`,
    );
    return r.values;
  }

  /** GET /items/creators/ranking — agents by total supply of skills created. */
  async creatorRanking(limit?: number): Promise<CreatorRank[]> {
    const qs = limit != null ? `?limit=${limit}` : "";
    const r = await this.get<{ creators: CreatorRank[] }>(`/items/creators/ranking${qs}`);
    return r.creators;
  }

  /** GET /health — used to decide whether to use the indexer or fall back. */
  async healthy(): Promise<boolean> {
    try {
      const h = await this.get<{ status: string }>(`/health`);
      return h.status === "ok";
    } catch {
      return false;
    }
  }
}

export type { CreatorRank, IndexerItem, ItemPage, ItemQuery, IndexerTrait } from "./types.js";
