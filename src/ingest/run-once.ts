// Manual one-shot ingest: `bun run ingest`. Runs a single full pass and exits —
// useful for seeding the index or debugging a collection scan without the
// server loop. Reads the same env as the server (Bun auto-loads .env).

import { COLLECTIONS, isDasConfigured } from "../config";
import { ingestAll } from "./index";

if (!isDasConfigured()) {
  console.error("no DAS RPC configured — set HELIUS_API_KEY or DAS_RPC_ENDPOINT");
  process.exit(1);
}
if (COLLECTIONS.length === 0) {
  console.error("no collections configured — set SKILLS_COLLECTION and/or WORKFLOWS_COLLECTION");
  process.exit(1);
}

const report = await ingestAll();
console.log(`done: ${report.items} items, ${report.pruned} pruned`);
