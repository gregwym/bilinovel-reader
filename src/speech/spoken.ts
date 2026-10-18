/**
 * What is spoken for a paragraph of a site page: its text, except that a
 * chapter's first text paragraph also reads the chapter title first.
 *
 * Shared by the reader (userscript and web app) and the server's audio
 * (app/server/tts.ts): stored audio is keyed by these texts, so both must
 * build them the same way.
 */
export function spokenText(
  paragraphs: readonly { text?: string }[],
  index: number,
  pageIndex: number,
  chapterTitle?: string,
): string | undefined {
  const text = paragraphs[index]?.text;
  const title = chapterTitle?.trim();
  if (!text || pageIndex !== 0 || !title) return text;
  if (paragraphs.findIndex((p) => p.text) !== index) return text;
  // Many chapters already open with their title.
  if (text.trimStart().startsWith(title)) return text;
  // A sentence end so it is spoken (and split) as a sentence of its own.
  return /[。！？!?…；;：:]$/.test(title) ? `${title}${text}` : `${title}。${text}`;
}
