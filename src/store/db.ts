// The one SQLite handle, opened lazily. bun:sqlite, same as iq-gateway's cache
// store. The whole DB is a DERIVED index — chain is the source of truth — so
// it's safe to delete and let the ingest job rebuild it.

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DB_PATH } from "../config";

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  prepare(db);
  return db;
}

function prepare(d: Database): void {
  // One row per item. attributes kept as JSON for the API; traits are also
  // exploded into item_trait so filtering is an indexed join, not a JSON scan.
  d.run(`
    CREATE TABLE IF NOT EXISTS item (
      mint        TEXT PRIMARY KEY,
      collection  TEXT NOT NULL,
      type        TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      image       TEXT,
      creator     TEXT,
      supply      INTEGER NOT NULL DEFAULT 0,
      price       TEXT,
      attributes  TEXT NOT NULL DEFAULT '[]'
    )
  `);
  // price was added after launch — bring an existing DB up to schema (SQLite has no
  // "ADD COLUMN IF NOT EXISTS"; a duplicate-column error means it's already there).
  try { d.run("ALTER TABLE item ADD COLUMN price TEXT"); } catch { /* column exists */ }
  d.run("CREATE INDEX IF NOT EXISTS idx_item_type_supply ON item(type, supply DESC)");
  d.run("CREATE INDEX IF NOT EXISTS idx_item_creator ON item(creator)");

  // Exploded traits: one row per {mint, trait_type, value}. The category/skill/
  // requiredSkill filters are equality lookups against this, intersected per
  // mint. Cascades with the item so a re-ingest replace stays consistent.
  d.run(`
    CREATE TABLE IF NOT EXISTS item_trait (
      mint       TEXT NOT NULL,
      trait_type TEXT NOT NULL,
      value      TEXT NOT NULL,
      FOREIGN KEY (mint) REFERENCES item(mint) ON DELETE CASCADE
    )
  `);
  d.run("CREATE INDEX IF NOT EXISTS idx_trait_lookup ON item_trait(trait_type, value, mint)");
  d.run("PRAGMA foreign_keys = ON");

  // Per-collection freshness: the last_indexed_slot the stored data is
  // consistent to. The ingest guard skips a scan whose slot is behind this, so
  // a stale (e.g. slow-RPC) snapshot never overwrites fresher supply numbers.
  d.run(`
    CREATE TABLE IF NOT EXISTS collection_meta (
      collection TEXT PRIMARY KEY,
      last_slot  INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Keyword search over name + description. Trigram tokenizer = substring +
  // prefix match across mixed-language strings, exactly like the gateway's
  // catalog_fts. content-less FTS keyed by mint (rowid stand-in via UNINDEXED).
  d.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS item_fts USING fts5(
      mint UNINDEXED,
      name,
      description,
      tokenize='trigram'
    )
  `);

  // Verified-work links: a GitHub repo a wallet attached to a Skill NFT as proof
  // of work done with that skill. UNLIKE every other table here, this one is NOT
  // derived from chain — it is the indexer's own data (the claim "wallet W used
  // skill S in repo R" lives nowhere on chain), so these rows are a backup target.
  // One row per (skill, repo): a repo using N skills makes N rows. Stars/forks are
  // a cached public GitHub signal refreshed by the stats job (src/stats), never a
  // source of truth — a display/ranking hint only. Ownership is verified at write
  // time by reading the repo's public `.agentnet` marker (src/routes/workLinks).
  d.run(`
    CREATE TABLE IF NOT EXISTS work_link (
      skill_mint       TEXT NOT NULL,
      github_repo_id   TEXT NOT NULL,
      repo_owner       TEXT NOT NULL,
      repo_name        TEXT NOT NULL,
      repo_url         TEXT NOT NULL,
      wallet           TEXT NOT NULL,
      stars            INTEGER NOT NULL DEFAULT 0,
      forks            INTEGER NOT NULL DEFAULT 0,
      stats_updated_at INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (skill_mint, github_repo_id)
    )
  `);
  // skill -> its repos sorted by stars (the "top examples for a skill" read);
  // wallet -> verified work for the blog/profile; repo_id -> every row to fan a
  // single stats refresh across all skills a repo is attached to.
  d.run("CREATE INDEX IF NOT EXISTS idx_worklink_skill ON work_link(skill_mint, stars DESC)");
  d.run("CREATE INDEX IF NOT EXISTS idx_worklink_wallet ON work_link(wallet)");
  d.run("CREATE INDEX IF NOT EXISTS idx_worklink_repo ON work_link(github_repo_id)");
}
