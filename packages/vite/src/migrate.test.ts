import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import type { UserConfig } from "vite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createMigratePlugin } from "./migrate.ts";

const fixturePath = path.join(import.meta.dirname, "../fixtures/two-databases");
const reactRouterPath = path.join(
  import.meta.dirname,
  "../node_modules/.bin/react-router",
);
const postgresUrl = process.env.ACME_TEST_POSTGRES_URL;
// Kysely's advisory lock id for Postgres migrations.
const postgresLockId = "3853314791062309107";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const runCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> },
) => {
  const env = { ...process.env, ...options.env };
  const child = spawn(command, args, { cwd: options.cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise<Run>((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
};

const buildApp = async (root: string) => {
  const run = await runCommand(reactRouterPath, ["build"], { cwd: root });
  if (run.code !== 0) throw new Error(run.stderr);
};

const runMigrate = (env: Record<string, string>, args: string[] = []) => {
  const script = path.join(fixturePath, "build/server/migrate.js");
  return runCommand(process.execPath, [script, ...args], { env });
};

const createSqliteEnv = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "acme-migrate-"));
  return {
    DEFAULT_DATABASE_URL: `sqlite:${path.join(directory, "default.db")}`,
    AUDIT_DATABASE_URL: `sqlite:${path.join(directory, "audit.db")}`,
  };
};

const createPostgresDatabase = async (client: Client) => {
  const database = `acme_test_${randomUUID().replaceAll("-", "")}`;
  await client.query(`create database ${database}`);
  const url = new URL(postgresUrl ?? "");
  url.pathname = `/${database}`;
  return url.href;
};

const createPostgresEnv = async () => {
  const client = new Client(postgresUrl);
  await client.connect();
  const defaultUrl = await createPostgresDatabase(client);
  const auditUrl = await createPostgresDatabase(client);
  await client.end();
  return { DEFAULT_DATABASE_URL: defaultUrl, AUDIT_DATABASE_URL: auditUrl };
};

const getTables = async (url: string) => {
  if (url.startsWith("sqlite:")) {
    const database = new Database(url.slice("sqlite:".length));
    const query = "select name from sqlite_master where type = 'table'";
    const rows = database.prepare<[], { name: string }>(query).all();
    database.close();
    return rows
      .map((row) => row.name)
      .filter((name) => !name.startsWith("kysely_"))
      .toSorted();
  }

  const client = new Client(url);
  await client.connect();
  const query = "select tablename from pg_tables where schemaname = 'public'";
  const { rows } = await client.query<{ tablename: string }>(query);
  await client.end();
  return rows
    .map((row) => row.tablename)
    .filter((name) => !name.startsWith("kysely_"))
    .toSorted();
};

// Another migrator mid-run: it holds the lock and has applied the first
// migration, uncommitted until the returned function runs.
const startOtherRun = async (url: string) => {
  const statements = [
    "create table widget (id integer primary key)",
    "insert into kysely_migration (name, timestamp) values ('00_0001_create_widget', '2026-10-29T00:00:00.000Z')",
  ];
  if (url.startsWith("sqlite:")) {
    const database = new Database(url.slice("sqlite:".length));
    database.exec("begin immediate");
    for (const statement of statements) database.exec(statement);
    return () => {
      database.exec("commit");
      database.close();
      return Promise.resolve();
    };
  }

  const client = new Client(url);
  await client.connect();
  await client.query(`select pg_advisory_lock(${postgresLockId})`);
  await client.query("begin");
  for (const statement of statements) {
    // oxlint-disable-next-line no-await-in-loop
    await client.query(statement);
  }
  return async () => {
    await client.query("commit");
    await client.end();
  };
};
const createTable = async (url: string, table: string) => {
  const statement = `create table ${table} (id integer primary key)`;
  if (url.startsWith("sqlite:")) {
    const database = new Database(url.slice("sqlite:".length));
    database.exec(statement);
    database.close();
    return;
  }

  const client = new Client(url);
  await client.connect();
  await client.query(statement);
  await client.end();
};

const backends = [
  { name: "sqlite", createEnv: () => Promise.resolve(createSqliteEnv()) },
  ...(postgresUrl ? [{ name: "postgres", createEnv: createPostgresEnv }] : []),
];

// One fixture build for every describe: a build takes two seconds.
await buildApp(fixturePath);

describe.each(backends)("migrate.js on $name", ({ createEnv }) => {
  let env: Awaited<ReturnType<typeof createEnv>>;

  beforeEach(async () => {
    env = await createEnv();
  });

  it("migrates every database to its latest", async () => {
    const run = await runMigrate(env);

    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(run.stdout.trim().split("\n")).toEqual([
      "default: applied 00_0001_create_widget",
      "default: applied 00_0002_create_gadget",
      "default: applied 01_0001_create_gizmo",
      "audit: applied 00_0001_create_entry",
    ]);
  });

  it.each([
    { from: "01", target: "00_0001_create_widget", tables: ["widget"] },
    { from: "01", target: "00_0002", tables: ["gadget", "widget"] },
    { from: "01", target: "00", tables: ["gadget", "widget"] },
    { from: "01", target: "none", tables: [] },
    { from: "none", target: "01", tables: ["gadget", "gizmo", "widget"] },
  ])("moves from $from to $target", async ({ from, target, tables }) => {
    await runMigrate(env, [from, "--db", "default"]);
    const run = await runMigrate(env, [target, "--db", "default"]);

    expect(run.code).toBe(0);
    expect(await getTables(env.DEFAULT_DATABASE_URL)).toEqual(tables);
  });

  it("exits 1 at a failing database, keeping earlier ones migrated", async () => {
    await createTable(env.AUDIT_DATABASE_URL, "entry");
    const run = await runMigrate(env);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      'database "audit": migration failed at 00_0001_create_entry',
    );
    expect(await getTables(env.DEFAULT_DATABASE_URL)).toEqual([
      "gadget",
      "gizmo",
      "widget",
    ]);
  });

  it("exits 1 on a target without --db, with nothing run", async () => {
    const run = await runMigrate(env, ["00"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("a target needs --db <name>");
    expect(await getTables(env.DEFAULT_DATABASE_URL)).toEqual([]);
  });

  it("waits for a migrator mid-run, then applies the rest", async () => {
    await runMigrate(env, ["none", "--db", "default"]);
    const commitOtherRun = await startOtherRun(env.DEFAULT_DATABASE_URL);
    const running = runMigrate(env, ["--db", "default"]);
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
    await commitOtherRun();
    const run = await running;

    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(run.stdout.trim().split("\n")).toEqual([
      "default: applied 00_0002_create_gadget",
      "default: applied 01_0001_create_gizmo",
    ]);
  });
  it("applies each migration once across concurrent processes", async () => {
    const runs = await Promise.all([runMigrate(env), runMigrate(env)]);

    expect(runs.map((run) => run.code)).toEqual([0, 0]);
    const lines = runs.flatMap((run) => run.stdout.trim().split("\n"));
    const widgetLines = lines.filter((line) => line.includes("widget"));
    expect(widgetLines).toEqual(["default: applied 00_0001_create_widget"]);
  });
});

describe("migrate.js on sqlite with a lock held past the busy timeout", () => {
  it("exits 1 naming the lock", async () => {
    const env = createSqliteEnv();
    await runMigrate(env, ["none", "--db", "default"]);
    const commitOtherRun = await startOtherRun(env.DEFAULT_DATABASE_URL);
    const run = await runMigrate(env, ["--db", "default"]);
    await commitOtherRun();

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("database is locked");
  }, 15_000);
});

// Just what the plugin's config hook reads: no build, so no imports to resolve.
const createApp = (files: readonly string[]) => {
  const root = mkdtempSync(path.join(tmpdir(), "acme-migrate-app-"));
  const appPackage = { name: "app", version: "1.0.0" };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(appPackage));
  for (const file of files) {
    const filePath = path.join(root, file);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "");
  }
  return root;
};

const runMigrateConfig = (root: string) => {
  const plugin = createMigratePlugin(["default", "audit"]);
  const config = plugin.config as (config: UserConfig) => unknown;
  return config({ root });
};

describe("the migrate plugin", () => {
  const roots: string[] = [];
  const validFiles = [
    "app/migrations/default/00_0001_create_widget.ts",
    "app/migrations/audit/00_0001_create_entry.ts",
  ];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    {
      change: "a directory not in databases",
      file: "app/migrations/billing/00_0001_create_invoice.ts",
      message: "app/migrations/ entries not in databases: billing",
    },
    {
      change: "a migration above the package.json major",
      file: "app/migrations/default/02_0001_create_part.ts",
      message: "migrations above package.json major 1: 02_0001_create_part",
    },
    {
      change: "a gap in a major",
      file: "app/migrations/audit/00_0003_create_note.ts",
      message:
        "00_0003_create_note breaks the sequence: expected 00_0002 after 00_0001_create_entry",
    },
    {
      change: "a file that is not a .ts migration",
      file: "app/migrations/audit/README.md",
      message: "holds more than .ts migrations: README.md",
    },
  ])("fails the build on $change", ({ file, message }) => {
    const root = createApp([...validFiles, file]);
    roots.push(root);
    const configure = () => runMigrateConfig(root);

    expect(configure).toThrow(message);
  });

  it("adds no migrate entry without app/migrations/", () => {
    const root = createApp([]);
    roots.push(root);

    expect(runMigrateConfig(root)).toBeUndefined();
  });
});
