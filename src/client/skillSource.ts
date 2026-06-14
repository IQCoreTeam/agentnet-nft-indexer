// SkillSource adapter — bridges the indexer to the agent-sdk's search seam.
//
// The SDK's `searchSkills` accepts a `SkillSource` ({ listSkills(limit) }).
// We do NOT import the SDK's Skill / SkillSource types here — the indexer must
// stay independent of the SDK (and of PR #4). Instead this factory is generic
// over the SDK's Skill shape: the SDK passes a `mapItem` that turns our
// IndexerItem into its Skill, and gets back an object that structurally IS a
// SkillSource. Dependency points SDK → indexer, never the reverse.
//
// Crucially the adapter sets `hydrated: true`: every item already carries live
// `supply` and `attributes` (the indexer read them from the DAS scan and stored
// them), so the SDK's searchSkills can SKIP its per-mint getMintSupply loop and
// verifyTraits re-reads. That elimination is the whole point of the indexer —
// dasSource leaves supply 0 / traits empty and pays N extra RPCs to recover
// them; the indexer hands them over in one HTTP call.

import { IndexerClient } from "./index.js";
import type { IndexerItem } from "./types.js";

/** What the SDK consumes. Generic over the SDK's own Skill type (TSkill) so we
 *  never name it here. `hydrated` tells searchSkills the supply/traits are
 *  already filled — skip the on-chain re-read loops. */
export interface HydratedSkillSource<TSkill> {
  hydrated: true;
  listSkills(limit?: number): Promise<TSkill[]>;
}

/** Build a SkillSource-shaped object backed by the indexer.
 *  @param baseUrl   indexer origin (e.g. https://nft-index.iqlabs.dev)
 *  @param mapItem   SDK-supplied IndexerItem → Skill (the SDK owns Skill's shape)
 *  @param type      optionally restrict enumeration to skills or workflows
 */
export function indexerSkillSource<TSkill>(
  baseUrl: string,
  mapItem: (item: IndexerItem) => TSkill,
  type?: "skill" | "workflow",
): HydratedSkillSource<TSkill> {
  const client = new IndexerClient(baseUrl);
  return {
    hydrated: true,
    async listSkills(limit = 1000): Promise<TSkill[]> {
      // sort=supply so the enumerator already returns popularity order; the
      // SDK can still re-sort, but the common case is free.
      const page = await client.listItems({ type, sort: "supply", limit });
      return page.items.map(mapItem);
    },
  };
}
