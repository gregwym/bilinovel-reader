# Bili Reader

在 iPhone / iPad Safari 上，把 [Bilinovel（哔哩轻小说）](https://www.bilinovel.net/) 的章节页变成一个干净的阅读器，并支持像微信读书一样**连续朗读**：自动翻页、自动进入下一章、记住阅读/收听位置。

它是一个用户脚本（userscript），通过 iOS 上的 [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) App 运行。没有后端、不需要签名、不需要 Apple 开发者账号。

想在 NAS 上自托管、带书架和有声书生成？见 [有声书库（NAS 自托管）](#有声书库nas-自托管)。

## 功能

- 打开任意章节页自动进入阅读模式（Shadow DOM 覆盖层，不改动原页面；可随时退出）
- 站点内部的分页（`180204.html → 180204_2.html → …`）对用户不可见，一章就是一章
- 滚动到底部自动加载下一页 / 下一章，不刷新页面（`fetch` + `DOMParser`），地址栏用 `history.replaceState` 同步
- 逐段朗读：当前段落高亮并跟随滚动，自动跨页、跨章继续
- 五种朗读引擎：系统语音（Safari Web Speech）、**Azure 神经网络语音**、**Google Cloud 语音**（逐句合成），以及 **Gemini 语音**、**Fish Audio 语音**（按页生成、本机缓存）；云端语音更自然，可在后台/锁屏继续播放，锁屏可控制
- 播放 / 暂停 / 上一段 / 下一段，点击段落「从这里开始朗读」，语速（0.75–1.5x）与中文声音可选
- 目录与跳转：右上角 ☰ 打开目录（按卷分组、高亮当前章），可上一章 / 下一章、上一页 / 下一页、跳到本章任意分页；内容顶部有「↑ 本章上一页 / 上一章」按钮，无需退出阅读模式
- 阅读与收听共用一个光标；按书保存进度（精确到段落，并记录段落开头文字以便定位）。重新打开同一章的任意一页会直接回到上次位置；打开其他章时提示「上次读到…，要继续吗？」
- 进度保存在 Userscripts 自身的存储里（不受 Safari 清除网站数据影响，所有标签页共享）；后台标签页不会覆盖其他标签页更新的进度，切回时会提示跳到较新的位置
- 每个标签页还在自己的历史记录里记住位置：Safari 回收后台标签页再重新加载时，直接回到这个标签页离开时的位置，不会被较旧的共享进度拉回去
- 暂停后滚动到别处再点 ▶，从当前看到的段落开始朗读；暂停的段落仍在屏幕上时则继续朗读该段。来电、其他 App 播放等系统打断会正确进入暂停状态
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
| 目录、上一章 / 下一章、翻页 | 右上角 ☰ |
| 声音、字号、行距、主题 | 右上角 ⋯ |
| 退出阅读模式 | 左上角 ‹（右下角会出现「📖 阅读模式」按钮可再次进入） |

## Azure 神经网络语音（可选）

系统语音比较生硬，可以改用 Azure AI Speech 的中文神经网络语音（晓晓、云希等）。使用**免费 F0 层**时，每月 50 万字符（中文按 2 计，约 25 万字）用完后 Azure 会拒绝请求，**不会自动扣费**；阅读器随即自动改用系统语音继续朗读，下月额度恢复后再切回 Azure（重新选择一次「Azure」即可立即重试）。

1. 在 [Azure 门户](https://portal.azure.com/) 创建 **Speech**（语音）资源，**定价层选 Free F0**，区域建议 `eastasia` 或 `southeastasia`。
2. 在资源的「密钥和终结点」页复制 **密钥 1** 和 **区域**。
3. 阅读器 ⋯ →「朗读」选 **Azure**，粘贴密钥、填写区域，选择声音，点「试听」。

说明：
- 密钥保存在 Userscripts 的私有存储（`GM.setValue`）中，网页脚本读不到；只有在不支持该 API 的管理器里才退回到 `localStorage`。
- 请求通过 `GM.xmlHttpRequest` 直接发往 `{区域}.tts.speech.microsoft.com`，正在朗读的文字会发送给微软。
- 设置页显示的「本月约用」是本机估算，以 Azure 后台计量为准。
- 每次请求约 300 字；可设置「预缓冲」1–8 句（默认 3 句，最多 2 个并发请求），跳转后的第一句会截短以便尽快开始播放。
- 出错时按类型处理：网络/限流/服务器错误会先重试，仍失败则这一句临时用系统语音，20 秒起逐步延长后自动重试 Azure；额度用完 30 分钟后重试；密钥错误需修改设置。设置里也可「立即重试 Azure」。

## Google Cloud 语音（可选）

Google Cloud Text-to-Speech 每月免费额度按声音类型分别计算：**Chirp 3 HD 100 万字符、WaveNet 400 万字符、Standard 400 万字符**（中文每个字计 1 个字符）。与 Azure F0 不同，Google 需要绑定结算账号，**超出免费额度会扣费**；因此阅读器在本机按类型统计当月用量，**到达免费额度即停止使用 Google**、改用系统语音（下月自动恢复）。本机统计只覆盖这台设备，多设备共用同一个密钥时请另外设置预算提醒。

1. 在 [Google Cloud 控制台](https://console.cloud.google.com/) 创建项目，绑定结算账号（新账号有试用赠金）。
2. 启用 **Cloud Text-to-Speech API**。
3. 「API 和服务 → 凭据」创建 **API 密钥**，并在「API 限制」里只允许 Cloud Text-to-Speech API。
4. 建议在「结算 → 预算和提醒」设一个很小的预算（如 1 美元）提醒。
5. 阅读器 ⋯ →「朗读」选 **Google**，粘贴密钥，选择声音（默认 Chirp 3 HD Aoede），点「试听」。

说明：密钥同样保存在 Userscripts 私有存储；请求通过 `GM.xmlHttpRequest` 发往 `texttospeech.googleapis.com`；出错时的重试、临时改用系统语音等行为与 Azure 相同。价格与额度以 [Google 官方价格页](https://cloud.google.com/text-to-speech/pricing) 为准。

## Gemini 语音（可选）

Gemini 用大模型生成语音，语气更像有声书，但工作方式与 Azure/Google 不同：

- **按页生成**：网站的一页对应一次请求、一份音频（约几分钟）；超过 2000 字的页按固定方式均分成几份，以免超出模型单次输出上限。朗读时会提前加载并生成后面几页（默认 4 页），网络慢或请求受限时也能连续播放。
- **本机缓存**：音频按页存在浏览器 IndexedDB（最多约 400 MB，超出时删最久未听的）。因为切分只取决于页面内容，从页中任何位置开始读、重听、刷新页面都能直接用缓存，不再请求。设置里可「清除缓存」。
- **高亮**：一份音频对应一页的多个段落，段落起点按字数估算、再对齐到音频里的停顿，高亮可能偶尔早晚一两秒。语速通过播放速度调节（Gemini 本身没有语速参数）。
- **额度**：Gemini Developer API 的免费层按每分钟/每天的**请求次数**限制（以 AI Studio 显示为准），大致每听一页用一次请求。只有**未开启结算**的项目才免费；开启结算后按用量计费。免费层的内容可能被 Google 用于改进产品。

1. 打开 [Google AI Studio](https://aistudio.google.com/apikey) 创建 API 密钥。
2. 阅读器 ⋯ →「朗读」选 **Gemini**，粘贴密钥；选择模型（会自动列出可用的 TTS 模型）和声音，点「试听」。
3. 「风格」是放在文字前的朗读要求，可改成自己喜欢的语气；改动模型、声音或风格后会重新生成。

被限流时会按服务器建议的时间等待重试；当天次数用完会暂用系统语音，30 分钟后再试。请求通过 `GM.xmlHttpRequest` 发往 `generativelanguage.googleapis.com`。参考：[Gemini 语音生成文档](https://ai.google.dev/gemini-api/docs/speech-generation)、[速率限制](https://ai.google.dev/gemini-api/docs/rate-limits)。

## Fish Audio 语音（可选）

Fish Audio 的 `s2.1-pro-free` 模型通过 API **免费使用至 2026-11-30**（“合理使用”，不保证延迟和可用性），表现力接近有声书。工作方式与 Gemini 相同：按页生成（超过 1000 字的页均分成几份，首段等待更短）、提前生成后面几页、音频缓存在本机 IndexedDB（与 Gemini 分开，各约 400 MB）、段落起点对齐到音频里的停顿、语速通过播放速度调节。

1. 在 [Fish Audio](https://fish.audio) 注册，到 API Keys 页面创建密钥。
2. 阅读器 ⋯ →「朗读」选 **Fish**，粘贴密钥，点「试听」。
3. 「声音」会列出你自己的声音和常用的中文声音；也可以在「声音 ID」里粘贴 fish.audio 上任意声音的链接（如 `https://fish.audio/zh-CN/m/<ID>/`）。不选则用模型默认声音。改动模型或声音后会重新生成。

「模型」里的 S2.1 Pro、Drama 3 等是**付费**模型，按 UTF-8 字节计费（中文约 3 字节一个字），需要账户有余额；余额不足会暂用系统语音。被限流时按服务器给出的时间等待重试。请求通过 `GM.xmlHttpRequest` 发往 `api.fish.audio`。参考：[S2.1 Pro 免费 API](https://fish.audio/blog/s2-1-pro-free-api/)、[价格与限制](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits)。

## 有声书库（NAS 自托管）

`app/` 是同一套阅读器的自托管版本，适合跑在 NAS 上：

- **阅读器体验一致**：章节页地址与网站相同（`/novel/<书>/<章>.html`），就是同一个阅读器。正文由服务器抓取并缓存，阅读设置和进度存在服务器上，多台设备之间同步。
- **书架**：仿微信读书的封面书架，带“继续阅读”卡片、阅读百分比和 🎧 有声章节数。粘贴书籍或章节链接即可加入；在阅读器里打开过的书也会自动加入。
- **有声书生成**：
  - **跟随阅读进度**（默认开启）：后台生成正在读的章节，以及之后 N 章（可调）。
  - **手动批量生成**：可以生成单章、整卷、从当前章起 10 章，或全书。
  - 声音使用 Fish Audio 或 Gemini，密钥只保存在服务器上。
  - 阅读器朗读和后台生成共用同一份语音片段缓存，已生成的部分不会再次请求。章节文件生成后，片段直接从章节文件里读取，不再单独保存一份。
  - 更换声音后，旧章节会标记为“需重新生成”。
  - 配额用尽时等到重置再继续；密钥无效时暂停，并在“任务”页提示。
- **本地书库**：像 Immich 管理照片一样，按模板把音频整理成文件夹（默认 `{author}/{book}/{volumeNo} {volume}/{chapterNo} {chapter}.mp3`）。
  - 每个文件写入 ID3 标签，每本书的文件夹里有 `cover.jpg`，可以直接给 Audiobookshelf、Plex 等使用。
  - 修改模板后可一键整理已有文件；“检查文件”会找出被删除的文件，并重新生成。
  - 一卷生成完后，可导出带章节标记的 **M4B**。

### 部署（Docker）

每次合并到 `main`，GitHub Actions 会自动构建镜像并发布到 `ghcr.io/gregwym/bilinovel-reader`（amd64 和 arm64，适用于大多数 NAS）：

- `latest`：`main` 分支的最新版本；
- `0.10.8` 这样的版本号：对应 `package.json` 里的版本；
- `sha-<commit>`：某次提交。

只需要 `docker-compose.yml` 一个文件：

```bash
mkdir bili-reader && cd bili-reader
curl -O https://raw.githubusercontent.com/gregwym/bilinovel-reader/main/docker-compose.yml
docker compose up -d             # 打开 http://<NAS-IP>:8790
```

更新：`docker compose pull && docker compose up -d`。想从源码自己构建，把 `docker-compose.yml` 里的 `image:` 换成 `build: .`，再运行 `docker compose up -d --build`。

`docker-compose.yml` 挂载两个目录：`./data`（数据库、语音片段缓存、导出文件）和 `./library`（整理好的有声书）。

常用环境变量：

| 变量 | 用途 |
| --- | --- |
| `APP_PASSWORD` | 访问密码；暴露到局域网以外时建议设置 |
| `FISH_API_KEY` / `GEMINI_API_KEY` | 也可以在“设置”页填写 |
| `SITE_ORIGIN` | 默认 `https://www.bilinovel.com` |
| `SITE_COOKIE` / `FLARESOLVERR_URL` | 遇到人机验证时使用 |
| `DEFAULT_AHEAD` | 跟随阅读时提前生成的章节数，默认 3 |
| `STORAGE_TEMPLATE` | 文件路径模板 |
| `PORT` | 端口，默认 8790 |

书库可以像 App 一样安装（PWA），全屏打开、有自己的图标：

- **iPhone / iPad**：用 Safari 打开书库，分享 →「添加到主屏幕」。
- **Android / 电脑上的 Chrome、Edge**：地址栏右侧的「安装」按钮，或菜单 →「安装应用 / 添加到主屏幕」。浏览器只对 HTTPS（或 `localhost`）地址提供安装，用 `http://<NAS IP>` 访问时请先在反向代理上配置 HTTPS。

### 无法添加书籍 / 访问网站

- 书架上的错误提示会写明原因（HTTP 状态码、DNS 解析失败、连接被重置、人机验证等）。「设置 → 网站访问 → 测试连接」可单独检查服务器能否访问网站。`docker logs bili-reader` 里也有同样的记录。
- **人机验证 / HTTP 403**：在浏览器中打开网站并通过验证，把 `cf_clearance` Cookie 和该浏览器的 User-Agent 填进设置；或部署 [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) 并填写地址。
- **DNS 解析失败 / 连接超时**：检查 NAS 或容器的网络与 DNS；也可以在设置里把网站地址换成 `https://www.bilinovel.net`。
- **目录显示“暂无链接”，但正文可以阅读**：原站可能只在目录提供占位链接。阅读器会用已读取正文的标题和相邻章节导航验证并补全链接，不会根据编号猜测。服务器升级启动、目录刷新和新正文缓存时会自动修复已有书库；若同卷其余已知章节的音频均已生成，会自动补排漏章，沿用现有暂停和语音设置，不重做已有音频。尚无正文证据的章节会保留占位状态。
- **只显示“HTTP 502：反向代理未收到书库服务的响应”**：这个错误来自 NAS 的反向代理，不是书库本身。检查容器是否在运行，或调高反向代理的超时时间。

### 不用 Docker

需要 Node.js 22.13 以上和 ffmpeg：

```bash
npm ci && npm run build:app
DATA_DIR=./data LIBRARY_DIR=./library npm run start:app
```

开发时用 `npm run dev:app`，它会启动前端开发服务器，并把 `/api` 代理到 `:8790`。

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

遇到解析问题时，可在 ⋯ 中点「复制诊断信息」（只含页面地址、加载方式和段落计数，不含正文）。

调试日志：在章节页的控制台执行 `localStorage.setItem("biliReader.debug", "1")` 后刷新（Mac Safari「开发」菜单可连接 iPhone 查看）。

`main` 分支的每次 push 都会由 GitHub Actions 执行 lint → test → build，并把脚本和安装页发布到 GitHub Pages（仓库需在 Settings → Pages 中把 Source 设为 **GitHub Actions**）。

### userscript 与服务器版保持同步

阅读器有两种形态：userscript（`src/main.ts`）和有声书库的网页 / PWA（`app/web/`，服务器在 `app/server/`）。两者共用 `src/` 下的阅读器、解析和语音代码，**任何功能或优化都要两边同时生效**：

- 阅读和朗读的行为写在共享的 `src/`（`Reader`、`ReaderView`、`speech/`）里，不要只改其中一个入口。
- 服务器预生成的语音必须和阅读器请求的文字完全一致（缓存按文字计算 key）：朗读文字一律经过 `src/speech/spoken.ts`，分段经过 `splitIntoChunks` / `splitPage`，服务器端入口是 `app/server/tts.ts` 的 `parts()`。
- 只有一方才有的能力（例如服务器的预生成、离线保存，userscript 的站点页面接管）要在 PR 说明里写明原因。
- 每个 PR 都要分别验证 userscript（`npm run build`）和服务器版（`npm run build:app`）。

## 架构

```
src/
├── main.ts                    入口：判断页面、启动 Reader
├── adapters/
│   ├── types.ts               站点无关的数据模型（Paragraph / PageContent / SiteAdapter）
│   └── bilinovel/             所有 Bilinovel 专有逻辑都在这里
│       ├── index.ts           BilinovelAdapter：抓取 + 解析 + chapterlog.js 参数缓存
│       ├── parser.ts          纯函数解析器（可在 jsdom 中测试）
│       ├── pagination.ts      下一页 / 下一章 / 结束 的判定，分页数
│       ├── catalog.ts         目录页解析（卷、章节、无链接章节）
│       ├── url.ts             URL 规则
│       ├── deobfuscate.ts     段落乱序还原、私有区字符替换、图片 URL 修正
│       └── charmap.ts         私有区字符映射表
├── reader/
│   ├── Reader.ts              控制器：共享光标、加载、进度、URL 同步
│   ├── ChapterBuffer.ts       把站点分页折叠成「章 → 段落」的滚动缓冲区
│   └── ProgressStore.ts       进度与设置（异步 KV 接口，可换成 IndexedDB）
├── speech/
│   ├── SpeechEngine.ts        SpeechEngine 接口 + WebSpeechEngine（可替换为原生引擎）
│   ├── CloudSpeechEngine.ts   云端语音公共部分（<audio> 播放、预取、缓存）
│   ├── AzureSpeechEngine.ts   Azure 神经网络语音（REST、用量估算）
│   ├── GoogleSpeechEngine.ts  Google Cloud 语音（REST、按类型统计并限制在免费额度内）
│   ├── PageSpeechEngine.ts    按页生成的语音公共部分（提前生成、IndexedDB 缓存、按停顿对齐段落）
│   ├── GeminiSpeechEngine.ts  Gemini 语音
│   ├── FishSpeechEngine.ts    Fish Audio 语音
│   ├── FallbackSpeechEngine.ts 云端语音失败（额度/密钥/网络）时自动改用系统语音
│   ├── SpeechPlayer.ts        逐段朗读状态机 idle/playing/paused/buffering/error
│   ├── spoken.ts              每段实际朗读的文字（章节首段前读标题），阅读器和服务器共用
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
- `chapterlog.js` 还原段落后，还会复制若干段落作为诱饵随机插入正文，并用动态 CSS 隐藏。
- 因此页面通过**禁用脚本的同源 iframe**（`sandbox="allow-same-origin"`）加载：拿到的是服务器原始 HTML，站点脚本不会执行，诱饵根本不会产生；站点 CSS 仍生效，再按实际渲染结果（`display`、透明度、字号、颜色、裁剪、尺寸和位置）剔除不可见元素；段落顺序由本项目按 chapterlog.js 中的常量还原。这同时是正常的页面导航，避开了 Cloudflare 对脚本 `fetch` 的拦截。
- 遇到人机验证或无法读取 chapterlog.js 时，改用允许脚本的 iframe（必要时在阅读器内显示验证页面），读取渲染结果并剔除不可见段落。
- 打开的第一页会同时与浏览器中已渲染的页面比对段落顺序（结果见「复制诊断信息」）。

参考并改编了以下 MIT 许可项目中的思路与数据（见 `THIRD_PARTY_NOTICES.md`）：
[Montaro2017/bili_novel_packer](https://github.com/Montaro2017/bili_novel_packer)、
[saudadez21/novel-downloader](https://github.com/saudadez21/novel-downloader)。
另参考了 [ShqWW/bilinovel-download](https://github.com/ShqWW/bilinovel-download) 与 [lightnovel-center/linovelib2epub](https://github.com/lightnovel-center/linovelib2epub) 的页面分析（未复制代码）。

## 已知限制

- **后台/锁屏朗读**：系统语音（`speechSynthesis`）在 Safari 切到后台或锁屏后可能暂停或在当前句后停止，回到前台时会自动尝试恢复。Azure 语音通过 `<audio>` 播放，后台表现通常更好，但仍受 iOS 对网页的限制（例如需要联网取下一句），不等同于原生有声书 App。TTS 隔离在 `SpeechEngine` 接口后面。
- Safari 网页无法使用 Siri 语音或下载的增强/高级语音（Apple 限制）。
- 暂停/恢复采用「取消 + 从当前句重读」，以规避 WebKit 的 `pause()/resume()` 不可靠问题，所以恢复时会重读当前句。
- 首次播放必须由点击触发（iOS 限制）。
- 恢复到某一页时，从该页开始显示；同一章之前的页面可通过 ⋯ →「从本章开头阅读」加载。
- 站点改版或更换混淆方式时解析可能失效：会显示「无法解析此 Bilinovel 页面」，可点「打开原网页」继续阅读，并欢迎提交 issue。
- 测试用的 HTML fixtures 依据公开解析器记录的页面结构合成（见 `tests/fixtures/README.md`），站点变化后应替换为脱敏的真实页面。
- 只缓存当前与下一页，不支持离线下载整本书（这是有意的）。

## 隐私

Bili Reader 没有后端，不会向开发者发送任何阅读数据。所有阅读进度和设置都只保存在你的设备上（Userscripts 的脚本存储和浏览器本地存储）。脚本只会向你正在浏览的 Bilinovel 站点请求你接下来要读的页面。

例外：如果你启用了 Azure、Google、Gemini 或 Fish Audio 语音，正在朗读（及提前生成）的文字会直接从你的设备发送到你自己的 Azure Speech 资源（微软）、Google 项目或 Fish Audio 账户以合成语音；默认的系统语音不会发送任何内容。

## 许可

MIT
