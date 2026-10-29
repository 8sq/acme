import { readFileSync } from "node:fs";
import path from "node:path";

export const isWorkerd = process.env.BUILD_TARGET === "workerd";

// CI passes empty for unset inputs.
export const readEnv = (name: string, fallback: string) => {
  const value = process.env[name] ?? "";
  return value === "" ? fallback : value;
};

// The app's root, not the cwd: a build may start from the repo root.
export const readAppPackage = (root: string) => {
  const packagePath = path.join(root, "package.json");
  const packageJson = readFileSync(packagePath, "utf8");
  return JSON.parse(packageJson) as { name: string; version: string };
};
