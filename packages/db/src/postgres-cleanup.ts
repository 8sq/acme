import { Client } from "pg";

// Drops databases left by earlier local runs; CI starts from an empty server.
export const setup = async () => {
  const serverUrl = process.env.ACME_TEST_POSTGRES_URL;
  const client = new Client(serverUrl);
  await client.connect();
  const query =
    "select datname from pg_database where datname like 'acme_test_%'";
  const { rows } = await client.query<{ datname: string }>(query);
  for (const { datname } of rows) {
    // A database another run still uses refuses to drop; it goes next time.
    // oxlint-disable-next-line no-await-in-loop
    await client.query(`drop database "${datname}"`).catch(() => undefined);
  }
  await client.end();
};
