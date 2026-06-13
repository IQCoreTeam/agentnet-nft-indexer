# agentnet-nft-indexer

A standalone, **NFT-only** indexer for AgentNet's on-chain skill/workflow NFTs.
It scans the Token-2022 collections via DAS and serves the reads a standard NFT
marketplace needs — filter by trait, sort by `supply` (popularity). Nothing
else: no sessions, no IQLabs tables, no chain writes.

## Why this exists (and why it's separate)

AgentNet's on-chain format was designed to **stand alone** — a skill is a
Token-2022 mint whose `uri` points at one standard NFT JSON
(`{ name, image?, description, attributes[], skillText }`), enumerable by a DAS
collection scan. The format docs (`AgentNet/plans/onchain-format/`) deliberately
**do not** bake any index into the chain layer:

> "Marketplace-grade search is a later concern, built then by following whatever
> model NFT marketplaces use at that time … it sits behind the existing
> `SkillSource` seam and is **never** an IQLabs table."

This service **is** that later concern, built as its own thing. It owns no data:
the chain is the source of truth, the SQLite index is derived and can be deleted
and rebuilt at any time. It also stays out of `iq-gateway` on purpose — the
gateway is the general IQLabs data gateway; pure-NFT marketplace indexing is a
separate endpoint with a separate lifecycle.

## Data model

One read per item, flattened from the on-chain NFT JSON:

| field | from | use |
|---|---|---|
| `mint` | DAS asset id | the NFT id |
| `type` | which configured collection | skill / workflow |
| `name` / `description` / `image` | `content.metadata` (DAS resolves the `uri`) | display + keyword |
| `attributes[]` | `content.metadata.attributes` | trait filter (`category`, `skill`, `requiredSkill`) |
| `supply` | `token_info.supply` | **the ranking signal** (+1 per buy) |
| `creator` | mint update authority | creator ranking |

Stored in `bun:sqlite` (same stack as `iq-gateway`'s cache): an `item` table,
an exploded `item_trait` table for indexed trait filtering, and an `item_fts`
FTS5 (trigram) index for keyword search.

### Staleness guard

Each scan carries DAS's response-level `last_indexed_slot` (DAS exposes no
per-asset slot). The ingest stores it per collection in `collection_meta` and
**skips a scan whose slot is behind what's already stored** — so a slow RPC
returning an older snapshot can't overwrite fresher `supply` numbers. A scan
with no reported slot (`0`) always applies; the guard is opt-in on the data, not
a hard requirement. This is the one technique borrowed from the DAS reference
indexer (`metaplex-foundation/digital-asset-rpc-infrastructure`), adapted from
its per-asset `slot_updated` to our per-collection full-scan model.

## API

```
GET  /health                         status + configured collections + indexed count
GET  /items                          list — filters + sort + pagination (below)
GET  /items/:mint                    one item by mint
GET  /items/facets/:trait_type       distinct trait values + counts (filter rail), ?type=
GET  /items/creators/ranking         agents ranked by total supply of skills they created
POST /fallback/scan                  live scan against the caller's own RPC (see Fallback)
```

`/items` query params:
- `type` = `skill` | `workflow`
- `q` = keyword on name + description (FTS5 ≥3 chars, LIKE substring below that)
- `trait` = `trait_type:value`, repeatable and **ANDed** (e.g. `?trait=category:clean-code&trait=skill:testing`)
- `creator` = filter to one creator wallet
- `sort` = `supply` (default, most-minted first) | `name` | `recent`
- `limit` (≤100, default 24) / `offset`

## Fallback — the index is an accelerator, never a gate

Because the on-chain format stands alone, the indexer is never required to read
the marketplace. Two fallbacks:

1. **Empty index is a real state.** If the collections aren't minted yet, or DAS
   isn't configured here, `/items` returns an honest empty list (not an error).
2. **Bring-your-own-RPC live scan.** `POST /fallback/scan { collection, type?, rpc, sort? }`
   runs the *same* collection scan against the caller's own DAS RPC and returns
   the same supply-sorted shape — so a user who distrusts our index, or hits it
   cold, still gets ranked results. We never store their RPC url. If their RPC
   has no DAS support, the exact same scan logic (`scanCollection`) can be run
   client-side instead — the on-chain data is all that's needed.

## Configure & run

Copy `.env.example` → `.env` and set a DAS RPC + the collection mints. Same
Helius key convention as `iq-gateway` (`HELIUS_API_KEY` / `HELIUS_API_KEYS`,
or an explicit `DAS_RPC_ENDPOINT`).

```bash
bun install
bun run dev          # watch mode
bun run ingest       # one-shot backfill (seed/debug without the server loop)
bun run start        # production
```

The server runs an ingest backfill ~3s after boot, then re-scans every
`INGEST_INTERVAL_MS` (default 10 min) so the `supply` ranking stays fresh.

## Deploy

Mirrors `iq-gateway`. CI (`.github/workflows/build.yml`) builds a single
`oven/bun:1` image and pushes to **GHCR** (`ghcr.io/iqcoreteam/agentnet-nft-indexer`,
provenance/SBOM off so prod pulls a clean v2 manifest), then SSH-deploys to
`iqlabs-prod-01`.

- **Port:** the container listens on **3009** (`Caddy → agentnet-nft-indexer:3009`),
  served at `https://nft-index.iqlabs.dev` (Cloudflare-proxied).
- **Volume:** `/app/data` (the SQLite index) → `/srv/iqlabs/data/agentnet-nft-indexer`,
  so a redeploy keeps the index. (It's derived from chain, so losing it only
  means a cold re-scan, never data loss.)
- **Deploy key:** an isolated ed25519 key whose `authorized_keys` entry is
  forced-command-locked to `deploy.sh agentnet-nft-indexer` server-side — a leaked
  key can only redeploy this one service. CI runs the deploy step once the repo
  has secrets `DEPLOY_HOST` / `DEPLOY_SSH_KEY` / `SSH_HOST_KEY` and the repo
  variable `DEPLOY_ENABLED=true` (flipped on after infra registers the key).
- **Env:** injected by the prod `docker compose` via an `env_file` on the server
  (`HELIUS_API_KEY`, `SOLANA_CLUSTER`, `SKILLS_COLLECTION` / `WORKFLOWS_COLLECTION`).
  Not managed in this repo.

The compose service block, Caddy block, env file, and DNS are added by infra on
the server — this repo owns only the image + the CI that pushes & triggers it.
