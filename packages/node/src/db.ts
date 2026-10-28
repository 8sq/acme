import { type Dialect, Kysely, PostgresDialect, SqliteDialect } from "kysely";

let db: Kysely<unknown> | undefined;

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

const createSqliteDatabase = async (path: string) => {
  const Database = await importDriver(
    () => import("better-sqlite3"),
    "better-sqlite3",
  );
  return new Database(path);
};

const createPostgresPool = async (url: string) => {
  const pg = await importDriver(() => import("pg"), "pg");
  return new pg.Pool({ connectionString: url });
};

const createDialect = (url: string): Dialect => {
  if (url.startsWith("sqlite:")) {
    const path = url.slice("sqlite:".length);
    return new SqliteDialect({ database: () => createSqliteDatabase(path) });
  }

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return new PostgresDialect({ pool: () => createPostgresPool(url) });
  }

  // The scheme only: a postgres URL carries a password.
  const scheme = url.split(":", 1)[0];
  const message = `DATABASE_URL: unsupported scheme "${scheme}:"`;
  throw new Error(message);
};

/**
 * One Kysely per process, over `DATABASE_URL` (`sqlite:<path>` or `postgres://...`).
 */
export const getDb = () => {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");

    db = new Kysely({ dialect: createDialect(url) });
  }

  return db;
};
