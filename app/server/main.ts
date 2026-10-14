import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { createApp } from "./http";
import { createServices } from "./services";

declare const __VERSION__: string;

const config = loadConfig();
const services = createServices(config, typeof __VERSION__ === "string" ? __VERSION__ : "dev");
const app = createApp(services);

services.jobs.start();
services.planner.start();
void services.ffmpeg.check().then((ok) => {
  if (!ok) console.warn("[library] ffmpeg not found: chapters cannot be assembled (install ffmpeg or set FFMPEG_PATH)");
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[library] Bili Reader library on http://${config.host}:${info.port} (data ${config.dataDir}, library ${config.libraryDir})`);
});

function shutdown(): void {
  services.jobs.stop();
  services.planner.stop();
  server.close(() => {
    services.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
