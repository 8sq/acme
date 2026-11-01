import {
  CompiledQuery,
  type Kysely,
  type QueryExecutor,
  type QueryResult,
  SingleConnectionProvider,
  sql,
} from "kysely";
import { getDbKind, type Kind } from "./db.ts";

// Postgres serialization failures; a batch is fixed SQL, so retrying is safe.
const batchAttempts = 10;
// Random waits spread retries out; without them, they collide again at once.
const maxBackoffMs = 200;

const waitBeforeRetry = (attempt: number) => {
  const ceiling = Math.min(maxBackoffMs, 5 * 2 ** attempt);
  const delay = Math.random() * ceiling;
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
};

const executeInOrder = async (
  db: Pick<QueryExecutor, "executeQuery">,
  queries: readonly CompiledQuery[],
) => {
  const results: QueryResult<unknown>[] = [];
  for (const query of queries) {
    // oxlint-disable-next-line no-await-in-loop
    const result = await db.executeQuery(query);
    results.push(result);
  }
  return results;
};

const batchSqlite = <Schema>(
  db: Kysely<Schema>,
  queries: readonly CompiledQuery[],
) => {
  // IMMEDIATE takes the write lock up front instead of failing on upgrade.
  return db.connection().execute(async (connection) => {
    await sql`begin immediate`.execute(connection);
    try {
      const results = await executeInOrder(connection, queries);
      await sql`commit`.execute(connection);
      return results;
    } catch (error) {
      await sql`rollback`.execute(connection);
      throw error;
    }
  });
};

const isSerializationFailure = (error: unknown) => {
  return error instanceof Error && "code" in error && error.code === "40001";
};

const batchPostgres = async <Schema>(
  db: Kysely<Schema>,
  queries: readonly CompiledQuery[],
  attempt = 1,
): Promise<QueryResult<unknown>[]> => {
  try {
    return await db
      .transaction()
      .setIsolationLevel("serializable")
      .execute((trx) => executeInOrder(trx, queries));
  } catch (error) {
    if (attempt < batchAttempts && isSerializationFailure(error)) {
      await waitBeforeRetry(attempt);
      return batchPostgres(db, queries, attempt + 1);
    }
    throw error;
  }
};

const executeInParallel = <Schema>(
  db: Kysely<Schema>,
  queries: readonly CompiledQuery[],
) => {
  const pending = queries.map((query) => db.executeQuery(query));
  return Promise.all(pending);
};

const savepoint = CompiledQuery.raw("savepoint acme_batch");
const releaseSavepoint = CompiledQuery.raw("release savepoint acme_batch");
const rollbackSavepoint = CompiledQuery.raw("rollback to savepoint acme_batch");

const runInSavepoint = async (
  executor: QueryExecutor,
  queries: readonly CompiledQuery[],
) => {
  await executor.executeQuery(savepoint);
  try {
    const results = await executeInOrder(executor, queries);
    await executor.executeQuery(releaseSavepoint);
    return results;
  } catch (error) {
    try {
      await executor.executeQuery(rollbackSavepoint);
      await executor.executeQuery(releaseSavepoint);
    } catch (rollbackError) {
      const message = "batch failed, then its rollback failed";
      throw new SuppressedError(rollbackError, error, message);
    }
    throw error;
  }
};

// Holding the connection queues every other query on the transaction, its
// clones included, so a rollback can only undo this batch's writes.
const batchInTransaction = <Schema>(
  trx: Kysely<Schema>,
  queries: readonly CompiledQuery[],
) => {
  const executor = trx.getExecutor();
  return executor.provideConnection((connection) => {
    const provider = new SingleConnectionProvider(connection);
    const held = executor.withConnectionProvider(provider);
    return runInSavepoint(held, queries);
  });
};

const runners = {
  sqlite: { batch: batchSqlite, readAll: executeInOrder },
  postgres: { batch: batchPostgres, readAll: executeInParallel },
} satisfies Record<Kind, unknown>;

export const batch = <Schema>(
  db: Kysely<Schema>,
  queries: readonly CompiledQuery[],
) => {
  const runner = runners[getDbKind(db)];

  return db.isTransaction
    ? batchInTransaction(db, queries)
    : runner.batch(db, queries);
};

export const readAll = <Schema>(
  db: Kysely<Schema>,
  queries: readonly CompiledQuery[],
) => {
  const runner = runners[getDbKind(db)];
  return runner.readAll(db, queries);
};
