import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

const isWorkerd = process.env.BUILD_TARGET === "workerd";
// Unset or empty means localhost; a container sets 0.0.0.0 to be reachable.
const { DEVSERVER_HOST: devServerHost } = process.env;

// React Router resolves this again; a shared plugin would keep stale outDirs.
export default defineConfig(() => {
  const cloudflarePlugins = isWorkerd
    ? cloudflare({ viteEnvironment: { name: "ssr" } })
    : [];

  return {
    plugins: [cloudflarePlugins, reactRouter()],
    server: { host: devServerHost === "" ? undefined : devServerHost },
    ssr: {
      // Node only (the Cloudflare plugin refuses it): better-sqlite3 breaks when bundled.
      external: isWorkerd ? [] : ["better-sqlite3", "pg"],
      // Bundled so apps need not depend on what @acme/server imports.
      noExternal: ["isbot"],
    },
  };
});
