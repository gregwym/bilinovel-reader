# Tested Debian runtime: avoids SQLite/seccomp incompatibilities on older hosts.
FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY . .
RUN npm run lint && npm test -- --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000 \
    && npm run build:app
FROM base AS runtime
ENV NODE_ENV=production PORT=8790 DATA_DIR=/data LIBRARY_DIR=/library WEB_DIR=/app/dist-app/web
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist-app ./dist-app
EXPOSE 8790
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist-app/server/main.js"]
