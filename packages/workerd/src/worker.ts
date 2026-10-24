import { createRequestHandler, type ServerBuild } from "react-router";

const getBuild = () => {
  return import("virtual:react-router/server-build") as Promise<ServerBuild>;
};
const handleRequest = createRequestHandler(getBuild, import.meta.env.MODE);

export default {
  fetch: (request) => handleRequest(request),
} satisfies ExportedHandler;
