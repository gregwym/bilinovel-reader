# Bili Reader library (NAS): web app + audiobook generation server.
# The build output and the production dependencies are plain JavaScript, so they
# are built once on the build machine; only the final stage is per platform.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:app

FROM --platform=$BUILDPLATFORM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine
RUN apk add --no-cache ffmpeg tini
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
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist-app/server/main.js"]
