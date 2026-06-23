// The marketplace read API — the only thing this service exposes. Standard NFT
// marketplace endpoints: a filtered/sorted listing, a single item, trait
// facets, and a creator ranking. All reads off the derived index; supply DESC
// is the default order ("수량별 줄세우기").

import { Hono } from "hono";
import type { Context } from "hono";
import { countItems, creatorRanking, getItem, queryItems, traitFacets } from "../store/query";
import type { QueryOpts } from "../store/query";
import { reposForSkill } from "../store/workLinks";

export const itemsRouter = new Hono();

const TYPES = new Set(["skill", "workflow"]);

/** Parse repeatable ?trait=trait_type:value pairs (e.g.
 *  ?trait=category:clean-code&trait=skill:testing) into the query shape. */
function parseTraits(values: string[]): { trait_type: string; value: string }[] {
  const out: { trait_type: string; value: string }[] = [];
  for (const raw of values) {
    const i = raw.indexOf(":");
    if (i <= 0 || i === raw.length - 1) continue;
    out.push({ trait_type: raw.slice(0, i), value: raw.slice(i + 1) });
  }
  return out;
}

function readOpts(c: Context): QueryOpts {
  const type = c.req.query("type");
  const sort = c.req.query("sort");
  return {
    type: type && TYPES.has(type) ? (type as QueryOpts["type"]) : undefined,
    q: c.req.query("q") || undefined,
    creator: c.req.query("creator") || undefined,
    traits: parseTraits(c.req.queries("trait") ?? []),
    sort: sort === "name" || sort === "recent" ? sort : "supply",
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
  };
}

// GET /items — filter (type/q/trait/creator) + sort (supply|name|recent) + page.
itemsRouter.get("/", (c) => {
  const opts = readOpts(c);
  const items = queryItems(opts);
  const total = countItems(opts);
  return c.json({ total, count: items.length, offset: opts.offset ?? 0, items });
});

// GET /items/facets/:trait_type — the filter-rail values + counts. Registered
// before /:mint so the static prefix wins over the param match.
itemsRouter.get("/facets/:trait_type", (c) => {
  const type = c.req.query("type");
  return c.json({
    trait_type: c.req.param("trait_type"),
    values: traitFacets(c.req.param("trait_type"), type && TYPES.has(type) ? (type as "skill" | "workflow") : undefined),
  });
});

// GET /items/creators/ranking — agents ranked by total supply of skills created.
itemsRouter.get("/creators/ranking", (c) => {
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  return c.json({ creators: creatorRanking(limit) });
});

// GET /items/:mint/repos — verified-work repos attached to this skill, most-
// starred first. Registered before the /:mint catch-all (more specific path).
itemsRouter.get("/:mint/repos", (c) => {
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  return c.json({ mint: c.req.param("mint"), repos: reposForSkill(c.req.param("mint"), limit) });
});

// GET /items/:mint — one item by its mint (= NFT id). Last: it's the catch-all.
itemsRouter.get("/:mint", (c) => {
  const item = getItem(c.req.param("mint"));
  if (!item) return c.json({ error: "not found" }, 404);
  return c.json(item);
});
