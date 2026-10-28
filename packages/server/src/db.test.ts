import { CamelCasePlugin, sql } from "kysely";
import { beforeEach, describe, expect, expectTypeOf, inject, it } from "vitest";
import { getDbKind } from "#runtime/db";
import { batch, getDb, readAll } from "./db.server.ts";

type DatabaseKind = "sqlite" | "d1" | "postgres";

declare module "vitest" {
  interface ProvidedContext {
    database: DatabaseKind;
  }
}

declare module "./db.server.ts" {
  interface Databases {
    default: { cat: { id: number; name: string } };
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
