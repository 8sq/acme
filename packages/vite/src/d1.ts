import type { PluginConfig } from "@cloudflare/vite-plugin";
import { readEnv } from "./utils.ts";

// Undocumented D1 limit, measured: longer names get API error 7400.
const maxD1NameLength = 255;

// `<worker>-<name>`, not wrangler's `<worker>-<binding>`: a re-created preview
// Worker reconnects to its database by name, and `migrate` can find it.
export const createD1Config =
  (names: readonly string[]): PluginConfig["config"] =>
  ({ name: configName }) => {
    if (names.length === 0) {
      return;
    }

    const worker = readEnv("ACME_WORKER_NAME", configName ?? "");
    if (worker === "") {
      throw new Error("databases need a Worker name or ACME_WORKER_NAME");
    }

    const d1Databases = names.map((name) => {
      const databaseName = `${worker}-${name}`;
      if (databaseName.length > maxD1NameLength) {
        const message = `D1 database "${databaseName}" for Worker "${worker}" is over ${maxD1NameLength} characters`;
        throw new Error(message);
      }

      return {
        binding: `${name.toUpperCase()}_DB`,
        database_name: databaseName,
      };
    });

    return { d1_databases: d1Databases };
  };
