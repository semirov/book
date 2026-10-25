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
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/web ./web
COPY --from=build /app/config ./config
COPY --from=build /app/bin ./bin
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
