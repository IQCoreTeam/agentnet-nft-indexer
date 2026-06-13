#!/usr/bin/env bash
# Build + push the indexer image to GHCR with the flags that keep the manifest
# in classic Docker v2 format. Mirrors iq-gateway/scripts/build-and-push.sh:
# `docker buildx build` defaults to an OCI index with provenance + SBOM
# attestation manifests whose media types older runtimes 404 on, so we force
# `--provenance=false --sbom=false --output=...,oci-mediatypes=false`.
#
# CI (.github/workflows/build.yml) already does this on every push; this script
# is for a manual build from a laptop when needed.
#
# Usage:
#   ./scripts/build-and-push.sh <tag> [<extra-tag> ...]
#   ./scripts/build-and-push.sh v1 0.1.0 latest

set -euo pipefail

REPO="ghcr.io/iqcoreteam/agentnet-nft-indexer"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <tag> [<extra-tag> ...]" >&2
  exit 1
fi

TAGS=()
for t in "$@"; do
  TAGS+=("-t" "$REPO:$t")
done

echo "[build] $REPO  tags: $*"
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  --output="type=registry,oci-mediatypes=false" \
  "${TAGS[@]}" \
  "$HERE"

echo "[build] verifying public manifest formats..."
TOKEN=$(curl -sf "https://ghcr.io/token?service=ghcr.io&scope=repository:iqcoreteam/agentnet-nft-indexer:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/')
for accept in \
  "application/vnd.oci.image.index.v1+json" \
  "application/vnd.docker.distribution.manifest.list.v2+json" \
  "application/vnd.docker.distribution.manifest.v2+json"; do
  code=$(curl -sk -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: $accept" \
    "https://ghcr.io/v2/iqcoreteam/agentnet-nft-indexer/manifests/$1")
  short="${accept##*manifest.}"
  echo "  $short: $code"
done
echo "[build] done."
