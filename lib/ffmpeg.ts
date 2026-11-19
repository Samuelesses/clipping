import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { run } from "./exec";
import type { ReframeStyle } from "./types";
import type { KeepRange } from "./pacing";
import type { FacecamBox } from "./facecam";
import { getGtaFontPath } from "./gtaFont";

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

export async function extractAudio(
  videoPath: string,
  workDir: string,
  startSeconds = 0,
  durationSeconds?: number,
): Promise<string> {
  const audioPath = path.join(workDir, "audio.mp3");
  await run("ffmpeg", [
    "-y",
    ...(startSeconds > 0 ? ["-ss", String(startSeconds)] : []),
    "-i",
    videoPath,
    ...(durationSeconds !== undefined ? ["-t", String(durationSeconds)] : []),
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

/** Whether this FFmpeg build can draw GTA titles and fallback captions. */
export async function supportsDrawtext(): Promise<boolean> {
  try {
    const stdout = await run("ffmpeg", ["-hide_banner", "-filters"]);
    return /^\s*\S+\s+drawtext\s+V->V/m.test(stdout);
  } catch {
    return false;
  }
}

export function ffmpegTextInstallMessage(): string {
  return "Your FFmpeg build lacks the drawtext filter needed for GTA-style titles/captions. " +
    "On macOS run `brew install ffmpeg-full`, then restart Clipping. " +
    "Verify with `$(brew --prefix ffmpeg-full)/bin/ffmpeg -hide_banner -filters | grep drawtext`. " +
    "Clipping will automatically use ffmpeg-full when installed.";
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
  /** Pre-rendered GTA hook text on disk, independent of ASS subtitle support. */
  hookTextPath?: string;
  /** Absolute source-video intervals to retain after removing genuinely quiet gaps. */
  keepRanges?: KeepRange[];
  fallbackCaptions?: Array<{ start: number; end: number; textPath: string }>;
  facecam?: FacecamBox | null;
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
  let videoLabel = "[0:v]";
  let audioLabel = "0:a?";

  const ranges = options.keepRanges?.filter(r => r.end > r.start) ?? [];
  if (ranges.length > 1) {
    // Reassemble the exact source intervals before applying the vertical composition.
    // Audio and video must be trimmed with the same timeline or they'll drift apart.
    const sources = ranges.map((_, i) => `[vsrc${i}]`).join("");
    filters.push(`[0:v]split=${ranges.length}${sources}`);
    ranges.forEach((range, i) => {
      const from = Math.max(0, range.start - startSeconds).toFixed(3);
      const to = Math.min(duration, range.end - startSeconds).toFixed(3);
      filters.push(`[vsrc${i}]trim=start=${from}:end=${to},setpts=PTS-STARTPTS[vseg${i}]`);
    });
    filters.push(`${ranges.map((_,i)=>`[vseg${i}]`).join("")}concat=n=${ranges.length}:v=1:a=0[stitchedVideo]`);
    videoLabel = "[stitchedVideo]";

    if (await hasAudioStream(videoPath)) {
      filters.push(`[0:a:0]asplit=${ranges.length}${ranges.map((_,i)=>`[asrc${i}]`).join("")}`);
      ranges.forEach((range, i) => {
        const from = Math.max(0, range.start - startSeconds).toFixed(3);
        const to = Math.min(duration, range.end - startSeconds).toFixed(3);
        filters.push(`[asrc${i}]atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS[aseg${i}]`);
      });
      filters.push(`${ranges.map((_,i)=>`[aseg${i}]`).join("")}concat=n=${ranges.length}:v=0:a=1[stitchedAudio]`);
      audioLabel = "[stitchedAudio]";
    }
  }

  if (options.vertical) {
    if (options.reframeStyle === "gaming") {
      // 1080x1920 portrait layout. All meaningful text stays between y=250..1300
      // and x=100..820, away from TikTok's top bar, right action rail and caption tray.
      // Keep gameplay visible low down, but never position text in the app chrome.
      const cam = options.facecam;
      if (cam) {
        const x = cam.x.toFixed(4), y = cam.y.toFixed(4);
        const w = cam.w.toFixed(4), h = cam.h.toFixed(4);
        const camLeft = cam.x + cam.w / 2 < 0.5;
        // Exclude the source webcam/chat side from the gameplay panel.
        const gameX = camLeft ? Math.min(0.43, cam.x + cam.w + 0.012) : 0;
        const gameWidth = camLeft ? 1-gameX : Math.max(0.55,cam.x-0.012);
        filters.push(
          `${videoLabel}split=3[camSrc][gameSrc][bgSrc]`,
          "[bgSrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=42,eq=brightness=-0.35:saturation=0.7[bg]",
          `[camSrc]crop=w=iw*${w}:h=ih*${h}:x=iw*${x}:y=ih*${y},scale=850:350:force_original_aspect_ratio=increase,crop=850:350[cam]`,
          `[gameSrc]crop=w=iw*${gameWidth.toFixed(4)}:h=ih*0.96:x=iw*${gameX.toFixed(4)}:y=ih*0.02,scale=1080:930:force_original_aspect_ratio=increase,crop=1080:930[game]`,
          "[bg][cam]overlay=65:245:shortest=1[withCam]",
          "[withCam][game]overlay=0:790:shortest=1[stacked]",
          "[stacked]drawbox=x=64:y=601:w=852:h=5:color=0xFFCB87:t=fill[vertical]",
        );
      } else {
        // Never fake a facecam position: if detection isn't confident, show only the game.
        filters.push(
          `${videoLabel}split=2[gameSrc][bgSrc]`,
          "[bgSrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=42,eq=brightness=-0.35:saturation=0.7[bg]",
          "[gameSrc]scale=1080:1280:force_original_aspect_ratio=increase,crop=1080:1280[game]",
          "[bg][game]overlay=0:350:shortest=1[vertical]",
        );
      }
    } else if (options.reframeStyle === "crop") {
      filters.push(
        `${videoLabel}crop=w='if(gt(iw/ih,9/16),ih*9/16,iw)':h='if(gt(iw/ih,9/16),ih,iw*16/9)',scale=1080:1920[vertical]`,
      );
    } else {
      filters.push(
        `${videoLabel}split=2[bgSrc][fgSrc]`,
        "[bgSrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[bg]",
        "[fgSrc]scale=1080:-2[fg]",
        "[bg][fg]overlay=(W-w)/2:(H-h)/2[vertical]",
      );
    }
    videoLabel = "[vertical]";
  }

  if (options.hookTextPath) {
    // drawtext works even if FFmpeg was built without the 'ass' subtitle filter.
    const font = await getGtaFontPath() ?? path.join(FONTS_DIR, "Anton-Regular.ttf");
    filters.push(
      `${videoLabel}drawtext=fontfile='${escapeForFilterGraph(font)}':` +
      `textfile='${escapeForFilterGraph(options.hookTextPath)}':` +
      "fontsize=76:fontcolor=white:borderw=6:bordercolor=black@0.97:" +
      "shadowcolor=black@0.8:shadowx=3:shadowy=4:line_spacing=5:" +
      "x=max(100,(940-text_w)/2):y=650:enable='between(t,0,3)'[titled]",
    );
    videoLabel = "[titled]";
  }

  // A functional caption track for FFmpeg builds that lack the libass/ass filter.
  // Each phrase is shown only for its own interval on the edited timeline.
  if (options.fallbackCaptions?.length) {
    const font = await getGtaFontPath() ?? path.join(FONTS_DIR, "Montserrat-ExtraBold.ttf");
    options.fallbackCaptions.forEach((caption, i) => {
      const from = Math.max(0, caption.start).toFixed(2);
      const to = Math.max(0, caption.end).toFixed(2);
      const color = i % 4 === 0 ? "0xFFCB87" : "white";
      const outLabel = `[fallbackCaption${i}]`;
      filters.push(
        `${videoLabel}drawtext=fontfile='${escapeForFilterGraph(font)}':` +
        `textfile='${escapeForFilterGraph(caption.textPath)}':` +
        `fontsize=60:fontcolor=${color}:borderw=5:bordercolor=black@0.97:` +
        `shadowx=3:shadowy=4:shadowcolor=black@0.8:line_spacing=8:` +
        `x=max(110,(920-text_w)/2):y=1110:enable='between(t,${from},${to})'${outLabel}`,
      );
      videoLabel = outLabel;
    });
  }

  if (options.subtitlesPath) {
    filters.push(
      `${videoLabel}ass=filename='${escapeForFilterGraph(options.subtitlesPath)}':` +
      `fontsdir='${escapeForFilterGraph(FONTS_DIR)}'[captioned]`,
    );
    videoLabel = "[captioned]";
  }

  if (filters.length > 0) {
    args.push("-filter_complex", filters.join(";"), "-map", videoLabel, "-map", audioLabel);
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
