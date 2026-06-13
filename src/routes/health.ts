import { Hono } from "hono";
import { COLLECTIONS, CLUSTER_NAME, isDasConfigured } from "../config";
import { itemCount } from "../store/items";

export const healthRouter = new Hono();

healthRouter.get("/health", (c) =>
  c.json({
    status: "ok",
    cluster: CLUSTER_NAME,
    dasConfigured: isDasConfigured(),
    collections: COLLECTIONS.map((x) => ({ type: x.type, collection: x.collection })),
    indexed: itemCount(),
  }),
);
