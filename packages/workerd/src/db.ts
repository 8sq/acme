import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-cloudflare";

// Fresh per call: the dialect runs one query at a time per instance.
export const getDb = () => {
  const { DEFAULT_DB: database } = env as { DEFAULT_DB?: D1Database };
  if (!database) {
    const message = "no D1 binding named DEFAULT_DB: add it to wrangler.jsonc";
    throw new Error(message);
  }

  return new Kysely<unknown>({ dialect: new D1Dialect({ database }) });
};
