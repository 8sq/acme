import { getHealth } from "@acme/server";
import type { LoaderFunctionArgs } from "react-router";

// Always 200: a liveness probe must not kill a degraded app; CI reads `status`.
export const loader = ({ request }: LoaderFunctionArgs) => {
  const full = new URL(request.url).searchParams.has("full");
  const health = getHealth(full);
  return Response.json(health, {
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
};
