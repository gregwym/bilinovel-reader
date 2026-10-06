# Bili Reader

在 iPhone / iPad Safari 上，把 [Bilinovel（哔哩轻小说）](https://www.bilinovel.net/) 的章节页变成一个干净的阅读器，并支持像微信读书一样**连续朗读**：自动翻页、自动进入下一章、记住阅读/收听位置。

它是一个用户脚本（userscript），通过 iOS 上的 [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) App 运行。没有后端、不需要签名、不需要 Apple 开发者账号。

## 功能

- 打开任意章节页自动进入阅读模式（Shadow DOM 覆盖层，不改动原页面；可随时退出）
- 站点内部的分页（`180204.html → 180204_2.html → …`）对用户不可见，一章就是一章
- 滚动到底部自动加载下一页 / 下一章，不刷新页面（`fetch` + `DOMParser`），地址栏用 `history.replaceState` 同步
- 浏览器 TTS 逐段朗读：当前段落高亮并跟随滚动，自动跨页、跨章继续
- 播放 / 暂停 / 上一段 / 下一段，点击段落「从这里开始朗读」，语速（0.75–1.5x）与中文声音可选
- 阅读与收听共用一个光标；按书保存进度，重新打开时提示「上次读到…，要继续吗？」
- 字号、行距、字体（黑体/宋体）、主题（自动/浅色/护眼/深色），设置持久化
- 插图按原顺序内联显示（懒加载、自适应宽度）
- 保守抓取：串行队列、两次请求间隔 ≥ 4 秒、只预取下一页、临时错误指数退避重试；出错时显示「重试 / 打开原网页」，已加载内容和进度都不会丢

## 支持的网站

- `https://www.bilinovel.net/novel/{书号}/{章节号}.html`（以及 `_2.html`、`_3.html` 等分页）
- `https://www.bilinovel.com/novel/…`（同一套移动版页面）

## 安装（iOS / iPadOS）

1. 在 App Store 安装 **Userscripts**（免费）。
2. 「设置 → Safari → 扩展 → Userscripts」：打开扩展，并允许它在 `bilinovel.net` 上运行。
3. 用 Safari 打开安装页 **https://gregwym.github.io/bilinovel-reader/**，点「安装用户脚本」，再点地址栏的扩展按钮 → Userscripts → Install。
4. 打开任意章节，例如 `https://www.bilinovel.net/novel/5369/180204.html`。

脚本固定地址（用于安装与更新）：

```
https://gregwym.github.io/bilinovel-reader/bili-reader.user.js
```

如果 Userscripts 没有按 `@updateURL` 自动更新，重新打开上面的地址安装即可覆盖。

## 使用

| 操作 | 方式 |
| --- | --- |
| 朗读 / 暂停 | 底部 ▶︎ 按钮 |
| 从某段开始朗读 | 点一下该段落 → 「▶ 从这里开始朗读」；朗读中直接点段落即可跳转 |
| 上一段 / 下一段 | ⏮ / ⏭ |
| 语速 | 左下角 `1.0x` |
| 声音、字号、行距、主题 | 右上角 ⋯ |
| 退出阅读模式 | 左上角 ‹（右下角会出现「📖 阅读模式」按钮可再次进入） |

## 开发

```bash
npm install
npm run dev        # 监听源码，持续输出 dist/bili-reader.user.js（带 inline sourcemap）
npm run build      # 生产构建：dist/bili-reader.user.js（单文件，含元数据头）
npm test           # 单元测试（vitest + jsdom，不需要 Safari）
npm run lint       # eslint + tsc
npm run serve      # 在局域网提供 dist/，iPhone 打开 http://<电脑IP>:4173/bili-reader.user.js 即可安装测试版
```

也可以直接把 `dist/bili-reader.user.js` 的内容复制到 Userscripts 的新建脚本里测试。

调试日志：在章节页的控制台执行 `localStorage.setItem("biliReader.debug", "1")` 后刷新（Mac Safari「开发」菜单可连接 iPhone 查看）。

`main` 分支的每次 push 都会由 GitHub Actions 执行 lint → test → build，并把脚本和安装页发布到 GitHub Pages（仓库需在 Settings → Pages 中把 Source 设为 **GitHub Actions**）。

## 架构

```
src/
├── main.ts                    入口：判断页面、启动 Reader
├── adapters/
│   ├── types.ts               站点无关的数据模型（Paragraph / PageContent / SiteAdapter）
│   └── bilinovel/             所有 Bilinovel 专有逻辑都在这里
│       ├── index.ts           BilinovelAdapter：抓取 + 解析 + chapterlog.js 参数缓存
│       ├── parser.ts          纯函数解析器（可在 jsdom 中测试）
│       ├── pagination.ts      下一页 / 下一章 / 结束 的判定
│       ├── url.ts             URL 规则
│       ├── deobfuscate.ts     段落乱序还原、私有区字符替换、图片 URL 修正
│       └── charmap.ts         私有区字符映射表
├── reader/
│   ├── Reader.ts              控制器：共享光标、加载、进度、URL 同步
│   ├── ChapterBuffer.ts       把站点分页折叠成「章 → 段落」的滚动缓冲区
│   └── ProgressStore.ts       进度与设置（异步 KV 接口，可换成 IndexedDB）
├── speech/
│   ├── SpeechEngine.ts        SpeechEngine 接口 + WebSpeechEngine（可替换为原生引擎）
│   ├── SpeechPlayer.ts        逐段朗读状态机 idle/playing/paused/buffering/error
│   └── VoiceManager.ts        中文声音列表
├── ui/                        ReaderView（Shadow DOM）与样式
└── utils/                     RequestQueue（串行限速 + 重试）、日志、DOM 工具
```

### Bilinovel 页面要点

调研了现有开源实现后确认（详见 `src/adapters/bilinovel/parser.ts` 与 `deobfuscate.ts` 注释）：

- 标题 `#atitle`（分页时带「（2/3）」后缀），正文 `#acontent`，翻页链接 `#footlink a.nextlink`，内联脚本 `ReadParams = {url_next, chapterid, articlename, …}`。
- 长章节被拆成 `{章节号}.html`、`{章节号}_2.html`… 多个网页；最后一页的「下一页」变为「下一章」，卷末则指向目录。
- **服务器返回的段落顺序是打乱的**：`/scripts/chapterlog.js` 在浏览器里按章节号做种子、用 LCG 驱动的 Fisher–Yates 还原（前 20 段不动）。`fetch` 回来的 HTML 不会执行脚本，所以本项目自行还原，并在运行时从 chapterlog.js 中提取常量（失败时用已知默认值）。
- 正文里混有广告、`<x1234>` 之类的反爬标签和私有区（PUA）字符，解析时会清理/替换；图片 URL 可能使用形近字符（如 `𝘣`）。
- 站点在 Cloudflare 之后，请求过快会出验证页；本项目把它识别为「需要人机验证」并引导打开原网页。

参考并改编了以下 MIT 许可项目中的思路与数据（见 `THIRD_PARTY_NOTICES.md`）：
[Montaro2017/bili_novel_packer](https://github.com/Montaro2017/bili_novel_packer)、
[saudadez21/novel-downloader](https://github.com/saudadez21/novel-downloader)。
另参考了 [ShqWW/bilinovel-download](https://github.com/ShqWW/bilinovel-download) 与 [lightnovel-center/linovelib2epub](https://github.com/lightnovel-center/linovelib2epub) 的页面分析（未复制代码）。

## 已知限制

- **后台/锁屏朗读**：这是纯网页 TTS。Safari 切到后台或锁屏后，iOS 可能暂停 `speechSynthesis`，也可能在当前句读完后不再继续；回到前台时会自动尝试恢复。它的表现不会等同于原生有声书 App。TTS 已隔离在 `SpeechEngine` 接口后面，将来可替换为原生实现。
- 暂停/恢复采用「取消 + 从当前句重读」，以规避 WebKit 的 `pause()/resume()` 不可靠问题，所以恢复时会重读当前句。
- 首次播放必须由点击触发（iOS 限制）。
- 恢复到某一页时，从该页开始显示；同一章之前的页面可通过 ⋯ →「从本章开头阅读」加载。
- 站点改版或更换混淆方式时解析可能失效：会显示「无法解析此 Bilinovel 页面」，可点「打开原网页」继续阅读，并欢迎提交 issue。
- 测试用的 HTML fixtures 依据公开解析器记录的页面结构合成（见 `tests/fixtures/README.md`），站点变化后应替换为脱敏的真实页面。
- 只缓存当前与下一页，不支持离线下载整本书（这是有意的）。

## 隐私

Bili Reader 没有后端，不会向开发者发送任何阅读数据。所有阅读进度和设置都只保存在你的浏览器（`localStorage`）中。脚本只会向你正在浏览的 Bilinovel 站点请求你接下来要读的页面。

## 许可

MIT
