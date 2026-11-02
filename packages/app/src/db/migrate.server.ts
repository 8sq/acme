import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { getDbKind as getRuntimeDbKind } from "#runtime/db";
import { checkMigrationNames } from "@acme/shared/rules";
import { migrateDatabase } from "./migrator.server.ts";

export { Kysely, sql } from "kysely";

/**
 * The `db` passed to `up` and `down`, typed loosely: schemas change over time.
 *
 * Use it, never `getDb()`: on SQLite and Postgres it is the run's transaction.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Migration uses any
export type MigrationDb = Kysely<any>;

/**
 * The database behind a migration's `db`.
 */
export const getDbKind: (db: MigrationDb) => "sqlite" | "postgres" | "d1" =
  getRuntimeDbKind;

/**
 * Migrations by name, `XX_YYYY_migration_name`, each with `up` and `down`.
 *
 * Never rename one that has run: the database stores its name.
 */
export type Migrations = Record<string, Required<Migration>>;

/**
 * Progress from `migrate()`: each step before and after it runs, then how each
 * database ended.
 *
 * Steps inside a transaction are only kept once `persisted` follows.
 */
export type MigrationEvent =
  | {
      type: "step";
      database: string;
      name: string;
      direction: "up" | "down";
      status: "running" | "done" | "failed";
    }
  | { type: "persisted" | "rolledBack"; database: string };

// The build imports migration modules untyped, past the `Migrations` type.
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

const usage = "usage: migrate.js [<target>] [--db <name>] [--no-color]";

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
 * @param args `[<target>] [--db <name>]`. A target is a name, `XX_YYYY`,
 * `XX` or `none`.
 */
export const migrate = async (
  migrationsByDatabase: Record<string, Migrations>,
  args: readonly string[],
  onProgress: (event: MigrationEvent) => void = () => undefined,
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
    await migrateDatabase(name, migrations, target, onProgress);
  }
};

const colorCodes = { green: 32, red: 31 };

// NO_COLOR (no-color.org) turns colors off, even with FORCE_COLOR set.
// FORCE_COLOR turns them on for piped output, as in CI logs.
const hasColors = (args: readonly string[]) => {
  if (args.includes("--no-color")) return false;

  const { NO_COLOR: noColor, FORCE_COLOR: forceColor } = process.env;
  if (noColor !== undefined && noColor !== "") return false;
  if (forceColor !== undefined) {
    return forceColor !== "0" && forceColor !== "false";
  }

  return process.stdout.isTTY && process.stdout.hasColors();
};

const createProgressWriter = (colors: boolean) => {
  const paint = (color: keyof typeof colorCodes, text: string) => {
    return colors ? `\u001B[${colorCodes[color]}m${text}\u001B[39m` : text;
  };

  return (event: MigrationEvent) => {
    if (event.type !== "step") {
      const isPersisted = event.type === "persisted";
      const outcome = isPersisted
        ? paint("green", "persisted")
        : paint("red", "rolled back");
      console.log(`${event.database}: ${outcome}`);
      return;
    }

    if (event.status === "running") {
      const verb = event.direction === "up" ? "applying" : "reverting";
      process.stdout.write(`${event.database}: ${verb} ${event.name}... `);
      return;
    }

    const isDone = event.status === "done";
    console.log(isDone ? paint("green", "done!") : paint("red", "failed!"));
  };
};

const getErrorLines = (error: unknown): string[] => {
  if (!(error instanceof Error)) return [String(error)];

  const causeLines =
    error.cause === undefined ? [] : getErrorLines(error.cause);
  return [error.message, ...causeLines.map((line) => `  ${line}`)];
};

/**
 * Runs `migrate()` on `process.argv`, as `build/server/migrate.js` does.
 *
 * Sets exit code 1 on any failure; `getDb()` closes the databases on exit.
 */
export const runMigrateScript = async (
  migrationsByDatabase: Record<string, Migrations>,
) => {
  try {
    const scriptArgs = process.argv.slice(2);
    const args = scriptArgs.filter((arg) => arg !== "--no-color");
    const writeProgress = createProgressWriter(hasColors(scriptArgs));
    await migrate(migrationsByDatabase, args, writeProgress);
  } catch (error) {
    const lines = getErrorLines(error);
    console.error(lines.join("\n"));
    process.exitCode = 1;
  }
};
