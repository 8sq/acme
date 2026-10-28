import { CamelCasePlugin, sql } from "kysely";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  inject,
  it,
  vi,
} from "vitest";
import { getDbKind } from "#runtime";
import { runHealthChecks } from "@acme/server";
import { batch, getDb, readAll } from "./index.server.ts";
import { type Migrations, migrate } from "./migrate.server.ts";

type DatabaseKind = "sqlite" | "d1" | "postgres";

declare module "vitest" {
  interface ProvidedContext {
    database: DatabaseKind;
  }
}

declare module "./index.server.ts" {
  interface Databases {
    default: {
      cat: { id: number; name: string };
      seat: { id: number };
    };
  }
}

const database = inject("database");
const isD1 = database === "d1";

const resetCatTable = async () => {
  const db = getDb();
  await db.schema.dropTable("cat").ifExists().execute();
  await db.schema
    .createTable("cat")
    .addColumn("id", "integer", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull())
    .execute();
};

describe("getDb", () => {
  beforeEach(resetCatTable);

  it("runs on the project's database", () => {
    expect(getDbKind(getDb())).toBe(database);
  });

  it("runs CRUD", async () => {
    const db = getDb();
    const inserted = await db
      .insertInto("cat")
      .values({ id: 1, name: "Cattie" })
      .returning("name")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("cat")
      .set({ name: "Jane" })
      .where("id", "=", 1)
      .execute();
    const cats = await db.selectFrom("cat").selectAll().execute();
    await db.deleteFrom("cat").where("id", "=", 1).execute();
    const left = await db.selectFrom("cat").selectAll().execute();

    expect(inserted).toEqual({ name: "Cattie" });
    expect(cats).toEqual([{ id: 1, name: "Jane" }]);
    expect(left).toEqual([]);
  });

  it("reports the database as healthy", async () => {
    const { status, checks } = await runHealthChecks();

    expect(checks).toEqual({ database: "pass" });
    expect(status).toBe("pass");
  });

  it("takes only the default name so far", () => {
    expectTypeOf(getDb).parameter(0).toEqualTypeOf<"default" | undefined>();
  });
});

describe.runIf(!isD1)("getDb on SQLite and Postgres", () => {
  beforeEach(resetCatTable);

  it("commits a transaction", async () => {
    await getDb()
      .transaction()
      .execute(async (trx) => {
        await trx.insertInto("cat").values({ id: 1, name: "Cattie" }).execute();
      });
    const cats = await getDb().selectFrom("cat").select("name").execute();

    expect(cats).toEqual([{ name: "Cattie" }]);
  });

  it("keeps one instance per process", () => {
    expect(getDb("default")).toBe(getDb());
  });
});

const importFreshGetDb = async (url?: string) => {
  vi.stubEnv("DATABASE_URL", url);
  const { getDb: getFreshDb } = await import("#runtime");
  return getFreshDb;
};

describe.runIf(!isD1)("DATABASE_URL on SQLite and Postgres", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails when DATABASE_URL is missing", async () => {
    const getFreshDb = await importFreshGetDb();
    expect(getFreshDb).toThrow("DATABASE_URL is not set");
  });

  it("names an unknown scheme without echoing the URL", async () => {
    const getFreshDb = await importFreshGetDb("mysql://admin:hunter2@host/app");
    expect(getFreshDb).toThrow('DATABASE_URL: unsupported scheme "mysql:"');
  });

  it("refuses a scheme named after an Object.prototype key", async () => {
    const getFreshDb = await importFreshGetDb("constructor:x");
    expect(getFreshDb).toThrow(
      'DATABASE_URL: unsupported scheme "constructor:"',
    );
  });
});

describe.runIf(isD1)("getDb on D1", () => {
  beforeEach(resetCatTable);

  it("throws on a transaction", async () => {
    const transaction = getDb()
      .transaction()
      .execute(() => Promise.resolve());

    await expect(transaction).rejects.toThrow(
      "D1 doesn't support transactions",
    );
  });

  it("doesn't queue one getDb() behind another", async () => {
    const first = getDb();
    const second = getDb();
    expect(second).not.toBe(first);

    // Holding the first instance's only connection stands in for a hung query.
    const answer = await first.connection().execute(async () => {
      return sql<{ one: number }>`select 1 as one`.execute(second);
    });
    expect(answer.rows).toEqual([{ one: 1 }]);
  });
});

const resetSeatTable = async () => {
  const db = getDb();
  await db.schema.dropTable("seat").ifExists().execute();
  await db.schema
    .createTable("seat")
    .addColumn("id", "integer", (column) => column.primaryKey())
    .execute();
};

const getSeats = () => {
  return getDb().selectFrom("seat").select("id").execute();
};

const buildSignUp = (id: number) => {
  const db = getDb();
  const takenSeats = db
    .selectFrom("seat")
    .select((builder) => builder.fn.countAll().as("taken"));
  const seat = db
    .selectNoFrom((builder) => builder.val(id).as("id"))
    .where(takenSeats, "<", 32);
  return db.insertInto("seat").columns(["id"]).expression(seat).compile();
};

describe("batch", () => {
  beforeEach(resetCatTable);

  it("returns RETURNING and SELECT results in order", async () => {
    const db = getDb();
    const insertKibby = db
      .insertInto("cat")
      .values({ id: 1, name: "Kibby" })
      .returning("id")
      .compile();
    const insertJane = db
      .insertInto("cat")
      .values({ id: 2, name: "Jane" })
      .compile();
    const selectNames = db
      .selectFrom("cat")
      .select("name")
      .orderBy("id")
      .compile();
    const [inserted, , cats] = await batch(db, [
      insertKibby,
      insertJane,
      selectNames,
    ]);

    expectTypeOf(inserted.rows).toEqualTypeOf<{ id: number }[]>();
    expect(inserted.rows).toEqual([{ id: 1 }]);
    expect(cats.rows).toEqual([{ name: "Kibby" }, { name: "Jane" }]);
  });

  it("runs on a clone from withPlugin()", async () => {
    const db = getDb().withPlugin(new CamelCasePlugin());
    expect(getDbKind(db)).toBe(database);
    const insertKibby = db
      .insertInto("cat")
      .values({ id: 1, name: "Kibby" })
      .returning("name")
      .compile();
    const [inserted] = await batch(db, [insertKibby]);
    expect(inserted.rows).toEqual([{ name: "Kibby" }]);
  });

  it("rolls back every statement when one fails", async () => {
    const db = getDb();
    const insertKibby = db
      .insertInto("cat")
      .values({ id: 1, name: "Kibby" })
      .compile();
    const insertSameId = db
      .insertInto("cat")
      .values({ id: 1, name: "Duplicate" })
      .compile();
    const failing = batch(db, [insertKibby, insertSameId]);
    await expect(failing).rejects.toThrow();

    const cats = await db.selectFrom("cat").selectAll().execute();
    expect(cats).toEqual([]);
  });

  it("fills 32 seats exactly from 40 concurrent sign-ups", async () => {
    await resetSeatTable();
    const db = getDb();
    const signUps = Array.from({ length: 40 }, (_entry, id) => {
      const signUp = buildSignUp(id);
      return batch(db, [signUp]);
    });
    await Promise.all(signUps);

    expect(await getSeats()).toHaveLength(32);
  });
});

describe("readAll", () => {
  beforeEach(resetCatTable);

  it("returns SELECT results in order", async () => {
    const db = getDb();
    await db.insertInto("cat").values({ id: 1, name: "Kibby" }).execute();
    const selectNames = db.selectFrom("cat").select("name").compile();
    const selectIds = db.selectFrom("cat").select("id").compile();
    const [names, ids] = await readAll(db, [selectNames, selectIds]);

    expectTypeOf(names.rows).toEqualTypeOf<{ name: string }[]>();
    expect(names.rows).toEqual([{ name: "Kibby" }]);
    expect(ids.rows).toEqual([{ id: 1 }]);
  });

  it("rejects a write, raw SQL and a writing CTE", async () => {
    const db = getDb();
    const insert = db.insertInto("cat").values({ id: 1, name: "Kibby" });
    const writingCte = db
      .with("added", () => insert.returning("id"))
      .selectFrom("added")
      .selectAll();
    const rejected = [
      insert.compile(),
      sql`select 1`.compile(db),
      writingCte.compile(),
    ];

    for (const query of rejected) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(readAll(db, [query])).rejects.toThrow("SELECT queries only");
    }
    const cats = await db.selectFrom("cat").selectAll().execute();
    expect(cats).toEqual([]);
  });
});

const createTableMigration = (name: string) => {
  return {
    up: async (db) => {
      await db.schema
        .createTable(name)
        .addColumn("id", "integer", (column) => column.primaryKey())
        .execute();
    },
    down: async (db) => {
      await db.schema.dropTable(name).execute();
    },
  } satisfies Migrations[string];
};

const migrations: Migrations = {
  "0001_widget": createTableMigration("widget"),
  "0002_gadget": createTableMigration("gadget"),
};

const brokenMigrations: Migrations = {
  "0001_widget": createTableMigration("widget"),
  "0002_broken": {
    up: async (db) => {
      await createTableMigration("gadget").up(db);
      throw new Error("broken on purpose");
    },
  },
};

const resetMigrationTables = async () => {
  const db = getDb();
  const tables = [
    "gadget",
    "widget",
    "kysely_migration",
    "kysely_migration_lock",
  ];
  for (const table of tables) {
    // oxlint-disable-next-line no-await-in-loop
    await db.schema.dropTable(table).ifExists().execute();
  }
};

const getMigratedTables = async () => {
  const tables = await getDb().introspection.getTables();
  const names = tables.map((table) => table.name);
  return names
    .filter((name) => name === "gadget" || name === "widget")
    .toSorted();
};

describe("migrate", () => {
  beforeEach(resetMigrationTables);

  it("migrates up in key order", async () => {
    const results = await migrate(getDb(), migrations, "up");

    expect(results.map((result) => result.migrationName)).toEqual([
      "0001_widget",
      "0002_gadget",
    ]);
    expect(await getMigratedTables()).toEqual(["gadget", "widget"]);
  });

  it("does nothing when up to date", async () => {
    await migrate(getDb(), migrations, "up");
    const results = await migrate(getDb(), migrations, "up");

    expect(results).toEqual([]);
  });

  it("migrates down one step", async () => {
    await migrate(getDb(), migrations, "up");
    const results = await migrate(getDb(), migrations, "down");

    expect(results.map((result) => result.migrationName)).toEqual([
      "0002_gadget",
    ]);
    expect(await getMigratedTables()).toEqual(["widget"]);
  });

  it("releases its lock after a failure", async () => {
    const failing = migrate(getDb(), brokenMigrations, "up");
    await expect(failing).rejects.toThrow("migration failed");

    // A held lock would make this run throw instead.
    const widgetOnly = { "0001_widget": createTableMigration("widget") };
    const retry = migrate(getDb(), widgetOnly, "up");
    await expect(retry).resolves.toBeDefined();
  });
});

describe.runIf(!isD1)("migrate on SQLite and Postgres", () => {
  beforeEach(resetMigrationTables);

  it("leaves the schema untouched when a migration fails", async () => {
    const failing = migrate(getDb(), brokenMigrations, "up");
    await expect(failing).rejects.toThrow("migration failed");

    expect(await getMigratedTables()).toEqual([]);
  });
});

describe.runIf(isD1)("migrate on D1", () => {
  beforeEach(resetMigrationTables);

  it("keeps what ran before a failure: D1 has no transactions", async () => {
    const failing = migrate(getDb(), brokenMigrations, "up");
    await expect(failing).rejects.toThrow("migration failed");

    expect(await getMigratedTables()).toEqual(["gadget", "widget"]);
  });
});
