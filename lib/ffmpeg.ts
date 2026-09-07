import fs from "fs/promises";
import path from "path";
import { run } from "./exec";

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

export async function cutClip(
  videoPath: string,
  outputPath: string,
  startSeconds: number,
  endSeconds: number,
): Promise<void> {
  const duration = Math.max(0.5, endSeconds - startSeconds);
  await run("ffmpeg", [
    "-y",
    "-ss",
    String(Math.max(0, startSeconds)),
    "-i",
    videoPath,
    "-t",
    String(duration),
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
  ]);
}
