import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { run } from "./exec";
import type { ReframeStyle } from "./types";

// Bundled fonts (see fonts/README.md) so burned-in text looks the same on every
// machine, regardless of what's installed locally - see lib/subtitles.ts for the
// style names ("Anton", "Montserrat ExtraBold") that reference these files.
const FONTS_DIR = path.join(process.cwd(), "fonts");

/**
 * Moves a finished file into place, tolerating a cross-device move (EXDEV, e.g. system
 * temp dir and destination on different volumes) by copying + removing the source
 * instead. The final step is always a same-directory rename (always atomic on every
 * filesystem), so a client reading the destination path mid-move never sees a partial
 * file - it sees either the old file or the fully-written new one.
 */
async function moveFileInto(fromPath: string, finalPath: string): Promise<void> {
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const stagingPath = path.join(path.dirname(finalPath), `.staging-${randomUUID()}-${path.basename(finalPath)}`);
  try {
    await fs.rename(fromPath, stagingPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await fs.copyFile(fromPath, stagingPath);
      await fs.rm(fromPath, { force: true });
    } else {
      throw err;
    }
  }
  await fs.rename(stagingPath, finalPath);
}

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

async function hasStreamType(mediaPath: string, streamType: "v" | "a"): Promise<boolean> {
  try {
    const stdout = await run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      streamType,
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      mediaPath,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export function hasVideoStream(mediaPath: string): Promise<boolean> {
  return hasStreamType(mediaPath, "v");
}

export function hasAudioStream(mediaPath: string): Promise<boolean> {
  return hasStreamType(mediaPath, "a");
}

/** Muxes a separate video-only and audio-only file into one, without re-encoding. */
export async function muxVideoAudio(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  // See cutClip's comment below on why this writes to a local temp path rather than
  // directly to outputPath before moving it into place.
  const tmpOutputPath = path.join(os.tmpdir(), `clipping-mux-${randomUUID()}.mp4`);
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    tmpOutputPath,
  ]);
  await moveFileInto(tmpOutputPath, outputPath);
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
  /** Reformat to 9:16 (1080x1920) - good for Shorts/Reels/TikTok. */
  vertical?: boolean;
  /**
   * How to fill the 9:16 frame when `vertical` is set:
   * - "blur" (default): shrink the full frame to fit width, fill the rest with a
   *   blurred copy of itself - nothing is ever cropped out, but there's letterboxing.
   * - "crop": crop straight to a centered 9:16 slice of the original frame - fills
   *   the screen edge-to-edge with no letterboxing, at the cost of cutting off the
   *   left/right edges of the source (a fixed center crop, not subject tracking).
   */
  reframeStyle?: ReframeStyle;
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
    if (options.reframeStyle === "crop") {
      // Centered crop to a 9:16 slice, then scale to the target canvas. Works for any
      // source aspect ratio: crops the sides for wide (e.g. 16:9) sources, or the
      // top/bottom for anything narrower than 9:16.
      filters.push(
        "[0:v]crop=w='if(gt(iw/ih,9/16),ih*9/16,iw)':h='if(gt(iw/ih,9/16),ih,iw*16/9)',scale=1080:1920[vertical]",
      );
    } else {
      filters.push(
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[bg]",
        "[0:v]scale=1080:-2[fg]",
        "[bg][fg]overlay=(W-w)/2:(H-h)/2[vertical]",
      );
    }
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

  // Write to a local system temp path, not outputPath directly, then move the finished
  // file into place. -movflags +faststart needs to reopen the output file after encoding
  // to shift its moov atom to the front for streaming playback - on a cloud-synced
  // folder (e.g. iCloud Drive, which silently syncs anything under ~/Documents by
  // default on macOS) that reopen can fail entirely ("Unable to re-open ... for
  // shifting data", "No such file or directory") if the sync daemon touches the file at
  // the wrong moment, corrupting the whole clip. A plain OS temp dir is never
  // cloud-synced, so the reopen always succeeds there; moveFileInto then relocates the
  // finished file afterward, which is just a rename/copy - no reopen-for-writing needed.
  const tmpOutputPath = path.join(os.tmpdir(), `clipping-cut-${randomUUID()}.mp4`);
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
    tmpOutputPath,
  );

  await run("ffmpeg", args);
  await moveFileInto(tmpOutputPath, outputPath);
}

/** Escapes a path for safe use as an ffmpeg filtergraph argument (e.g. subtitles=<path>). */
function escapeForFilterGraph(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
