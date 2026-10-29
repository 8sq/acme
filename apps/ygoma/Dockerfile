# syntax=docker/dockerfile:1
FROM node:24.22.1-trixie-slim AS build
RUN npm install -g pnpm@12.16.0
WORKDIR /repo

# The lockfile alone keys the download layer, so editing sources skips it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY apps apps
COPY packages packages
RUN pnpm install --offline --frozen-lockfile

# Declared late so a new commit does not rebuild the install layers.
ARG APP_REVISION
RUN pnpm --filter @acme/ygoma build
RUN pnpm --filter @acme/ygoma deploy --prod /deploy

# Same base as the build stage, so native modules keep a matching ABI.
FROM node:24.22.1-trixie-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DEFAULT_DATABASE_URL=sqlite:/var/lib/ygoma/ygoma.db
WORKDIR /app
COPY --from=build /deploy ./
# Before VOLUME: Docker seeds a new volume from this directory, owner included.
RUN mkdir /var/lib/ygoma && chown node:node /var/lib/ygoma
VOLUME /var/lib/ygoma
USER node
EXPOSE 3000
# Through node: the slim image has neither curl nor wget.
# Plain /_health, not ?full: liveness must not mark a degraded app unhealthy.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s \
  CMD ["node", "-e", "fetch(`http://localhost:${process.env.PORT}/_health`).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node_modules/.bin/react-router-serve", "build/server/index.js"]
