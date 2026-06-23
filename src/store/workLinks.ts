// Read/write side of the verified-work index. Mirrors store/items.ts: prepared
// statements, idempotent upserts, plain SQL reads. The link rows are the one
// thing in this DB that is NOT rebuildable from chain (see db.ts) — they are
// written only through the verified register path (routes/workLinks.ts).

import { getDb } from "./db";

/** One stored verified-work row, as the API returns it. */
export interface WorkLink {
  skill_mint: string;
  github_repo_id: string;
  repo_owner: string;
  repo_name: string;
  repo_url: string;
  wallet: string;
  stars: number;
  forks: number;
  stats_updated_at: number;
  created_at: number;
}

/** What the register route resolved before storing: the repo identity + the
 *  wallet that proved control of it, plus the skills it claims to have used. */
export interface NewWorkLink {
  skillMints: string[];
  githubRepoId: string;
  owner: string;
  name: string;
  url: string;
  wallet: string;
  stars: number;
  forks: number;
}

/** Insert one row per claimed skill for a verified repo, in a single
 *  transaction. Idempotent: re-registering the same (skill, repo) replaces the
 *  row (refreshes wallet/url/stats) rather than erroring. Returns the rows. */
export function upsertWorkLink(link: NewWorkLink): WorkLink[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const up = db.prepare(`
    INSERT INTO work_link
      (skill_mint, github_repo_id, repo_owner, repo_name, repo_url, wallet, stars, forks, stats_updated_at, created_at)
    VALUES
      ($skill, $repoId, $owner, $name, $url, $wallet, $stars, $forks, $now, $now)
    ON CONFLICT(skill_mint, github_repo_id) DO UPDATE SET
      repo_owner=$owner, repo_name=$name, repo_url=$url, wallet=$wallet,
      stars=$stars, forks=$forks, stats_updated_at=$now
  `);

  db.transaction((mints: string[]) => {
    for (const skill of mints) {
      up.run({
        $skill: skill,
        $repoId: link.githubRepoId,
        $owner: link.owner,
        $name: link.name,
        $url: link.url,
        $wallet: link.wallet,
        $stars: link.stars,
        $forks: link.forks,
        $now: now,
      });
    }
  })(link.skillMints);

  return link.skillMints.map((skill) =>
    getDb()
      .query<WorkLink, [string, string]>(
        "SELECT * FROM work_link WHERE skill_mint = ? AND github_repo_id = ?",
      )
      .get(skill, link.githubRepoId)!,
  );
}

/** Repos attached to a skill, strongest (most-starred) first — the "top repo
 *  examples for this skill" read. */
export function reposForSkill(skillMint: string, limit = 50): WorkLink[] {
  return getDb()
    .query<WorkLink, [string, number]>(
      "SELECT * FROM work_link WHERE skill_mint = ? ORDER BY stars DESC, created_at DESC LIMIT ?",
    )
    .all(skillMint, Math.min(Math.max(limit, 1), 200));
}

/** Verified repos a wallet registered — its blog/profile work cards. Newest
 *  first. */
export function workLinksForWallet(wallet: string, limit = 100): WorkLink[] {
  return getDb()
    .query<WorkLink, [string, number]>(
      "SELECT * FROM work_link WHERE wallet = ? ORDER BY created_at DESC, stars DESC LIMIT ?",
    )
    .all(wallet, Math.min(Math.max(limit, 1), 500));
}

/** Distinct repos in the index (one entry however many skills it backs) — the
 *  worklist for the stats refresh job. */
export function distinctRepos(): { github_repo_id: string; repo_owner: string; repo_name: string }[] {
  return getDb()
    .query<{ github_repo_id: string; repo_owner: string; repo_name: string }, []>(
      "SELECT github_repo_id, repo_owner, repo_name FROM work_link GROUP BY github_repo_id",
    )
    .all();
}

/** Apply fresh stars/forks to every row of a repo (a repo attached to N skills
 *  has N rows; one fetch updates all of them). */
export function updateRepoStats(githubRepoId: string, stars: number, forks: number): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().run(
    "UPDATE work_link SET stars = ?, forks = ?, stats_updated_at = ? WHERE github_repo_id = ?",
    [stars, forks, now, githubRepoId],
  );
}

export function workLinkCount(): number {
  return getDb().query<{ n: number }, []>("SELECT count(*) AS n FROM work_link").get()?.n ?? 0;
}
