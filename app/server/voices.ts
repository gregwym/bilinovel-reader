import type { BookVoice, BookVoices, PageProvider } from "../shared/api";
import { bookCatalog, type BookRow, type Library } from "./library";
import type { SiteSource } from "./site/source";
import { PROVIDERS, type Tts } from "./tts";

/** A book's audio per voice, with the segment keys of each (for deleting them). */
export function bookVoices(
  book: BookRow,
  tts: Tts,
  source: SiteSource,
  library: Library,
): BookVoices & { keys: Map<string, { provider: PageProvider; keys: string[] }> } {
  const profile = tts.profile();
  const current = profile ? tts.profileId(profile) : "";
  const files = new Map<string, number>();
  for (const row of library.chapterAudio(book.id)) files.set(row.profile, (files.get(row.profile) ?? 0) + 1);

  const chapterIds = (bookCatalog(book)?.volumes ?? []).flatMap((v) => v.chapters.flatMap((c) => (c.chapterId ? [c.chapterId] : [])));
  const chapters = chapterIds.map((id) => ({ id, ...source.cachedChapterPages(book.id, id) })).filter((c) => c.pages.length);

  const stats = new Map<string, Omit<BookVoice, "label" | "current" | "switchable" | "chapterFiles" | "provider" | "model" | "voice">>();
  const keys = new Map<string, { provider: PageProvider; keys: string[] }>();
  const withSegments = new Set<string>();
  for (const provider of PROVIDERS) {
    const voices = tts.storedVoices(provider);
    if (!voices.length) continue;
    for (const ch of chapters) {
      const parts = tts.parts(provider, ch.pages);
      for (const id of voices) {
        const found = parts.flatMap((texts) => {
          const key = tts.keyIn(id, texts);
          const s = tts.stored(provider, key);
          return s ? [{ key, bytes: s.bytes }] : [];
        });
        if (!found.length) continue;
        withSegments.add(ch.id);
        const st = stats.get(id) ?? { id, segments: 0, bytes: 0, chapters: 0, partial: 0 };
        st.segments += found.length;
        st.bytes += found.reduce((n, f) => n + f.bytes, 0);
        if (ch.complete && found.length === parts.length) st.chapters++;
        else st.partial++;
        stats.set(id, st);
        const k = keys.get(id) ?? { provider, keys: [] };
        k.keys.push(...found.map((f) => f.key));
        keys.set(id, k);
      }
    }
  }

  const ids = new Set([...stats.keys(), ...files.keys()]);
  if (current) ids.add(current);
  const voices = [...ids].flatMap((id): BookVoice[] => {
    const p = tts.parseProfileId(id);
    if (!p) return [];
    const st = stats.get(id) ?? { id, segments: 0, bytes: 0, chapters: 0, partial: 0 };
    const chapterFiles = files.get(id) ?? 0;
    if (id !== current && !st.segments && !chapterFiles) return [];
    return [
      {
        ...p,
        ...st,
        label: tts.voiceLabel(p),
        current: id === current,
        switchable: p.provider === "fish" || p.style !== undefined,
        chapterFiles,
      },
    ];
  });
  voices.sort((a, b) => Number(b.current) - Number(a.current) || b.segments - a.segments);
  return { voices, chapters: [...withSegments], keys };
}
