import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const importGetDb = async (url?: string) => {
  vi.stubEnv("DATABASE_URL", url);
  const { getDb } = await import("./db.ts");
  return getDb;
};

describe("getDb", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails when DATABASE_URL is missing", async () => {
    const getDb = await importGetDb();
    expect(getDb).toThrow("DATABASE_URL is not set");
  });

  it("names an unknown scheme without echoing the URL", async () => {
    const getDb = await importGetDb("mysql://admin:hunter2@host/app");
    expect(getDb).toThrow('DATABASE_URL: unsupported scheme "mysql:"');
  });

  it("refuses a scheme named after an Object.prototype key", async () => {
    const getDb = await importGetDb("constructor:x");
    expect(getDb).toThrow('DATABASE_URL: unsupported scheme "constructor:"');
  });
});
