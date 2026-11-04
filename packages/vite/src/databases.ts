import type { Plugin } from "vite";

// Uppercased into `<NAME>_DB` and `<NAME>_DATABASE_URL`.
// No "-": CI deletes preview databases by matching `<worker>-<name>`.
const databaseNamePattern = /^[a-z][a-z0-9_]*$/u;

export const checkDatabaseNames = (names: readonly string[]) => {
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

export const createDatabasesPlugin = (names: readonly string[]): Plugin => {
  const define = { __ACME_DATABASES__: JSON.stringify(names) };
  return { name: "acme:databases", config: () => ({ define }) };
};
