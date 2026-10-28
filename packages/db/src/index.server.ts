import {
  type CompiledQuery,
  type Kysely,
  type OperationNode,
  type QueryResult,
  SelectQueryNode,
} from "kysely";
import {
  batch as runBatch,
  getDb as getRuntimeDb,
  readAll as runReadAll,
} from "#runtime";

/**
 * Schemas by database name, filled with `declare module "@acme/db"`.
 */
// oxlint-disable-next-line no-empty-object-type
export interface Databases {}

type Schema<Name> = Name extends keyof Databases ? Databases[Name] : never;

/**
 * One `QueryResult` per query passed to `batch()` or `readAll()`, in order.
 */
export type BatchResults<Queries extends readonly CompiledQuery[]> = {
  [Index in keyof Queries]: Queries[Index] extends CompiledQuery<infer Row>
    ? QueryResult<Row>
    : never;
};

/**
 * The app's database: D1 on workerd, `DATABASE_URL` on Node.
 *
 * Only `"default"` exists so far.
 */
export const getDb = (_name: "default" = "default") => {
  return getRuntimeDb() as Kysely<Schema<"default">>;
};

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
