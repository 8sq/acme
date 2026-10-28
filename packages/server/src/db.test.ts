import { sql } from "kysely";
import { beforeEach, describe, expect, expectTypeOf, inject, it } from "vitest";
import { getDbKind } from "#runtime/db";
import { getDb } from "./db.server.ts";

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

describe("getDb", () => {
  beforeEach(async () => {
    const db = getDb();
    await db.schema.dropTable("cat").ifExists().execute();
    await db.schema
      .createTable("cat")
      .addColumn("id", "integer", (column) => column.primaryKey())
      .addColumn("name", "text", (column) => column.notNull())
      .execute();
  });

  it("runs on the project's database", () => {
    expect(getDbKind()).toBe(database);
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

  it.runIf(!isD1)("commits a transaction", async () => {
    await getDb()
      .transaction()
      .execute(async (trx) => {
        await trx.insertInto("cat").values({ id: 1, name: "Cattie" }).execute();
      });
    const cats = await getDb().selectFrom("cat").select("name").execute();

    expect(cats).toEqual([{ name: "Cattie" }]);
  });

  it.runIf(isD1)("throws on a transaction", async () => {
    const transaction = getDb()
      .transaction()
      .execute(() => Promise.resolve());

    await expect(transaction).rejects.toThrow(
      "D1 doesn't support transactions",
    );
  });

  it.runIf(!isD1)("keeps one instance per process", () => {
    expect(getDb("default")).toBe(getDb());
  });

  it.runIf(isD1)("doesn't queue one getDb() behind another", async () => {
    const first = getDb();
    expect(getDb()).not.toBe(first);

    // Holding the first instance's only connection stands in for a hung query.
    const answer = await first
      .connection()
      .execute(async () =>
        sql<{ one: number }>`select 1 as one`.execute(getDb()),
      );
    expect(answer.rows).toEqual([{ one: 1 }]);
  });

  it("takes only the default name so far", () => {
    expectTypeOf(getDb).parameter(0).toEqualTypeOf<"default" | undefined>();
  });
});
