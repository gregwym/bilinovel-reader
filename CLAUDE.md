# Bili Reader

- Every feature or fix must work in both the userscript (`src/main.ts`) and the server's web app / PWA (`app/web/`, `app/server/`). Put shared behaviour in `src/`; see README「userscript 与服务器版保持同步」.
- Spoken text must be built the same way by the reader and the server (`src/speech/spoken.ts`, `splitIntoChunks`, `splitPage`, `app/server/tts.ts` `parts()`): stored audio is keyed by it.
- Before pushing: `npm run lint`, `npm test`, `npm run build`, `npm run build:app`. Bump the version in `package.json`.
- Never commit e2e screenshots.
- PRs: the owner does not review them. Once a PR is ready (checks green, review comments answered), the agent merges it itself (squash) without asking, and the owner raises problems afterwards. Only when it is data-safe: no change may lose or corrupt what users already have (the database, `data/`, the library and its `.bili-reader` backups, saved progress and settings). Migrations only add or convert, never drop data that isn't backed up elsewhere; old library and backup formats stay readable; nothing deletes or moves user files without the existing tests covering it. If a PR can't meet that, don't merge it: ask the owner first and say what is at risk.
