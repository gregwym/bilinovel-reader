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
