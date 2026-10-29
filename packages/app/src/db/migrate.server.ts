import { type Migration, Migrator, NO_MIGRATIONS } from "kysely/migration";
import { getDb } from "#runtime/db";
import { checkMigrationNames } from "./migration-names.ts";

/**
 * Migrations by name, `NN_NNNN_migration_name`, each with `up` and `down`.
 *
 * Never rename one that has run: the database stores its name.
 */
export type Migrations = Record<string, Required<Migration>>;

const getTargetName = (names: readonly string[], target: string) => {
  if (target === "none") return NO_MIGRATIONS;
  if (/^\d{2}$/u.test(target)) {
    return names.findLast((name) => name.startsWith(`${target}_`));
  }
  if (/^\d{2}_\d{4}$/u.test(target)) {
    return names.find((name) => name.startsWith(`${target}_`));
  }
  return names.find((name) => name === target);
};

// Modules from import.meta.glob escape the `Migrations` type.
// On a revert, Kysely skips a missing `down` and keeps the migration applied.
const checkDowns = (database: string, migrations: Migrations) => {
  const downless = Object.keys(migrations).filter(
    (name) => typeof migrations[name]?.down !== "function",
  );
  if (downless.length > 0) {
    const list = downless.join(", ");
    const message = `database "${database}": no down in ${list}; use () => Promise.resolve() if nothing needs reverting`;
    throw new Error(message);
  }
};

const migrateDatabase = async (
  database: string,
  migrations: Migrations,
  target: string | undefined,
) => {
  const names = Object.keys(migrations).toSorted();
  const targetName =
    target === undefined ? undefined : getTargetName(names, target);
  if (target !== undefined && targetName === undefined) {
    const message = `database "${database}": unknown target "${target}"`;
    throw new Error(message);
  }

  const provider = { getMigrations: () => Promise.resolve(migrations) };
  const db = getDb(database);
  const migrator = new Migrator({ db, provider });
  const { error, results = [] } =
    targetName === undefined
      ? await migrator.migrateToLatest()
      : await migrator.migrateTo(targetName);
  if (error) {
    const failed = results.find((result) => result.status === "Error");
    const location = failed ? ` at ${failed.migrationName}` : "";
    const message = `database "${database}": migration failed${location}`;
    throw new Error(message, { cause: error });
  }

  for (const { direction, migrationName } of results) {
    const verb = direction === "Up" ? "applied" : "reverted";
    console.log(`${database}: ${verb} ${migrationName}`);
  }
};

const usage = "usage: migrate.js [<target>] [--db <name>]";

// workerd, where the D1 tests run, has no `parseArgs` from node:util.
const parseMigrateArgs = (args: readonly string[]) => {
  const positionals: string[] = [];
  let database: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--db" && database === undefined) {
      database = args[index + 1];
      index += 1;
      if (database === undefined) throw new Error(usage);
    } else if (arg.startsWith("-") || positionals.length > 0) {
      throw new Error(usage);
    } else {
      positionals.push(arg);
    }
  }

  const [target] = positionals;
  if (target !== undefined && database === undefined) {
    throw new Error("a target needs --db <name>: names are per database");
  }
  return { target, database };
};

/**
 * Migrates each database in `@acme/vite`'s order, to its latest or `target`.
 *
 * Stops at the first failing database, leaving earlier ones migrated.
 *
 * @param args `[<target>] [--db <name>]`. A target is a name, `NN_NNNN`, `NN`
 * or `none`.
 */
export const migrate = async (
  migrationsByDatabase: Record<string, Migrations>,
  args: readonly string[],
) => {
  const { target, database } = parseMigrateArgs(args);
  const givenNames = [database, ...Object.keys(migrationsByDatabase)];
  const unknownNames = givenNames.filter(
    (name) => name !== undefined && !__ACME_DATABASES__.includes(name),
  );
  if (unknownNames.length > 0) {
    const message = `not in @acme/vite's databases: ${unknownNames.join(", ")}`;
    throw new Error(message);
  }

  for (const [name, migrations] of Object.entries(migrationsByDatabase)) {
    const names = Object.keys(migrations);
    checkMigrationNames(names);
    checkDowns(name, migrations);
  }

  const databases = database === undefined ? __ACME_DATABASES__ : [database];
  for (const name of databases) {
    const migrations = migrationsByDatabase[name] ?? {};
    // oxlint-disable-next-line no-await-in-loop -- one database at a time
    await migrateDatabase(name, migrations, target);
  }
};
