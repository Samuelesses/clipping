import { run } from "./exec";
import type { TranscriptSegment } from "./types";

/** All times are absolute source-video seconds, so clip review and captions remain aligned. */
export interface KeepRange { start: number; end: number }

/**
 * GTA pacing: remove ONLY genuinely quiet audio stretches inside a selected highlight.
 * A streamer being silent isn't enough: game action, music, engines, gunfire, etc.
 * should remain. Never trim the beginning/end of an event and leave a beat
 * around each cut. If detection fails, keep the original uninterrupted clip.
 */
export async function findPacingRanges(
  videoPath: string,
  clipStart: number,
  clipEnd: number,
): Promise<KeepRange[]> {
  const duration = clipEnd - clipStart;
  if (duration < 14) return [{ start: clipStart, end: clipEnd }];
  const stderr: string[] = [];
  try {
    await run("ffmpeg", [
      "-hide_banner", "-nostats", "-loglevel", "info",
      "-ss", String(clipStart), "-i", videoPath,
      "-t", String(duration), "-vn",
      "-af", "silencedetect=noise=-31dB:d=2.8",
      "-f", "null", "-",
    ], { onStderr: chunk => stderr.push(chunk) });
  } catch {
    return [{ start: clipStart, end: clipEnd }];
  }

  const silenceStarts: number[] = [];
  const cuts: KeepRange[] = [];
  for (const line of stderr.join("").split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([\d.]+)/);
    if (start) silenceStarts.push(Number(start[1]));
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (end && silenceStarts.length) {
      const silenceStart = silenceStarts.shift()!;
      const silenceEnd = Number(end[1]);
      if (!Number.isFinite(silenceEnd) || silenceEnd - silenceStart < 3.3) continue;
      // Keep the final ~4 seconds intact, even in a quiet aftermath.
      const from = Math.max(clipStart + 3, clipStart + silenceStart + 0.45);
      const to = Math.min(clipEnd - 4, clipStart + silenceEnd - 0.35);
      if (to - from >= 1.6) cuts.push({ start: from, end: to });
    }
  }
  cuts.sort((a,b) => a.start - b.start);

  let cursor = clipStart;
  const ranges: KeepRange[] = [];
  for (const cut of cuts) {
    if (cut.start <= cursor || cut.end >= clipEnd) continue;
    if (cut.start - cursor < 0.7) continue;
    ranges.push({ start: cursor, end: cut.start });
    cursor = cut.end;
    if (ranges.length >= 7) break; // Never turn a narrative event into jump-cut noise.
  }
  ranges.push({ start: cursor, end: clipEnd });
  return ranges.length > 1 ? ranges : [{ start: clipStart, end: clipEnd }];
}

/** Map absolute source timestamps to an edited clip timeline. */
export function mapEditedTime(sourceTime: number, ranges: KeepRange[]): number {
  let result = 0;
  for (const range of ranges) {
    if (sourceTime < range.start) return result;
    const inside = Math.min(sourceTime, range.end) - range.start;
    result += Math.max(0, inside);
    if (sourceTime < range.end) return result;
  }
  return result;
}

/** Rebuild word/segment timestamps after excising quiet stretches from the video. */
export function remapTranscript(segments: TranscriptSegment[], ranges: KeepRange[]): TranscriptSegment[] {
  const output: TranscriptSegment[] = [];
  let editedAt = 0;
  for (const range of ranges) {
    const offset = editedAt - range.start;
    for (const segment of segments) {
      if (segment.end <= range.start || segment.start >= range.end) continue;
      const start = Math.max(segment.start, range.start);
      const end = Math.min(segment.end, range.end);
      const words = segment.words?.filter(w => w.start >= start && w.start < end)
        .map(w => ({ ...w, start: w.start + offset }));
      output.push({
        ...segment, start: start + offset, end: end + offset,
        ...(words ? { words } : {}),
      });
    }
    editedAt += range.end - range.start;
  }
  return output;
}
