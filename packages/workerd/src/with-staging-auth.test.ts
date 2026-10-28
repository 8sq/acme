import { describe, expect, it } from "vitest";
import { withStagingAuth } from "./with-staging-auth.ts";

const env = { BASIC_AUTH: "admin:s3:cret" };

const createRequest = (authorization?: string, path = "/") => {
  const headers = authorization ? { Authorization: authorization } : undefined;
  return new Request(`https://staging.example${path}`, { headers });
};

const encodeBasic = (credentials: string, prefix = "Basic") => {
  const bytes = new TextEncoder().encode(credentials);
  return `${prefix} ${btoa(String.fromCodePoint(...bytes))}`;
};

const fetchApp = withStagingAuth(() => {
  return new Response("app");
});

describe("withStagingAuth", () => {
  it("passes the right credentials, colon in the password included", async () => {
    const request = createRequest(encodeBasic("admin:s3:cret"));
    const response = await fetchApp(request, env);
    expect(await response.text()).toBe("app");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("passes a lowercase scheme", async () => {
    const authorization = encodeBasic("admin:s3:cret", "basic");
    const response = await fetchApp(createRequest(authorization), env);
    expect(await response.text()).toBe("app");
  });

  it("passes non-ASCII credentials", async () => {
    const request = createRequest(encodeBasic("admin:pässwörd"));
    const utf8Env = { BASIC_AUTH: "admin:pässwörd" };
    const response = await fetchApp(request, utf8Env);
    expect(await response.text()).toBe("app");
  });

  it("marks a response whose headers are immutable", async () => {
    const fetchRedirect = withStagingAuth(() => {
      return Response.redirect("https://staging.example/home", 302);
    });
    const request = createRequest(encodeBasic("admin:s3:cret"));
    const response = await fetchRedirect(request, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
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
    const response = await fetchApp(request, env);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toMatch(/^Basic realm=/u);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it.each([
    ["empty", ""],
    ["without a colon", "admin"],
    ["without a user", ":s3cret"],
  ])("answers 503 when the secret is %s", async (_case, secret) => {
    const request = createRequest(encodeBasic("admin:s3:cret"));
    const response = await fetchApp(request, { BASIC_AUTH: secret });
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("leaves /_health open", async () => {
    const request = createRequest(undefined, "/_health");
    const response = await fetchApp(request, env);
    expect(await response.text()).toBe("app");
  });

  it.each(["/_health/x", "/_healthz", "/x/_health"])(
    "gates %s",
    async (path) => {
      const request = createRequest(undefined, path);
      const response = await fetchApp(request, env);
      expect(response.status).toBe(401);
    },
  );

  it("is open and indexable when no secret is set", async () => {
    const response = await fetchApp(createRequest(), {});
    expect(await response.text()).toBe("app");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
  });
});
