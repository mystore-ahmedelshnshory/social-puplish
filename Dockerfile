# Amplify — image for a Docker-type Hugging Face Space (free, no payment card).
#
# HF builds this file on their infrastructure and routes the public URL to
# app_port 7860 (declared in README.md). The multi-stage split exists because
# node-canvas 2.11 ships no prebuilt binary for some targets, so the builder
# stage carries a compiler toolchain and the runtime stage stays slim.
#
# First build takes roughly 5–10 minutes; later rebuilds are faster.

# ---------------------------------------------------------------- builder
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ pkg-config \
      libcairo2-dev libpango1.0-dev libjpeg62-turbo-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
      fontconfig fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=7860

EXPOSE 7860

# SQLite DB, uploads, renders: /app/data. On a free Space this disk resets on
# restart — credentials kept in Space "Secrets" are re-seeded automatically at
# boot (see server/seed-env.js).
CMD ["node", "server/index.js"]
