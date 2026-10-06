// Assembles the GitHub Pages site: install page + built userscript -> _site/
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const pagesUrl = (process.env.BILI_READER_PAGES_URL ?? "https://gregwym.github.io/bilinovel-reader").replace(/\/$/, "");
const repoUrl = process.env.BILI_READER_REPO_URL ?? "https://github.com/gregwym/bilinovel-reader";
const out = resolve(root, "_site");

mkdirSync(out, { recursive: true });
copyFileSync(resolve(root, "dist/bili-reader.user.js"), resolve(out, "bili-reader.user.js"));
const html = readFileSync(resolve(root, "site/index.html"), "utf8")
  .replaceAll("__VERSION__", pkg.version)
  .replaceAll("__SCRIPT_URL__", `${pagesUrl}/bili-reader.user.js`)
  .replaceAll("__REPO_URL__", repoUrl);
writeFileSync(resolve(out, "index.html"), html);
writeFileSync(resolve(out, ".nojekyll"), "");
console.log(`site written to ${out} (v${pkg.version})`);
