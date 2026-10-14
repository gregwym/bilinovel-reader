/**
 * Types exchanged between the library server and its web app.
 */

import type { Catalog } from "../../src/adapters/types";

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
export type JobKind = "chapter" | "export";
/** Why a chapter was queued: following the reading position, or asked for. */
export type JobReason = "follow" | "manual";

export interface JobInfo {
  id: number;
  kind: JobKind;
  bookId: string;
  bookTitle: string;
  /** Chapter id, or the volume index for an export. */
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
  /** The catalog is being fetched from the site. */
  loading?: boolean;
  /** Why the last catalog fetch failed. */
  loadError?: string;
}

export type ChapterAudioState = "none" | "stale" | "queued" | "running" | "done" | "failed";

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

export interface VolumeInfo {
  title: string;
  chapters: ChapterInfo[];
  /** Ready export (m4b) of the volume, if any. */
  export?: { bytes: number; createdAt: number };
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
