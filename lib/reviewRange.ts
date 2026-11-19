import type { ProcessOptions, TranscriptSegment } from "./types";

/** Resolve source-relative timestamps. End omitted means the rest of the stream. */
export function getReviewWindow(
  options: Pick<ProcessOptions, "reviewStartSeconds" | "reviewEndSeconds">,
  duration: number,
): { start: number; end: number; duration: number } {
  const start = options.reviewStartSeconds ?? 0;
  const requestedEnd = options.reviewEndSeconds ?? duration;
  if (!Number.isFinite(duration) || duration <= 0 ||
      !Number.isFinite(start) || start < 0 ||
      !Number.isFinite(requestedEnd) || requestedEnd <= start ||
      start >= duration) {
    throw new Error("The selected review range is outside this stream. Check your start and end times.");
  }
  // Do not allow accidentally analysing outside the requested range.
  const end = Math.min(duration, requestedEnd);
  return { start, end, duration: end - start };
}

/** Keeps the transcript and word timing aligned with original video time. */
export function restrictTranscript(
  segments: TranscriptSegment[],
  start: number,
  end: number,
): TranscriptSegment[] {
  return segments.filter(s => s.end > start && s.start < end).map(s => ({
    ...s,
    start: Math.max(start, s.start),
    end: Math.min(end, s.end),
    ...(s.words ? { words: s.words.filter(w => w.start >= start && w.start < end) } : {}),
  }));
}
