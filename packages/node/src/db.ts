import {
  type CompiledQuery,
  Kysely,
  PostgresDialect,
  PostgresIntrospector,
  type QueryResult,
  SqliteDialect,
  SqliteIntrospector,
  sql,
} from "kysely";

let instance: Kysely<unknown> | undefined;

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

const importDriver = async <Driver>(
  load: () => Promise<{ default: Driver }>,
  name: string,
) => {
  try {
    const { default: driver } = await load();
    return driver;
  } catch (error) {
    const message = `DATABASE_URL needs the ${name} package installed`;
    throw new Error(message, { cause: error });
  }
};

const createSqliteDialect = (url: string) => {
  const path = url.slice("sqlite:".length);
  return new SqliteDialect({
    database: async () => {
      const Database = await importDriver(
        () => import("better-sqlite3"),
        "better-sqlite3",
      );
      return new Database(path);
    },
  });
};

const createPostgresDialect = (url: string) => {
  return new PostgresDialect({
    pool: async () => {
      const pg = await importDriver(() => import("pg"), "pg");
      return new pg.Pool({ connectionString: url });
    },
  });
};

const executeInOrder = async <Schema>(
  db: Kysely<Schema>,
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

const databases = {
  sqlite: {
    schemes: ["sqlite"],
    Introspector: SqliteIntrospector,
    createDialect: createSqliteDialect,
    batch: batchSqlite,
    readAll: executeInOrder,
  },
  postgres: {
    schemes: ["postgres", "postgresql"],
    Introspector: PostgresIntrospector,
    createDialect: createPostgresDialect,
    batch: batchPostgres,
    readAll: executeInParallel,
  },
};

type Kind = keyof typeof databases;
const kinds = Object.keys(databases) as Kind[];

const schemeKinds = kinds.flatMap((kind) => {
  return databases[kind].schemes.map((scheme) => [scheme, kind] as const);
});
const kindsByScheme = new Map(schemeKinds);

const introspectorKinds = kinds.map((kind) => {
  return [databases[kind].Introspector, kind] as const;
});
const kindsByIntrospector = new Map<unknown, Kind>(introspectorKinds);

/**
 * One Kysely per process, from `DATABASE_URL` (`sqlite:<path>`, `postgres://`).
 */
export const getDb = () => {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");

    // The scheme only: a postgres URL carries a password.
    const scheme = url.split(":", 1)[0] ?? "";
    const kind = kindsByScheme.get(scheme);
    if (!kind) {
      const message = `DATABASE_URL: unsupported scheme "${scheme}:"`;
      throw new Error(message);
    }

    const { createDialect } = databases[kind];
    const dialect = createDialect(url);
    instance = new Kysely({ dialect });
  }

  return instance;
};

/**
 * The database behind `db`, clones from `withPlugin()` and the like included.
 */
export const getDbKind = <Schema>(db: Kysely<Schema>) => {
  const kind = kindsByIntrospector.get(db.introspection.constructor);
  if (!kind) throw new Error("not a database from getDb()");

  return kind;
};

export const batch = <Schema>(
  db: Kysely<Schema>,
  queries: readonly CompiledQuery[],
) => {
  const database = databases[getDbKind(db)];
  return database.batch(db, queries);
};

export const readAll = <Schema>(
  db: Kysely<Schema>,
  queries: readonly CompiledQuery[],
) => {
  const database = databases[getDbKind(db)];
  return database.readAll(db, queries);
};
