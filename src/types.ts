// The shape an indexed item takes — a flattened read of the AgentNet on-chain
// NFT format (AgentNet plans/onchain-format/skill-nft-json.md): a Token-2022
// mint whose uri points at one standard NFT JSON
// { name, image?, description, attributes[], skillText }. We index every field
// a standard marketplace needs (traits + supply) and skip skillText — the body
// is fetched on demand by whoever runs the skill, not needed for browse/rank.

/** Standard NFT trait — the exact {trait_type, value} shape every NFT tool
 *  understands. `category` appears once; `skill` / `requiredSkill` repeat. */
export interface Trait {
  trait_type: string;
  value: string;
}

export interface IndexedItem {
  mint: string;                 // the item's Token-2022 mint = its NFT id
  collection: string;           // the umbrella collection mint
  type: "skill" | "workflow";   // which umbrella (from collection config)
  name: string;
  description: string;
  image: string | null;         // value's shape says where it lives (json §3)
  creator: string | null;       // mint update authority — recovered, not a trait
  supply: number;               // the ranking signal (+1 per buy)
  // Price in lamports a buyer pays, read from the gate program's ItemConfig PDA
  // (the on-chain source of truth — buy_item charges exactly this). Not in DAS or
  // the code-in JSON; we fetch the PDA per item. null = config not found / unread.
  price: string | null;         // u64 lamports as a decimal string (no JS number overflow)
  attributes: Trait[];          // standard traits — filterable
  stars: number;                // summed GitHub stars across repos that use this skill (issue #89)
}

/** One page of a collection scan: the items, the cursor to continue, and the
 *  slot DAS guarantees this data is indexed up to (0 if the RPC omits it). */
export interface ScanPage {
  items: IndexedItem[];
  nextPage: number | null;      // null when the collection is exhausted
  slot: number;                 // response-level last_indexed_slot
}

/** A full collection scan: every item plus the freshness slot (the lowest
 *  last_indexed_slot across pages — the floor the whole scan is consistent to).
 *  The ingest guard skips a scan whose slot is behind what's already stored. */
export interface ScanResult {
  items: IndexedItem[];
  slot: number;
}
