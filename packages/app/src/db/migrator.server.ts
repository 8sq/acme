import type { ControlledTransaction } from "kysely";
import { getDb, getDbKind } from "#runtime/db";
import {
  compareMigrationNames,
  getMigrationMajor,
  getMigrationSequence,
} from "@acme/shared/rules";
import { sql } from "kysely";
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

const createMigrationTable = async (db: MigrationDb) => {
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
};

const createLockTable = async (db: MigrationDb) => {
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
  if (target === "none") {
    return -1;
  }

  if (/^\d+$/u.test(target)) {
    const major = Number(target);
    return names.findLastIndex((name) => getMigrationMajor(name) === major);
  }

  const version = /^(\d+)_(\d+)$/u.exec(target);
  if (version === null) {
    return names.indexOf(target);
  }

  const [major, sequence] = version.slice(1).map(Number);
  return names.findIndex((name) => {
    const isMajor = getMigrationMajor(name) === major;
    return isMajor && getMigrationSequence(name) === sequence;
  });
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
  targetCount: number,
) => {
  if (targetCount < applied.length) {
    const reverted = applied.slice(targetCount).toReversed();
    return reverted.map((name) => ({ name, direction: "down" as const }));
  }
  return names
    .slice(applied.length, targetCount)
    .map((name) => ({ name, direction: "up" as const }));
};

type Report = (event: MigrationEvent) => void;

// `targetCount` is how many migrations, in name order, stay applied.
interface DatabaseRun {
  database: string;
  migrations: Migrations;
  targetCount: number;
  transaction?: ControlledTransaction<unknown>;
  running?: string;
  hasSteps: boolean;
  isCommitted: boolean;
}

const runSteps = async (db: MigrationDb, run: DatabaseRun, report: Report) => {
  const { database, migrations, targetCount } = run;
  const names = Object.keys(migrations).toSorted(compareMigrationNames);
  const rows = await db.selectFrom(migrationTable).select("name").execute();
  const applied = rows
    .map(({ name }) => String(name))
    .toSorted(compareMigrationNames);
  checkApplied(names, applied);

  for (const { name, direction } of getSteps(names, applied, targetCount)) {
    const step = { type: "step" as const, database, name, direction };
    run.running = name;
    run.hasSteps = true;
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
  delete run.running;
};

// Not Kysely's lock id: its migrators on the same database would block ours.
const postgresLockId = 5_077_236_158_559_334_355n;

// The commit releases this lock, so no run reads between commit and unlock.
const lockPostgres = async (db: MigrationDb) => {
  await sql`set local lock_timeout = '1h'`.execute(db);
  const lock = sql`select pg_advisory_xact_lock(${sql.lit(postgresLockId)})`;
  await lock.execute(db);
  await sql`set local lock_timeout to default`.execute(db);
};

// Kysely marks `getExecutor()` internal; its own `Migrator` uses it too.
const runD1 = async (db: MigrationDb, run: DatabaseRun, report: Report) => {
  const { adapter } = db.getExecutor();
  await createLockTable(db);
  await db.connection().execute(async (connection) => {
    await adapter.acquireMigrationLock(connection, lockOptions);
    try {
      await runSteps(connection, run, report);
      run.isCommitted = true;
    } finally {
      await adapter.releaseMigrationLock(connection, lockOptions);
    }
  });
};

const migrateUncommitted = async (run: DatabaseRun, report: Report) => {
  const db = getDb(run.database);
  await createMigrationTable(db);
  if (!db.getExecutor().adapter.supportsTransactionalDdl) {
    await runD1(db, run, report);
    return;
  }

  const transaction = await db.startTransaction().execute();
  run.transaction = transaction;
  // SQLite needs no lock: its driver starts transactions `begin immediate`.
  if (getDbKind(db) === "postgres") await lockPostgres(transaction);
  await runSteps(transaction, run, report);
};

// A failed rollback still hands its connection back to the pool.
// Its transaction then ends when the pool closes on exit.
const rollBack = async (databaseRuns: readonly DatabaseRun[]) => {
  for (const { transaction, isCommitted } of databaseRuns) {
    if (transaction === undefined || isCommitted) continue;

    // oxlint-disable-next-line no-await-in-loop -- one database at a time
    await transaction
      .rollback()
      .execute()
      .catch(() => undefined);
  }
};

const reportOutcomes = (
  databaseRuns: readonly DatabaseRun[],
  report: Report,
) => {
  for (const run of databaseRuns) {
    // Without a transaction (D1), the steps before a failure stay applied.
    const isKept = run.isCommitted || run.transaction === undefined;
    const type = isKept ? "persisted" : "rolledBack";
    if (run.hasSteps) report({ type, database: run.database });
  }
};

const createDatabaseRun = (
  database: string,
  migrations: Migrations,
  target: string | undefined,
) => {
  const names = Object.keys(migrations).toSorted(compareMigrationNames);
  const targetIndex =
    target === undefined ? names.length - 1 : getTargetIndex(names, target);
  if (target !== undefined && target !== "none" && targetIndex === -1) {
    const message = `database "${database}": unknown target "${target}"`;
    throw new Error(message);
  }

  const targetCount = targetIndex + 1;
  return {
    database,
    migrations,
    targetCount,
    hasSteps: false,
    isCommitted: false,
  };
};

export const migrateDatabases = async (
  migrationsByDatabase: Record<string, Migrations>,
  databases: readonly string[],
  target: string | undefined,
  report: Report,
) => {
  const databaseRuns: DatabaseRun[] = databases.map((database) => {
    const migrations = migrationsByDatabase[database] ?? {};
    return createDatabaseRun(database, migrations, target);
  });

  let activeRun: DatabaseRun | undefined;
  let isCommitting = false;
  try {
    for (const run of databaseRuns) {
      activeRun = run;
      // oxlint-disable-next-line no-await-in-loop -- one database at a time
      await migrateUncommitted(run, report);
    }
    isCommitting = true;
    for (const run of databaseRuns) {
      activeRun = run;
      // oxlint-disable-next-line no-await-in-loop -- one database at a time
      await run.transaction?.commit().execute();
      run.isCommitted = true;
    }
  } catch (error) {
    await rollBack(databaseRuns);
    if (activeRun === undefined) throw error;

    const { database, running } = activeRun;
    const location = running === undefined ? "" : ` at ${running}`;
    const failure = isCommitting
      ? "commit failed"
      : `migration failed${location}`;
    const message = `database "${database}": ${failure}`;
    throw new Error(message, { cause: error });
  } finally {
    reportOutcomes(databaseRuns, report);
  }
};
