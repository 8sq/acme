import { describe, expect, it } from "vitest";
import { checkStagingAuth } from "./check-staging-auth.ts";

const env = { BASIC_AUTH: "admin:s3:cret" };

const createRequest = (authorization?: string) => {
  const headers = authorization ? { Authorization: authorization } : undefined;
  return new Request("https://staging.example/", { headers });
};

const encodeBasic = (credentials: string, prefix = "Basic") => {
  const bytes = new TextEncoder().encode(credentials);
  return `${prefix} ${btoa(String.fromCodePoint(...bytes))}`;
};

describe("checkStagingAuth", () => {
  it("passes the right credentials, colon in the password included", async () => {
    const request = createRequest(encodeBasic("admin:s3:cret"));
    await expect(checkStagingAuth(request, env)).resolves.toBeUndefined();
  });

  it("passes a lowercase scheme", async () => {
    const authorization = encodeBasic("admin:s3:cret", "basic");
    const request = createRequest(authorization);
    await expect(checkStagingAuth(request, env)).resolves.toBeUndefined();
  });

  it("passes non-ASCII credentials", async () => {
    const request = createRequest(encodeBasic("admin:pässwörd"));
    const utf8Env = { BASIC_AUTH: "admin:pässwörd" };
    await expect(checkStagingAuth(request, utf8Env)).resolves.toBeUndefined();
  });

  it.each([
    ["missing", undefined],
    ["wrong password", encodeBasic("admin:s3:creT")],
    ["wrong user", encodeBasic("root:s3:cret")],
    ["other scheme", "Bearer abc"],
    ["bad base64", "Basic %%%"],
    ["empty token", "Basic "],
  ])("answers 401 when the header is %s", async (_case, authorization) => {
    const request = createRequest(authorization);
    const response = await checkStagingAuth(request, env);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("WWW-Authenticate")).toMatch(/^Basic realm=/u);
    expect(response?.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it.each([
    ["empty", ""],
    ["without a colon", "admin"],
    ["without a user", ":s3cret"],
  ])("answers 503 when the secret is %s", async (_case, secret) => {
    const request = createRequest(encodeBasic("admin:s3:cret"));
    const response = await checkStagingAuth(request, { BASIC_AUTH: secret });
    expect(response?.status).toBe(503);
    expect(response?.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("is open when no secret is set", async () => {
    const request = createRequest();
    await expect(checkStagingAuth(request, {})).resolves.toBeUndefined();
  });
});
