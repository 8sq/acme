import { getRelease } from "./release.ts";

type Result = "pass" | "fail";
type HealthCheck = () => unknown;

// A hung dependency must not hang the probe, which gives up after 5s.
const checkTimeoutMs = 2000;
const healthChecks = new Map<string, HealthCheck>();

/**
 * Adds a check that `/_health?full` runs and reports as `pass` or `fail`.
 *
 * Call it at module top level; a check that throws, rejects or hangs fails.
 */
export const addHealthCheck = (name: string, check: HealthCheck) => {
  if (healthChecks.has(name)) {
    throw new Error(`health check "${name}" is taken`);
  }

  healthChecks.set(name, check);
};

const runCheck = async (name: string, check: HealthCheck) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise((_resolve, reject) => {
    const error = new Error(`timed out after ${checkTimeoutMs}ms`);
    timer = setTimeout(reject, checkTimeoutMs, error);
  });

  try {
    await Promise.race([check(), timeout]);
    return [name, "pass"] as const;
  } catch (error) {
    console.error(`health check "${name}" failed:`, error);
    return [name, "fail"] as const;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Runs every added check; `status` fails if any of them does.
 */
export const runHealthChecks = async () => {
  const entries = [...healthChecks];
  const pending = entries.map(([name, check]) => runCheck(name, check));
  const results = await Promise.all(pending);
  const hasFailure = results.some(([, result]) => result === "fail");
  const status: Result = hasFailure ? "fail" : "pass";
  return { status, checks: Object.fromEntries(results) };
};

export interface Health {
  status: "pass" | "fail";
  release?: string;
  checks?: Record<string, "pass" | "fail">;
}

// Never put error messages, hosts or env names here: the endpoint is open.
export const getHealth = async (full: boolean): Promise<Health> => {
  if (!full) return { status: "pass" };

  const { status, checks } = await runHealthChecks();
  return { status, release: getRelease(), checks };
};
