import { beforeEach, describe, expect, inject, it } from "vitest";
import { getDb } from "#runtime/db";
import {
  getDbKind,
  type MigrationDb,
  type Migrations,
  migrate,
  sql,
} from "./migrate.server.ts";
import { checkMigrationNames } from "./migration-names.ts";

const database = inject("database");
const isD1 = database === "d1";
const databases = ["default", "audit"];

const createTableMigration = (table: string) => {
  return {
    up: async (db) => {
      await db.schema
        .createTable(table)
        .addColumn("id", "integer", (column) => column.primaryKey())
        .execute();
    },
    down: async (db) => {
      await db.schema.dropTable(table).execute();
    },
  } satisfies Migrations[string];
};

const brokenMigration: Migrations[string] = {
  up: async (db) => {
    await createTableMigration("broken").up(db);
    throw new Error("broken on purpose");
  },
  down: () => Promise.resolve(),
};

const defaultMigrations: Migrations = {
  "00_0001_widget": createTableMigration("widget"),
  "00_0002_gadget": createTableMigration("gadget"),
  "01_0001_gizmo": createTableMigration("gizmo"),
};

const auditMigrations: Migrations = {
  "00_0001_entry": createTableMigration("entry"),
};

const migrations = { default: defaultMigrations, audit: auditMigrations };

const resetDatabases = async () => {
  const tables = ["widget", "gadget", "gizmo", "entry", "broken"];
  const migrationTables = ["kysely_migration", "kysely_migration_lock"];
  for (const name of databases) {
    for (const table of [...tables, ...migrationTables]) {
      // oxlint-disable-next-line no-await-in-loop
      await getDb(name).schema.dropTable(table).ifExists().execute();
    }
  }
};

const getTables = async (name: string) => {
  const tables = await getDb(name).introspection.getTables();
  return tables
    .map((table) => table.name)
    .filter((table) => !table.startsWith("kysely_"))
    .toSorted();
};

describe("migrate", () => {
  beforeEach(resetDatabases);

  it("migrates every database to its latest", async () => {
    await migrate(migrations, []);

    expect(await getTables("default")).toEqual(["gadget", "gizmo", "widget"]);
    expect(await getTables("audit")).toEqual(["entry"]);
  });

  // A migration applied twice throws: its table already exists.
  it("does nothing when up to date", async () => {
    await migrate(migrations, []);
    await expect(migrate(migrations, [])).resolves.toBeUndefined();
  });

  it("limits a run to --db", async () => {
    await migrate(migrations, ["--db", "audit"]);

    expect(await getTables("default")).toEqual([]);
    expect(await getTables("audit")).toEqual(["entry"]);
  });

  it.each([
    {
      from: "none",
      target: "01_0001_gizmo",
      tables: ["gadget", "gizmo", "widget"],
    },
    { from: "01", target: "00_0001_widget", tables: ["widget"] },
    { from: "00_0001_widget", target: "00_0002", tables: ["gadget", "widget"] },
    { from: "01", target: "00_0002", tables: ["gadget", "widget"] },
    { from: "none", target: "00", tables: ["gadget", "widget"] },
    { from: "01", target: "00", tables: ["gadget", "widget"] },
    {
      from: "00_0001_widget",
      target: "01",
      tables: ["gadget", "gizmo", "widget"],
    },
    { from: "01", target: "none", tables: [] },
  ])("moves from $from to $target", async ({ from, target, tables }) => {
    await migrate(migrations, [from, "--db", "default"]);
    await migrate(migrations, [target, "--db", "default"]);

    expect(await getTables("default")).toEqual(tables);
  });

  it("stops at a failing database, keeping earlier ones migrated", async () => {
    const auditBroken = { "00_0001_broken": brokenMigration };
    const withBrokenAudit = { ...migrations, audit: auditBroken };
    const running = migrate(withBrokenAudit, []);

    await expect(running).rejects.toThrow(
      'database "audit": migration failed at 00_0001_broken',
    );
    expect(await getTables("default")).toEqual(["gadget", "gizmo", "widget"]);
  });

  it.each([
    { args: ["00"], message: "a target needs --db <name>" },
    {
      args: ["00_0003", "--db", "default"],
      message: 'database "default": unknown target',
    },
    {
      args: ["02", "--db", "default"],
      message: 'database "default": unknown target',
    },
    { args: ["--db", "nope"], message: "not in @acme/vite's databases: nope" },
    { args: ["00", "01"], message: "usage: migrate.js" },
  ])("refuses $args with nothing run", async ({ args, message }) => {
    await expect(migrate(migrations, args)).rejects.toThrow(message);

    expect(await getTables("default")).toEqual([]);
  });

  it("refuses a migration without down before migrating any", async () => {
    const { down: _down, ...entry } = createTableMigration("entry");
    const downless = { "00_0001_entry": entry } as unknown as Migrations;
    const running = migrate({ ...migrations, audit: downless }, []);

    await expect(running).rejects.toThrow(
      'database "audit": no down in 00_0001_entry',
    );
    expect(await getTables("default")).toEqual([]);
  });

  it("refuses invalid names before migrating any database", async () => {
    const badAudit = { "00_0002_entry": createTableMigration("entry") };
    const running = migrate({ ...migrations, audit: badAudit }, []);

    await expect(running).rejects.toThrow("00_0001 is missing");
    expect(await getTables("default")).toEqual([]);
  });

  it.runIf(!isD1)(
    "waits for a concurrent run, then finds it done",
    async () => {
      const runs = [migrate(migrations, []), migrate(migrations, [])];
      await expect(Promise.all(runs)).resolves.toBeDefined();

      expect(await getTables("audit")).toEqual(["entry"]);
    },
  );

  it.runIf(isD1)("refuses a run while another holds the lock", async () => {
    const runs = [migrate(migrations, []), migrate(migrations, [])];
    const outcomes = await Promise.allSettled(runs);

    const statuses = outcomes.map((outcome) => outcome.status).toSorted();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
    const refused = outcomes.find((outcome) => outcome.status === "rejected");
    const error = refused?.reason as Error;
    expect(error.cause).toHaveProperty(
      "message",
      expect.stringContaining("lock is already held"),
    );
  });

  it("releases its lock after a failure", async () => {
    const broken = { ...auditMigrations, "00_0002_broken": brokenMigration };
    const failing = migrate({ audit: broken }, ["--db", "audit"]);
    await expect(failing).rejects.toThrow("migration failed");

    // A held lock would make this run throw instead.
    const retry = migrate(migrations, ["--db", "audit"]);
    await expect(retry).resolves.toBeUndefined();
  });

  it.runIf(!isD1)("leaves the schema untouched when one fails", async () => {
    const broken = { ...auditMigrations, "00_0002_broken": brokenMigration };
    const failing = migrate({ audit: broken }, ["--db", "audit"]);
    await expect(failing).rejects.toThrow("migration failed");

    expect(await getTables("audit")).toEqual([]);
  });

  it.runIf(isD1)("keeps what ran before a failure on D1", async () => {
    const broken = { ...auditMigrations, "00_0002_broken": brokenMigration };
    const failing = migrate({ audit: broken }, ["--db", "audit"]);
    await expect(failing).rejects.toThrow("migration failed");

    expect(await getTables("audit")).toEqual(["broken", "entry"]);
  });
});

describe("migration exports", () => {
  beforeEach(resetDatabases);

  it("passes a db that getDbKind() and sql work on", async () => {
    const kinds: string[] = [];
    const up = async (db: MigrationDb) => {
      kinds.push(getDbKind(db));
      await sql`create table widget (id integer primary key)`.execute(db);
    };
    const down = () => Promise.resolve();
    await migrate({ default: { "00_0001_widget": { up, down } } }, []);

    expect(kinds).toEqual([database]);
    expect(await getTables("default")).toEqual(["widget"]);
  });
});

describe("checkMigrationNames", () => {
  it("accepts names numbered from 0001 per major", () => {
    const names = ["00_0001_a", "00_0002_b", "01_0001_c", "99_0001_d"];
    const checkNames = () => {
      checkMigrationNames(names);
    };
    expect(checkNames).not.toThrow();
  });

  it("names every invalid, missing and duplicate migration", () => {
    const names = [
      "100_0001_wide_major",
      "00_00001_wide_sequence",
      "00_0001_Upper",
      "00-0001-kebab",
      "00_0002_a",
      "01_0002_gap",
      "01_0003_twin",
      "01_0003_other_twin",
    ];
    const problems = [
      '"100_0001_wide_major" is not NN_NNNN_migration_name',
      '"00_00001_wide_sequence" is not NN_NNNN_migration_name',
      '"00_0001_Upper" is not NN_NNNN_migration_name',
      '"00-0001-kebab" is not NN_NNNN_migration_name',
      "00_0001 is missing",
      "01_0001 is missing",
      "01_0003 is taken by 01_0003_twin, 01_0003_other_twin",
    ];
    const message = `invalid migration names:\n${problems.join("\n")}`;
    const checkNames = () => {
      checkMigrationNames(names);
    };
    expect(checkNames).toThrow(message);
  });
});
