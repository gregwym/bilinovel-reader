/** Where a chapter goes inside its book's folder (which is always `author/book`, see Library.bookDir). */
export const DEFAULT_STORAGE_TEMPLATE = "{volumeNo} {volume}/{chapterNo} {chapter}";
const BOOK_FIELDS = new Set(["author", "book", "bookId"]);

/**
 * A storage template inside the book's folder. Leading folders that name
 * only the book (templates from before the book's folder was fixed, such as
 * `{author}/{book}/…`) are dropped; one without the chapter gets the default.
 * Used by the server and by the settings page's preview.
 */
export function bookTemplate(template: string): string {
  const parts = template.split("/").filter((p) => p.trim());
  while (parts.length > 1) {
    const fields = [...parts[0].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (!fields.length || !fields.every((f) => BOOK_FIELDS.has(f))) break;
    parts.shift();
  }
  const t = parts.join("/");
  return t.includes("{chapter") ? t : DEFAULT_STORAGE_TEMPLATE;
}
