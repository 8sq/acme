import { spawn } from "node:child_process";
import { get, type IncomingMessage } from "node:http";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { type Kysely, sql } from "kysely";
import { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const postgresUrl = process.env.ACME_TEST_POSTGRES_URL;
const serverUrl = new URL("../testing/shutdown-server.ts", import.meta.url);
const serverPath = fileURLToPath(serverUrl);

// Without allowExitOnIdle, pg's idle clients hold the process for 10s.
const maxShutdownMs = 2000;

const fetchBody = async (port: string) => {
  const url = `http://localhost:${port}/`;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(url, { agent: false }, resolve).on("error", reject);
  });
  return text(response);
};

// A request is in flight, between two queries, when SIGTERM arrives.
const shutDownMidRequest = async (databaseUrls: Record<string, string>) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [name, url] of Object.entries(databaseUrls)) {
    env[`${name.toUpperCase()}_DATABASE_URL`] = url;
  }

  const names = Object.keys(databaseUrls);
  const child = spawn(process.execPath, [serverPath, ...names], { env });
  const exiting = new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();

  const { value: port = "" } = await lines.next();
  const responding = fetchBody(port);
  // The server prints "in flight" between the request's two queries.
  await lines.next();

  const signalledAt = performance.now();
  child.kill("SIGTERM");
  const body = await responding;
  const closed = await Array.fromAsync(lines);
  const code = await exiting;
  const shutdownMs = performance.now() - signalledAt;

  return { body, closed: closed.toSorted(), code, shutdownMs };
};

const selectBackendPid = async (db: Kysely<unknown>) => {
  const query = sql<{ pid: number }>`select pg_backend_pid() as pid`;
  const { rows } = await query.execute(db);
  return rows[0]?.pid;
};

const terminateBackend = async (url: string, pid: number | undefined) => {
  const client = new Client(url);
  await client.connect();
  try {
    await client.query("select pg_terminate_backend($1)", [pid]);
  } finally {
    await client.end();
  }
};

// Opened databases are module state: each test gets a fresh module.
const importDb = () => {
  return import("./db.ts");
};

const sqliteOnly = {
  name: "SQLite",
  databaseUrls: { local: "sqlite::memory:" },
  closed: ["sqlite closed"],
};
const postgresAndSqlite = {
  name: "Postgres and SQLite",
  databaseUrls: { local: "sqlite::memory:", remote: postgresUrl ?? "" },
  closed: ["postgres closed", "sqlite closed"],
};
// Postgres runs only when a server is given, so `pnpm test` needs none.
const shutdownCases = postgresUrl
  ? [sqliteOnly, postgresAndSqlite]
  : [sqliteOnly];

describe("getDb", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("adds its exit listener on the first database only", async () => {
    const { getDb } = await importDb();
    const listenersBefore = process.listenerCount("beforeExit");
    process.env.LISTENER_DATABASE_URL = "sqlite::memory:";
    getDb("listener");
    getDb("listener");

    expect(process.listenerCount("beforeExit")).toBe(listenersBefore + 1);
  });

  it("adds no exit listener when the database fails to open", async () => {
    const { getDb } = await importDb();
    const listenersBefore = process.listenerCount("beforeExit");
    delete process.env.MISSING_DATABASE_URL;

    expect(() => getDb("missing")).toThrow("MISSING_DATABASE_URL is not set");
    expect(process.listenerCount("beforeExit")).toBe(listenersBefore);
  });

  it.runIf(postgresUrl)(
    "keeps serving after an idle connection drops",
    async () => {
      const { getDb } = await importDb();
      process.env.DROPPED_DATABASE_URL = postgresUrl;
      const db = getDb("dropped");
      const logging = new Promise((resolve) => {
        vi.spyOn(console, "error").mockImplementation(resolve);
      });

      try {
        const pid = await selectBackendPid(db);
        await terminateBackend(postgresUrl ?? "", pid);
        const logged = await logging;
        const nextPid = await selectBackendPid(db);

        expect(logged).toBe("DROPPED_DATABASE_URL: idle connection failed");
        expect(nextPid).not.toBe(pid);
      } finally {
        vi.restoreAllMocks();
        await db.destroy();
      }
    },
  );

  it.each(shutdownCases)(
    "closes $name after the last request on SIGTERM",
    async ({ databaseUrls, closed }) => {
      const result = await shutDownMidRequest(databaseUrls);

      expect(result.body).toBe("done");
      expect(result.closed).toEqual(closed);
      expect(result.code).toBe(0);
      expect(result.shutdownMs).toBeLessThan(maxShutdownMs);
    },
  );
});
