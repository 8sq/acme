import { beforeEach, describe, expect, inject, it } from "vitest";
import { getDb } from "#runtime/db";
import {
  getDbKind,
  type MigrationDb,
  type MigrationEvent,
  type Migrations,
  migrate,
  sql,
} from "./migrate.server.ts";

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

// Postgres checks the deferred foreign key at commit, so the commit fails.
const uncommittableMigration: Migrations[string] = {
  up: async (db) => {
    await sql`create table parent (id integer primary key)`.execute(db);
    const child = sql`create table child (parent_id integer references parent deferrable initially deferred)`;
    await child.execute(db);
    await sql`insert into child (parent_id) values (1)`.execute(db);
  },
  down: () => Promise.resolve(),
};

const resetDatabases = async () => {
  const tables = ["widget", "gadget", "gizmo", "entry", "broken"];
  const deferredTables = ["child", "parent"];
  const migrationTables = ["acme_migration", "acme_migration_lock"];
  for (const name of databases) {
    for (const table of [...tables, ...deferredTables, ...migrationTables]) {
      // oxlint-disable-next-line no-await-in-loop
      await getDb(name).schema.dropTable(table).ifExists().execute();
    }
  }
};

const getTables = async (name: string) => {
  const tables = await getDb(name).introspection.getTables();
  return tables
    .map((table) => table.name)
    .filter((table) => !table.startsWith("acme_"))
    .toSorted();
};

describe("migrate", () => {
  beforeEach(resetDatabases);

  it("migrates every database to its latest", async () => {
    await migrate(migrations, []);

    expect(await getTables("default")).toEqual(["gadget", "gizmo", "widget"]);
    expect(await getTables("audit")).toEqual(["entry"]);
  });

  it("reports each step before and after it runs, then persisted", async () => {
    const events: MigrationEvent[] = [];
    const collect = (event: MigrationEvent) => {
      events.push(event);
    };
    await migrate(migrations, ["00_0002", "--db", "default"], collect);
    await migrate(migrations, ["00_0001", "--db", "default"], collect);

    expect(events).toEqual([
      {
        type: "step",
        database: "default",
        name: "00_0001_widget",
        direction: "up",
        status: "running",
      },
      {
        type: "step",
        database: "default",
        name: "00_0001_widget",
        direction: "up",
        status: "done",
      },
      {
        type: "step",
        database: "default",
        name: "00_0002_gadget",
        direction: "up",
        status: "running",
      },
      {
        type: "step",
        database: "default",
        name: "00_0002_gadget",
        direction: "up",
        status: "done",
      },
      { type: "persisted", database: "default" },
      {
        type: "step",
        database: "default",
        name: "00_0002_gadget",
        direction: "down",
        status: "running",
      },
      {
        type: "step",
        database: "default",
        name: "00_0002_gadget",
        direction: "down",
        status: "done",
      },
      { type: "persisted", database: "default" },
    ]);
  });

  // A migration applied twice throws: its table already exists.
  it("does nothing when up to date", async () => {
    await migrate(migrations, []);
    const events: MigrationEvent[] = [];
    const running = migrate(migrations, [], (event) => {
      events.push(event);
    });

    await expect(running).resolves.toBeUndefined();
    expect(events).toEqual([]);
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
    {
      from: "00_0001_widget",
      target: "00_0002",
      tables: ["gadget", "widget"],
    },
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

  it.runIf(!isD1)(
    "rolls every database back when a later one fails",
    async () => {
      const events: MigrationEvent[] = [];
      const withBrokenAudit = {
        default: { "00_0001_widget": createTableMigration("widget") },
        audit: { "00_0001_broken": brokenMigration },
      };
      const running = migrate(withBrokenAudit, [], (event) => {
        events.push(event);
      });

      await expect(running).rejects.toThrow(
        'database "audit": migration failed at 00_0001_broken',
      );
      expect(await getTables("default")).toEqual([]);
      expect(events).toEqual([
        {
          type: "step",
          database: "default",
          name: "00_0001_widget",
          direction: "up",
          status: "running",
        },
        {
          type: "step",
          database: "default",
          name: "00_0001_widget",
          direction: "up",
          status: "done",
        },
        {
          type: "step",
          database: "audit",
          name: "00_0001_broken",
          direction: "up",
          status: "running",
        },
        {
          type: "step",
          database: "audit",
          name: "00_0001_broken",
          direction: "up",
          status: "failed",
        },
        { type: "rolledBack", database: "default" },
        { type: "rolledBack", database: "audit" },
      ]);
    },
  );

  it.runIf(isD1)("keeps earlier databases migrated on D1", async () => {
    const events: MigrationEvent[] = [];
    const withBrokenAudit = {
      default: { "00_0001_widget": createTableMigration("widget") },
      audit: { "00_0001_broken": brokenMigration },
    };
    const running = migrate(withBrokenAudit, [], (event) => {
      events.push(event);
    });

    await expect(running).rejects.toThrow(
      'database "audit": migration failed at 00_0001_broken',
    );
    expect(await getTables("default")).toEqual(["widget"]);
    expect(events).toEqual([
      {
        type: "step",
        database: "default",
        name: "00_0001_widget",
        direction: "up",
        status: "running",
      },
      {
        type: "step",
        database: "default",
        name: "00_0001_widget",
        direction: "up",
        status: "done",
      },
      {
        type: "step",
        database: "audit",
        name: "00_0001_broken",
        direction: "up",
        status: "running",
      },
      {
        type: "step",
        database: "audit",
        name: "00_0001_broken",
        direction: "up",
        status: "failed",
      },
      { type: "persisted", database: "default" },
      { type: "persisted", database: "audit" },
    ]);
  });

  // The earlier database commits first, so it stays migrated.
  it.runIf(database === "postgres")(
    "names what stayed migrated when a commit fails",
    async () => {
      const events: MigrationEvent[] = [];
      const withUncommittable = {
        default: { "00_0001_widget": createTableMigration("widget") },
        audit: { "00_0001_parent": uncommittableMigration },
      };
      const running = migrate(withUncommittable, [], (event) => {
        events.push(event);
      });

      await expect(running).rejects.toThrow('database "audit": commit failed');
      expect(await getTables("default")).toEqual(["widget"]);
      expect(await getTables("audit")).toEqual([]);
      expect(events).toEqual([
        {
          type: "step",
          database: "default",
          name: "00_0001_widget",
          direction: "up",
          status: "running",
        },
        {
          type: "step",
          database: "default",
          name: "00_0001_widget",
          direction: "up",
          status: "done",
        },
        {
          type: "step",
          database: "audit",
          name: "00_0001_parent",
          direction: "up",
          status: "running",
        },
        {
          type: "step",
          database: "audit",
          name: "00_0001_parent",
          direction: "up",
          status: "done",
        },
        { type: "persisted", database: "default" },
        { type: "rolledBack", database: "audit" },
      ]);
    },
  );

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

    await expect(running).rejects.toThrow(
      "00_0002_entry breaks the sequence: major 00 starts at 00_0001",
    );
    expect(await getTables("default")).toEqual([]);
  });

  it("reverts in name order, whatever order they were applied in", async () => {
    const reverted: string[] = [];
    const recording = Object.fromEntries(
      Object.entries(defaultMigrations).map(([name, migration]) => {
        const down = async (db: MigrationDb) => {
          reverted.push(name);
          await migration.down(db);
        };
        return [name, { ...migration, down }];
      }),
    );
    await migrate({ default: recording }, []);
    const timestamp = "2000-01-01T00:00:00.000Z";
    const backdate = sql`update acme_migration set timestamp = ${timestamp} where name = ${"01_0001_gizmo"}`;
    await backdate.execute(getDb("default"));
    await migrate({ default: recording }, ["none", "--db", "default"]);

    expect(reverted).toEqual([
      "01_0001_gizmo",
      "00_0002_gadget",
      "00_0001_widget",
    ]);
  });

  it.each([
    {
      applied: "02_0001_unknown",
      message: "applied migration 02_0001_unknown is not in this build",
    },
    {
      applied: "01_0001_gizmo",
      message: "00_0002_gadget is not applied, but the later 01_0001_gizmo is",
    },
  ])(
    "refuses a database with $applied applied",
    async ({ applied, message }) => {
      await migrate(migrations, ["00_0001", "--db", "default"]);
      const timestamp = new Date().toISOString();
      const insert = sql`insert into acme_migration (name, timestamp) values (${applied}, ${timestamp})`;
      await insert.execute(getDb("default"));
      const running = migrate(migrations, ["--db", "default"]);

      await expect(running).rejects.toThrow("migration failed");
      await expect(running).rejects.toHaveProperty("cause.message", message);
      expect(await getTables("default")).toEqual(["widget"]);
    },
  );

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

  it.runIf(!isD1)("rolls every step back when one fails", async () => {
    const events: MigrationEvent[] = [];
    const broken = { ...auditMigrations, "00_0002_broken": brokenMigration };
    const failing = migrate({ audit: broken }, ["--db", "audit"], (event) => {
      events.push(event);
    });
    await expect(failing).rejects.toThrow("migration failed");

    expect(await getTables("audit")).toEqual([]);
    expect(events).toEqual([
      {
        type: "step",
        database: "audit",
        name: "00_0001_entry",
        direction: "up",
        status: "running",
      },
      {
        type: "step",
        database: "audit",
        name: "00_0001_entry",
        direction: "up",
        status: "done",
      },
      {
        type: "step",
        database: "audit",
        name: "00_0002_broken",
        direction: "up",
        status: "running",
      },
      {
        type: "step",
        database: "audit",
        name: "00_0002_broken",
        direction: "up",
        status: "failed",
      },
      { type: "rolledBack", database: "audit" },
    ]);
  });

  it.runIf(isD1)("keeps what ran before a failure on D1", async () => {
    const events: MigrationEvent[] = [];
    const broken = { ...auditMigrations, "00_0002_broken": brokenMigration };
    const failing = migrate({ audit: broken }, ["--db", "audit"], (event) => {
      events.push(event);
    });
    await expect(failing).rejects.toThrow("migration failed");

    expect(await getTables("audit")).toEqual(["broken", "entry"]);
    expect(events).toEqual([
      {
        type: "step",
        database: "audit",
        name: "00_0001_entry",
        direction: "up",
        status: "running",
      },
      {
        type: "step",
        database: "audit",
        name: "00_0001_entry",
        direction: "up",
        status: "done",
      },
      {
        type: "step",
        database: "audit",
        name: "00_0002_broken",
        direction: "up",
        status: "running",
      },
      {
        type: "step",
        database: "audit",
        name: "00_0002_broken",
        direction: "up",
        status: "failed",
      },
      { type: "persisted", database: "audit" },
    ]);
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
