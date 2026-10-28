import { fileURLToPath } from "node:url";
import type { RouteConfigEntry } from "@react-router/dev/routes";

// A real path: the SSR build fails on one through node_modules.
const getRouteFile = (relativePath: string) => {
  return fileURLToPath(new URL(relativePath, import.meta.url));
};

const acmeRoutes: RouteConfigEntry[] = [
  {
    id: "acme/health",
    path: "_health",
    file: getRouteFile("./routes/health.ts"),
  },
];

export const defineRoutes = (
  routes: RouteConfigEntry[],
): RouteConfigEntry[] => {
  return [...acmeRoutes, ...routes];
};
