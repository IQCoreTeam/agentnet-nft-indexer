// Read side: the marketplace query. Filter by type + traits + keyword, sort by
// supply (popularity) or recency, paginate. Pure SQL over the derived index —
// the on-chain order is reproduced here, which is the whole point of the
// indexer (no public API sorts by Token-2022 supply, so we rank ourselves).

import { getDb } from "./db";
import type { IndexedItem, Trait } from "../types";

export interface QueryOpts {
  type?: "skill" | "workflow";
  q?: string;                          // keyword on name + description
  traits?: { trait_type: string; value: string }[]; // ANDed (each must match)
  creator?: string;
  sort?: "supply" | "name" | "recent"; // default supply DESC (= most-minted)
  limit?: number;
  offset?: number;
}

interface ItemRow {
  mint: string; collection: string; type: string; name: string;
  description: string; image: string | null; creator: string | null;
  supply: number; price: string | null; attributes: string;
}

function rowToItem(r: ItemRow): IndexedItem {
  let attributes: Trait[] = [];
  try { attributes = JSON.parse(r.attributes) as Trait[]; } catch {}
  return {
    mint: r.mint, collection: r.collection, type: r.type as IndexedItem["type"],
    name: r.name, description: r.description, image: r.image,
    creator: r.creator, supply: r.supply, price: r.price, attributes,
  };
}

const ORDER: Record<NonNullable<QueryOpts["sort"]>, string> = {
  supply: "i.supply DESC, i.name ASC",
  name: "i.name ASC",
  recent: "i.rowid DESC",
};

/** Build the WHERE fragments + args shared by query() and count(). Keyword
 *  uses FTS5 when every token is ≥3 chars (trigram floor), else LIKE — the
 *  same fallback the gateway's catalog search uses. Each trait is a correlated
 *  EXISTS so multiple traits AND together (must hold all). */
function build(opts: QueryOpts): { where: string; joins: string; args: (string | number)[] } {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  let joins = "";

  if (opts.type) { clauses.push("i.type = ?"); args.push(opts.type); }
  if (opts.creator) { clauses.push("i.creator = ?"); args.push(opts.creator); }

  const q = opts.q?.trim();
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.some((t) => t.length < 3)) {
      const esc = (s: string) => s.replace(/[\\%_]/g, "\\$&");
      for (const t of tokens) {
        clauses.push("(i.name LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\')");
        args.push(`%${esc(t)}%`, `%${esc(t)}%`);
      }
    } else {
      const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
      joins += " JOIN item_fts f ON f.mint = i.mint";
      clauses.push("item_fts MATCH ?");
      args.push(match);
    }
  }

  for (const t of opts.traits ?? []) {
    clauses.push("EXISTS (SELECT 1 FROM item_trait t WHERE t.mint = i.mint AND t.trait_type = ? AND t.value = ?)");
    args.push(t.trait_type, t.value);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", joins, args };
}

export function queryItems(opts: QueryOpts): IndexedItem[] {
  const { where, joins, args } = build(opts);
  const order = ORDER[opts.sort ?? "supply"];
  const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sql = `SELECT i.* FROM item i${joins} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const rows = getDb().query<ItemRow, (string | number)[]>(sql).all(...args, limit, offset);
  return rows.map(rowToItem);
}

export function countItems(opts: QueryOpts): number {
  const { where, joins, args } = build(opts);
  const sql = `SELECT count(*) AS n FROM item i${joins} ${where}`;
  return getDb().query<{ n: number }, (string | number)[]>(sql).get(...args)?.n ?? 0;
}

export function getItem(mint: string): IndexedItem | null {
  const r = getDb().query<ItemRow, [string]>("SELECT * FROM item WHERE mint = ?").get(mint);
  return r ? rowToItem(r) : null;
}

/** Distinct trait values for a trait_type (e.g. all categories) with how many
 *  items carry each — the facet list a marketplace shows in its filter rail. */
export function traitFacets(trait_type: string, type?: "skill" | "workflow"): { value: string; count: number }[] {
  const db = getDb();
  const sql = type
    ? `SELECT t.value, count(*) AS count FROM item_trait t JOIN item i ON i.mint = t.mint
         WHERE t.trait_type = ? AND i.type = ? GROUP BY t.value ORDER BY count DESC`
    : `SELECT value, count(*) AS count FROM item_trait WHERE trait_type = ? GROUP BY value ORDER BY count DESC`;
  const args = type ? [trait_type, type] : [trait_type];
  return db.query<{ value: string; count: number }, (string)[]>(sql).all(...args);
}

/** Agents ranked by the total supply of skills they created — "famous agent =
 *  sum of supply" (AgentNet tables.md §5). Derived live from the index. */
export function creatorRanking(limit = 24): { creator: string; totalSupply: number; items: number }[] {
  const db = getDb();
  return db.query<{ creator: string; totalSupply: number; items: number }, [number]>(
    `SELECT creator, sum(supply) AS totalSupply, count(*) AS items
       FROM item WHERE creator IS NOT NULL
       GROUP BY creator ORDER BY totalSupply DESC LIMIT ?`,
  ).all(limit);
}
