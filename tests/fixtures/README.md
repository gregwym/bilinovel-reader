# Parser fixtures

These pages are **synthesized, sanitized replicas** of Bilinovel mobile chapter
pages. They reproduce the structure documented by open-source Bilinovel parsers
(see the project README): `#atitle`, `#acontent`, `#footlink`, inline
`ReadParams`, `/scripts/chapterlog.js`, ads/anti-scrape junk, private-use-area
characters, look-alike characters in image URLs, and the server-side paragraph
shuffle (produced by an independent Python port of the chapterlog.js algorithm,
so the TypeScript restore is cross-checked).

Book text is placeholder text. To refresh them, edit and run:

```bash
python3 tests/fixtures/generate.py
```

When the site changes, prefer saving real pages from Safari (Develop menu →
Show Page Source, i.e. the server HTML *before* scripts run), replace the book
text with placeholders, and add them here with matching tests.

## Real pages (2026-11)

Saved on 2026-11-04 from book 5370, chapter 288458 (page 1), mobile user agent,
server HTML before scripts. Chapter text is replaced with placeholders numbered
in the order the browser renders them (the shuffle depends only on the chapter
id and paragraph count, so the order check still holds); Cloudflare and tracker
snippets are removed.

- `incomplete-2026-11.html`: without the site's `night` cookie (set by its
  `darkmode.js` in a browser; see `src/adapters/bilinovel/siteCookies.ts`):
  the first 11 paragraphs, the last one cut off and running into
  「（內容加載失敗！請刷新或更換瀏覽器）」 without a closing `</p>`.
- `complete-2026-11.html`: the same page with `night`: 122 paragraphs and a
  section mark, shuffled after the 20th.
- `chapterlog-2026-11.js`: `/themes/zhmb/js/chapterlog.js?v1006c1.82` as served
  (obfuscated; new constants). The old `/scripts/chapterlog.js` now answers 404.
