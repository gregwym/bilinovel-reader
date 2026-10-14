# Bili Reader library (NAS): web app + audiobook generation server.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:app

FROM node:24-alpine
RUN apk add --no-cache ffmpeg tini
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8790 \
    DATA_DIR=/data \
    LIBRARY_DIR=/library \
    WEB_DIR=/app/dist-app/web
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist-app ./dist-app
VOLUME ["/data", "/library"]
EXPOSE 8790
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist-app/server/main.js"]
