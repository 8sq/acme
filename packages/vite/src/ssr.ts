import type { Plugin } from "vite";
import { isWorkerd } from "./utils.ts";

// Unset or empty means localhost; a container sets 0.0.0.0 to be reachable.
const { DEVSERVER_HOST: devServerHost } = process.env;

export const createSsrPlugin = (): Plugin => ({
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
