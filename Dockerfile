# Bili Reader library (NAS): web app + audiobook generation server.
# The build output and the production dependencies are plain JavaScript, so they
# are built once on the build machine; only the final stage is per platform.
# Debian rather than Alpine: Alpine images failed to open the SQLite database in
# WAL mode under some hosts' default Docker seccomp profile.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:app

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8790 \
    DATA_DIR=/data \
    LIBRARY_DIR=/library \
    WEB_DIR=/app/dist-app/web
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist-app ./dist-app
VOLUME ["/data", "/library"]
EXPOSE 8790
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist-app/server/main.js"]
