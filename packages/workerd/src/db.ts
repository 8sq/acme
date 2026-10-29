import { env } from "cloudflare:workers";
import { type CompiledQuery, Kysely } from "kysely";
import { D1Dialect, batch as runBatch } from "kysely-cloudflare";

// Fresh per call: the dialect runs one query at a time per instance.
export const getDb = (name: string) => {
  const binding = `${name.toUpperCase()}_DB`;
  const database = (env as Record<string, D1Database | undefined>)[binding];
  if (!database) {
    const message = `no D1 binding named ${binding}: add it to wrangler.jsonc`;
    throw new Error(message);
  }

  const dialect = new D1Dialect({ database });
  return new Kysely<unknown>({ dialect });
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

// One D1 request; atomic too, though readAll() doesn't promise it.
export const readAll = batch;
