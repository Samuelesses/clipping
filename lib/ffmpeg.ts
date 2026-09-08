import fs from "fs/promises";
import path from "path";
import { run } from "./exec";

// Bundled fonts (see fonts/README.md) so burned-in text looks the same on every
// machine, regardless of what's installed locally - see lib/subtitles.ts for the
// style names ("Anton", "Montserrat ExtraBold") that reference these files.
const FONTS_DIR = path.join(process.cwd(), "fonts");

export async function extractAudio(videoPath: string, workDir: string): Promise<string> {
  const audioPath = path.join(workDir, "audio.mp3");
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    audioPath,
  ]);
  return audioPath;
}

export async function getMediaDuration(mediaPath: string): Promise<number> {
  const stdout = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    mediaPath,
  ]);
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration)) {
    throw new Error(`Could not determine duration of ${mediaPath}`);
  }
  return duration;
}

/** Whether this ffmpeg build has libass support (required for the `ass` filter used to burn in captions). */
export async function supportsBurnedCaptions(): Promise<boolean> {
  try {
    const stdout = await run("ffmpeg", ["-filters"]);
    return /\bass\s+V->V/.test(stdout);
  } catch {
    return false;
  }
}

export async function getVideoDimensions(videoPath: string): Promise<{ width: number; height: number }> {
  const stdout = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=s=x:p=0",
    videoPath,
  ]);
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) {
    throw new Error(`Could not determine dimensions of ${videoPath}`);
  }
  return { width, height };
}

export interface AudioChunk {
  path: string;
  offsetSeconds: number;
}

export async function splitAudioIntoChunks(
  audioPath: string,
  workDir: string,
  chunkSeconds: number,
): Promise<AudioChunk[]> {
  const chunkDir = path.join(workDir, "audio-chunks");
  await fs.mkdir(chunkDir, { recursive: true });
  const pattern = path.join(chunkDir, "chunk-%03d.mp3");
  await run("ffmpeg", [
    "-y",
    "-i",
    audioPath,
    "-f",
    "segment",
    "-segment_time",
    String(chunkSeconds),
    "-c",
    "copy",
    "-reset_timestamps",
    "1",
    pattern,
  ]);
  const files = (await fs.readdir(chunkDir))
    .filter((f) => f.startsWith("chunk-"))
    .sort();
  return files.map((f, i) => ({
    path: path.join(chunkDir, f),
    offsetSeconds: i * chunkSeconds,
  }));
}

export interface CutClipOptions {
  /** Reformat to 9:16 (1080x1920) with a blurred, filled background - good for Shorts/Reels/TikTok. */
  vertical?: boolean;
  /** Path to an .ass caption file (see lib/subtitles.ts) to burn in as open captions. */
  subtitlesPath?: string;
}

export async function cutClip(
  videoPath: string,
  outputPath: string,
  startSeconds: number,
  endSeconds: number,
  options: CutClipOptions = {},
): Promise<void> {
  const duration = Math.max(0.5, endSeconds - startSeconds);
  const args = ["-y", "-ss", String(Math.max(0, startSeconds)), "-i", videoPath, "-t", String(duration)];

  const filters: string[] = [];
  let videoLabel: string | null = null;

  if (options.vertical) {
    filters.push(
      "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[bg]",
      "[0:v]scale=1080:-2[fg]",
      "[bg][fg]overlay=(W-w)/2:(H-h)/2[vertical]",
    );
    videoLabel = "vertical";
  }

  if (options.subtitlesPath) {
    // Use the `ass` filter (not `subtitles`) - the caption file already carries its own
    // PlayResX/PlayResY and style block (see lib/subtitles.ts), so no force_style/sizing
    // guesswork is needed here and nothing can silently mis-scale on a tall vertical frame.
    // filename= must be named explicitly (not passed as a bare positional value) - newer
    // ffmpeg builds (9.x) reject "ass=/path/to/file" with "No option name near ...".
    const source = videoLabel ? `[${videoLabel}]` : "[0:v]";
    filters.push(
      `${source}ass=filename='${escapeForFilterGraph(options.subtitlesPath)}':` +
        `fontsdir='${escapeForFilterGraph(FONTS_DIR)}'[captioned]`,
    );
    videoLabel = "captioned";
  }

  if (filters.length > 0) {
    args.push("-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`, "-map", "0:a?");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath,
  );

  await run("ffmpeg", args);
}

/** Escapes a path for safe use as an ffmpeg filtergraph argument (e.g. subtitles=<path>). */
function escapeForFilterGraph(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
