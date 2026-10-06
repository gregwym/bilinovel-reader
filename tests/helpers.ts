import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ORIGIN = "https://www.bilinovel.net";

export function fixture(name: string): string {
  return readFileSync(resolve(__dirname, "fixtures", name), "utf8");
}

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

export function loadFixture(name: string): Document {
  return parseHtml(fixture(name));
}
