import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  server: { host: "0.0.0.0" },
  // Bundled so apps need not depend on what @acme/app/server imports.
  ssr: { noExternal: ["isbot"] },
});
