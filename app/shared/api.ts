/**
 * Types exchanged between the library server and its web app.
 */

import type { Catalog, ChapterNav } from "../../src/adapters/types";
import type { ChapterTimeline } from "../../src/speech/PageSpeechEngine";

export type PageProvider = "gemini" | "fish";

/** What decides how generated audio sounds: chapters made with another profile are regenerated. */
export interface VoiceProfile {
  provider: PageProvider;
  model: string;
  voice: string;
  /** Gemini only: reading direction. */
  style?: string;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
/** chapter: voice a chapter; text: download its text into the library; export: pack a volume. */
export type JobKind = "chapter" | "text" | "export";
/** Why a chapter was queued: following the reading position, or asked for. */
export type JobReason = "follow" | "manual";

export interface JobInfo {
  id: number;
  kind: JobKind;
  bookId: string;
  bookTitle: string;
  /** Chapter id (chapter, text), or the volume index for an export. */
  target: string;
  title: string;
  reason: JobReason;
  status: JobStatus;
  progress: number;
  message?: string;
  error?: string;
  /** Waiting until then (quota, back-off). */
  notBefore?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReadingPosition {
  chapterId: string;
  chapterTitle?: string;
  pageIndex: number;
  paragraphIndex: number;
  url?: string;
  updatedAt: number;
}

export interface BookSummary {
  id: string;
  title: string;
  author: string;
  hasCover: boolean;
  addedAt: number;
  readAt?: number;
  position?: ReadingPosition;
  /** Chapters with a link in the catalog. */
  chapters: number;
  /** Chapters whose audio matches the current voice. */
  audioChapters: number;
  /** Chapter index (0-based, among linked chapters) of the reading position. */
  readIndex?: number;
  activeJobs: number;
  follow: boolean;
  ahead: number;
  audioBytes: number;
  /** Chapters whose whole text is saved in the library. */
  textChapters: number;
  /** Their Markdown and illustrations. */
  textBytes: number;
  /** The catalog is being fetched from the site. */
  loading?: boolean;
  /** Why the last catalog fetch failed. */
  loadError?: string;
}

export type ChapterAudioState = "none" | "stale" | "queued" | "running" | "done" | "failed";
/** done: the whole text is saved in the library; partial: only what the site sent (incomplete). */
export type ChapterTextState = "none" | "partial" | "queued" | "running" | "done" | "failed";

export interface ChapterInfo {
  chapterId?: string;
  title: string;
  audio: ChapterAudioState;
  /** Percent done while running. */
  progress?: number;
  message?: string;
  duration?: number;
  bytes?: number;
  jobId?: number;
  /** Nothing to read aloud (illustrations only). */
  silent?: boolean;
  /** Site pages of this chapter cached on the server. */
  pages?: number;
  /** One of them is only the start the site sent (see PageContent.incomplete). */
  incomplete?: boolean;
  /** The text in the library (downloaded like audio is generated). */
  text: ChapterTextState;
  textMessage?: string;
  textJobId?: number;
  /** Markdown and illustrations in the library. */
  textBytes?: number;
}

/** A chapter's speech segments in one voice (each is one request). */
export interface ChapterSegments {
  provider: PageProvider;
  /** Profile id of the voice shown. */
  voice: string;
  /** Voices with segments of this chapter, and the current one. */
  voices: { id: string; label: string; current: boolean; ready: number }[];
  /** False while pages are still being fetched: more segments will follow. */
  complete: boolean;
  segments: { key: string; text: string; chars: number; ready: boolean }[];
}

/** A chapter's audio as one track (see src/speech/PageSpeechEngine ChapterTimeline); null until all of it is stored. */
export interface TimelineResult {
  timeline: ChapterTimeline | null;
}

export interface VolumeInfo {
  title: string;
  chapters: ChapterInfo[];
  /** The catalog shows a cover for this volume (`/api/books/:id/volumes/:vi/cover`). */
  cover?: boolean;
  /** Ready export (m4b) of the volume, if any; `stale` once a chapter changed after it was made. */
  export?: { bytes: number; createdAt: number; stale: boolean };
  exportJob?: { status: JobStatus; progress: number; message?: string };
}

export interface BookDetail extends BookSummary {
  intro: string;
  sourceUrl: string;
  catalogAt?: number;
  volumes: VolumeInfo[];
  profile?: VoiceProfile;
  /** Readable name of the profile's voice. */
  profileLabel?: string;
}

/** Audio of a book in one voice (segments and assembled chapters). */
export interface BookVoice extends VoiceProfile {
  /** Profile id: chapters' audio and segments are kept per id. */
  id: string;
  label: string;
  current: boolean;
  /** False when its settings are no longer known (a Gemini style changed since). */
  switchable: boolean;
  segments: number;
  bytes: number;
  /** Chapters with every segment generated. */
  chapters: number;
  /** Chapters with some segments generated. */
  partial: number;
  /** Assembled chapter files in this voice. */
  chapterFiles: number;
}

export interface BookVoices {
  voices: BookVoice[];
  /** Chapters with segments in any voice. */
  chapters: string[];
}

export interface ServerSettings {
  siteOrigin: string;
  /** Sent with site requests (e.g. `cf_clearance=…`), to pass a bot check solved in a browser. */
  cookie: string;
  userAgent: string;
  flaresolverrUrl: string;
  /** Minimum gap between two site requests. */
  requestIntervalMs: number;
  /** Chapters generated ahead of the reading position (default for new books). */
  defaultAhead: number;
  storageTemplate: string;
  /** Write-only on PUT; GET says whether a key is set. */
  keys: Partial<Record<PageProvider, boolean>>;
}

export interface ServerSettingsUpdate extends Partial<Omit<ServerSettings, "keys">> {
  /** New keys ("" clears). */
  keys?: Partial<Record<PageProvider, string>>;
}

export interface ProviderBlock {
  code: string;
  message: string;
  since: number;
}

export interface JobsOverview {
  paused: boolean;
  blocked: Partial<Record<PageProvider, ProviderBlock>>;
  jobs: JobInfo[];
  counts: Record<JobStatus, number>;
}

export interface LibraryStats {
  books: number;
  chapterFiles: number;
  libraryBytes: number;
  /** Chapter texts (.txt) in the library. */
  textFiles: number;
  textBytes: number;
  segmentFiles: number;
  segmentBytes: number;
  cacheBytes: number;
  libraryDir: string;
  ffmpeg: boolean;
}

export interface RescanResult {
  checked: number;
  missing: number;
  moved: number;
  /** Chapter texts written (new, changed, moved or missing). */
  texts: number;
}

export interface AppInfo {
  version: string;
  auth: boolean;
  loggedIn: boolean;
  ffmpeg: boolean;
  profile?: VoiceProfile;
  /** Site the books come from (for "open the original page"). */
  siteOrigin: string;
}

export type { Catalog };

/** A page the site did not deliver, kept for the settings page's diagnostics (not content). */
export interface SiteFailure {
  at: number;
  url: string;
  /** unavailable: the site's "content failed to load" page; challenge: bot check; fetch: HTTP/network; parse: unexpected page. */
  kind: "unavailable" | "challenge" | "fetch" | "parse";
  message: string;
  status?: number;
  /** What the error page still showed. */
  nav?: ChapterNav;
  excerpt?: string;
  /** Readable characters sent before the notice: only part of the chapter came. */
  partial?: number;
}

/** Result of loading one chapter page without storing it. */
export interface PageProbe {
  ok: boolean;
  url: string;
  ms: number;
  kind?: SiteFailure["kind"];
  error?: string;
  status?: number;
  title?: string;
  paragraphs?: number;
  nav?: ChapterNav;
  excerpt?: string;
  partial?: number;
}


/** `POST /api/books/:id/download`: chapters queued to download their text into the library. */
export interface DownloadResult {
  queued: number;
}

/** `POST /api/books/:id/generate`: chapters queued, and those left out because their text is incomplete. */
export interface GenerateResult {
  queued: number;
  /** Not queued: the site sent only part of their text. Asked again with `partial: true` once the user confirms. */
  incomplete: { chapterId: string; title: string }[];
}
