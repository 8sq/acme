import { randomUUID } from "node:crypto";
import { Client } from "pg";

// A database per test file, so files can run in parallel.
const serverUrl = process.env.ACME_TEST_POSTGRES_URL;
const name = `acme_test_${randomUUID().replaceAll("-", "")}`;

const client = new Client(serverUrl);
await client.connect();
await client.query(`create database ${name}`);
await client.end();

const url = new URL(serverUrl ?? "");
url.pathname = `/${name}`;
process.env.DEFAULT_DATABASE_URL = url.href;
