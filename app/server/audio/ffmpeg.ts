import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

/**
 * Audio processing with ffmpeg: decoding for pause detection, converting
 * Gemini's WAV to MP3, joining a chapter's segments and building M4B books.
 */

export interface ChapterMark {
  title: string;
  /** Seconds. */
  start: number;
  end: number;
}

export interface Tags {
  title?: string;
  album?: string;
  artist?: string;
  track?: string;
  disc?: string;
  genre?: string;
}

function run(cmd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited with ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

const tagArgs = (tags: Tags): string[] =>
  Object.entries(tags).flatMap(([k, v]) => (v ? ["-metadata", `${k}=${v}`] : []));

/** Escapes a value for ffmpeg's FFMETADATA format. */
const metaEscape = (s: string) => s.replace(/[=;#\\\n]/g, (c) => `\\${c}`);

/** ffconcat list entry. */
const concatEntry = (file: string) => `file '${file.replace(/'/g, "'\\''")}'`;

export class Ffmpeg {
  private available?: Promise<boolean>;

  constructor(
    private readonly ffmpeg = "ffmpeg",
    private readonly ffprobe = "ffprobe",
  ) {}

  /** Whether ffmpeg runs (checked once). */
  check(): Promise<boolean> {
    this.available ??= run(this.ffmpeg, ["-hide_banner", "-version"]).then(
      () => true,
      () => false,
    );
    return this.available;
  }

  /** Mono 32-bit float samples at a low rate (enough to find pauses). */
  async decode(data: Buffer, rate = 8000): Promise<{ samples: Float32Array; rate: number }> {
    const raw = await run(
      this.ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"],
      data,
    );
    const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength - (raw.byteLength % 4)));
    return { samples, rate };
  }

  /** Any audio to MP3 (mono, speech bitrate). */
  toMp3(data: Buffer, bitrate = "64k"): Promise<Buffer> {
    return run(
      this.ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-c:a", "libmp3lame", "-b:a", bitrate, "-f", "mp3", "pipe:1"],
      data,
    );
  }

  /** Any image to JPEG (covers: audiobook apps and MP4 cover art want JPEG or PNG). */
  toJpeg(data: Buffer): Promise<Buffer> {
    return run(
      this.ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
      data,
    );
  }

  /** Duration in seconds. */
  async duration(file: string): Promise<number | undefined> {
    try {
      const out = await run(this.ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ]);
      const d = parseFloat(out.toString());
      return Number.isFinite(d) ? d : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Joins MP3 files into `out` with tags. Copies the streams when possible
   * (segments from one service share a format), re-encodes otherwise.
   */
  async concatMp3(files: string[], out: string, tags: Tags, listFile: string): Promise<void> {
    await writeFile(listFile, `ffconcat version 1.0\n${files.map(concatEntry).join("\n")}\n`);
    const base = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile];
    const meta = [...tagArgs(tags), "-id3v2_version", "3", "-write_xing", "1"];
    try {
      await run(this.ffmpeg, [...base, "-map", "0:a", "-c", "copy", ...meta, "-f", "mp3", out]);
    } catch {
      await run(this.ffmpeg, [...base, "-map", "0:a", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", ...meta, "-f", "mp3", out]);
    }
  }

  /** An M4B audiobook (AAC) from chapter files, with chapter marks and an optional cover. */
  async m4b(
    files: string[],
    chapters: ChapterMark[],
    out: string,
    tags: Tags,
    work: { list: string; meta: string },
    cover?: string,
  ): Promise<void> {
    await writeFile(work.list, `ffconcat version 1.0\n${files.map(concatEntry).join("\n")}\n`);
    const lines = [";FFMETADATA1"];
    for (const [k, v] of Object.entries(tags)) if (v) lines.push(`${k}=${metaEscape(v)}`);
    for (const c of chapters) {
      lines.push(
        "[CHAPTER]",
        "TIMEBASE=1/1000",
        `START=${Math.round(c.start * 1000)}`,
        `END=${Math.round(c.end * 1000)}`,
        `title=${metaEscape(c.title)}`,
      );
    }
    await writeFile(work.meta, `${lines.join("\n")}\n`);
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", work.list, "-i", work.meta];
    if (cover) args.push("-i", cover);
    args.push("-map", "0:a", "-map_metadata", "1", "-map_chapters", "1");
    if (cover) args.push("-map", "2:v", "-c:v", "copy", "-disposition:v:0", "attached_pic");
    args.push("-ac", "1", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-f", "mp4", out);
    await run(this.ffmpeg, args);
  }
}
