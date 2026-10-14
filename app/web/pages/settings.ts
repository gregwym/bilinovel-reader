import { h } from "../../../src/utils/dom";
import { DEFAULT_SETTINGS, type Settings } from "../../../src/reader/ProgressStore";
import { GEMINI_PRESET_MODELS, GEMINI_VOICES } from "../../../src/speech/GeminiSpeechEngine";
import { FISH_MODELS } from "../../../src/speech/FishSpeechEngine";
import type { AzureVoice } from "../../../src/speech/AzureSpeechEngine";
import type { AppInfo, LibraryStats, PageProvider, RescanResult, ServerSettings, ServerSettingsUpdate } from "../../shared/api";
import { api } from "../api";
import { act, formatBytes, stepper, toast, topbar, type Page } from "../ui";

const READER_SETTINGS_KEY = "biliReader.settings";
type Usage = Record<PageProvider, { requests: number; chars: number }>;

/** Voice, keys, site access and library storage. */
export function settingsPage(): Page {
  const el = h("div", {}, topbar("设置"));
  const body = h("div");
  el.append(body);
  void load().catch((err: Error) => body.replaceChildren(h("div", { class: "banner error" }, err.message)));

  async function load() {
    const [server, kv, stats, info] = await Promise.all([
      api.get<ServerSettings & { usage: Usage }>("/api/settings"),
      api.get<{ value: string | null }>(`/api/kv/${READER_SETTINGS_KEY}`),
      api.get<LibraryStats>("/api/library/stats"),
      api.get<AppInfo>("/api/info"),
    ]);
    const reader = { ...DEFAULT_SETTINGS, ...(kv.value ? (JSON.parse(kv.value) as Partial<Settings>) : {}) };
    body.replaceChildren(
      voiceCard(server, reader),
      keysCard(server),
      siteCard(server),
      libraryCard(server, stats),
      aboutCard(info),
    );
  }

  const reload = () => void load().catch((err: Error) => toast(err.message));

  async function saveServer(patch: ServerSettingsUpdate, message = "已保存") {
    await api.put("/api/settings", patch);
    toast(message);
  }

  // ---------------------------------------------------------------- voice

  function voiceCard(server: ServerSettings, reader: Settings): HTMLElement {
    const provider: PageProvider =
      reader.ttsEngine === "gemini" || reader.ttsEngine === "fish"
        ? reader.ttsEngine
        : server.keys.fish
          ? "fish"
          : "gemini";
    let current = provider;
    const seg = h("div", { class: "segmented" });
    const fields = h("div");
    const draw = () => {
      seg.replaceChildren(
        ...(["fish", "gemini"] as const).map((p) =>
          h(
            "button",
            {
              type: "button",
              class: p === current ? "on" : "",
              onclick: () => {
                current = p;
                draw();
              },
            },
            p === "fish" ? "Fish Audio" : "Gemini",
          ),
        ),
      );
      fields.replaceChildren(...(current === "fish" ? fishFields(reader) : geminiFields(reader)));
    };
    draw();
    const save = h("button", { class: "btn primary" }, "保存声音");
    save.addEventListener("click", () =>
      void act(save, async () => {
        const next: Settings = { ...reader, ttsEngine: current };
        for (const input of fields.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]")) {
          (next as unknown as Record<string, string>)[input.name] = input.value.trim();
        }
        await api.put(`/api/kv/${READER_SETTINGS_KEY}`, { value: JSON.stringify(next) });
        toast("声音已保存；阅读器和后台生成都会使用这个声音");
        reload();
      }),
    );
    return h(
      "section",
      { class: "card" },
      h("h2", {}, "声音"),
      h("p", { class: "hint", style: "margin-top:-6px" }, "阅读器朗读和后台生成共用同一个声音。更换声音后，已有章节会显示为“需重新生成”。"),
      seg,
      fields,
      h("div", { class: "actions" }, save),
      server.keys[current] ? null : h("div", { class: "banner", style: "margin-top:12px" }, "还没有设置这个服务的密钥（见下方）"),
    );
  }

  function select(name: string, value: string, options: [string, string][]): HTMLSelectElement {
    const el = h("select", { class: "select", name });
    const known = options.some(([v]) => v === value);
    for (const [v, label] of known || !value ? options : [[value, value] as [string, string], ...options]) {
      const opt = h("option", { value: v }, label);
      opt.selected = v === value;
      el.append(opt);
    }
    return el;
  }

  function voiceSelect(name: string, value: string, provider: PageProvider, preset: AzureVoice[], empty?: string): HTMLSelectElement {
    const opts = (voices: AzureVoice[]): [string, string][] => [
      ...(empty !== undefined ? [["", empty] as [string, string]] : []),
      ...voices.map((v) => [v.shortName, v.label] as [string, string]),
    ];
    const el = select(name, value, opts(preset));
    void api
      .get<AzureVoice[]>(`/api/voices/${provider}`)
      .then((voices) => {
        if (!voices.length) return;
        el.replaceWith(select(name, el.value, opts(voices)));
      })
      .catch(() => undefined);
    return el;
  }

  function geminiFields(s: Settings): HTMLElement[] {
    return [
      h("label", { class: "field" }, h("span", {}, "模型"), select("geminiModel", s.geminiModel, GEMINI_PRESET_MODELS.map((m) => [m, m]))),
      h("label", { class: "field" }, h("span", {}, "声音"), voiceSelect("geminiVoice", s.geminiVoice, "gemini", GEMINI_VOICES)),
      h(
        "label",
        { class: "field" },
        h("span", {}, "朗读要求"),
        Object.assign(h("textarea", { class: "textarea", name: "geminiStyle", rows: 3 }), { value: s.geminiStyle }),
      ),
    ];
  }

  function fishFields(s: Settings): HTMLElement[] {
    const custom = h("input", { class: "input", placeholder: "或粘贴 fish.audio/m/… 声音 ID" });
    const voice = voiceSelect("fishVoice", s.fishVoice, "fish", [], "模型默认声音");
    custom.addEventListener("change", () => {
      const id = /[0-9a-f]{32}/.exec(custom.value)?.[0];
      if (!id) return toast("无法识别的声音 ID");
      const sel = custom.parentElement?.parentElement?.querySelector<HTMLSelectElement>("select[name=fishVoice]");
      if (!sel) return;
      if (![...sel.options].some((o) => o.value === id)) sel.append(h("option", { value: id }, id));
      sel.value = id;
    });
    return [
      h("label", { class: "field" }, h("span", {}, "模型"), select("fishModel", s.fishModel, FISH_MODELS)),
      h("label", { class: "field" }, h("span", {}, "声音"), voice),
      h("label", { class: "field" }, h("span", {}, "自定义声音"), custom),
    ];
  }

  // ---------------------------------------------------------------- keys

  function keysCard(server: ServerSettings & { usage?: Usage }): HTMLElement {
    const rows = (["fish", "gemini"] as const).map((p) => {
      const input = h("input", {
        class: "input",
        type: "password",
        autocomplete: "off",
        placeholder: server.keys[p] ? "已设置（输入新密钥替换，留空不变）" : "未设置",
      });
      const save = h("button", { class: "btn small" }, "保存");
      save.addEventListener("click", () =>
        void act(save, async () => {
          await saveServer({ keys: { [p]: input.value } }, input.value ? "密钥已保存" : "密钥已清除");
          reload();
        }),
      );
      const u = server.usage?.[p];
      return h(
        "div",
        { class: "field" },
        h("span", {}, `${p === "fish" ? "Fish Audio" : "Gemini"} 密钥`, server.keys[p] ? " ✓" : ""),
        h("div", { style: "display:flex;gap:8px" }, input, save),
        u ? h("div", { class: "hint", style: "margin-top:4px" }, `今日：${u.requests} 次请求 · ${u.chars.toLocaleString()} 字`) : null,
      );
    });
    return h(
      "section",
      { class: "card" },
      h("h2", {}, "密钥"),
      h("p", { class: "hint", style: "margin-top:-6px" }, "密钥只保存在服务器上，浏览器不会拿到。也可以用环境变量 FISH_API_KEY / GEMINI_API_KEY 设置。"),
      ...rows,
    );
  }

  // ---------------------------------------------------------------- site

  function siteCard(server: ServerSettings): HTMLElement {
    const origin = h("input", { class: "input", value: server.siteOrigin });
    const cookie = h("input", { class: "input", value: server.cookie, placeholder: "cf_clearance=…" });
    const ua = h("input", { class: "input", value: server.userAgent });
    const fs = h("input", { class: "input", value: server.flaresolverrUrl, placeholder: "http://flaresolverr:8191" });
    const interval = h("input", { class: "input", type: "number", min: 500, max: 60000, step: 100, value: server.requestIntervalMs });
    const save = h("button", { class: "btn primary" }, "保存");
    save.addEventListener("click", () =>
      void act(save, async () => {
        await saveServer({
          siteOrigin: origin.value,
          cookie: cookie.value,
          userAgent: ua.value,
          flaresolverrUrl: fs.value,
          requestIntervalMs: Number(interval.value),
        });
        reload();
      }),
    );
    const result = h("div", { class: "hint mono", style: "margin-top:10px" });
    const test = h("button", { class: "btn" }, "测试连接");
    test.addEventListener("click", () =>
      void act(test, async () => {
        result.textContent = "连接中…";
        const r = await api.post<{ ok: boolean; ms: number; status?: number; challenge?: boolean; error?: string }>("/api/site/test");
        result.style.color = r.ok ? "var(--ok)" : "var(--danger)";
        result.textContent = r.ok
          ? `✓ 连接正常（${r.ms} ms）`
          : `✗ ${r.challenge ? "遇到人机验证" : "连接失败"}（${r.ms} ms）：${r.error ?? ""}`;
      }),
    );
    return h(
      "section",
      { class: "card" },
      h("h2", {}, "网站访问"),
      h("label", { class: "field" }, h("span", {}, "网站地址"), origin),
      h("label", { class: "field" }, h("span", {}, "请求间隔（毫秒）"), interval),
      h(
        "label",
        { class: "field" },
        h("span", {}, "Cookie（遇到人机验证时，从浏览器复制 cf_clearance；User-Agent 须与该浏览器一致）"),
        cookie,
      ),
      h("label", { class: "field" }, h("span", {}, "User-Agent"), ua),
      h("label", { class: "field" }, h("span", {}, "FlareSolverr 地址（可选，自动通过人机验证）"), fs),
      h("div", { class: "actions" }, save, test),
      result,
    );
  }

  // ---------------------------------------------------------------- library

  function libraryCard(server: ServerSettings, stats: LibraryStats): HTMLElement {
    const template = h("input", { class: "input mono", value: server.storageTemplate });
    const preview = h("div", { class: "hint mono", style: "margin-top:6px" });
    const showPreview = () => {
      const sample: Record<string, string> = {
        author: "作者",
        book: "书名",
        bookId: "1234",
        volume: "第一卷",
        volumeNo: "01",
        chapter: "第一章 开始",
        chapterNo: "001",
        chapterId: "56789",
      };
      preview.textContent = `例：${stats.libraryDir}/${template.value.replace(/\{(\w+)\}/g, (m, k: string) => sample[k] ?? m)}.mp3`;
    };
    template.addEventListener("input", showPreview);
    showPreview();
    let ahead = server.defaultAhead;
    const saveTemplate = h("button", { class: "btn primary" }, "保存并整理文件");
    saveTemplate.addEventListener("click", () =>
      void act(saveTemplate, async () => {
        await api.put("/api/settings", { storageTemplate: template.value, defaultAhead: ahead });
        const r = await api.post<RescanResult>("/api/library/relayout");
        toast(r.moved ? `已移动 ${r.moved} 个文件` : "已保存");
        reload();
      }),
    );
    const rescan = h("button", { class: "btn small" }, "检查文件");
    rescan.addEventListener("click", () =>
      void act(rescan, async () => {
        const r = await api.post<RescanResult>("/api/library/rescan");
        toast(`检查了 ${r.checked} 个文件${r.missing ? `，${r.missing} 个缺失（将重新生成）` : "，全部完好"}`);
        reload();
      }),
    );
    const clearSegments = h("button", { class: "btn small danger" }, "清空语音片段缓存");
    clearSegments.addEventListener("click", () => {
      if (!confirm("清空后，重新生成章节需要再次请求语音服务。已生成的章节音频不受影响。")) return;
      void act(clearSegments, async () => {
        await api.post("/api/library/clear-segments");
        toast("已清空");
        reload();
      });
    });
    return h(
      "section",
      { class: "card" },
      h("h2", {}, "有声书库"),
      h(
        "div",
        { class: "stats", style: "margin-bottom:12px" },
        h("div", {}, h("b", {}, String(stats.chapterFiles)), h("span", {}, "章节文件")),
        h("div", {}, h("b", {}, formatBytes(stats.libraryBytes)), h("span", {}, "有声书")),
        h("div", {}, h("b", {}, formatBytes(stats.segmentBytes + stats.cacheBytes)), h("span", {}, "缓存")),
      ),
      stats.ffmpeg ? null : h("div", { class: "banner error" }, "找不到 ffmpeg，无法生成章节音频。"),
      h(
        "label",
        { class: "field" },
        h("span", {}, "文件路径模板：{author} {book} {bookId} {volume} {volumeNo} {chapter} {chapterNo} {chapterId}"),
        template,
        preview,
      ),
      h(
        "div",
        { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "label" }, "新书默认提前生成"), h("div", { class: "hint" }, "跟随阅读进度时，在当前章之后生成的章节数")),
        stepper(ahead, 0, 50, (v) => (ahead = v)),
      ),
      h("div", { class: "actions" }, saveTemplate),
      h("div", { class: "actions" }, rescan, clearSegments),
    );
  }

  function aboutCard(info: AppInfo): HTMLElement {
    const logout = info.auth
      ? h(
          "button",
          {
            class: "btn small ghost",
            onclick: () => void api.post("/api/logout").then(() => (location.href = "/login")),
          },
          "退出登录",
        )
      : null;
    return h(
      "section",
      { class: "card" },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "label" }, "Bili Reader 有声书库"), h("div", { class: "hint" }, `版本 ${info.version}`)), logout),
    );
  }

  return { el };
}
