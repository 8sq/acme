import { release } from "./release.ts";

export interface Health {
  status: "pass" | "fail";
  release?: string;
}

// Never put error messages, hosts or env names here: the endpoint is open.
export const getHealth = (full: boolean): Health => {
  const status = "pass";
  if (!full) return { status };

  return { status, release };
};
