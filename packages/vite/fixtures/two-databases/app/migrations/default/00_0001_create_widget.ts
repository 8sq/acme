import type { MigrationDb } from "@acme/app/migrate";

export const up = async (db: MigrationDb) => {
  await db.schema
    .createTable("widget")
    .addColumn("id", "integer", (column) => column.primaryKey())
    .execute();
};

export const down = async (db: MigrationDb) => {
  await db.schema.dropTable("widget").execute();
};
