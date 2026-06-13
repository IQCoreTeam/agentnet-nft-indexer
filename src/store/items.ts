// Write side of the index: upsert items (with their exploded traits + FTS row)
// and prune items that left a collection. Idempotent — re-ingesting the same
// mint replaces every derived row for it, so supply changes and trait edits
// land cleanly.

import { getDb } from "./db";
import type { IndexedItem } from "../types";

/** Replace one item and all its derived rows in a single transaction. */
export function upsertItems(items: IndexedItem[]): void {
  if (items.length === 0) return;
  const db = getDb();

  const upItem = db.prepare(`
    INSERT INTO item (mint, collection, type, name, description, image, creator, supply, attributes)
    VALUES ($mint, $collection, $type, $name, $description, $image, $creator, $supply, $attributes)
    ON CONFLICT(mint) DO UPDATE SET
      collection=$collection, type=$type, name=$name, description=$description,
      image=$image, creator=$creator, supply=$supply, attributes=$attributes
  `);
  const delTraits = db.prepare("DELETE FROM item_trait WHERE mint = ?");
  const insTrait = db.prepare("INSERT INTO item_trait (mint, trait_type, value) VALUES (?, ?, ?)");
  const delFts = db.prepare("DELETE FROM item_fts WHERE mint = ?");
  const insFts = db.prepare("INSERT INTO item_fts (mint, name, description) VALUES (?, ?, ?)");

  db.transaction((rows: IndexedItem[]) => {
    for (const it of rows) {
      upItem.run({
        $mint: it.mint,
        $collection: it.collection,
        $type: it.type,
        $name: it.name,
        $description: it.description,
        $image: it.image,
        $creator: it.creator,
        $supply: it.supply,
        $attributes: JSON.stringify(it.attributes),
      });
      delTraits.run(it.mint);
      for (const t of it.attributes) insTrait.run(it.mint, t.trait_type, t.value);
      delFts.run(it.mint);
      insFts.run(it.mint, it.name, it.description);
    }
  })(items);
}

/** Drop every indexed mint of a collection that isn't in `keep` — items that
 *  were burned or otherwise left the collection between scans. Run after a full
 *  backfill of that collection so the index never serves stale entries. */
export function pruneCollection(collection: string, keep: Set<string>): number {
  const db = getDb();
  const existing = db.query<{ mint: string }, [string]>("SELECT mint FROM item WHERE collection = ?").all(collection);
  const stale = existing.filter((r) => !keep.has(r.mint)).map((r) => r.mint);
  if (stale.length === 0) return 0;
  const delItem = db.prepare("DELETE FROM item WHERE mint = ?");
  const delFts = db.prepare("DELETE FROM item_fts WHERE mint = ?");
  db.transaction((mints: string[]) => {
    for (const m of mints) { delItem.run(m); delFts.run(m); } // item_trait cascades
  })(stale);
  return stale.length;
}

export function itemCount(): number {
  return getDb().query<{ n: number }, []>("SELECT count(*) AS n FROM item").get()?.n ?? 0;
}

/** The slot a collection's stored data is consistent to (0 if never ingested). */
export function getCollectionSlot(collection: string): number {
  return getDb()
    .query<{ last_slot: number }, [string]>("SELECT last_slot FROM collection_meta WHERE collection = ?")
    .get(collection)?.last_slot ?? 0;
}

export function setCollectionSlot(collection: string, slot: number): void {
  getDb().run(
    "INSERT INTO collection_meta (collection, last_slot) VALUES (?, ?) ON CONFLICT(collection) DO UPDATE SET last_slot = ?",
    [collection, slot, slot],
  );
}
