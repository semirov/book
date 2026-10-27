# syntax=docker/dockerfile:1
# book-site (ARCHITECTURE.md §15.4). One image, one process: Fastify serves the API, the
# WebSocket and the built SPA from web/dist. The engine is a second compose service later.
FROM node:22-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Dependencies first: the lock file only changes when the tree does.
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

COPY . .
# BOOK-109: the sha the image reports. The build context carries no `.git`, so `build-info.mjs`
# cannot read the tree; `--build-arg BOOK_BUILD_COMMIT=<sha>` (compose: `BOOK_BUILD_COMMIT`)
# names it. Without the arg the image says `dev` — honest, and its identity is the stamp the
# build just wrote (`builtAt`/`stamp`), not a commit it cannot know.
ARG BOOK_BUILD_COMMIT=""
ENV BOOK_BUILD_COMMIT=$BOOK_BUILD_COMMIT
# BOOK-119: `build` lands in `web/dist/staging`; `release:publish` renames it into
# `web/dist/releases/<id>` and points `current` at it. Without the publish the image has no
# shell at all and the site answers `UI_NOT_BUILT`.
RUN npm run build && npm run release:publish && npm prune --omit=dev --no-audit --no-fund

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/web ./web
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/bin ./bin
# BOOK-109: the stamp `npm run build` wrote (prebuild) — the image's own identity, and what
# `/healthz` answers with. Copied, not regenerated: the runtime stage has no build step.
COPY --from=build --chown=node:node /app/build-info.json ./build-info.json
# The data volume is mounted here; the image owns the mount point, so a *fresh* named
# volume inherits uid 1000 and the unprivileged process can create book.db (audit m7).
# An existing root-owned volume needs one `chown 1000:1000 /data` (see README).
RUN mkdir -p /data && chown node:node /data
# Never root (audit m7): the process reads the manuscript and writes only DATA_DIR.
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
