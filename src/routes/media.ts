// The NFT's public face: /image/{mint}.png and /metadata/{mint}. External
// viewers (Magic Eden, Tensor, Solscan, wallets) fetch the mint's uri over
// HTTP expecting standard NFT JSON with an image field; our mints carry a
// code-in inscription instead, so this route serves that JSON from the index
// and points image at the deterministic card renderer. The chain stays the
// source of truth: everything here is derived from indexed on-chain data.
import { Hono } from "hono";
import { PUBLIC_URL } from "../config";
import { getItem } from "../store/query";
import { renderCard } from "../render/card";

export const mediaRouter = new Hono();

// The card derives only from immutable mint data (name, description, category,
// creator, price), so long caching is safe. A layout improvement rolls out to
// CDNs within a day, which is fine for cosmetics.
const IMAGE_CACHE = "public, max-age=86400, stale-while-revalidate=604800";
const META_CACHE = "public, max-age=300";

mediaRouter.get("/image/:file", (c) => {
  const mint = c.req.param("file").replace(/\.png$/, "");
  const item = getItem(mint);
  if (!item) return c.json({ error: "unknown mint" }, 404);
  return c.body(new Uint8Array(renderCard(item)) as Uint8Array<ArrayBuffer>, 200, {
    "Content-Type": "image/png",
    "Cache-Control": IMAGE_CACHE,
  });
});

mediaRouter.get("/metadata/:mint", (c) => {
  const mint = c.req.param("mint");
  const item = getItem(mint);
  if (!item) return c.json({ error: "unknown mint" }, 404);
  const image = `${PUBLIC_URL}/image/${mint}.png`;
  c.header("Cache-Control", META_CACHE);
  return c.json({
    name: item.name,
    symbol: item.name.substring(0, 8).toUpperCase(),
    description: item.description,
    image,
    attributes: item.attributes,
    properties: { category: "image", files: [{ uri: image, type: "image/png" }] },
  });
});
