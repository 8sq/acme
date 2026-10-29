import { defineConfig } from "vite";
import acme from "../../src/index.ts";

export default defineConfig({
  plugins: [acme({ databases: ["default"] })],
});
