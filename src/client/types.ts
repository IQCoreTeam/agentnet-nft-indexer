// Public client types — the wire shape consumers (the SDK, a web UI) get back
// from the indexer's read API. Re-declared here (not imported from ../types)
// so a consumer can `import type { IndexerItem } from "agentnet-nft-indexer/client"`
// without pulling in any server/bun/sqlite code. Kept structurally identical to
// the server's IndexedItem; if they ever drift, the response parse is the seam.

export interface IndexerTrait {
  trait_type: string;
  value: string;
}

export interface IndexerItem {
  mint: string;
  collection: string;
  type: "skill" | "workflow";
  name: string;
  description: string;
  image: string | null;
  creator: string | null;
  supply: number;
  price: string | null; // lamports (decimal string) from the on-chain ItemConfig PDA
  attributes: IndexerTrait[];
}

/** A page from GET /items. */
export interface ItemPage {
  total: number;
  count: number;
  offset: number;
  items: IndexerItem[];
}

/** A creator from GET /items/creators/ranking. */
export interface CreatorRank {
  creator: string;
  totalSupply: number;
  items: number;
}

/** Filters accepted by the /items listing — mirrors the server query params. */
export interface ItemQuery {
  type?: "skill" | "workflow";
  q?: string;
  /** Each entry is ANDed; the item must carry every one. */
  traits?: IndexerTrait[];
  creator?: string;
  sort?: "supply" | "name" | "recent";
  limit?: number;
  offset?: number;
}
