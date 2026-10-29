import { getHealth } from "../health.ts";
import type { LoaderFunctionArgs } from "react-router";

// Always 200: a liveness probe must not kill a degraded app; CI reads `status`.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const full = new URL(request.url).searchParams.has("full");
  const health = await getHealth(full);
  return Response.json(health, {
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
};
