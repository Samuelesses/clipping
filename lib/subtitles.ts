import fs from "fs/promises";
import { getGtaFontPath } from "./gtaFont";
import type { TranscriptSegment } from "./types";

const MAX_TITLE_LENGTH = 70;
// Keep each burned caption card short and punchy - long lines wrap to 3+ lines and can
// grow tall enough to run off the top/bottom of the frame, and short bursts read faster
// on short-form video anyway (closer to how TikTok/Shorts captions are usually cut).
const MAX_WORDS_PER_CAPTION = 4;
const MAX_CAPTION_CHARACTERS = 24;

interface Cue {
  start: number;
  end: number;
  text: string;
}

interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/**
 * Writes an ASS (Advanced SubStation Alpha) caption file for a single clip: a bottom
 * caption track built from the transcript, plus a title burned in at the top for the
 * whole clip. Transcript timestamps are re-based relative to the clip's own start
 * (t=0 at the clip's first frame). ASS is used instead of SRT because it lets us pin
 * PlayResX/PlayResY and style blocks directly - ffmpeg's SRT-to-ASS auto-conversion
 * (via the `subtitles` filter) assumes a fixed 384x288 canvas and silently
 * mis-scales/mis-positions text on anything else, which is exactly wrong for a
 * 1080x1920 vertical clip.
 *
 * When `animated` is true and word-level timestamps are available (see
 * TranscriptSegment.words), captions render word-by-word: one word at a time pops
 * into an accent color as it's spoken, in the context of the rest of its caption
 * card - otherwise (or wherever word timing isn't available) captions fall back to a
 * plain static line per card.
 */
export async function writeClipAss(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  canvasWidth: number,
  canvasHeight: number,
  title: string,
  outPath: string,
  videoBottomY: number | null = null,
  animated = false,
  gtaMode = false,
): Promise<void> {
  const gtaFont = gtaMode ? await getGtaFontPath() : null;
  const captionFontName = gtaFont ? "Pricedown" : "Montserrat ExtraBold";
  const captionFontSize = Math.round(canvasHeight * (gtaMode ? 0.042 : 0.038));
  const titleFontSize = Math.round(canvasHeight * 0.062);
  const titleMarginV = Math.round(canvasHeight * 0.09);
  const sideMargin = gtaMode ? 140 : Math.round(canvasWidth * 0.06);
  const rightMargin = gtaMode ? 205 : sideMargin;

  // When we know where the actual video content ends (vertical mode, where the sharp
  // foreground video sits centered over a blurred fill), anchor captions just under it
  // instead of near the bottom of the whole canvas - otherwise they end up stranded
  // deep in the blurred padding, disconnected from the video itself. Alignment 8
  // (top-center) + MarginV-from-top does that: text starts right below the video and
  // grows downward. Clamp so a near-full-height video (little/no padding) still leaves
  // room for the text instead of pushing it off-screen.
  const captionGap = Math.round(canvasHeight * 0.02);
  const maxCaptionMarginV = canvasHeight - Math.round(captionFontSize * 2.6);
  const captionAlignment = gtaMode ? 8 : (videoBottomY !== null ? 8 : 2);
  const captionMarginV = gtaMode ? 1285 :
    videoBottomY !== null ? Math.min(videoBottomY + captionGap, maxCaptionMarginV) : Math.round(canvasHeight * 0.1);

  // Bright gold title (classic high-contrast "clip title" look), clean white captions -
  // both rendered with bundled fonts (see fonts/README.md) so they look the same on
  // every machine instead of falling back to whatever's installed locally.
  const titleColour = "&H0000D7FF";
  const captionColour = "&H00FFFFFF";
  // Same gold as the title, but as a bare BGR inline override (no alpha byte) for the
  // \c tag used to pop the currently-spoken word in animated captions.
  const highlightInline = "&H00C7FF&";

  const header =
    "[Script Info]\n" +
    "ScriptType: v4.00+\n" +
    `PlayResX: ${canvasWidth}\n` +
    `PlayResY: ${canvasHeight}\n` +
    // Smart wrapping (evenly split, auto-wraps within MarginL/MarginR) - required so a
    // longer title or caption wraps safely instead of overflowing off-screen.
    "WrapStyle: 0\n" +
    "ScaledBorderAndShadow: yes\n\n" +
    "[V4+ Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, " +
    "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, " +
    "Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    `Style: Caption,${captionFontName},${captionFontSize},${captionColour},&H000000FF,&H00000000,` +
    `&H00000000,1,0,0,0,100,100,0,0,1,5,2,${captionAlignment},${sideMargin},${rightMargin},${captionMarginV},1\n` +
    `Style: Title,Anton,${titleFontSize},${titleColour},&H000000FF,&H00000000,&H00000000,0,0,0,0,` +
    `100,100,0,0,1,4.5,2,8,${sideMargin},${sideMargin},${titleMarginV},1\n\n` +
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

  // Show the title briefly so it does not obscure the gameplay payoff.
  const titleSeconds = Math.min(4.5, Math.max(0.5, clipEnd - clipStart));
  const titleLine = gtaMode ? "" : `Dialogue: 0,${formatAssTime(0)},${formatAssTime(titleSeconds)},Title,,0,0,0,,${truncateTitle(title)}\n`;

  const wordChunks = animated ? buildWordChunks(segments, clipStart, clipEnd) : null;
  const captionLines = wordChunks
    ? wordChunks.flatMap((chunk) => buildAnimatedDialogueLines(chunk, highlightInline)).join("\n") +
      (wordChunks.length > 0 ? "\n" : "")
    : buildPlainCaptionCues(segments, clipStart, clipEnd)
        .map((cue) => `Dialogue: 0,${formatAssTime(cue.start)},${formatAssTime(cue.end)},Caption,,0,0,0,,${cue.text}\n`)
        .join("");

  await fs.writeFile(outPath, header + titleLine + captionLines, "utf8");
}

function buildPlainCaptionCues(segments: TranscriptSegment[], clipStart: number, clipEnd: number): Cue[] {
  return segments
    .filter((s) => s.end > clipStart && s.start < clipEnd)
    .map((s) => ({
      start: Math.max(0, s.start - clipStart),
      end: Math.min(clipEnd - clipStart, s.end - clipStart),
      text: sanitizeAssText(s.text.trim()),
    }))
    .filter((cue) => cue.end > cue.start && cue.text.length > 0)
    .flatMap(splitLongCue);
}

/**
 * GTA dialogue cards: no arbitrary 5-word breaks. Split at real pauses and sentence
 * endings, limit physical width, then render a stable card while the active word turns
 * gold. When external captions have segment timing but no word timings, interpolate
 * the words across that segment so the whole clip still gets karaoke highlighting.
 * Interpolated timings are approximate (no forced alignment is performed).
 */
function buildWordChunks(segments: TranscriptSegment[], clipStart: number, clipEnd: number): TimedWord[][] | null {
  const relevant = segments.filter(s => s.end > clipStart && s.start < clipEnd);
  if (!relevant.length) return null;

  const flatWords: TimedWord[] = [];
  for (const segment of relevant) {
    const rawWords = segment.words?.length ? segment.words : null;
    const words = rawWords
      ? rawWords.map((word, index) => ({
          text: word.text,
          start: word.start,
          end: index + 1 < rawWords.length ? rawWords[index + 1].start : segment.end,
        }))
      : (() => {
          const tokens = sanitizeAssText(segment.text).split(/\s+/).filter(Boolean);
          if (!tokens.length) return [];
          const totalWeight = tokens.reduce((sum, word) => sum + Math.max(2, word.length), 0);
          let weightedStart = 0;
          return tokens.map(word => {
            const from = weightedStart;
            weightedStart += Math.max(2, word.length);
            const span = Math.max(0.1, segment.end - segment.start);
            return {
              text: word,
              start: segment.start + span * from / totalWeight,
              end: segment.start + span * weightedStart / totalWeight,
            };
          });
        })();
    for (const word of words) {
      const text = sanitizeAssText(word.text).replace(/^>>\s*/, "");
      if (!text || word.end <= clipStart || word.start >= clipEnd) continue;
      flatWords.push({
        text,
        start: Math.max(0, word.start - clipStart),
        end: Math.min(clipEnd - clipStart, word.end - clipStart),
      });
    }
  }
  if (!flatWords.length) return null;
  flatWords.sort((a, b) => a.start - b.start);

  const chunks: TimedWord[][] = [];
  let current: TimedWord[] = [];
  const flush = () => { if (current.length) chunks.push(current); current = []; };
  for (const word of flatWords) {
    const prior = current[current.length - 1];
    const pause = prior ? word.start - prior.end : 0;
    const length = [...current.map(item => item.text), word.text].join(" ").length;
    const phraseTime = current.length ? word.end - current[0].start : 0;
    if (current.length && (pause >= 0.38 || current.length >= MAX_WORDS_PER_CAPTION ||
        length > MAX_CAPTION_CHARACTERS || phraseTime > 2.5)) flush();
    current.push(word);
    if (/[.!?]$/.test(word.text)) flush();
  }
  flush();
  return chunks;
}

/** One Dialogue line per word in the chunk, each showing the full chunk text with just
 * that word popped into the highlight color for its own [start, end) - the classic
 * "current word highlighted" short-form caption style. */
function buildAnimatedDialogueLines(chunk: TimedWord[], highlightInline: string): string[] {
  return chunk.map((word, i) => {
    const before = chunk
      .slice(0, i)
      .map((w) => w.text)
      .join(" ");
    const after = chunk
      .slice(i + 1)
      .map((w) => w.text)
      .join(" ");
    const highlighted = `{\\c${highlightInline}}${word.text}{\\c}`;
    const text = [before, highlighted, after].filter(Boolean).join(" ");
    return `Dialogue: 0,${formatAssTime(word.start)},${formatAssTime(word.end)},Caption,,0,0,0,,${text}`;
  });
}

function splitLongCue(cue: Cue): Cue[] {
  const words = cue.text.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_WORDS_PER_CAPTION) return [cue];

  const chunks: string[][] = [];
  for (let i = 0; i < words.length; i += MAX_WORDS_PER_CAPTION) {
    chunks.push(words.slice(i, i + MAX_WORDS_PER_CAPTION));
  }

  const duration = cue.end - cue.start;
  return chunks.map((chunkWords, i) => ({
    start: cue.start + (duration * i) / chunks.length,
    end: cue.start + (duration * (i + 1)) / chunks.length,
    text: chunkWords.join(" "),
  }));
}

function truncateTitle(title: string): string {
  const text = sanitizeAssText(title.trim());
  if (text.length <= MAX_TITLE_LENGTH) return text;
  return `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function sanitizeAssText(text: string): string {
  // Curly braces and backslashes are ASS override-tag syntax - strip them so
  // transcript text can never be (mis)interpreted as formatting commands.
  return text.replace(/[{}]/g, "").replace(/\\/g, "/")
    .replace(/^(?:\s*>>\s*)+/, "").replace(/\s+/g, " ").trim();
}

function formatAssTime(totalSeconds: number): string {
  const totalCentis = Math.max(0, Math.round(totalSeconds * 100));
  const hours = Math.floor(totalCentis / 360_000);
  const minutes = Math.floor((totalCentis % 360_000) / 6_000);
  const seconds = Math.floor((totalCentis % 6_000) / 100);
  const centis = totalCentis % 100;
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
}

/** Balance a persistent GTA title into two visually similar, readable lines. */
export async function writeGtaHookText(title: string, outPath: string): Promise<void> {
  const cleaned = title.toUpperCase()
    .normalize("NFKD").replace(/[^A-Z0-9?!'& -]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 44) || "GTA MOMENT";
  const words = cleaned.split(" ");
  if (words.length === 1) {
    await fs.writeFile(outPath, cleaned, "utf8");
    return;
  }
  let best: string[] = [cleaned];
  let score = Infinity;
  for (let i = 1; i < words.length; i++) {
    const first = words.slice(0, i).join(" ");
    const second = words.slice(i).join(" ");
    if (first.length > 19 || second.length > 19) continue;
    // Avoid one-word orphan lines and prefer roughly even line lengths.
    const imbalance = Math.abs(first.length - second.length);
    const orphan = Math.min(i, words.length - i) === 1 ? 7 : 0;
    const candidate = imbalance + orphan;
    if (candidate < score) { score = candidate; best = [first, second]; }
  }
  if (best.length === 1) {
    // Oversized headlines are deliberately shortened rather than wrapped into 3+ lines.
    const shorter = words.slice(0, 5);
    const split = Math.max(1, Math.floor(shorter.length / 2));
    best = [shorter.slice(0, split).join(" "), shorter.slice(split).join(" ")];
  }
  await fs.writeFile(outPath, best.filter(Boolean).join("\n"), "utf8");
}

export interface FallbackCaption {
  start: number;
  end: number;
  textPath: string;
}

/**
 * Speech cards rendered by FFmpeg drawtext if libass is unavailable. This is
 * intentionally phrase-at-a-time rather than losing captions entirely.
 */
export async function writeFallbackCaptionCards(
  segments: TranscriptSegment[],
  clipDuration: number,
  outDir: string,
): Promise<FallbackCaption[]> {
  await fs.mkdir(outDir, { recursive: true });
  const raw = buildPlainCaptionCues(segments, 0, clipDuration);
  const cards: FallbackCaption[] = [];
  for (const cue of raw) {
    if (cue.end - cue.start < 0.16) continue;
    const words = cue.text.split(/\s+/).filter(Boolean);
    // Avoid subtitles that overrun the width of the 1080px GTA composition.
    let first = "";
    let second = "";
    for (const word of words) {
      if (!second && (first + " " + word).trim().length <= 16) first = (first + " " + word).trim();
      else second = (second + " " + word).trim();
    }
    const path = outDir + "/caption-" + cards.length + ".txt";
    await fs.writeFile(path, [first, second].filter(Boolean).join("\n"), "utf8");
    cards.push({ start: cue.start, end: cue.end, textPath: path });
  }
  return cards;
}
