// Child process for db.test.ts: closes on SIGTERM like react-router-serve.
import type { AddressInfo } from "node:net";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import Database from "better-sqlite3";
import { sql } from "kysely";
import { Pool } from "pg";
import { getDb } from "../src/db.ts";

type Method = (this: unknown, ...args: unknown[]) => unknown;

const logCalls = (prototype: object, method: string, message: string) => {
  const original = Reflect.get(prototype, method) as Method;
  const logged: Method = function logged(...args) {
    console.log(message);
    return original.apply(this, args);
  };
  Reflect.set(prototype, method, logged);
};

logCalls(Pool.prototype, "end", "postgres closed");
logCalls(Database.prototype, "close", "sqlite closed");

const names = process.argv.slice(2);
const queryAll = () => {
  const queries = names.map((name) => sql`select 1`.execute(getDb(name)));
  return Promise.all(queries);
};

const respond = async (response: ServerResponse) => {
  await queryAll();
  console.log("in flight");
  await wait(300);
  await queryAll();
  response.end("done");
};

await queryAll();

const server = createServer((_request, response) => {
  respond(response).catch((error: unknown) => {
    console.error(error);
    response.statusCode = 500;
    response.end("failed");
  });
});

// The first line of output is the port.
server.listen(0, () => {
  const { port } = server.address() as AddressInfo;
  console.log(port);
});

process.once("SIGTERM", () => {
  server.close();
});
