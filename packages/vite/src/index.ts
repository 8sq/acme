import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflare, type PluginConfig } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import type { Plugin, PluginOption } from "vite";

const isWorkerd = process.env.BUILD_TARGET === "workerd";
// Unset or empty means localhost; a container sets 0.0.0.0 to be reachable.
const { DEVSERVER_HOST: devServerHost } = process.env;

// CI passes empty for unset inputs.
const readEnv = (name: string, fallback: string) => {
  const value = process.env[name] ?? "";
  return value === "" ? fallback : value;
};

// The app's root, not the cwd: a build may start from the repo root.
const createIdentityPlugin = (): Plugin => ({
  name: "acme:identity",
  config: (config) => {
    const root = path.resolve(config.root ?? "");
    const packagePath = path.join(root, "package.json");
    const packageJson = readFileSync(packagePath, "utf8");
    const appPackage = JSON.parse(packageJson) as {
      name: string;
      version: string;
    };
    const identity = {
      NAME: appPackage.name.replace(/^@[^/]+\//u, ""),
      VERSION: appPackage.version,
      ENV: readEnv("APP_ENV", "development"),
      REVISION: readEnv("APP_REVISION", "dev").slice(0, 7),
    };

    const define: Record<string, string> = {};
    for (const [key, value] of Object.entries(identity)) {
      define[`__ACME_${key}__`] = JSON.stringify(value);
    }
    return { define };
  },
});

// Uppercased into `<NAME>_DB` and `<NAME>_DATABASE_URL`.
// No "-": CI deletes preview databases by matching `<worker>-<name>`.
const databaseNamePattern = /^[a-z][a-z0-9_]*$/u;

const checkDatabaseNames = (names: readonly string[]) => {
  const invalidNames = names.filter((name) => !databaseNamePattern.test(name));
  if (invalidNames.length > 0) {
    const list = invalidNames.map((name) => `"${name}"`).join(", ");
    const rule = "lower case letters, digits, _, and start with a letter";
    const message = `database names should be ${rule}: ${list}`;
    throw new Error(message);
  }

  if (new Set(names).size !== names.length) {
    throw new Error("database names must be unique");
  }
};

const createDatabasesPlugin = (names: readonly string[]): Plugin => {
  const define = { __ACME_DATABASES__: JSON.stringify(names) };
  return { name: "acme:databases", config: () => ({ define }) };
};

const createSsrPlugin = (): Plugin => ({
  name: "acme:ssr",
  config: () => ({
    server: { host: devServerHost === "" ? undefined : devServerHost },
    ssr: {
      // Bundling breaks better-sqlite3. Node only: the Cloudflare plugin
      // refuses `external`.
      external: isWorkerd ? [] : ["better-sqlite3", "pg"],
      // Bundled so apps need not depend on what @acme/app/server imports.
      noExternal: ["isbot"],
    },
  }),
});

// Undocumented D1 limit, measured: longer names get API error 7400.
const maxD1NameLength = 255;

// `<worker>-<name>`, not wrangler's `<worker>-<binding>`: a re-created preview
// Worker reconnects to its database by name, and `migrate` can find it.
const createD1Config =
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

export interface Options {
  /**
   * Names for `getDb()` from `@acme/app/db`; none leaves it unused.
   */
  databases?: readonly string[];
}

/**
 * React Router, Cloudflare on workerd builds, and the `__ACME_*__` globals.
 */
const acme = ({ databases = [] }: Options = {}): PluginOption[] => {
  checkDatabaseNames(databases);

  const d1Config = createD1Config(databases);
  const cloudflarePlugins = isWorkerd
    ? cloudflare({
        viteEnvironment: { name: "ssr" },
        config: d1Config,
      })
    : [];
  return [
    createIdentityPlugin(),
    createDatabasesPlugin(databases),
    createSsrPlugin(),
    cloudflarePlugins,
    reactRouter(),
  ];
};

export default acme;
