/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as {
  version: string;
  description: string;
};

// Canonical GitHub Pages location. Override with BILI_READER_PAGES_URL for forks.
const PAGES_URL = (process.env.BILI_READER_PAGES_URL ?? "https://gregwym.github.io/bilinovel-reader").replace(
  /\/$/,
  "",
);
const SCRIPT_URL = `${PAGES_URL}/bili-reader.user.js`;

const metadata = `// ==UserScript==
// @name         Bili Reader
// @namespace    bili-reader
// @version      ${pkg.version}
// @description  ${pkg.description}
// @match        https://www.bilinovel.net/novel/*
// @match        https://www.bilinovel.com/novel/*
// @run-at       document-idle
// @noframes
// @grant        none
// @homepageURL  ${PAGES_URL}/
// @updateURL    ${SCRIPT_URL}
// @downloadURL  ${SCRIPT_URL}
// ==/UserScript==
`;

/** Prepends the userscript metadata block to the bundled file. */
function userscriptHeader(): Plugin {
  return {
    name: "userscript-header",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk" && chunk.isEntry) {
          chunk.code = `${metadata}\n${chunk.code}`;
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "safari15",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: mode === "development" ? "inline" : false,
    lib: {
      entry: resolve(import.meta.dirname, "src/main.ts"),
      name: "BiliReader",
      formats: ["iife"],
      fileName: () => "bili-reader.user.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  plugins: [userscriptHeader()],
  preview: { port: 4173 },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
}));
