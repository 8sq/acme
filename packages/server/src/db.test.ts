import type { Generated } from "kysely";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { getDb } from "./db.server.ts";

declare module "./db.server.ts" {
  interface Databases {
    default: { cat: { id: Generated<number>; name: string } };
  }
}

vi.stubEnv("DATABASE_URL", "sqlite::memory:");

describe("getDb", () => {
  it("types the default database by its declared schema", async () => {
    const db = getDb();
    await db.schema
      .createTable("cat")
      .addColumn("id", "integer", (column) => column.primaryKey())
      .addColumn("name", "text", (column) => column.notNull())
      .execute();
    await db.insertInto("cat").values({ name: "Kibby" }).execute();
    const cats = await db.selectFrom("cat").select("name").execute();
    expect(cats).toEqual([{ name: "Kibby" }]);
  });

  it("is the same database by name", () => {
    expect(getDb("default")).toBe(getDb());
  });

  it("takes only the default name so far", () => {
    expectTypeOf(getDb).parameter(0).toEqualTypeOf<"default" | undefined>();
  });
});
