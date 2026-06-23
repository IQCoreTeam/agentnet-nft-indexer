// Refresh cached GitHub stars/forks for every repo in the verified-work index.
// Mirrors src/ingest: a delayed first pass on boot, then a periodic refresh.
// Pull-only and rate-limit friendly — one GitHub call per distinct repo (a repo
// attached to N skills is fetched once and its N rows updated together), on a
// slow cadence (default 12h), because stars move slowly and are only a display
// hint. Idempotent; safe to run while serving.

import { STATS_INTERVAL_MS } from "../config";
import { distinctRepos, updateRepoStats } from "../store/workLinks";
import { fetchRepoStats } from "../github";

export interface StatsReport {
  repos: number;
  updated: number;
  failed: number;
}

/** One pass over every distinct repo: fetch live stars/forks, write them to all
 *  rows of that repo. A repo that errors (deleted, rate-limited) is left at its
 *  last-known counts and counted as failed — never zeroed. */
export async function refreshAllStats(): Promise<StatsReport> {
  const repos = distinctRepos();
  let updated = 0;
  let failed = 0;
  for (const r of repos) {
    const stats = await fetchRepoStats(r.repo_owner, r.repo_name).catch(() => null);
    if (!stats) { failed++; continue; }
    updateRepoStats(r.github_repo_id, stats.stars, stats.forks);
    updated++;
  }
  return { repos: repos.length, updated, failed };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Schedule the stats refresh loop. Always safe to call: with an empty index it
 *  just finds no repos. The first pass is delayed so boot stays fast. */
export function startStatsJob(intervalMs = STATS_INTERVAL_MS): void {
  if (timer) return;
  const run = (label: string) =>
    refreshAllStats()
      .then((r) => console.log(`[stats] ${label}: ${r.updated}/${r.repos} repos refreshed, ${r.failed} failed`))
      .catch((e) => console.warn(`[stats] ${label} failed:`, e instanceof Error ? e.message : e));

  setTimeout(() => run("refresh"), 15_000);
  timer = setInterval(() => run("refresh"), intervalMs);
}
