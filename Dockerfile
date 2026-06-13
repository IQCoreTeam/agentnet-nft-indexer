FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY src ./src

# The index DB lives here; mounted as a named volume in prod so a redeploy that
# swaps the image keeps the data. Created up front so the first boot can write
# even before the volume mount exists (local runs).
RUN mkdir -p /app/data

# NFT-only indexer. Reads a Token-2022 collection via DAS (getAssetsByGroup)
# and serves standard marketplace reads (filter by trait, sort by supply).
# Configure at runtime via env / compose env_file (see .env.example).
# Host port on iqlabs-prod-01 = 3009 (Caddy → agentnet-nft-indexer:3009).
ENV NODE_ENV=production
EXPOSE 3009
CMD ["bun", "run", "src/server.ts"]
