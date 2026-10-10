# Bili Reader

在 iPhone / iPad Safari 上，把 [Bilinovel（哔哩轻小说）](https://www.bilinovel.net/) 的章节页变成一个干净的阅读器，并支持像微信读书一样**连续朗读**：自动翻页、自动进入下一章、记住阅读/收听位置。

它是一个用户脚本（userscript），通过 iOS 上的 [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) App 运行。没有后端、不需要签名、不需要 Apple 开发者账号。

## 功能

- 打开任意章节页自动进入阅读模式（Shadow DOM 覆盖层，不改动原页面；可随时退出）
- 站点内部的分页（`180204.html → 180204_2.html → …`）对用户不可见，一章就是一章
- 滚动到底部自动加载下一页 / 下一章，不刷新页面（`fetch` + `DOMParser`），地址栏用 `history.replaceState` 同步
- 逐段朗读：当前段落高亮并跟随滚动，自动跨页、跨章继续
- 三种朗读引擎：系统语音（Safari Web Speech）、**Azure 神经网络语音**或 **Google Cloud 语音**（后两者更自然，可在后台/锁屏继续播放，锁屏可控制）
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

Google Cloud Text-to-Speech 每月免费额度按声音类型分别计算：**Chirp 3 HD 100 万字符、WaveNet 100 万字符、Standard 400 万字符**（中文每个字计 1 个字符）。与 Azure F0 不同，Google 需要绑定结算账号，**超出免费额度会扣费**；因此阅读器在本机按类型统计当月用量，**到达免费额度即停止使用 Google**、改用系统语音（下月自动恢复）。本机统计只覆盖这台设备，多设备共用同一个密钥时请另外设置预算提醒。

1. 在 [Google Cloud 控制台](https://console.cloud.google.com/) 创建项目，绑定结算账号（新账号有试用赠金）。
2. 启用 **Cloud Text-to-Speech API**。
3. 「API 和服务 → 凭据」创建 **API 密钥**，并在「API 限制」里只允许 Cloud Text-to-Speech API。
4. 建议在「结算 → 预算和提醒」设一个很小的预算（如 1 美元）提醒。
5. 阅读器 ⋯ →「朗读」选 **Google**，粘贴密钥，选择声音（默认 Chirp 3 HD Aoede），点「试听」。

说明：密钥同样保存在 Userscripts 私有存储；请求通过 `GM.xmlHttpRequest` 发往 `texttospeech.googleapis.com`；出错时的重试、临时改用系统语音等行为与 Azure 相同。价格与额度以 [Google 官方价格页](https://cloud.google.com/text-to-speech/pricing) 为准。

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
│   ├── FallbackSpeechEngine.ts 云端语音失败（额度/密钥/网络）时自动改用系统语音
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

例外：如果你启用了 Azure 或 Google 语音，正在朗读的文字会直接从你的设备发送到你自己的 Azure Speech 资源（微软）或 Google Cloud 项目以合成语音；默认的系统语音不会发送任何内容。

## 许可

MIT
