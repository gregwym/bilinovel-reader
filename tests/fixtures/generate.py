#!/usr/bin/env python3
"""
Generates the sanitized Bilinovel fixture pages used by the parser tests.

The markup mirrors the mobile theme served on www.bilinovel.net (#atitle,
#acontent, #footlink, inline `ReadParams`, /scripts/chapterlog.js) including
the junk the parser must discard. Paragraphs are scrambled the way the
server does it, using an independent Python port of the chapterlog.js
shuffle, so the TypeScript restore is cross-checked against it.

Replace these files with captured pages (book text replaced by placeholders)
whenever the site changes; run: python3 tests/fixtures/generate.py
"""

from pathlib import Path

OUT = Path(__file__).parent
BOOK_ID = "5369"
BOOK = "测试轻小说"


def chapterlog_order(n, cid, fixed=20, mul=127, off=235, a=9302, c=49397, m=233280):
    if n <= fixed:
        return list(range(n))
    rest = list(range(fixed, n))
    s = cid * mul + off
    for i in range(len(rest) - 1, 0, -1):
        s = (s * a + c) % m
        j = (s * (i + 1)) // m
        rest[i], rest[j] = rest[j], rest[i]
    return list(range(fixed)) + rest


def scramble(items, cid):
    """Inverse of the restore: restored[order[i]] = scrambled[i]."""
    order = chapterlog_order(len(items), cid)
    return [items[order[i]] for i in range(len(items))]


def para(chapter, page, n):
    return f"第{chapter}章第{page}页第{n:02d}段。这是用于测试的正文内容。"


def page_html(*, chapter_id, page_no, title, body, url_prev, url_next, prev_text, next_text, chapterlog=True):
    page_suffix = f"_{page_no}" if page_no > 1 else ""
    return f"""<!DOCTYPE html>
<html lang="zh-Hans">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>{title}_{BOOK}_哔哩轻小说</title>
<meta property="og:novel:book_name" content="{BOOK}">
<link rel="stylesheet" href="/themes/zhmb/css/read.css?v0401">
<script src="/themes/zhmb/js/jquery-3.3.1.js"></script>
<script>var ReadParams={{url_previous:'{url_prev}',url_next:'{url_next}',url_index:'/novel/{BOOK_ID}/catalog',url_articleinfo:'/novel/{BOOK_ID}.html',url_image:'https://www.bilinovel.net/files/article/image/5/{BOOK_ID}/{BOOK_ID}s.jpg',url_home:'https://www.bilinovel.net/',articleid:'{BOOK_ID}',articlename:'{BOOK}',subid:'5',author:'测试作者',chapterid:'{chapter_id}',page:'{page_no}',chaptername:'{title.split("（")[0]}',chapterisvip:'0',userid:'0',readtime:''}};</script>
</head>
<body id="aread">
<div class="header" id="header"><a href="/" class="logo">哔哩轻小说</a><div class="hdtitle">{BOOK}</div></div>
<div class="main">
<div class="atitle"><h1 id="atitle">{title}</h1></div>
<div id="acontent" class="acontent">
<div class="cgo"><script>zation();</script></div>
{body}
<div class="dag"><ins class="adsbygoogle" data-ad-slot="1"></ins></div>
</div>
<div id="footlink"><a href="{url_prev}" class="prevlink">{prev_text}</a><a href="/novel/{BOOK_ID}/catalog">目录</a><a href="/novel/{BOOK_ID}.html">书页</a><a href="{url_next}" class="nextlink">{next_text}</a></div>
</div>
{'<script src="/scripts/chapterlog.js?v1006b8-5"></script>' if chapterlog else ''}
<script src="/themes/zhmb/js/readtool.js?v0401"></script>
<!-- page {chapter_id}{page_suffix} -->
</body>
</html>
"""


def ps(texts):
    return "\n".join(f"<p>{t}</p>" for t in texts)


def write(name, html):
    (OUT / name).write_text(html, encoding="utf-8")
    print("wrote", name)


# 1. Single-page chapter (<= 20 paragraphs: shuffle is a no-op), next = next chapter.
cid = 180210
texts = [para(10, 1, i) for i in range(1, 9)]
texts[2] = "他这样走了​。"  # PUA substitution ( -> 就) + zero-width space
write(
    "normal-chapter.html",
    page_html(
        chapter_id=cid,
        page_no=1,
        title="第十章 普通的一章",
        body=ps(texts) + "\n<p>　</p>\n<p></p>",
        url_prev=f"/novel/{BOOK_ID}/180209.html",
        url_next=f"/novel/{BOOK_ID}/180211.html",
        prev_text="上一章",
        next_text="下一章",
    ),
)

# 2. Paginated chapter, page 1 (30 paragraphs, scrambled) -> next page.
cid = 180204
texts = scramble([para(4, 1, i) for i in range(1, 31)], cid)
body = ps(texts[:12]) + "\n<x1234>反爬虫提示文字</x1234>\n<script>var a=1;</script>\n" + ps(texts[12:])
write(
    "paginated-page-1.html",
    page_html(
        chapter_id=cid,
        page_no=1,
        title="第四章 分页的章节（1/3）",
        body=body,
        url_prev=f"/novel/{BOOK_ID}/180203.html",
        url_next=f"/novel/{BOOK_ID}/180204_2.html",
        prev_text="上一章",
        next_text="下一页",
    ),
)

# 3. Paginated chapter, page 2 (25 paragraphs, scrambled) -> next page.
texts = scramble([para(4, 2, i) for i in range(1, 26)], cid)
write(
    "paginated-page-2.html",
    page_html(
        chapter_id=cid,
        page_no=2,
        title="第四章 分页的章节（2/3）",
        body=ps(texts),
        url_prev=f"/novel/{BOOK_ID}/180204.html",
        url_next=f"/novel/{BOOK_ID}/180204_3.html",
        prev_text="上一页",
        next_text="下一页",
    ),
)

# 4. Last page of the paginated chapter -> next chapter.
texts = [para(4, 3, i) for i in range(1, 6)]
write(
    "next-chapter.html",
    page_html(
        chapter_id=cid,
        page_no=3,
        title="第四章 分页的章节（3/3）",
        body=ps(texts),
        url_prev=f"/novel/{BOOK_ID}/180204_2.html",
        url_next=f"/novel/{BOOK_ID}/180205.html",
        prev_text="上一页",
        next_text="下一章",
    ),
)

# 5. Illustrations interleaved with text (direct, wrapped, obfuscated, protocol-relative).
cid = 180205
body = "\n".join(
    [
        '<img src="/images/loading.gif" data-src="https://img3.readpai.com/0/5369/180205/1.jpg" class="imagecontent lazyload">',
        f"<p>{para(5, 1, 1)}</p>",
        '<div class="divimage"><img src="https://img3.readpai.com/0/5369/180205/2.jpg" class="imagecontent"></div>',
        f"<p>{para(5, 1, 2)}</p>",
        "<p>插图前的文字<br><img src=\"//img3.readpai.com/0/5369/180205/3.png\"></p>",
        # Look-alike U+1D623 must be normalised back to "b".
        '<img data-src="https://img3.readpai.com/0/5369/180205/\U0001D6234.jpg" class="imagecontent">',
        f"<p>{para(5, 1, 3)}</p>",
    ]
)
write(
    "chapter-with-images.html",
    page_html(
        chapter_id=cid,
        page_no=1,
        title="插图",
        body=body,
        url_prev=f"/novel/{BOOK_ID}/180204_3.html",
        url_next=f"/novel/{BOOK_ID}/180206.html",
        prev_text="上一章",
        next_text="下一章",
    ),
)

# 6. Last chapter of the volume / book: "next" goes back to the catalog.
cid = 180299
texts = [para(99, 1, i) for i in range(1, 6)]
write(
    "end-of-volume.html",
    page_html(
        chapter_id=cid,
        page_no=1,
        title="后记",
        body=ps(texts),
        url_prev=f"/novel/{BOOK_ID}/180298.html",
        url_next=f"/novel/{BOOK_ID}/catalog",
        prev_text="上一章",
        next_text="返回目录",
    ),
)
