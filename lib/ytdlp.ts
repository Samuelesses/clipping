import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { checkDependency, resolveExecutablePath, run } from "./exec";
import { hasAudioStream, hasVideoStream, muxVideoAudio } from "./ffmpeg";
import type { VideoInfo } from "./types";

// The simplest way to fix YouTube's bot check: just drop a cookies.txt exported from
// your browser (e.g. via the "Get cookies.txt LOCALLY" extension) into the project root
// - no .env.local editing needed. Checked for on every call so it starts working as
// soon as the file appears, without restarting the dev server.
const DEFAULT_COOKIES_FILE = path.join(process.cwd(), "cookies.txt");

/**
 * Cookie args to pass to yt-dlp, if configured. YouTube sometimes requires a signed-in
 * session to serve a video at all (age/region gating, or a bot check on some IPs) - see
 * lib/exec.ts's YOUTUBE_BOT_CHECK_RE handling for the error message pointing here.
 * Checked in order: an explicit YTDLP_COOKIES_FILE, then YTDLP_COOKIES_FROM_BROWSER
 * (read live from an installed browser's profile), then a cookies.txt auto-detected in
 * the project root.
 */
export function cookieArgs(): string[] {
  const cookiesFile = process.env.YTDLP_COOKIES_FILE;
  if (cookiesFile) return ["--cookies", cookiesFile];

  const cookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER;
  if (cookiesFromBrowser) return ["--cookies-from-browser", cookiesFromBrowser];

  if (existsSync(DEFAULT_COOKIES_FILE)) return ["--cookies", DEFAULT_COOKIES_FILE];

  return [];
}

export async function checkDependencies(): Promise<void> {
  await checkDependency(
    "yt-dlp",
    "--version",
    "Install it from https://github.com/yt-dlp/yt-dlp#installation (e.g. `brew install yt-dlp` or `pipx install yt-dlp`).",
  );
  await checkDependency(
    "ffmpeg",
    "-version",
    "Install it from https://ffmpeg.org/download.html (e.g. `brew install ffmpeg`).",
  );
}

function parseDuration(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  if (/^\\d+(?:\\.\\d+)?$/.test(value)) {
    const n = Number(value);
    return n > 0 && Number.isFinite(n) ? n : null;
  }
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  const total = nums.reduce((acc, part) => acc * 60 + part, 0);
  return total > 0 && Number.isFinite(total) ? total : null;
}

export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const stdout = await run("yt-dlp", ["-J", "--no-playlist", ...cookieArgs(), url]);
  const data = JSON.parse(stdout) as Record<string, unknown>;
  const title = typeof data.title === "string" ? data.title : "Untitled video";
  const duration = parseDuration(data.duration) ?? parseDuration(data.duration_string);
  if (duration !== null) return { title, duration };

  // A live broadcast has no fixed end time. Never accidentally try to download
  // an endless recording while the user expects a finite VOD.
  const liveStatus = typeof data.live_status === "string" ? data.live_status : "";
  if (data.is_live === true || liveStatus === "is_live" || liveStatus === "is_upcoming") {
    throw new Error("This link points to a live or upcoming broadcast with no fixed duration. Use its archived VOD link once the stream has ended.");
  }
  throw new Error(
    `yt-dlp did not report a duration for "${title}" (live status: ${liveStatus || "unknown"}). ` +
    "The app needs a known duration to validate the review range. Update yt-dlp with " +
    "`brew upgrade yt-dlp`, then try the archived VOD's direct URL. If the problem continues, " +
    "run `yt-dlp -J --no-playlist VIDEO_URL` in Terminal and check duration, duration_string and live_status."
  );
}

const DOWNLOAD_PERCENT_RE = /\[download\]\s+(\d+(?:\.\d+)?)%/;

export async function downloadVideo(
  url: string,
  workDir: string,
  onProgress?: (percent: number) => void,
): Promise<string> {
  const outputTemplate = path.join(workDir, "source.%(ext)s");

  // yt-dlp does its own search for ffmpeg to merge separately-downloaded video and
  // audio into one file, and that search can fail even when ffmpeg is perfectly
  // reachable on PATH for this process (common for GUI-launched dev servers with a
  // trimmed PATH) - being explicit here means merging isn't left to chance.
  const ffmpegPath = await resolveExecutablePath("ffmpeg");

  // yt-dlp normally overwrites its progress line in place with carriage returns;
  // --newline makes it print one line per update instead, which is what makes parsing
  // it out of a stdout stream straightforward. Lines can still arrive split across
  // chunks, so buffer up to the last newline and only parse complete lines.
  let buffer = "";
  await run(
    "yt-dlp",
    [
      "-f",
      "bv*[height<=1080]+ba/b[height<=1080]/b",
      "--merge-output-format",
      "mp4",
      "--no-playlist",
      "--newline",
      ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
      ...cookieArgs(),
      "-o",
      outputTemplate,
      url,
    ],
    {
      onStdout: (chunk) => {
        if (!onProgress) return;
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = line.match(DOWNLOAD_PERCENT_RE);
          if (match) onProgress(parseFloat(match[1]));
        }
      },
    },
  );

  return resolveDownloadedFile(workDir);
}

/**
 * Picks out the file yt-dlp just downloaded to workDir. Usually there's exactly one
 * ("source.mp4") - yt-dlp merged video+audio as asked. But if merging failed for any
 * reason (its own ffmpeg detection, a codec mismatch, etc.) it silently leaves the
 * separate video-only and audio-only streams instead, each suffixed with a format id
 * (e.g. "source.f137.mp4" + "source.f251.webm") - picking either one alone by name is
 * wrong (naively grabbing "whichever file exists" can and did pick the audio-only file,
 * producing an unplayable-as-video output). Detect that case by content (via ffprobe,
 * not filename) and mux them into a proper merged file instead of guessing.
 */
export async function resolveDownloadedFile(workDir: string): Promise<string> {
  const files = (await fs.readdir(workDir)).filter(
    (f) => f.startsWith("source.") && !f.endsWith(".part") && !f.endsWith(".ytdl"),
  );
  if (files.length === 0) {
    throw new Error("yt-dlp finished but no output file was found in the working directory.");
  }
  if (files.length === 1) {
    return path.join(workDir, files[0]);
  }

  const candidates = await Promise.all(
    files.map(async (f) => {
      const full = path.join(workDir, f);
      const [video, audio] = await Promise.all([hasVideoStream(full), hasAudioStream(full)]);
      return { path: full, video, audio };
    }),
  );

  const alreadyMerged = candidates.find((c) => c.video && c.audio);
  if (alreadyMerged) {
    return alreadyMerged.path;
  }

  const videoOnly = candidates.find((c) => c.video && !c.audio);
  const audioOnly = candidates.find((c) => c.audio && !c.video);
  if (videoOnly && audioOnly) {
    const mergedPath = path.join(workDir, "source.merged.mp4");
    await muxVideoAudio(videoOnly.path, audioOnly.path, mergedPath);
    await Promise.all(files.map((f) => fs.rm(path.join(workDir, f), { force: true })));
    const finalPath = path.join(workDir, "source.mp4");
    await fs.rename(mergedPath, finalPath);
    return finalPath;
  }

  throw new Error(
    "yt-dlp downloaded multiple files but none of them is a usable merged video - " +
      `found: ${files.join(", ")}. This usually means yt-dlp couldn't find ffmpeg to merge ` +
      "separately-downloaded video and audio streams; make sure ffmpeg is on your PATH.",
  );
}
