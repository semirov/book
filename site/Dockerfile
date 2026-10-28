# syntax=docker/dockerfile:1
# book-site (ARCHITECTURE.md §15.4, BOOK-172). ONE image, THREE services: Fastify + the built SPA
# from `web/dist` (`server/dist/index.js`), the engine's internal API (`server/dist/engine.js`) and
# the writer lane (`server/dist/writer/main.js --loop`). The service that runs it is chosen by the
# compose `command`, never by a second Dockerfile — one build, one tag, one identity on `/healthz`.
FROM node:22.23.3-slim AS build
# Equal to prod and to `gate.yml`'s setup-node value: a build is not allowed to pick a different
# point release than the one that serves.
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
# cannot read the tree; `--build-arg BOOK_BUILD_COMMIT=<sha7>` (compose-release.sh always passes it)
# names it. Without the arg the image says `dev` — honest, and its identity is the stamp the
# build just wrote (`builtAt`/`stamp`), not a commit it cannot know.
ARG BOOK_BUILD_COMMIT=""
ENV BOOK_BUILD_COMMIT=$BOOK_BUILD_COMMIT
# BOOK-119: `build` lands in `web/dist/staging`; `release:publish` renames it into
# `web/dist/releases/<id>` and points `current` at it. Without the publish the image has no
# shell at all and the site answers `UI_NOT_BUILT`.
RUN npm run build && npm run release:publish && npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.3-slim AS runtime
ENV NODE_ENV=production
# The root filesystem is read-only for every service (compose `read_only`): node's own HOME writes
# land in the `/tmp` tmpfs instead of failing on `/root`.
ENV HOME=/tmp
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
# BOOK-172: container runtime helpers, not app code. The entrypoint takes the per-role single-instance
# lock (`flock`, util-linux ships in bookworm-slim) before `exec`ing the service; the healthcheck
# compares the commit in `/app/build-info.json` with what `/healthz` answers, without needing an env
# value — nothing about the image's identity arrives at runtime.
COPY --chown=root:root deploy/entrypoint.sh deploy/healthcheck.mjs /app/deploy/
RUN chmod 0755 /app/deploy/entrypoint.sh
# The data dir is a bind mount in production (host-owned uid 501); the directory only has to exist
# in the image so a run without the mount still starts and fails loudly on the data guard.
RUN mkdir -p /data
ARG BOOK_BUILD_COMMIT=""
# The commit as an image label: `docker image ls --filter label=book.commit` is how the release
# script prunes old builds and how a human names what is on disk. A commit is not a secret.
LABEL book.commit="${BOOK_BUILD_COMMIT}" book.image="book"
# Never root: compose sets `user: 501:20` (the host data dir's owner) and this `USER` is the floor
# for anyone who runs the image by hand.
USER node
EXPOSE 8080
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
