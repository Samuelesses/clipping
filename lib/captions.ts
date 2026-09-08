import fs from "fs/promises";
import path from "path";
import { run } from "./exec";
import type { TranscriptSegment } from "./types";

/**
 * Tries to grab YouTube's own subtitles (manually uploaded or auto-generated) via
 * yt-dlp instead of paying for/needing audio transcription. Returns null if the
 * video has no usable captions (e.g. most Twitch VODs), so the caller can fall
 * back to Whisper.
 */
export async function fetchCaptions(url: string, workDir: string): Promise<TranscriptSegment[] | null> {
  const outputTemplate = path.join(workDir, "captions");

  try {
    await run("yt-dlp", [
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "en.*,en",
      "--sub-format",
      "vtt",
      "--no-playlist",
      "-o",
      outputTemplate,
      url,
    ]);
  } catch {
    return null;
  }

  const files = await fs.readdir(workDir).catch(() => [] as string[]);
  const vttFile = files.find((f) => f.startsWith("captions") && f.endsWith(".vtt"));
  if (!vttFile) return null;

  const content = await fs.readFile(path.join(workDir, vttFile), "utf8");
  const segments = parseVtt(content);
  return segments.length > 0 ? segments : null;
}

const TIME_RE =
  /(\d{2}:)?\d{2}:\d{2}\.\d{3}\s*-->\s*(\d{2}:)?\d{2}:\d{2}\.\d{3}/;

export function parseVtt(content: string): TranscriptSegment[] {
  const lines = content.split(/\r?\n/);
  const rawCues: { start: number; end: number; text: string }[] = [];

  let i = 0;
  while (i < lines.length) {
    if (TIME_RE.test(lines[i])) {
      const [startStr, endStr] = lines[i].split("-->").map((s) => s.trim().split(" ")[0]);
      const start = parseVttTime(startStr);
      const end = parseVttTime(endStr);
      i++;
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        textLines.push(cleanCueText(lines[i]));
        i++;
      }
      const text = textLines.join(" ").replace(/\s+/g, " ").trim();
      if (text) rawCues.push({ start, end, text });
    } else {
      i++;
    }
  }

  // YouTube's auto-captions use a rolling 2-line window: each cue repeats the
  // tail of the previous cue plus a few new words. Diff consecutive cues at the
  // word level and keep only the newly-added words, so the transcript doesn't
  // contain the same phrases over and over.
  const segments: TranscriptSegment[] = [];
  let previousWords: string[] = [];
  for (const cue of rawCues) {
    const words = cue.text.split(/\s+/).filter(Boolean);
    const overlap = wordOverlap(previousWords, words);
    const incremental = words.slice(overlap).join(" ");
    previousWords = words;
    if (incremental) {
      segments.push({ start: cue.start, end: cue.end, text: incremental });
    }
  }
  return segments;
}

/** Length of the longest suffix of `prev` that matches a prefix of `curr`. */
function wordOverlap(prev: string[], curr: string[]): number {
  const maxLen = Math.min(prev.length, curr.length);
  for (let len = maxLen; len > 0; len--) {
    if (prev.slice(prev.length - len).join(" ") === curr.slice(0, len).join(" ")) {
      return len;
    }
  }
  return 0;
}

function cleanCueText(line: string): string {
  return decodeHtmlEntities(
    line.replace(/<[^>]+>/g, ""), // inline timing/style tags in auto-subs, e.g. <00:00:01.240><c>
  ).trim();
}

// WebVTT cues are HTML-escaped, so things like speaker-change markers show up as
// literal "&gt;&gt;" instead of ">>" unless unescaped. &amp; is decoded last so an
// already-escaped "&amp;gt;" (a literal "&gt;" in the original text) doesn't get
// double-unescaped into ">".
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

export function parseVttTime(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
  }
  const [m, s] = parts;
  return m * 60 + s;
}
