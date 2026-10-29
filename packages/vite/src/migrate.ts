import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { checkMigrationNames } from "@acme/shared/rules";
import type { Plugin } from "vite";
import { isWorkerd, readAppPackage } from "./utils.ts";

const migrateEntryId = "virtual:acme/migrate";
const resolvedMigrateEntryId = `\0${migrateEntryId}`;
const serverBuildId = "virtual:react-router/server-build";

// Dotfiles are editor and OS litter, never migrations.
const readVisibleEntries = (directory: string) => {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.filter((entry) => !entry.name.startsWith("."));
};

const checkMajors = (names: readonly string[], appMajor: number) => {
  const newer = names.filter((name) => Number(name.slice(0, 2)) > appMajor);
  if (newer.length > 0) {
    const list = newer.join(", ");
    const message = `migrations above package.json major ${appMajor}: ${list}`;
    throw new Error(message);
  }
};

const readDatabaseMigrations = (directory: string, appMajor: number) => {
  const entries = readVisibleEntries(directory);
  const strays = entries.filter((entry) => {
    return !entry.isFile() || !entry.name.endsWith(".ts");
  });
  if (strays.length > 0) {
    const list = strays.map((entry) => entry.name).join(", ");
    const message = `${directory} holds more than .ts migrations: ${list}`;
    throw new Error(message);
  }

  const names = entries.map((entry) => entry.name.slice(0, -".ts".length));
  checkMigrationNames(names);
  checkMajors(names, appMajor);
  return names.toSorted();
};

// Undefined without app/migrations/: the build then emits no migrate.js.
const readMigrations = (root: string, databases: readonly string[]) => {
  const migrationsPath = path.join(root, "app", "migrations");
  if (!existsSync(migrationsPath)) return;

  const entries = readVisibleEntries(migrationsPath);
  const strays = entries.filter((entry) => {
    return !entry.isDirectory() || !databases.includes(entry.name);
  });
  if (strays.length > 0) {
    const list = strays.map((entry) => entry.name).join(", ");
    const message = `app/migrations/ entries not in databases: ${list}`;
    throw new Error(message);
  }

  const appMajor = Number(readAppPackage(root).version.split(".", 1)[0]);
  const directories = entries.map((entry) => entry.name);
  const migrations = directories.map((name) => {
    const directory = path.join(migrationsPath, name);
    const names = readDatabaseMigrations(directory, appMajor);
    return { name, directory, names };
  });
  return migrations;
};

type DatabaseMigrations = NonNullable<ReturnType<typeof readMigrations>>;

const createMigrateEntry = (migrations: DatabaseMigrations) => {
  const imports: string[] = [];
  const records = migrations.map(({ name, directory, names }) => {
    const fields = names.map((migration) => {
      const file = path.join(directory, `${migration}.ts`);
      const binding = `migration${imports.length}`;
      imports.push(`import * as ${binding} from ${JSON.stringify(file)};`);
      return `${JSON.stringify(migration)}: ${binding}`;
    });
    return `${JSON.stringify(name)}: { ${fields.join(", ")} }`;
  });
  return [
    'import { runMigrateScript } from "@acme/app/migrate";',
    ...imports,
    `await runMigrateScript({ ${records.join(", ")} });`,
  ].join("\n");
};

// A second server entry, so code shared with the app lands in shared chunks.
export const createMigratePlugin = (databases: readonly string[]): Plugin => {
  let migrations: DatabaseMigrations | undefined;
  return {
    name: "acme:migrate",
    apply: "build",
    config: (config) => {
      const root = path.resolve(config.root ?? "");
      migrations = readMigrations(root, databases);
      if (!migrations || isWorkerd) return;

      const input = { index: serverBuildId, "acme-migrate": migrateEntryId };
      const build = { rolldownOptions: { input } };
      return { environments: { ssr: { build } } };
    },
    // Runs after React Router gives every server entry the same file name.
    configEnvironment: {
      order: "post",
      handler: (name, config) => {
        if (name !== "ssr" || !migrations || isWorkerd) return;

        const serverOutput = config.build?.rolldownOptions?.output;
        const serverFile =
          !Array.isArray(serverOutput) && serverOutput?.entryFileNames;
        if (typeof serverFile !== "string") {
          throw new TypeError("React Router no longer names its server file");
        }

        // By module id: an app's own chunk could share any name.
        const entryFileNames = (chunk: { facadeModuleId: string | null }) => {
          const isMigrate = chunk.facadeModuleId === resolvedMigrateEntryId;
          return isMigrate ? "migrate.js" : serverFile;
        };
        const output = { entryFileNames };
        return { build: { rolldownOptions: { output } } };
      },
    },
    resolveId: (id) => {
      if (id !== migrateEntryId) return;

      return resolvedMigrateEntryId;
    },
    load: (id) => {
      if (id !== resolvedMigrateEntryId || !migrations) return;

      return createMigrateEntry(migrations);
    },
  };
};
