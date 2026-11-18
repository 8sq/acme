import { getDb } from "@acme/app/db";

export const up = async () => {
  await getDb()
    .schema.createTable("player")
    .addColumn("id", "integer", (column) => column.primaryKey())
    .execute();
};

export const down = async () => {
  await getDb().schema.dropTable("player").execute();
};
