import { type Generated, type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { getDb } from "./db.ts";

interface Database {
  cat: { id: Generated<number>; name: string };
}

describe("getDb", () => {
  it("runs CRUD on D1", async () => {
    const db = getDb() as Kysely<Database>;
    await db.schema
      .createTable("cat")
      .addColumn("id", "integer", (column) => column.primaryKey())
      .addColumn("name", "text", (column) => column.notNull())
      .execute();

    const { id } = await db
      .insertInto("cat")
      .values({ name: "Kibby" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("cat")
      .set({ name: "Jane" })
      .where("id", "=", id)
      .execute();
    const cats = await db.selectFrom("cat").selectAll().execute();
    await db.deleteFrom("cat").where("id", "=", id).execute();
    const left = await db.selectFrom("cat").selectAll().execute();

    expect(cats).toEqual([{ id, name: "Jane" }]);
    expect(left).toEqual([]);
    // D1 refuses `sqlite_version()`, which a Node SQLite would answer.
    await expect(sql`select sqlite_version()`.execute(db)).rejects.toThrow();
  });

  it("throws on transaction()", async () => {
    const transaction = getDb()
      .transaction()
      .execute(() => Promise.resolve());
    await expect(transaction).rejects.toThrow(
      "D1 doesn't support transactions",
    );
  });

  it("doesn't queue one getDb() behind another", async () => {
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
});
