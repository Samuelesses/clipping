import { execFile } from "child_process";
import { promisify } from "util";
import { NonRetryableError } from "./retry";

const execFileAsync = promisify(execFile);

const LARGE_BUFFER = 1024 * 1024 * 100;

// YouTube sometimes challenges yt-dlp with a bot check - especially common from a
// server/VM IP, but it can happen on a home connection too depending on the video.
// Retrying doesn't help (it'll fail the same way every time), so this is surfaced as a
// NonRetryableError with a pointer to the actual fix (authenticate yt-dlp with cookies)
// instead of burning through withRetry's attempts first.
const YOUTUBE_BOT_CHECK_RE = /sign in to confirm you.?re not a bot/i;

export async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      maxBuffer: LARGE_BUFFER,
    });
    return stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prefix = `${command} ${args[0] ?? ""} failed`;

    if (command === "yt-dlp" && YOUTUBE_BOT_CHECK_RE.test(message)) {
      throw new NonRetryableError(
        `${prefix}: YouTube is asking to verify you're not a bot (this happens especially often from a ` +
          "server/VM IP, but can happen on any connection depending on the video). Fix: authenticate yt-dlp " +
          "with cookies from a browser you're logged into YouTube with - set YTDLP_COOKIES_FROM_BROWSER=chrome " +
          "(or firefox/edge/safari/etc) in .env.local, or export a cookies.txt and set " +
          "YTDLP_COOKIES_FILE=/path/to/cookies.txt. Then restart the app. See " +
          "https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp for details.",
      );
    }

    throw new Error(`${prefix}: ${message}`);
  }
}

export async function checkDependency(command: string, versionFlag: string, installHint: string): Promise<void> {
  try {
    await execFileAsync(command, [versionFlag]);
  } catch {
    throw new Error(`Required tool "${command}" was not found on your PATH. ${installHint}`);
  }
}
