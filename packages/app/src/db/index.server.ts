import {
  type CompiledQuery,
  type Kysely,
  type OperationNode,
  type QueryResult,
  SelectQueryNode,
  sql,
} from "kysely";
import {
  batch as runBatch,
  getDb as getRuntimeDb,
  readAll as runReadAll,
} from "#runtime/db";
import { addHealthCheck } from "../server/health.ts";

/**
 * Schemas by database name, filled with `declare module "@acme/app/db"`.
 */
// oxlint-disable-next-line no-empty-object-type
export interface Databases {}

type DatabaseName = Extract<keyof Databases, string>;
type DefaultDb = Databases extends { default: infer Schema }
  ? Kysely<Schema>
  : never;
// Without a `default` database, `getDb()` reports "Expected 1 arguments".
type NoName = Databases extends { default: unknown } ? [] : [name: never];

interface GetDb {
  (...args: NoName): DefaultDb;
  <Name extends DatabaseName>(name: Name): Kysely<Databases[Name]>;
}

/**
 * One `QueryResult` per query passed to `batch()` or `readAll()`, in order.
 */
export type BatchResults<Queries extends readonly CompiledQuery[]> = {
  [Index in keyof Queries]: Queries[Index] extends CompiledQuery<infer Row>
    ? QueryResult<Row>
    : never;
};

/**
 * The D1 binding `<NAME>_DB` on workerd, `<NAME>_DATABASE_URL` on Node.
 *
 * Throws on a name missing from `@acme/vite`'s `databases`.
 *
 * @param name Defaults to `"default"`.
 */
export const getDb: GetDb = (name = "default") => {
  if (!__ACME_DATABASES__.includes(name)) {
    const message = `database "${name}" is not in @acme/vite's databases`;
    throw new Error(message);
  }

  return getRuntimeDb(name);
};

const pingDb = async (name: string) => {
  try {
    await sql`select 1`.execute(getRuntimeDb(name));
  } catch (error) {
    const message = `database "${name}" is down`;
    throw new Error(message, { cause: error });
  }
};

// Runs on import, so `/_health?full` reports it in any app using the database.
// Keep `"sideEffects": false` out of package.json, or bundlers drop this.
addHealthCheck("database", async () => {
  await Promise.all(__ACME_DATABASES__.map((name) => pingDb(name)));
});

/**
 * Runs compiled queries atomically, in order: all succeed or none do.
 *
 * Postgres retries the whole batch on serialization failures, up to 10 times.
 */
export const batch = async <Tables, Queries extends readonly CompiledQuery[]>(
  db: Kysely<Tables>,
  queries: readonly [...Queries],
) => {
  const results = await runBatch(db, queries);
  return results as BatchResults<Queries>;
};

// CTEs count too: `with x as (insert ...) select` writes.
const isSelect = (node: OperationNode): boolean => {
  if (!SelectQueryNode.is(node)) return false;

  const ctes = node.with?.expressions ?? [];
  return ctes.every((cte) => isSelect(cte.expression));
};

/**
 * Runs compiled SELECT queries, with no atomicity or shared snapshot.
 */
export const readAll = async <Tables, Queries extends readonly CompiledQuery[]>(
  db: Kysely<Tables>,
  queries: readonly [...Queries],
) => {
  if (!queries.every((query) => isSelect(query.query))) {
    throw new Error("readAll() takes SELECT queries only");
  }

  const results = await runReadAll(db, queries);
  return results as BatchResults<Queries>;
};
