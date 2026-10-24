import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

const isWorkerd = process.env.BUILD_TARGET === "workerd";

// React Router resolves this again; a shared plugin would keep stale outDirs.
export default defineConfig(() => {
  const cloudflarePlugins = isWorkerd
    ? cloudflare({ viteEnvironment: { name: "ssr" } })
    : [];

  return {
    plugins: [cloudflarePlugins, reactRouter()],
    server: { host: "0.0.0.0" },
    // Bundled so apps need not depend on what @acme/app/server imports.
    ssr: { noExternal: ["isbot"] },
  };
});
