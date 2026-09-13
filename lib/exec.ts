import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { NonRetryableError } from "./retry";

const execFileAsync = promisify(execFile);

// YouTube sometimes challenges yt-dlp with a bot check - especially common from a
// server/VM IP, but it can happen on a home connection too depending on the video.
// Retrying doesn't help (it'll fail the same way every time), so this is surfaced as a
// NonRetryableError with a pointer to the actual fix (authenticate yt-dlp with cookies)
// instead of burning through withRetry's attempts first.
const YOUTUBE_BOT_CHECK_RE = /sign in to confirm you.?re not a bot/i;

// ffmpeg's own corruption guard: it aborts a decode once too large a fraction of frames
// error out. Most commonly this is a truncated/incomplete download that still has a
// valid-looking container and stream headers (so it passes a "does this file have a
// video stream" check but falls apart partway through actual frame data) - but it can
// also happen on a perfectly intact file if cutClip's `-ss`-before-`-i` seek lands off a
// real frame boundary in a stream that isn't reliably seekable (some AV1-in-mp4 files;
// see lib/ytdlp.ts's format selection for why downloads now prefer avc1/H.264 instead).
// Either way it's a property of this specific source file, not a transient failure -
// retrying the same cut just fails the same way again, so callers that cut clips need
// to recognize it and re-download instead.
const DECODE_CORRUPTION_RE = /decode error rate .* exceeds maximum/i;

/** Thrown when ffmpeg can't decode enough of a source file to finish a cut - see DECODE_CORRUPTION_RE. */
export class CorruptSourceError extends Error {}

export interface RunOptions {
  /** Called with each raw chunk of stdout as it arrives - not guaranteed to be
   * line-aligned - so a caller can parse live progress out of a long-running command
   * (e.g. yt-dlp's own download percentage) instead of only seeing output at the end. */
  onStdout?: (chunk: string) => void;
}

export async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(buildError(command, args, stderr || err.message));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(buildError(command, args, stderr.trim() || stdout.trim() || `exited with code ${code}`));
      }
    });
  });
}

function buildError(command: string, args: string[], detail: string): Error {
  const prefix = `${command} ${args[0] ?? ""} failed`;

  if (command === "yt-dlp" && YOUTUBE_BOT_CHECK_RE.test(detail)) {
    return new NonRetryableError(
      `${prefix}: YouTube is asking to verify you're not a bot (this happens especially often from a ` +
        "server/VM IP, but can happen on any connection depending on the video). Fix: authenticate yt-dlp " +
        "with cookies from a browser you're logged into YouTube with - set YTDLP_COOKIES_FROM_BROWSER=chrome " +
        "(or firefox/edge/safari/etc) in .env.local, or export a cookies.txt and set " +
        "YTDLP_COOKIES_FILE=/path/to/cookies.txt. Then restart the app. See " +
        "https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp for details.",
    );
  }

  if (command === "ffmpeg" && DECODE_CORRUPTION_RE.test(detail)) {
    return new CorruptSourceError(
      `${prefix}: most of the source video failed to decode cleanly. This is usually an incomplete/truncated ` +
        "download, or an AV1 stream that doesn't seek reliably - not a problem with the clip settings.",
    );
  }

  return new Error(`${prefix}: ${detail}`);
}

export async function checkDependency(command: string, versionFlag: string, installHint: string): Promise<void> {
  try {
    await execFileAsync(command, [versionFlag]);
  } catch {
    throw new Error(`Required tool "${command}" was not found on your PATH. ${installHint}`);
  }
}

/**
 * Resolves the absolute path to a command on PATH, or null if it can't be found. Used to
 * hand yt-dlp an explicit --ffmpeg-location: yt-dlp does its own (occasionally
 * unreliable, especially for GUI-launched processes with a trimmed PATH) search for
 * ffmpeg, and when that fails it silently leaves video+audio unmerged instead of
 * erroring - being explicit avoids relying on yt-dlp's own detection working.
 */
export async function resolveExecutablePath(command: string): Promise<string | null> {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(finder, [command]);
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}
