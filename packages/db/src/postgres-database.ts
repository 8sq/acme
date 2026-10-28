import { randomUUID } from "node:crypto";
import { Client } from "pg";

// A database per name per test file, so files can run in parallel.
const serverUrl = process.env.ACME_TEST_POSTGRES_URL;

const createDatabase = async (client: Client, name: string) => {
  const database = `acme_test_${randomUUID().replaceAll("-", "")}`;
  await client.query(`create database ${database}`);

  const url = new URL(serverUrl ?? "");
  url.pathname = `/${database}`;
  process.env[`${name.toUpperCase()}_DATABASE_URL`] = url.href;
};

const client = new Client(serverUrl);
await client.connect();
const creating = __ACME_DATABASES__.map((name) => createDatabase(client, name));
await Promise.all(creating);
await client.end();
