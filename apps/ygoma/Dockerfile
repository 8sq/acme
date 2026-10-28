# syntax=docker/dockerfile:1
FROM node:24.22.1-trixie-slim AS build
RUN npm install -g pnpm@12.15.0
WORKDIR /repo

# The lockfile alone keys the download layer, so editing sources skips it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY apps apps
COPY packages packages
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @acme/ygoma build
RUN pnpm --filter @acme/ygoma deploy --prod /deploy

# Same base as the build stage, so native modules keep a matching ABI.
FROM node:24.22.1-trixie-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /deploy ./
USER node
EXPOSE 3000
CMD ["node_modules/.bin/react-router-serve", "build/server/index.js"]
