# Bili Reader

- Every feature or fix must work in both the userscript (`src/main.ts`) and the server's web app / PWA (`app/web/`, `app/server/`). Put shared behaviour in `src/`; see README「userscript 与服务器版保持同步」.
- Spoken text must be built the same way by the reader and the server (`src/speech/spoken.ts`, `splitIntoChunks`, `splitPage`, `app/server/tts.ts` `parts()`): stored audio is keyed by it.
- Before pushing: `npm run lint`, `npm test`, `npm run build`, `npm run build:app`. Bump the version in `package.json`.
- Never commit e2e screenshots.
