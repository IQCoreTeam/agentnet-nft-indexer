// The indexer's only outbound HTTP besides DAS/gateway: GitHub public reads.
// Two calls, both for public data:
//   - the `.agentnet` marker on a repo (raw.githubusercontent — no auth), the
//     ownership proof the register path verifies;
//   - the repo's numeric id + star/fork counts (api.github.com), used as the
//     stable key and the cached ranking signal.
// A service GITHUB_TOKEN (public-read) only raises the rate limit; the user's
// PAT is never sent here (verified-work-indexer.md §6). Plain fetch — Bun global.

import { GITHUB_TOKEN } from "./config";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const UA = "agentnet-nft-indexer"; // GitHub requires a User-Agent

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": UA, Accept: "application/vnd.github+json" };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

/** Accept "owner/name", a github.com URL, or an ssh/`.git` form and return the
 *  canonical { owner, name }. Returns null when it isn't a recognizable repo. */
export function parseRepo(input: string): { owner: string; name: string } | null {
  let s = (input || "").trim();
  if (!s) return null;
  // strip a URL/host down to the path
  s = s.replace(/^git@github\.com:/i, "").replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  s = s.replace(/\.git$/i, "").replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const name = parts[1];
  // GitHub owner/name charset — reject anything that wouldn't be a real repo path
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  return { owner, name };
}

/** Read the repo's `.agentnet` marker (default branch root) and pull the wallet
 *  it claims. Public raw read, no token. Returns the wallet string or null when
 *  the file is missing / has no wallet line. The marker is simple `key: value`
 *  lines; `#` comments and blanks are ignored. */
export async function fetchMarkerWallet(owner: string, name: string): Promise<string | null> {
  const res = await fetch(`${RAW}/${owner}/${name}/HEAD/.agentnet`, { headers: { "User-Agent": UA } });
  if (!res.ok) return null; // 404 = no marker
  const text = await res.text();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    if (line.slice(0, i).trim().toLowerCase() === "wallet") {
      const v = line.slice(i + 1).trim();
      if (v) return v;
    }
  }
  return null;
}

export interface RepoMeta {
  id: string; // numeric repo id as string — stable across renames
  owner: string;
  name: string;
  url: string;
  stars: number;
  forks: number;
}

/** Resolve a repo's stable id + current stars/forks. Returns null on 404 /
 *  error so callers reject the registration cleanly. */
export async function fetchRepoMeta(owner: string, name: string): Promise<RepoMeta | null> {
  const res = await fetch(`${API}/repos/${owner}/${name}`, { headers: ghHeaders() });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    id?: number;
    full_name?: string;
    html_url?: string;
    owner?: { login?: string };
    name?: string;
    stargazers_count?: number;
    forks_count?: number;
  };
  if (typeof j.id !== "number") return null;
  return {
    id: String(j.id),
    owner: j.owner?.login ?? owner,
    name: j.name ?? name,
    url: j.html_url ?? `https://github.com/${owner}/${name}`,
    stars: j.stargazers_count ?? 0,
    forks: j.forks_count ?? 0,
  };
}

/** Just the live stars/forks for the refresh job (skips the marker re-check). */
export async function fetchRepoStats(owner: string, name: string): Promise<{ stars: number; forks: number } | null> {
  const meta = await fetchRepoMeta(owner, name);
  return meta ? { stars: meta.stars, forks: meta.forks } : null;
}
