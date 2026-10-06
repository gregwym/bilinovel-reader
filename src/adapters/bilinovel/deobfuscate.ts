/**
 * Bilinovel anti-scraping countermeasures, undone for documents whose scripts
 * did not run (i.e. HTML obtained with fetch + DOMParser).
 *
 * 1. Paragraph shuffle (`/scripts/chapterlog.js`): the server sends the
 *    non-empty direct `<p>` children of the content element in a scrambled
 *    order. The first `fixedLength` stay put; the rest were permuted with a
 *    seeded Fisher–Yates driven by an LCG: `s = (s*a + c) % mod`,
 *    `j = floor(s / mod * (i+1))`, with `seed = chapterId*mul + off`.
 *    The constants live in chapterlog.js and may change between versions,
 *    so they are extracted from the script at runtime when possible.
 * 2. Private-use-area character substitution (rendered via a theme script).
 * 3. Image URLs obfuscated with look-alike characters.
 *
 * The shuffle restore and constant extraction are adapted from
 * Montaro2017/bili_novel_packer (MIT) and the analysis notes of
 * saudadez21/novel-downloader (MIT).
 */

import { PUA_CHAR_MAP } from "./charmap";

export interface ShuffleTemplate {
  fixedLength: number;
  seedMultiplier: number;
  seedOffset: number;
  a: number;
  c: number;
  mod: number;
}

/** Constants observed in chapterlog.js as of 2025–2026; used when extraction fails. */
export const DEFAULT_SHUFFLE_TEMPLATE: ShuffleTemplate = {
  fixedLength: 20,
  seedMultiplier: 127,
  seedOffset: 235,
  a: 9302,
  c: 49397,
  mod: 233280,
};

/**
 * Returns `order` such that `restored[order[i]] = scrambled[i]`.
 */
export function shuffleOrder(count: number, chapterId: number, t: ShuffleTemplate): number[] {
  const order: number[] = [];
  for (let i = 0; i < count; i++) order.push(i);
  if (count <= t.fixedLength) return order;
  const rest = order.slice(t.fixedLength);
  // Intermediate values stay far below 2^53 for realistic constants.
  let s = chapterId * t.seedMultiplier + t.seedOffset;
  for (let i = rest.length - 1; i > 0; i--) {
    s = (s * t.a + t.c) % t.mod;
    const j = Math.floor((s / t.mod) * (i + 1));
    const tmp = rest[i];
    rest[i] = rest[j];
    rest[j] = tmp;
  }
  return order.slice(0, t.fixedLength).concat(rest);
}

/** Restores scrambled items. */
export function unshuffle<T>(scrambled: T[], chapterId: number, t: ShuffleTemplate): T[] {
  const order = shuffleOrder(scrambled.length, chapterId, t);
  const restored = new Array<T>(scrambled.length);
  for (let i = 0; i < scrambled.length; i++) restored[order[i]] = scrambled[i];
  return restored;
}

/** Matches chapterlog.js's paragraph filter: direct `<p>` children with non-blank innerHTML. */
export function isShuffledParagraph(node: Node): node is HTMLElement {
  return (
    node.nodeType === 1 &&
    (node as Element).tagName.toLowerCase() === "p" &&
    (node as Element).innerHTML.replace(/\s+/g, "").length > 0
  );
}

/**
 * Reorders the shuffled `<p>` children of `container` in place. Other child
 * nodes (images, text, etc.) keep their slots, as on the live site.
 */
export function restoreParagraphOrder(container: Element, chapterId: number, t: ShuffleTemplate): void {
  const nodes = Array.from(container.childNodes);
  const slots: number[] = [];
  const paragraphs: ChildNode[] = [];
  nodes.forEach((node, i) => {
    if (isShuffledParagraph(node)) {
      slots.push(i);
      paragraphs.push(node);
    }
  });
  if (paragraphs.length <= t.fixedLength) return;
  const restored = unshuffle(paragraphs, chapterId, t);
  slots.forEach((slot, i) => (nodes[slot] = restored[i]));
  const doc = container.ownerDocument;
  const frag = doc.createDocumentFragment();
  for (const node of nodes) frag.appendChild(node);
  container.appendChild(frag);
}

// ---------------------------------------------------------------------------
// chapterlog.js constant extraction

/** Tiny integer expression evaluator (numbers, hex, + - * / % ^ << >> >>> ~ and parentheses). */
export function evalIntExpression(source: string): number | null {
  let i = 0;
  const s = source;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const eat = (tok: string) => {
    ws();
    if (s.startsWith(tok, i)) {
      i += tok.length;
      return true;
    }
    return false;
  };
  const primary = (): number => {
    ws();
    if (eat("(")) {
      const v = xor();
      if (!eat(")")) throw new Error("missing )");
      return v;
    }
    const m = /^(0[xX][0-9a-fA-F]+|\d+)/.exec(s.slice(i));
    if (!m) throw new Error(`number expected at ${i}`);
    i += m[0].length;
    return m[0].startsWith("0x") || m[0].startsWith("0X") ? parseInt(m[0].slice(2), 16) : parseInt(m[0], 10);
  };
  const unary = (): number => {
    if (eat("+")) return unary();
    if (eat("-")) return -unary();
    if (eat("~")) return ~unary();
    return primary();
  };
  const mul = (): number => {
    let v = unary();
    for (;;) {
      if (eat("*")) v *= unary();
      else if (eat("/")) v = Math.trunc(v / unary());
      else if (eat("%")) v %= unary();
      else return v;
    }
  };
  const add = (): number => {
    let v = mul();
    for (;;) {
      if (eat("+")) v += mul();
      else if (eat("-")) v -= mul();
      else return v;
    }
  };
  const shift = (): number => {
    let v = add();
    for (;;) {
      if (eat("<<")) v = v << add();
      else if (eat(">>>")) v = v >>> add();
      else if (eat(">>")) v = v >> add();
      else return v;
    }
  };
  const xor = (): number => {
    let v = shift();
    while (eat("^")) v ^= shift();
    return v;
  };
  try {
    const v = xor();
    ws();
    if (i !== s.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

function evalWith(expr: string, name: string, value: number): number | null {
  const replaced = expr
    .replace(new RegExp(`Number\\s*\\(\\s*${escapeRe(name)}\\s*\\)`, "g"), String(value))
    .replace(new RegExp(`(^|[^\\w$])${escapeRe(name)}(?![\\w$])`, "g"), `$1${value}`);
  return evalIntExpression(replaced);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitTopLevel(expr: string, op: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + op.length;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

function stripParens(expr: string): string {
  let v = expr.trim();
  while (v.startsWith("(") && v.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < v.length; i++) {
      if (v[i] === "(") depth++;
      else if (v[i] === ")") {
        depth--;
        if (depth === 0 && i !== v.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps) return v;
    v = v.slice(1, -1).trim();
  }
  return v;
}

function parsePlain(js: string): ShuffleTemplate | null {
  const fixedStart = /if\s*\(\s*[\w$]+\s*>\s*/.exec(js);
  const seedMatch = /=\s*(.+?Number\s*\(\s*chapterId\s*\).+?)\s*;/.exec(js);
  const lcgMatch = /=\s*(\(\s*[\w$]+\s*\*.+?\)\s*%\s*.+?)\s*;/.exec(js);
  if (!fixedStart || !seedMatch || !lcgMatch) return null;

  // fixed length: expression up to the closing parenthesis of the if
  let depth = 0;
  let fixedExpr: string | null = null;
  for (let i = fixedStart.index + fixedStart[0].length; i < js.length; i++) {
    if (js[i] === "(") depth++;
    else if (js[i] === ")") {
      if (depth === 0) {
        fixedExpr = js.slice(fixedStart.index + fixedStart[0].length, i);
        break;
      }
      depth--;
    }
  }
  const fixedLength = fixedExpr ? evalIntExpression(stripParens(fixedExpr)) : null;

  const off = evalWith(seedMatch[1], "chapterId", 0);
  const one = evalWith(seedMatch[1], "chapterId", 1);

  const modParts = splitTopLevel(lcgMatch[1], "%");
  if (modParts.length !== 2) return null;
  const mod = evalIntExpression(modParts[1]);
  const left = stripParens(modParts[0]);
  const varName = /[A-Za-z_$][\w$]*/.exec(left)?.[0];
  if (!varName) return null;
  const c = evalWith(left, varName, 0);
  const a1 = evalWith(left, varName, 1);

  if (fixedLength === null || off === null || one === null || mod === null || c === null || a1 === null) return null;
  return { fixedLength, seedMultiplier: one - off, seedOffset: off, a: a1 - c, c, mod };
}

function parseObfuscated(js: string): ShuffleTemplate | null {
  let seed: { m: number; o: number } | null = null;
  const seedRe =
    /var\s+[\w$]+\s*=\s*[^;]*?Number\s*\(\s*[\w$]+\s*\)\s*,\s*([^,)]+?)\s*\)\s*,\s*([^,)]+?)\s*\)\s*,/g;
  for (let m = seedRe.exec(js); m; m = seedRe.exec(js)) {
    const mul = evalIntExpression(m[1]);
    const off = evalIntExpression(m[2]);
    if (mul !== null && off !== null && mul > 0 && off >= 0) {
      seed = { m: mul, o: off };
      break;
    }
  }
  let lcg: { a: number; c: number; mod: number } | null = null;
  const lcgRe = /([\w$]+)\s*=\s*[^;]*?\(\s*\1\s*,\s*([^,)]+?)\s*\)\s*,\s*([^,)]+?)\s*\)\s*,\s*([^;)]+?)\s*\)\s*;/g;
  for (let m = lcgRe.exec(js); m; m = lcgRe.exec(js)) {
    const a = evalIntExpression(m[2]);
    const c = evalIntExpression(m[3]);
    const mod = evalIntExpression(m[4]);
    if (a !== null && c !== null && mod !== null && a > 0 && c >= 0 && mod > a && mod > c) {
      lcg = { a, c, mod };
      break;
    }
  }
  if (!seed || !lcg) return null;
  return {
    fixedLength: DEFAULT_SHUFFLE_TEMPLATE.fixedLength,
    seedMultiplier: seed.m,
    seedOffset: seed.o,
    ...lcg,
  };
}

/** Extracts shuffle constants from chapterlog.js source; null if unrecognised. */
export function parseChapterLogScript(js: string): ShuffleTemplate | null {
  const t = parsePlain(js) ?? parseObfuscated(js);
  if (!t) return null;
  const sane =
    t.fixedLength >= 0 && t.fixedLength < 1000 && t.mod > 0 && t.a > 0 && t.c >= 0 && t.seedMultiplier !== 0;
  return sane ? t : null;
}

// ---------------------------------------------------------------------------
// Text and image cleanup

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;
const PUA = /[\ue000-\uf8ff]/g;

export function decodeText(text: string): string {
  return text
    .replace(ZERO_WIDTH, "")
    .replace(PUA, (ch) => PUA_CHAR_MAP[ch] ?? ch)
    .replace(/[\s\u00a0\u3000]+/g, " ")
    .trim();
}

export function hasUnmappedPua(text: string): boolean {
  return /[\ue000-\uf8ff]/.test(text);
}

/** Normalises an image URL (look-alike characters, protocol-relative, relative). */
export function normalizeImageUrl(raw: string | null | undefined, base: URL): string | undefined {
  if (!raw) return undefined;
  let src = raw.trim().replace(/\u{1D623}/gu, "b");
  if (!src || src.startsWith("data:") || src.includes("<")) return undefined;
  if (src.startsWith("//")) src = `https:${src}`;
  src = src.replace(/^https:\/\/https:\/\//, "https://");
  try {
    return new URL(src, base).href;
  } catch {
    return undefined;
  }
}
