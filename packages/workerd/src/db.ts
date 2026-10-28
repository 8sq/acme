import { env } from "cloudflare:workers";
import { type CompiledQuery, Kysely } from "kysely";
import { D1Dialect, batch as runBatch } from "kysely-cloudflare";

// Fresh per call: the dialect runs one query at a time per instance.
export const getDb = () => {
  const { DEFAULT_DB: database } = env as { DEFAULT_DB?: D1Database };
  if (!database) {
    const message = "no D1 binding named DEFAULT_DB: add it to wrangler.jsonc";
    throw new Error(message);
  }

  return new Kysely<unknown>({ dialect: new D1Dialect({ database }) });
};

export const getDbKind = <Schema>(_db: Kysely<Schema>) => {
  return "d1" as const;
};

export const batch = <Schema>(
  db: Kysely<Schema>,
  queries: readonly CompiledQuery[],
) => {
  return runBatch(db, queries);
};

// One D1 request for all of them; atomic too, though readAll() doesn't promise it.
export const readAll = batch;
