import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Same compatibility date as the apps' wrangler.jsonc.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-10-12",
        d1Databases: ["DEFAULT_DB"],
      },
    }),
  ],
});
