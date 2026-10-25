import { createRequestHandler, type ServerBuild } from "react-router";
import { type StagingAuthEnv, withStagingAuth } from "./with-staging-auth.ts";

interface Env extends StagingAuthEnv {
  ASSETS: Fetcher;
}

const getBuild = () => {
  return import("virtual:react-router/server-build") as Promise<ServerBuild>;
};
const handleRequest = createRequestHandler(getBuild, import.meta.env.MODE);

const serve = async (request: Request, env: Env) => {
  // `run_worker_first` sends assets here too, so the gate covers them.
  const asset = await env.ASSETS.fetch(request);
  return asset.status === 404 ? handleRequest(request) : asset;
};

export default {
  fetch: withStagingAuth(serve),
} satisfies ExportedHandler<Env>;
