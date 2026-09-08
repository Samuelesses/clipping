import fs from "fs/promises";
import type { TranscriptSegment } from "./types";

const MAX_TITLE_LENGTH = 70;
// Keep each burned caption card short and punchy - long lines wrap to 3+ lines and can
// grow tall enough to run off the top/bottom of the frame, and short bursts read faster
// on short-form video anyway (closer to how TikTok/Shorts captions are usually cut).
const MAX_WORDS_PER_CAPTION = 5;

interface Cue {
  start: number;
  end: number;
  text: string;
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
 */
export async function writeClipAss(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  canvasWidth: number,
  canvasHeight: number,
  title: string,
  outPath: string,
): Promise<void> {
  const cues: Cue[] = segments
    .filter((s) => s.end > clipStart && s.start < clipEnd)
    .map((s) => ({
      start: Math.max(0, s.start - clipStart),
      end: Math.min(clipEnd - clipStart, s.end - clipStart),
      text: sanitizeAssText(s.text.trim()),
    }))
    .filter((cue) => cue.end > cue.start && cue.text.length > 0)
    .flatMap(splitLongCue);

  const captionFontSize = Math.round(canvasHeight * 0.038);
  const captionMarginV = Math.round(canvasHeight * 0.1);
  const titleFontSize = Math.round(canvasHeight * 0.052);
  const titleMarginV = Math.round(canvasHeight * 0.075);
  const sideMargin = Math.round(canvasWidth * 0.06);

  // Bright gold title (classic high-contrast "clip title" look), clean white captions -
  // both rendered with bundled fonts (see fonts/README.md) so they look the same on
  // every machine instead of falling back to whatever's installed locally.
  const titleColour = "&H0000D7FF";
  const captionColour = "&H00FFFFFF";

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
    `Style: Caption,Montserrat ExtraBold,${captionFontSize},${captionColour},&H000000FF,&H00000000,` +
    `&H00000000,0,0,0,0,100,100,0,0,1,3.5,1.5,2,${sideMargin},${sideMargin},${captionMarginV},1\n` +
    `Style: Title,Anton,${titleFontSize},${titleColour},&H000000FF,&H00000000,&H00000000,0,0,0,0,` +
    `100,100,0,0,1,4.5,2,8,${sideMargin},${sideMargin},${titleMarginV},1\n\n` +
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

  const titleLine = `Dialogue: 0,${formatAssTime(0)},${formatAssTime(clipEnd - clipStart)},Title,,0,0,0,,${truncateTitle(title)}\n`;

  const captionLines = cues
    .map((cue) => `Dialogue: 0,${formatAssTime(cue.start)},${formatAssTime(cue.end)},Caption,,0,0,0,,${cue.text}\n`)
    .join("");

  await fs.writeFile(outPath, header + titleLine + captionLines, "utf8");
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
  return text.replace(/[{}]/g, "").replace(/\\/g, "/");
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
