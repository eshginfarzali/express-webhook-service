# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

# ---- base: shared runtime image -------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app

# ---- deps: all dependencies (toolchain available for native modules) -------
FROM base AS deps
# better-sqlite3 ships prebuilt binaries; the toolchain is only a fallback.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript ---------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- prod-deps: production dependencies only -------------------------------
FROM deps AS prod-deps
RUN npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3300 \
    DATABASE_PATH=/app/data/webhooks.db

# Application files stay root-owned (read-only for the app user);
# only the data directory is writable by the unprivileged `node` user.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3300
VOLUME ["/app/data"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3300) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "dist/server.js"]
