import { getDb } from "@acme/app/db";

declare module "@acme/app/db" {
  interface Databases {
    default: { player: { id: number } };
  }
}

export const getPlayerIds = () => {
  return getDb().selectFrom("player").select("id").execute();
};
