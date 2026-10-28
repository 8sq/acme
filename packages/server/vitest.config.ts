import { cloudflareTest } from "@cloudflare/vitest-plugin";
import {
  defineConfig,
  type TestProjectInlineConfiguration,
} from "vitest/config";

const include = ["src/**/*.test.ts"];
const postgresUrl = process.env.ACME_TEST_POSTGRES_URL;

// Defined only when a server is given, so `pnpm test` needs no Postgres.
const postgres: TestProjectInlineConfiguration[] = postgresUrl
  ? [
      {
        test: {
          name: "node:postgres",
          include,
          // One shared database: parallel files would drop each other's tables.
          fileParallelism: false,
          env: { DATABASE_URL: postgresUrl },
          provide: { database: "postgres" },
        },
      },
    ]
  : [];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node:sqlite",
          include,
          env: { DATABASE_URL: "sqlite::memory:" },
          provide: { database: "sqlite" },
        },
      },
      {
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
