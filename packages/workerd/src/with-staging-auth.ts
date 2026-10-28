export interface StagingAuthEnv {
  BASIC_AUTH?: string;
}

const digest = async (bytes: Uint8Array) => {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash);
};

// Hashing gives both sides one length; the loop never exits early.
const isSameBytes = async (left: Uint8Array, right: Uint8Array) => {
  const [leftHash, rightHash] = await Promise.all([
    digest(left),
    digest(right),
  ]);

  let diff = 0;
  for (const [index, byte] of leftHash.entries()) {
    diff += Math.abs(byte - (rightHash[index] ?? 0));
  }
  return diff === 0;
};

// No or unreadable credentials read as empty, which never matches a secret.
const readCredentials = (request: Request) => {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Basic\s+(\S+)$/iu.exec(header);
  try {
    const binary = atob(match?.[1] ?? "");
    return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
  } catch {
    return new Uint8Array();
  }
};

const getRejection = async (request: Request, secret: string) => {
  if (secret.indexOf(":") < 1) {
    return new Response("Service unavailable", { status: 503 });
  }

  const credentials = readCredentials(request);
  const expected = new TextEncoder().encode(secret);
  if (await isSameBytes(credentials, expected)) return;

  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Staging", charset="UTF-8"' },
  });
};

// Exact paths: deploy probes read them without credentials; they hold nothing sensitive.
const openPaths = new Set(["/_health"]);

// No BASIC_AUTH means no gate; a malformed one answers 503.
export const withStagingAuth = <HandlerEnv extends StagingAuthEnv>(
  handler: (request: Request, env: HandlerEnv) => Response | Promise<Response>,
) => {
  return async (request: Request, env: HandlerEnv) => {
    const secret = env.BASIC_AUTH;
    const { pathname } = new URL(request.url);
    const isOpen = openPaths.has(pathname);
    if (secret === undefined || isOpen) {
      return handler(request, env);
    }

    const rejection = await getRejection(request, secret);
    const response = rejection ?? (await handler(request, env));

    // Asset responses have immutable headers.
    const privateResponse = new Response(response.body, response);
    privateResponse.headers.set("X-Robots-Tag", "noindex");
    return privateResponse;
  };
};
