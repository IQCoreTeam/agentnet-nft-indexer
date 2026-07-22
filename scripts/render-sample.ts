// Eyeball test for the card renderer: renders one real item shape and one
// worst case (long name, long description) to /tmp without touching the DB.
//   bun scripts/render-sample.ts && open /tmp/card-*.png
import { writeFileSync } from "node:fs";
import { renderCard } from "../src/render/card";
import type { IndexedItem } from "../src/types";

const real: IndexedItem = {
  mint: "Es18ADJ4ZpKDojLtvNJEBGCaXpqxsmw2kG8ihS6TJC7U",
  collection: "BUGHnCh2Pf93tgcxAEfhjd6tUjbY56JrSZdCRXyt7uS5",
  type: "skill",
  name: "learn-this-repo",
  description:
    "Rapidly build working context on an unfamiliar repository by reading a minimal high-signal set of sources - plan and architecture markdown, package manifests, entry points, recent git commits, and open GitHub issues - then produce a structured project brief.",
  image: null,
  creator: "C3EPAsjHq6DHLDzG2bXySFpUYmQ5AUqDXDfEiEsCekrH",
  supply: 2,
  price: "100000000",
  attributes: [
    { trait_type: "category", value: "development" },
    { trait_type: "skill", value: "onboarding" },
    { trait_type: "skill", value: "codebase" },
    { trait_type: "skill", value: "context" },
    { trait_type: "skill", value: "git" },
    { trait_type: "skill", value: "study" },
  ],
  stars: 0,
};

const long: IndexedItem = {
  ...real,
  mint: "LongFake11111111111111111111111111111111111",
  name: "enterprise-grade-multi-cloud-kubernetes-cluster-migration-orchestrator",
  description:
    "Plans and executes a full cluster migration between any two Kubernetes distributions across cloud providers without dropping a single request. Starts by fingerprint scanning the source cluster: every workload, CRD, operator, webhook, storage class, network policy, and the exact places where provider-specific behaviour leaks into manifests. Builds a dependency-ordered migration graph so stateful services move only after their backing stores are replicated and verified checksum clean on the target side. Traffic moves in stages: a weighted mesh shifts one percent, then ten, then half, watching golden signals at every step. Any regression beyond the error budget triggers an automatic rollback to the source cluster, which stays warm until the final cutover is signed off.",
  price: "1500000000",
  attributes: [
    { trait_type: "category", value: "infrastructure" },
    { trait_type: "skill", value: "kubernetes" },
    { trait_type: "skill", value: "migration" },
    { trait_type: "skill", value: "multi-cloud" },
    { trait_type: "skill", value: "zero-downtime" },
    { trait_type: "skill", value: "rollback" },
    { trait_type: "skill", value: "audit" },
  ],
};

for (const [label, item] of [["real", real], ["long", long]] as const) {
  const png = renderCard(item);
  writeFileSync(`/tmp/card-${label}.png`, png);
  console.log(`/tmp/card-${label}.png ${png.length} bytes`);
}
