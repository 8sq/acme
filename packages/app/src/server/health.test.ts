import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The registry is module state: each test gets a fresh one.
const importHealthChecks = () => {
  return import("./health.ts");
};

describe("runHealthChecks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes with no checks", async () => {
    const { runHealthChecks } = await importHealthChecks();
    expect(await runHealthChecks()).toEqual({ status: "pass", checks: {} });
  });

  it("reports each check and fails the status if one fails", async () => {
    const { addHealthCheck, runHealthChecks } = await importHealthChecks();
    addHealthCheck("cache", () => undefined);
    addHealthCheck("queue", () => Promise.reject(new Error("secret host")));

    expect(await runHealthChecks()).toEqual({
      status: "fail",
      checks: { cache: "pass", queue: "fail" },
    });
  });

  it("logs why a check failed", async () => {
    const { addHealthCheck, runHealthChecks } = await importHealthChecks();
    const error = new Error("secret host");
    addHealthCheck("queue", () => Promise.reject(error));
    await runHealthChecks();

    expect(console.error).toHaveBeenCalledWith(
      'health check "queue" failed:',
      error,
    );
  });

  it("fails a check that throws synchronously", async () => {
    const { addHealthCheck, runHealthChecks } = await importHealthChecks();
    addHealthCheck("broken", () => {
      throw new Error("boom");
    });

    const { checks } = await runHealthChecks();
    expect(checks).toEqual({ broken: "fail" });
  });

  it("fails a check that hangs past 2 seconds", async () => {
    vi.useFakeTimers();
    const { addHealthCheck, runHealthChecks } = await importHealthChecks();
    const neverSettles = new Promise(() => {
      // Never settles, like a hung dependency.
    });
    addHealthCheck("hung", () => neverSettles);

    const running = runHealthChecks();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await running).toEqual({ status: "fail", checks: { hung: "fail" } });
  });

  it("refuses a name that is taken", async () => {
    const { addHealthCheck } = await importHealthChecks();
    addHealthCheck("database", () => undefined);

    expect(() => {
      addHealthCheck("database", () => undefined);
    }).toThrow('health check "database" is taken');
  });
});
