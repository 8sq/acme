import { type Generated, type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Database {
  cat: { id: Generated<number>; name: string };
}

const importGetDb = async (url?: string) => {
  vi.stubEnv("DATABASE_URL", url);
  const { getDb } = await import("./db.ts");
  return getDb;
};

describe("getDb", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs CRUD on SQLite", async () => {
    const getDb = await importGetDb("sqlite::memory:");
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
    const { rows } = await sql<{
      version: string;
    }>`select sqlite_version() as version`.execute(db);
    expect(rows[0]?.version).toMatch(/^3\./u);
  });

  it("keeps one instance per process", async () => {
    const getDb = await importGetDb("sqlite::memory:");
    expect(getDb()).toBe(getDb());
  });

  it("runs a transaction on SQLite", async () => {
    const getDb = await importGetDb("sqlite::memory:");
    const answer = await getDb()
      .transaction()
      .execute(async (trx) =>
        sql<{ one: number }>`select 1 as one`.execute(trx),
      );
    expect(answer.rows).toEqual([{ one: 1 }]);
  });

  it("fails when DATABASE_URL is missing", async () => {
    const getDb = await importGetDb();
    expect(getDb).toThrow("DATABASE_URL is not set");
  });

  it("names an unknown scheme without echoing the URL", async () => {
    const getDb = await importGetDb("mysql://admin:hunter2@host/app");
    expect(getDb).toThrow('DATABASE_URL: unsupported scheme "mysql:"');
  });
});
