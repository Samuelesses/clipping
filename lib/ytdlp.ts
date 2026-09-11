import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { checkDependency, run } from "./exec";
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

export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const stdout = await run("yt-dlp", ["-J", "--no-playlist", ...cookieArgs(), url]);
  const data = JSON.parse(stdout);
  const title = typeof data.title === "string" ? data.title : "Untitled video";
  const duration = typeof data.duration === "number" ? data.duration : 0;
  if (!duration) {
    throw new Error("Could not determine the video's duration - is this a live/in-progress stream?");
  }
  return { title, duration };
}

const DOWNLOAD_PERCENT_RE = /\[download\]\s+(\d+(?:\.\d+)?)%/;

export async function downloadVideo(
  url: string,
  workDir: string,
  onProgress?: (percent: number) => void,
): Promise<string> {
  const outputTemplate = path.join(workDir, "source.%(ext)s");

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

  const files = await fs.readdir(workDir);
  const video = files.find((f) => f.startsWith("source."));
  if (!video) {
    throw new Error("yt-dlp finished but no output file was found in the working directory.");
  }
  return path.join(workDir, video);
}
