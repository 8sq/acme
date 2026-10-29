import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { checkMigrationNames, getMigrationMajor } from "@acme/shared/rules";
import type { EnvironmentOptions, Plugin, Rolldown } from "vite";
import { isWorkerd, readAppPackage } from "./utils.ts";

const migrateEntryId = "virtual:acme/migrate";
const resolvedMigrateEntryId = `\0${migrateEntryId}`;
const serverBuildId = "virtual:react-router/server-build";
const appDbModule = "@acme/app/db";

// Dotfiles are editor and OS litter, never migrations.
const readVisibleEntries = (directory: string) => {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.filter((entry) => !entry.name.startsWith("."));
};

const checkMajors = (names: readonly string[], appMajor: number) => {
  const newer = names.filter((name) => getMigrationMajor(name) > appMajor);
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

// `towardTarget` maps each module to its next import on the way to the target.
const getChain = (towardTarget: ReadonlyMap<string, string>, start: string) => {
  const chain = [start];
  for (let id = towardTarget.get(start); id; id = towardTarget.get(id)) {
    chain.push(id);
  }
  return chain;
};

// One walk back through importers, so its cost is independent of how many
// migrations exist. Breadth-first, so each chain found is the shortest.
const findImportChains = (
  context: Rolldown.PluginContext,
  starts: readonly string[],
  target: string,
) => {
  const towardTarget = new Map<string, string>();
  const queue = [target];
  for (const id of queue) {
    const info = context.getModuleInfo(id);
    const importers = [
      ...(info?.importers ?? []),
      ...(info?.dynamicImporters ?? []),
    ];
    for (const importer of importers) {
      if (importer !== target && !towardTarget.has(importer)) {
        towardTarget.set(importer, id);
        queue.push(importer);
      }
    }
  }
  const reached = starts.filter((start) => towardTarget.has(start));
  return reached.map((start) => getChain(towardTarget, start));
};

// getDb() bypasses the migration's transaction, which holds the connection.
// SQLite then waits forever; Postgres writes outside the rollback.
const checkMigrationImports = async (
  context: Rolldown.PluginContext,
  root: string,
  migrations: DatabaseMigrations,
) => {
  const files = migrations.flatMap(({ directory, names }) => {
    return names.map((name) => path.join(directory, `${name}.ts`));
  });
  const resolved = await context.resolve(appDbModule, files[0]);
  if (!resolved) return;

  const chains = findImportChains(context, files, resolved.id);
  if (chains.length > 0) {
    const lines = chains.map((chain) => {
      const importers = chain.slice(0, -1).map((id) => path.relative(root, id));
      return `  ${[...importers, appDbModule].join(" imports ")}`;
    });
    const rule = "migrations must use the db passed to up and down";
    const message = `${rule}, never ${appDbModule}:\n${lines.join("\n")}`;
    context.error(message);
  }
};

const createMigrateOutput = (config: EnvironmentOptions) => {
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
  return { entryFileNames };
};

// A second server entry, so code shared with the app lands in shared chunks.
export const createMigratePlugin = (databases: readonly string[]): Plugin => {
  let root = "";
  let migrations: DatabaseMigrations | undefined;
  return {
    name: "acme:migrate",
    apply: "build",
    config: (config) => {
      root = path.resolve(config.root ?? "");
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

        const output = createMigrateOutput(config);
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
    async buildEnd() {
      if (this.environment.name !== "ssr" || !migrations || isWorkerd) return;

      await checkMigrationImports(this, root, migrations);
    },
  };
};
