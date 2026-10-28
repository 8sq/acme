import type { Kysely } from "kysely";
import { type Migration, Migrator } from "kysely/migration";

/**
 * Migrations by name, applied in key order; never rename one that has run.
 */
export type Migrations = Record<string, Migration>;

/**
 * Migrates up to the latest, or down one step; throws if a migration fails.
 *
 * On SQLite and Postgres, all pending migrations share one transaction.
 */
export const migrate = async <Tables>(
  db: Kysely<Tables>,
  migrations: Migrations,
  direction: "up" | "down",
) => {
  const provider = { getMigrations: () => Promise.resolve(migrations) };
  const migrator = new Migrator({ db, provider });
  const { error, results = [] } =
    direction === "up"
      ? await migrator.migrateToLatest()
      : await migrator.migrateDown();
  if (error) throw new Error("migration failed", { cause: error });

  return results;
};
