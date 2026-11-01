// oxlint-disable max-classes-per-file -- Kysely extends by subclassing
import {
  CompiledQuery,
  type DatabaseConnection,
  Kysely,
  PostgresDialect,
  PostgresIntrospector,
  SqliteAdapter,
  SqliteDialect,
  type SqliteDialectConfig,
  SqliteDriver,
  SqliteIntrospector,
} from "kysely";

const instances = new Map<string, Kysely<unknown>>();

const importDriver = async <Driver>(
  load: () => Promise<{ default: Driver }>,
  name: string,
  variable: string,
) => {
  try {
    const { default: driver } = await load();
    return driver;
  } catch (error) {
    const message = `${variable} needs the ${name} package installed`;
    throw new Error(message, { cause: error });
  }
};

// SQLite runs DDL in transactions; Kysely's adapter says otherwise, so the
// migrator would apply migrations one by one and leave failures half-done.
class TransactionalSqliteAdapter extends SqliteAdapter {
  // oxlint-disable-next-line class-methods-use-this
  public override get supportsTransactionalDdl() {
    return true;
  }
}

// IMMEDIATE takes the write lock before the first read, so a second migrator
// process waits for the first instead of reading the state it is changing.
class ImmediateSqliteDriver extends SqliteDriver {
  // oxlint-disable-next-line class-methods-use-this
  public override async beginTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw("begin immediate"));
  }
}

class TransactionalSqliteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig;

  public constructor(config: SqliteDialectConfig) {
    super(config);
    this.#config = config;
  }

  public override createDriver() {
    return new ImmediateSqliteDriver(this.#config);
  }

  // oxlint-disable-next-line class-methods-use-this
  public override createAdapter() {
    return new TransactionalSqliteAdapter();
  }
}

const createSqliteDialect = (url: string, variable: string) => {
  const path = url.slice("sqlite:".length);
  return new TransactionalSqliteDialect({
    database: async () => {
      const Database = await importDriver(
        () => import("better-sqlite3"),
        "better-sqlite3",
        variable,
      );
      return new Database(path);
    },
  });
};

const createPostgresDialect = (url: string, variable: string) => {
  return new PostgresDialect({
    pool: async () => {
      const pg = await importDriver(() => import("pg"), "pg", variable);
      // Idle clients would hold the event loop open for their 10s idle timeout.
      const pool = new pg.Pool({
        connectionString: url,
        allowExitOnIdle: true,
      });
      // Without a listener, an idle client's error event kills the process.
      // pg has already removed that client, so logging is all that is left.
      pool.on("error", (error) => {
        console.error(`${variable}: idle connection failed`, error);
      });
      return pool;
    },
  });
};

const databases = {
  sqlite: {
    schemes: ["sqlite"],
    Introspector: SqliteIntrospector,
    createDialect: createSqliteDialect,
  },
  postgres: {
    schemes: ["postgres", "postgresql"],
    Introspector: PostgresIntrospector,
    createDialect: createPostgresDialect,
  },
};

export type Kind = keyof typeof databases;
const kinds = Object.keys(databases) as Kind[];

const schemeKinds = kinds.flatMap((kind) => {
  return databases[kind].schemes.map((scheme) => [scheme, kind] as const);
});
const kindsByScheme = new Map(schemeKinds);

const introspectorKinds = kinds.map((kind) => {
  return [databases[kind].Introspector, kind] as const;
});
const kindsByIntrospector = new Map<unknown, Kind>(introspectorKinds);

const createDb = (name: string) => {
  const variable = `${name.toUpperCase()}_DATABASE_URL`;
  const url = process.env[variable];
  if (!url) throw new Error(`${variable} is not set`);

  // The scheme only: a postgres URL carries a password.
  const scheme = url.split(":", 1)[0] ?? "";
  const kind = kindsByScheme.get(scheme);
  if (!kind) {
    const message = `${variable}: unsupported scheme "${scheme}:"`;
    throw new Error(message);
  }

  const { createDialect } = databases[kind];
  const dialect = createDialect(url, variable);
  return new Kysely<unknown>({ dialect });
};

const destroyAll = () => {
  const opened = [...instances.values()];
  instances.clear();
  const destroying = opened.map((db) => db.destroy());
  Promise.all(destroying).catch((error: unknown) => {
    console.error("closing the databases failed", error);
    process.exitCode = 1;
  });
};

/**
 * One Kysely per name per process, from `<NAME>_DATABASE_URL`
 * (`sqlite:<path>`, `postgres://`).
 *
 * Every database closes when the event loop drains, after the host's shutdown.
 */
export const getDb = (name: string) => {
  let instance = instances.get(name);
  if (!instance) {
    // Created before the exit listener is added,
    // so that a potential throw leaves none behind.
    instance = createDb(name);

    // A signal listener would replace Node's default exit on SIGTERM.
    if (instances.size === 0) {
      process.once("beforeExit", destroyAll);
    }

    instances.set(name, instance);
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
