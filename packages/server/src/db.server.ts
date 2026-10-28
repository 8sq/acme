import type { Kysely } from "kysely";
import { getDb as getRuntimeDb } from "#runtime/db";

/**
 * The app's schemas by database name, filled with `declare module "@acme/server/db"`.
 */
// oxlint-disable-next-line no-empty-object-type
export interface Databases {}

type Schema<Name> = Name extends keyof Databases ? Databases[Name] : never;

/**
 * An app's database: D1 on workerd, `DATABASE_URL` on Node. Only `"default"` exists so far.
 */
export const getDb = (_name: "default" = "default") => {
  return getRuntimeDb() as Kysely<Schema<"default">>;
};
