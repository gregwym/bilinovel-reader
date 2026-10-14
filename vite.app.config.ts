import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * Library app (NAS server + web app). `vite build -c vite.app.config.ts`
 * builds the web app into dist-app/web; `--mode server` builds the server
 * into dist-app/server (dependencies stay in node_modules).
 */

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as { version: string };

export default defineConfig(({ mode }) =>
  mode === "server"
    ? {
        define: { __VERSION__: JSON.stringify(pkg.version) },
        build: {
          ssr: resolve(import.meta.dirname, "app/server/main.ts"),
          outDir: "dist-app/server",
          emptyOutDir: true,
          target: "node22",
          minify: false,
          rollupOptions: { output: { entryFileNames: "main.js", format: "es" } },
        },
      }
    : {
        root: resolve(import.meta.dirname, "app/web"),
        publicDir: resolve(import.meta.dirname, "app/web/public"),
        define: { __VERSION__: JSON.stringify(pkg.version) },
        build: {
          outDir: resolve(import.meta.dirname, "dist-app/web"),
          emptyOutDir: true,
          target: "safari15",
        },
        server: { proxy: { "/api": "http://localhost:8790" } },
      },
);
