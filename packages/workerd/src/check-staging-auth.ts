export interface StagingAuthEnv {
  BASIC_AUTH?: string;
}

const reply = (body: string, status: number, init?: HeadersInit) => {
  const headers = new Headers(init);
  headers.set("X-Robots-Tag", "noindex");
  return new Response(body, { status, headers });
};

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

// No BASIC_AUTH means no gate; a malformed one answers 503.
export const checkStagingAuth = async (
  request: Request,
  env: StagingAuthEnv,
) => {
  const secret = env.BASIC_AUTH;
  if (secret === undefined) return;
  if (secret.indexOf(":") < 1) return reply("Service unavailable", 503);

  const credentials = readCredentials(request);
  const expected = new TextEncoder().encode(secret);
  if (await isSameBytes(credentials, expected)) return;

  return reply("Unauthorized", 401, {
    "WWW-Authenticate": 'Basic realm="Staging", charset="UTF-8"',
  });
};
