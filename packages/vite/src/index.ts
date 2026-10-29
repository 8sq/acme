import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import type { Plugin } from "vite";
import { createD1Config } from "./d1.ts";
import { checkDatabaseNames, createDatabasesPlugin } from "./databases.ts";
import { createIdentityPlugin } from "./identity.ts";
import { createSsrPlugin } from "./ssr.ts";
import { isWorkerd } from "./utils.ts";

export interface Options {
  /**
   * Names for `getDb()` from `@acme/app/db`; none leaves it unused.
   */
  databases?: readonly string[];
}

/**
 * React Router, Cloudflare on workerd builds, and the `__ACME_*__` globals.
 */
const acme = ({ databases = [] }: Options = {}): Plugin[] => {
  checkDatabaseNames(databases);

  const d1Config = createD1Config(databases);
  const cloudflarePlugins = isWorkerd
    ? cloudflare({
        viteEnvironment: { name: "ssr" },
        config: d1Config,
      })
    : [];
  const reactRouterPlugins = reactRouter();
  return [
    createIdentityPlugin(),
    createDatabasesPlugin(databases),
    createSsrPlugin(),
    ...cloudflarePlugins,
    ...reactRouterPlugins,
  ];
};

export default acme;
