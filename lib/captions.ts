import fs from "fs/promises";
import path from "path";
import { run } from "./exec";
import type { TranscriptSegment, TranscriptWord } from "./types";
import { cookieArgs } from "./ytdlp";

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
      ...cookieArgs(),
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

interface RawWord {
  text: string;
  start: number;
}

interface RawCue {
  start: number;
  end: number;
  words: RawWord[];
  /** True if this cue actually carried inline per-word timing (auto-generated
   * captions do, via <00:00:01.240><c> tags; manually-uploaded captions usually
   * don't, in which case every word here just has the cue's own start time). */
  hasWordTiming: boolean;
}

export function parseVtt(content: string): TranscriptSegment[] {
  const lines = content.split(/\r?\n/);
  const rawCues: RawCue[] = [];

  let i = 0;
  while (i < lines.length) {
    if (TIME_RE.test(lines[i])) {
      const [startStr, endStr] = lines[i].split("-->").map((s) => s.trim().split(" ")[0]);
      const start = parseVttTime(startStr);
      const end = parseVttTime(endStr);
      i++;
      const words: RawWord[] = [];
      let hasWordTiming = false;
      while (i < lines.length && lines[i].trim() !== "") {
        const parsed = parseWordsFromLine(lines[i], start);
        words.push(...parsed.words);
        if (parsed.sawTag) hasWordTiming = true;
        i++;
      }
      if (words.length > 0) rawCues.push({ start, end, words, hasWordTiming });
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
    const wordTexts = cue.words.map((w) => w.text);
    const overlap = wordOverlap(previousWords, wordTexts);
    const incremental = cue.words.slice(overlap);
    previousWords = wordTexts;
    if (incremental.length === 0) continue;

    const text = incremental.map((w) => w.text).join(" ");
    const words: TranscriptWord[] | undefined = cue.hasWordTiming
      ? incremental.map((w) => ({ start: w.start, text: w.text }))
      : undefined;

    segments.push({ start: incremental[0].start, end: cue.end, text, words });
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

// Matches either an inline timestamp tag (captured, for timing) or any other tag
// (voice/style/<c> tags etc., stripped with no timing effect).
const INLINE_TAG_RE = /<(\d{2}:\d{2}:\d{2}\.\d{3})>|<[^>]+>/g;

function parseWordsFromLine(line: string, cueStart: number): { words: RawWord[]; sawTag: boolean } {
  const words: RawWord[] = [];
  let currentTime = cueStart;
  let sawTag = false;
  let lastIndex = 0;

  const flushText = (text: string, time: number) => {
    for (const raw of text.split(/\s+/)) {
      const word = decodeHtmlEntities(raw);
      if (word) words.push({ text: word, start: time });
    }
  };

  INLINE_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_TAG_RE.exec(line)) !== null) {
    flushText(line.slice(lastIndex, match.index), currentTime);
    if (match[1]) {
      currentTime = parseVttTime(match[1]);
      sawTag = true;
    }
    lastIndex = INLINE_TAG_RE.lastIndex;
  }
  flushText(line.slice(lastIndex), currentTime);

  return { words, sawTag };
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
