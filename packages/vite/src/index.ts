import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin } from "vite";

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
      REVISION: readEnv("APP_REVISION", "dev"),
    };

    const define: Record<string, string> = {};
    for (const [key, value] of Object.entries(identity)) {
      define[`__APP_${key}__`] = JSON.stringify(value);
    }
    return { define };
  },
});

// React Router resolves this again; a shared plugin would keep stale outDirs.
export default defineConfig(() => {
  const cloudflarePlugins = isWorkerd
    ? cloudflare({ viteEnvironment: { name: "ssr" } })
    : [];

  return {
    plugins: [createIdentityPlugin(), cloudflarePlugins, reactRouter()],
    server: { host: devServerHost === "" ? undefined : devServerHost },
    // Bundled so apps need not depend on what @acme/server imports.
    ssr: { noExternal: ["isbot"] },
  };
});
