// Verified-work API. The first WRITE endpoint in this service (everything else
// is a derived read), so the write is trust-minimized rather than key-gated:
// anyone may POST, but a row is only stored when the repo's public `.agentnet`
// marker proves the wallet controls it. No shared secret; the user's PAT never
// reaches the indexer (verified-work-indexer.md §2, §6). No wallet signature —
// the marker IS the proof; the only signature in AgentNet is session-key
// derivation, which is unrelated.

import { Hono } from "hono";
import { fetchMarkerWallet, fetchRepoMeta, parseRepo } from "../github";
import { reposForSkill, upsertWorkLink, workLinksForWallet } from "../store/workLinks";

export const workLinksRouter = new Hono();

const MAX_SKILLS = 20; // a single repo claiming more skills than this is spam, not a real attach

// POST /work-links — register a repo as verified work for one or more skills.
// body: { repo: "owner/name" | url, skillMints: string[], wallet }
workLinksRouter.post("/", async (c) => {
  let body: { repo?: unknown; skillMints?: unknown; wallet?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const repoInput = typeof body.repo === "string" ? body.repo : "";
  const skillMints = Array.isArray(body.skillMints)
    ? [...new Set(body.skillMints.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()))]
    : [];

  if (!wallet) return c.json({ error: "wallet required" }, 400);
  if (skillMints.length === 0) return c.json({ error: "skillMints required" }, 400);
  if (skillMints.length > MAX_SKILLS) return c.json({ error: `too many skills (max ${MAX_SKILLS})` }, 400);

  const repo = parseRepo(repoInput);
  if (!repo) return c.json({ error: "repo must be owner/name or a github url" }, 400);

  // Ownership proof: the repo's public `.agentnet` must name this wallet. This is
  // the whole gate — only someone who can commit to the repo could have put it
  // there, and only the named wallet may claim it.
  const markerWallet = await fetchMarkerWallet(repo.owner, repo.name).catch(() => null);
  if (!markerWallet) {
    return c.json({ error: "no .agentnet marker found on the repo's default branch" }, 422);
  }
  if (markerWallet !== wallet) {
    return c.json({ error: "the repo's .agentnet wallet does not match the requesting wallet" }, 403);
  }

  // Resolve the stable repo id + current stars/forks (also confirms the repo is
  // public and real). 404/error here means we can't index it.
  const meta = await fetchRepoMeta(repo.owner, repo.name).catch(() => null);
  if (!meta) return c.json({ error: "repo not found or not public" }, 422);

  const rows = upsertWorkLink({
    skillMints,
    githubRepoId: meta.id,
    owner: meta.owner,
    name: meta.name,
    url: meta.url,
    wallet,
    stars: meta.stars,
    forks: meta.forks,
  });

  return c.json({ ok: true, count: rows.length, links: rows });
});

// GET /work-links?wallet=<wallet>  — verified work for a blog/profile.
// GET /work-links?skill=<mint>     — top repos for a skill (stars DESC).
workLinksRouter.get("/", (c) => {
  const wallet = c.req.query("wallet");
  const skill = c.req.query("skill");
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  if (wallet) return c.json({ wallet, links: workLinksForWallet(wallet, limit) });
  if (skill) return c.json({ skill, repos: reposForSkill(skill, limit) });
  return c.json({ error: "pass ?wallet= or ?skill=" }, 400);
});
