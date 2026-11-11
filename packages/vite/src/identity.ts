import path from "node:path";
import type { Plugin } from "vite";
import { readAppPackage, readEnv } from "./utils.ts";

export const createIdentityPlugin = (): Plugin => ({
  name: "acme:identity",
  config: (config) => {
    const root = path.resolve(config.root ?? "");
    const appPackage = readAppPackage(root);
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
