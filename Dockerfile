# syntax=docker/dockerfile:1

# --- Build stage: install all deps and compile TypeScript to build/ ---
FROM node:22.12-slim AS build
WORKDIR /app
# Copy manifests (and scripts/, which the postinstall hook needs) first so the
# dependency layer is cached independently of source changes.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run build

# --- Runtime stage: production deps + compiled output only ---
FROM node:22.12-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

COPY package.json package-lock.json ./
COPY scripts ./scripts
# syncables ships prebuilt, so the postinstall build is a no-op here; skip it.
RUN npm ci --omit=dev --ignore-scripts

# Compiled app plus the runtime assets it reads relative to the repo root.
COPY --from=build /app/build ./build
COPY spec ./spec
COPY public ./public

# Persist the local-first copy and OAuth tokens on a mounted volume so they
# survive container restarts (unlike a Heroku dyno's ephemeral disk).
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["npm", "start"]
