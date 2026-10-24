import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { type EntryContext, ServerRouter } from "react-router";

// The router's web-streams default; shipping one stops it editing package.json.

export const streamTimeout = 5000;
// React gets 1s past the router's rejection of pending promises to flush them.
const renderAbortMs = streamTimeout + 1000;

export async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  let status = responseStatusCode;
  let shellRendered = false;
  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(renderAbortMs),
      onError(error: unknown) {
        status = 500;
        // Shell errors reject and are logged by the router.
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  const userAgent = request.headers.get("user-agent");
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");

  return new Response(body, { headers: responseHeaders, status });
}
