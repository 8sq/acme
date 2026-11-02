import { getDb } from "#runtime/db";
import type {
  MigrationDb,
  MigrationEvent,
  Migrations,
} from "./migrate.server.ts";

const migrationTable = "acme_migration";
const lockOptions = {
  lockTable: "acme_migration_lock",
  lockRowId: "migration_lock",
};

// Postgres can throw on `if not exists` while another run creates the table.
const createTable = async (
  db: MigrationDb,
  table: string,
  create: () => Promise<unknown>,
) => {
  try {
    await create();
  } catch (error) {
    const tables = await db.introspection.getTables();
    if (!tables.some(({ name }) => name === table)) throw error;
  }
};

const createMigrationTables = async (db: MigrationDb) => {
  await createTable(db, migrationTable, () => {
    return db.schema
      .createTable(migrationTable)
      .ifNotExists()
      .addColumn("name", "varchar(255)", (column) => {
        return column.notNull().primaryKey();
      })
      .addColumn("timestamp", "varchar(255)", (column) => column.notNull())
      .execute();
  });
  await createTable(db, lockOptions.lockTable, () => {
    return db.schema
      .createTable(lockOptions.lockTable)
      .ifNotExists()
      .addColumn("id", "varchar(255)", (column) => {
        return column.notNull().primaryKey();
      })
      .addColumn("is_locked", "integer", (column) => {
        return column.notNull().defaultTo(0);
      })
      .execute();
  });
  await db
    .insertInto(lockOptions.lockTable)
    .values({ id: lockOptions.lockRowId, is_locked: 0 })
    .onConflict((conflict) => conflict.column("id").doNothing())
    .execute();
};

// The index of the last migration to keep applied, -1 for none.
const getTargetIndex = (names: readonly string[], target: string) => {
  if (target === "none") return -1;
  if (/^\d{2}$/u.test(target)) {
    return names.findLastIndex((name) => name.startsWith(`${target}_`));
  }
  if (/^\d{2}_\d{4}$/u.test(target)) {
    return names.findIndex((name) => name.startsWith(`${target}_`));
  }
  return names.indexOf(target);
};

const checkApplied = (names: readonly string[], applied: readonly string[]) => {
  const unknown = applied.find((name) => !names.includes(name));
  if (unknown !== undefined) {
    throw new Error(`applied migration ${unknown} is not in this build`);
  }

  const gap = names.find(
    (name, index) => index < applied.length && name !== applied[index],
  );
  if (gap !== undefined) {
    const message = `${gap} is not applied, but the later ${applied.at(-1)} is`;
    throw new Error(message);
  }
};

// Down from the last applied, up from the first pending: both in name order.
const getSteps = (
  names: readonly string[],
  applied: readonly string[],
  keep: number,
) => {
  if (keep < applied.length) {
    const reverted = applied.slice(keep).toReversed();
    return reverted.map((name) => ({ name, direction: "down" as const }));
  }
  return names
    .slice(applied.length, keep)
    .map((name) => ({ name, direction: "up" as const }));
};

type Report = (event: MigrationEvent) => void;

interface Progress {
  database: string;
  running?: string;
  hasSteps: boolean;
  isTransaction: boolean;
}

const runSteps = async (
  db: MigrationDb,
  migrations: Migrations,
  keep: number,
  progress: Progress,
  report: Report,
) => {
  progress.isTransaction = db.isTransaction;
  const names = Object.keys(migrations).toSorted();
  const rows = await db.selectFrom(migrationTable).select("name").execute();
  const applied = rows.map(({ name }) => String(name)).toSorted();
  checkApplied(names, applied);

  for (const { name, direction } of getSteps(names, applied, keep)) {
    const step = {
      type: "step" as const,
      database: progress.database,
      name,
      direction,
    };
    progress.running = name;
    progress.hasSteps = true;
    report({ ...step, status: "running" });
    try {
      // oxlint-disable-next-line no-await-in-loop -- migrations run in order
      await migrations[name]?.[direction](db);
      const timestamp = new Date().toISOString();
      const record =
        direction === "up"
          ? db.insertInto(migrationTable).values({ name, timestamp })
          : db.deleteFrom(migrationTable).where("name", "=", name);
      // oxlint-disable-next-line no-await-in-loop -- migrations run in order
      await record.execute();
    } catch (error) {
      report({ ...step, status: "failed" });
      throw error;
    }
    report({ ...step, status: "done" });
  }
  delete progress.running;
};

// Kysely marks `getExecutor()` internal; its own `Migrator` uses it too.
const runLocked = async (
  db: MigrationDb,
  run: (db: MigrationDb) => Promise<void>,
) => {
  const { adapter } = db.getExecutor();
  await createMigrationTables(db);
  await db.connection().execute(async (connection) => {
    await adapter.acquireMigrationLock(connection, lockOptions);
    try {
      await (adapter.supportsTransactionalDdl
        ? connection.transaction().execute(run)
        : run(connection));
    } finally {
      await adapter.releaseMigrationLock(connection, lockOptions);
    }
  });
};

export const migrateDatabase = async (
  database: string,
  migrations: Migrations,
  target: string | undefined,
  report: Report,
) => {
  const names = Object.keys(migrations).toSorted();
  const targetIndex =
    target === undefined ? names.length - 1 : getTargetIndex(names, target);
  if (target !== undefined && target !== "none" && targetIndex === -1) {
    const message = `database "${database}": unknown target "${target}"`;
    throw new Error(message);
  }

  const progress: Progress = {
    database,
    hasSteps: false,
    isTransaction: false,
  };
  try {
    await runLocked(getDb(database), (db) => {
      return runSteps(db, migrations, targetIndex + 1, progress, report);
    });
  } catch (error) {
    const { running, hasSteps, isTransaction } = progress;

    // Without a transaction (D1), the steps before the failure stay applied.
    if (hasSteps) {
      report({ type: isTransaction ? "rolledBack" : "persisted", database });
    }

    const location = running === undefined ? "" : ` at ${running}`;
    const message = `database "${database}": migration failed${location}`;
    throw new Error(message, { cause: error });
  }

  if (progress.hasSteps) report({ type: "persisted", database });
};
