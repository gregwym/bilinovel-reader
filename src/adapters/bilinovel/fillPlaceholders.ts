import type { Catalog, CatalogChapter, PageContent } from "../types";
import { reconcileCatalog } from "./reconcileCatalog";
import { parseChapterUrl } from "./url";

/** A chapter page to load. */
export interface PageLead {
  chapterId: string;
  pageIndex: number;
}

const ref = (chapterId: string, pageIndex: number) => `${chapterId}:${pageIndex}`;
export const pageRef = (page: Pick<PageContent, "chapterId" | "pageIndex">) => ref(page.chapterId, page.pageIndex);

const hasPlaceholders = (catalog: Catalog) => catalog.volumes.some((v) => v.chapters.some((c) => !c.chapterId));

/**
 * The pages that would show where the catalog's placeholder entries link to,
 * from the site's own chapter navigation (never from chapter numbers):
 * the next entry's「上一章」(on its first page), or, when nothing after the
 * placeholder can tell, the previous entry's「下一章」(on its last page).
 * Then the first page of the chapter it points at, which
 * `reconcileCatalog` checks (title and links) before linking it.
 */
export function placeholderLeads(catalog: Catalog, pages: ReadonlyMap<string, PageContent>, tried: ReadonlySet<string>): PageLead[] {
  const flat = catalog.volumes.flatMap((v) => v.chapters);
  const linked = new Set(flat.flatMap((c) => (c.chapterId ? [c.chapterId] : [])));
  const leads = new Map<string, PageLead>();
  const want = (chapterId: string, pageIndex: number) => {
    const k = ref(chapterId, pageIndex);
    if (!pages.has(k) && !tried.has(k)) leads.set(k, { chapterId, pageIndex });
  };
  /** A chapter of this book the catalog doesn't link to yet. */
  const unlinked = (url: string | undefined) => {
    const info = url ? parseChapterUrl(url) : null;
    return info && info.bookId === catalog.bookId && !linked.has(info.chapterId) ? info.chapterId : undefined;
  };
  /** Follows the next chapter's「上一章」. */
  const fromNext = (next: string) => {
    const first = pages.get(ref(next, 0));
    if (!first) return want(next, 0);
    const id = first.prev && first.prev.chapterId !== next ? unlinked(first.prev.url) : undefined;
    if (id) want(id, 0);
  };
  /** Follows the previous chapter's「下一章」(only when its last page is known). */
  const fromPrevious = (previous: string) => {
    const first = pages.get(ref(previous, 0));
    if (!first) return want(previous, 0);
    let last: PageContent | undefined = first;
    if (first.nextType !== "next-chapter") {
      if (!first.pageCount || first.pageCount < 2) return;
      last = pages.get(ref(previous, first.pageCount - 1));
      if (!last) return want(previous, first.pageCount - 1);
    }
    const id = last.nextType === "next-chapter" ? unlinked(last.nextUrl) : undefined;
    if (id) want(id, 0);
  };

  for (const [i, c] of flat.entries()) if (!c.chapterId && flat[i + 1]?.chapterId) fromNext(flat[i + 1].chapterId!);
  if (leads.size) return [...leads.values()];
  // Nothing more from the following chapters (end of the book, or a run of placeholders it couldn't resolve).
  for (const [i, c] of flat.entries()) if (!c.chapterId && flat[i - 1]?.chapterId) fromPrevious(flat[i - 1].chapterId!);
  return [...leads.values()];
}

export interface FillOptions {
  /** Pages already known (e.g. kept from earlier visits), keyed by `pageRef`. */
  pages?: Map<string, PageContent>;
  /** Pages not to load (e.g. failed before), keyed by `pageRef`. */
  tried?: Set<string>;
  /** Called whenever entries were linked. */
  onRecovered?: (chapters: CatalogChapter[]) => void;
}

/**
 * Links the catalog's placeholder entries by loading the neighbouring
 * chapters' pages (see `placeholderLeads`), one at a time. Mutates the
 * catalog in place; returns the entries it linked. At most three loads per
 * placeholder. `load` returns undefined (or rejects) for a page it couldn't get.
 */
export async function fillPlaceholders(
  catalog: Catalog,
  load: (chapterId: string, pageIndex: number) => Promise<PageContent | undefined>,
  options: FillOptions = {},
): Promise<CatalogChapter[]> {
  const pages = options.pages ?? new Map<string, PageContent>();
  const tried = options.tried ?? new Set<string>();
  const recovered: CatalogChapter[] = [];
  let budget = catalog.volumes.reduce((n, v) => n + v.chapters.filter((c) => !c.chapterId).length, 0) * 3;
  for (;;) {
    const linked = reconcileCatalog(catalog, pages.values());
    if (linked.length) {
      recovered.push(...linked);
      options.onRecovered?.(linked);
    }
    if (!hasPlaceholders(catalog) || budget <= 0) break;
    const leads = placeholderLeads(catalog, pages, tried);
    if (!leads.length) break;
    for (const lead of leads.slice(0, budget)) {
      budget--;
      tried.add(ref(lead.chapterId, lead.pageIndex));
      const page = await load(lead.chapterId, lead.pageIndex).catch(() => undefined);
      if (page && page.bookId === catalog.bookId) pages.set(pageRef(page), page);
    }
  }
  return recovered;
}
