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
      attributes  TEXT NOT NULL DEFAULT '[]'
    )
  `);
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
}
