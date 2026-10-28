import type { RouteConfigEntry } from "@react-router/dev/routes";

const acmeRoutes: RouteConfigEntry[] = [];

export const defineRoutes = (
  routes: RouteConfigEntry[],
): RouteConfigEntry[] => {
  return [...acmeRoutes, ...routes];
};
