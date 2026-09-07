import fs from "fs/promises";
import path from "path";
import { checkDependency, run } from "./exec";
import type { VideoInfo } from "./types";

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
  const stdout = await run("yt-dlp", ["-J", "--no-playlist", url]);
  const data = JSON.parse(stdout);
  const title = typeof data.title === "string" ? data.title : "Untitled video";
  const duration = typeof data.duration === "number" ? data.duration : 0;
  if (!duration) {
    throw new Error("Could not determine the video's duration - is this a live/in-progress stream?");
  }
  return { title, duration };
}

export async function downloadVideo(url: string, workDir: string): Promise<string> {
  const outputTemplate = path.join(workDir, "source.%(ext)s");
  await run("yt-dlp", [
    "-f",
    "bv*[height<=1080]+ba/b[height<=1080]/b",
    "--merge-output-format",
    "mp4",
    "--no-playlist",
    "-o",
    outputTemplate,
    url,
  ]);
  const files = await fs.readdir(workDir);
  const video = files.find((f) => f.startsWith("source."));
  if (!video) {
    throw new Error("yt-dlp finished but no output file was found in the working directory.");
  }
  return path.join(workDir, video);
}
