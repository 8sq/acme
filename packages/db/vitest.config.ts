import { cloudflareTest } from "@cloudflare/vitest-plugin";
import {
  defineConfig,
  type TestProjectInlineConfiguration,
} from "vitest/config";

const include = ["src/**/*.test.ts"];
// What @acme/vite stamps in an app.
const define = { __ACME_DATABASES__: JSON.stringify(["default"]) };
const postgresUrl = process.env.ACME_TEST_POSTGRES_URL;

// Defined only when a server is given, so `pnpm test` needs no Postgres.
const postgres: TestProjectInlineConfiguration[] = postgresUrl
  ? [
      {
        define,
        test: {
          name: "node:postgres",
          include,
          globalSetup: ["src/postgres-cleanup.ts"],
          setupFiles: ["src/postgres-database.ts"],
          provide: { database: "postgres" },
        },
      },
    ]
  : [];

export default defineConfig({
  test: {
    projects: [
      {
        define,
        test: {
          name: "node:sqlite",
          include,
          env: { DEFAULT_DATABASE_URL: "sqlite::memory:" },
          provide: { database: "sqlite" },
        },
      },
      {
        define,
        // Same compatibility date as the apps' wrangler.jsonc.
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: "2026-10-12",
              d1Databases: ["DEFAULT_DB"],
            },
          }),
        ],
        test: { name: "workerd:d1", include, provide: { database: "d1" } },
      },
      ...postgres,
    ],
  },
});
