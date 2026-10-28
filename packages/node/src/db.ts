import { type Dialect, Kysely, PostgresDialect, SqliteDialect } from "kysely";

let db: Kysely<unknown> | undefined;

type Scheme = [
  kind: "sqlite" | "postgres",
  createDialect: (url: string) => Dialect,
];

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

const schemes = new Map<string, Scheme>(
  Object.entries({
    sqlite: ["sqlite", createSqliteDialect],
    postgres: ["postgres", createPostgresDialect],
    postgresql: ["postgres", createPostgresDialect],
  }),
);

const getUrl = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  return url;
};

const getScheme = (url: string) => {
  // The name only: a postgres URL carries a password.
  const name = url.split(":", 1)[0] ?? "";
  const scheme = schemes.get(name);
  if (scheme) return scheme;

  const message = `DATABASE_URL: unsupported scheme "${name}:"`;
  throw new Error(message);
};

/**
 * One Kysely per process, over `DATABASE_URL` (`sqlite:<path>` or `postgres://...`).
 */
export const getDb = () => {
  if (!db) {
    const url = getUrl();
    const [, createDialect] = getScheme(url);
    db = new Kysely({ dialect: createDialect(url) });
  }

  return db;
};

/**
 * The database `getDb()` connects to, from the `DATABASE_URL` scheme.
 */
export const getDbKind = () => {
  const [kind] = getScheme(getUrl());
  return kind;
};
