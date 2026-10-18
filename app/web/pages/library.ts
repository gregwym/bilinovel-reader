import { h } from "../../../src/utils/dom";
import type { BookSummary } from "../../shared/api";
import { api, ApiError } from "../api";
import { cover, formatTime, icon, openReader, poll, progressBar, toast, type Page } from "../ui";
import { navigate } from "../router";

/** The bookshelf: the book being read, then every book as a cover grid. */
export function libraryPage(): Page {
  const el = h("div");
  const input = h("input", {
    class: "input",
    type: "url",
    inputmode: "url",
    placeholder: "粘贴哔哩轻小说书籍或章节链接",
    enterkeyhint: "go",
  });
  const addBtn = h("button", { class: "icon-btn", type: "submit", "aria-label": "加入书架" }, icon("plus"));
  const form = h("form", { class: "add-bar" }, input, addBtn);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const url = input.value.trim();
    if (!url) return input.focus();
    error.hidden = true;
    addBtn.disabled = true;
    input.disabled = true;
    api
      .post<BookSummary>("/api/books", { url })
      .then((book) => {
        input.value = "";
        toast(book.loading ? "已加入书架，目录在后台获取" : `已加入书架：${book.title}`);
        navigate(`/book/${book.id}`);
      })
      .catch((err: Error) => {
        // Kept on screen (not a toast): the reason is needed to fix site access.
        error.replaceChildren(
          h(
            "div",
            { class: "grow" },
            h("b", {}, "添加失败"),
            h("div", { class: "mono" }, err.message),
            err instanceof ApiError && (err.code === "fetch" || err.code === "challenge")
              ? h("div", { class: "hint" }, "可在", h("a", { href: "/settings", "data-link": true }, "设置 → 网站访问"), "中测试连接")
              : null,
          ),
        );
        error.hidden = false;
      })
      .finally(() => {
        addBtn.disabled = false;
        input.disabled = false;
      });
  });
  const error = h("div", { class: "banner error", role: "alert", hidden: true });
  const body = h("div");
  el.append(h("header", { class: "topbar" }, h("h1", {}, "书架")), form, error, body);

  let last = "";
  const show = (books: BookSummary[]) => {
    const sig = JSON.stringify(books);
    if (sig === last) return;
    last = sig;
    body.replaceChildren(...render(books));
  };
  const load = async () => show(await api.keep<BookSummary[]>("/api/books"));
  // Drawn at once from the last answer; the server's replaces it when it comes.
  const kept = api.cached<BookSummary[]>("/api/books");
  if (kept) show(kept);
  void load().catch((err: Error) => (kept ? toast(err.message) : body.replaceChildren(h("div", { class: "banner error" }, err.message))));
  return { el, dispose: poll(load, 5000) };
}

function render(books: BookSummary[]): Node[] {
  if (!books.length) {
    return [
      h(
        "div",
        { class: "empty" },
        h("div", { class: "big" }, "📚"),
        h("div", {}, "书架还是空的"),
        h("div", { class: "hint" }, "在上方粘贴书籍链接，或直接在阅读器里打开一本书"),
      ),
    ];
  }
  const nodes: Node[] = [];
  const reading = books.find((b) => b.position);
  if (reading) nodes.push(continueCard(reading));
  nodes.push(
    h(
      "div",
      { class: "shelf-tools" },
      h("span", {}, `共 ${books.length} 本`),
      h("span", {}, `${books.reduce((n, b) => n + b.audioChapters, 0)} 章有声`),
    ),
  );
  nodes.push(h("div", { class: "shelf" }, ...books.map(bookTile)));
  return nodes;
}

const readFraction = (b: BookSummary) => (b.readIndex !== undefined && b.chapters ? (b.readIndex + 1) / b.chapters : 0);

function continueCard(book: BookSummary): HTMLElement {
  const pos = book.position!;
  const read = h(
    "button",
    {
      class: "btn primary small",
      onclick: (ev: Event) => {
        ev.stopPropagation();
        openReader(book.id, pos);
      },
    },
    "继续阅读",
  );
  const card = h(
    "div",
    { class: "continue", role: "link", tabindex: 0 },
    cover(book),
    h(
      "div",
      { class: "info" },
      h("div", { class: "kicker" }, "继续阅读"),
      h("div", { class: "title" }, book.title),
      h("div", { class: "chapter" }, pos.chapterTitle ?? `第 ${(book.readIndex ?? 0) + 1} 章`),
      h("div", { class: "hint" }, `${formatTime(pos.updatedAt)} · 有声 ${book.audioChapters}/${book.chapters} 章`),
      h("div", { class: "bottom" }, progressBar(readFraction(book)), read),
    ),
  );
  card.addEventListener("click", () => navigate(`/book/${book.id}`));
  return card;
}

function bookTile(book: BookSummary): HTMLElement {
  const badge = book.audioChapters > 0 ? h("span", { class: "corner" }, `🎧 ${book.audioChapters}`) : null;
  const tile = h(
    "a",
    { class: "book", href: `/book/${book.id}`, "data-link": true },
    cover(book, badge),
    h("div", { class: "title" }, book.title),
    h(
      "div",
      { class: "meta" },
      book.loading
        ? "获取目录中…"
        : book.loadError
          ? h("span", { style: "color:var(--danger)" }, "目录获取失败")
          : book.readIndex !== undefined
            ? `读到 ${Math.round(readFraction(book) * 100)}%`
            : book.author || "未读",
    ),
  );
  if (book.loading || book.activeJobs) {
    tile.querySelector(".cover")!.append(h("span", { class: "working", title: book.loading ? "正在获取目录" : "正在生成" }, h("span", { class: "spin" })));
  }
  return tile;
}
