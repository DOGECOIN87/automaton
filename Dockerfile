# Automaton (Solana-only) — multi-stage build
#
# Stage 1: build the runtime (tsc) + GUI (vite) with dev dependencies.
# Stage 2: minimal runtime image with production dependencies only.
#
# PREPARE ONLY — this image is for first-deployment prep. The wallet key is
# generated at runtime by the setup wizard and MUST be provided via a mounted
# volume or env, never baked into the image (see DEPLOY.md).

# ─── Build stage ───────────────────────────────────────────────
FROM node:20-bookworm AS build

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

WORKDIR /app

# better-sqlite3 needs native build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
COPY packages/gui/package.json packages/gui/
RUN pnpm install --frozen-lockfile

# Copy the rest of the source and build
COPY . .
RUN pnpm build

# ─── Runtime stage ─────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
COPY packages/gui/package.json packages/gui/
RUN pnpm install --frozen-lockfile --prod

# Compiled runtime + compiled CLI + built GUI static assets
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
COPY --from=build /app/packages/gui/dist ./packages/gui/dist

# Runtime state directory (SQLite DB, wallet.json). Mount a volume in prod.
ENV AUTOMATON_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8787

# Default: run the agent with the GUI dashboard.
# Override with: docker run ... automaton --run   (no GUI)
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--run", "--gui", "--gui-port", "8787"]
