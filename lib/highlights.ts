import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { HighlightClip, ProcessOptions, TranscriptSegment, VideoInfo } from "./types";

const DEFAULT_MODEL = "gpt-5.1";

const ClipSchema = z.object({
  title: z.string(),
  start: z.number(),
  end: z.number(),
  reason: z.string(),
  socialCaption: z
    .string()
    .describe(
      "A ready-to-post caption for TikTok/Instagram Reels/YouTube Shorts: 1-2 punchy sentences about " +
        "this specific clip, then a line of 3-6 relevant hashtags (topic, game/category, and creator name " +
        "if known). Plain text only, no markdown - it should be copy-pasteable directly into a post.",
    ),
});

const HighlightsSchema = z.object({
  clips: z.array(ClipSchema),
});

function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export async function findHighlights(
  segments: TranscriptSegment[],
  info: VideoInfo,
  options: ProcessOptions,
): Promise<HighlightClip[]> {
  const client = new OpenAI();
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  const transcript = segments
    .map((s) => `[${formatTime(s.start)} - ${formatTime(s.end)}] ${s.text}`)
    .join("\n");

  // Ask for a few extra candidates - overlap dedup below can drop some, and this keeps
  // the final count close to what was actually requested.
  const requestCount = Math.min(options.clipCount + 3, 20);

  const completion = await client.chat.completions.parse({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are an expert short-form video editor. You read transcripts of long-form videos and streams " +
          "and find the moments most likely to work as standalone short clips (e.g. YouTube Shorts, TikTok, " +
          "Twitter clips) - the kind that get shared and go viral. Look for a mix of: \n" +
          "- Funny moments: jokes, punchlines, bits, funny exchanges or reactions\n" +
          "- Highlights: exciting plays, big wins, surprising twists, standout skill\n" +
          "- Emotional peaks: genuine excitement, frustration, shock, or a strong reaction\n" +
          "- Hot takes and drama: a strong opinion, a callout, trash talk, beef with another " +
          "creator, or the streamer saying something blunt/controversial about a person, game, or event\n" +
          "- Self-contained stories: a short anecdote or take that stands on its own\n" +
          "Prioritize whatever is most likely to get clicks and reactions, even if it's blunt, opinionated, " +
          "or dramatic - don't soften or filter out controversial moments, just report them faithfully. " +
          "Each clip must make sense without any extra context and should isolate a single moment rather " +
          "than spanning several unrelated topics. Choose start/end times that land on natural speech " +
          "boundaries - start right as a sentence/thought begins (never mid-sentence or mid-word) and end " +
          "right after a sentence/thought completes, so the clip doesn't feel cut off. The requested " +
          "maximum is a real ceiling, not a loose target: aim to land AT OR UNDER it, and only go over " +
          "by the few seconds truly needed to finish the current sentence or payoff - a couple seconds " +
          "over is normal, going tens of seconds or 50% over is not and must not happen routinely. The " +
          "requested minimum works the other direction: never come in under it - if a moment is " +
          "naturally brief, extend the clip to include surrounding context (reaction, follow-up, related " +
          "back-and-forth) rather than submitting something shorter than the minimum. Within " +
          "[minimum, maximum], shorter is completely fine whenever the moment itself is naturally short - " +
          "a complete, satisfying moment matters more than hitting an exact duration, but that means using " +
          "the room between min and max as needed, not defaulting to the maximum every time. Scan the ENTIRE transcript from start to finish and pick clips spread across " +
          "different moments/timestamps - never pick two clips covering the same or overlapping moment, " +
          "and don't cluster every pick in one section unless the rest of the video genuinely has nothing " +
          "else worth clipping. Aim for variety across the categories above rather than several of the " +
          "same type back to back.",
      },
      {
        role: "user",
        content:
          `Video title: ${info.title}\n` +
          `Video duration: ${formatTime(info.duration)} (${Math.round(info.duration)} seconds)\n\n` +
          `Transcript with timestamps:\n${transcript}\n\n` +
          `Pick ${requestCount} of the best, most engaging, self-contained moments to turn into clips, ` +
          `drawn from different parts of the video. Each clip must be between ${options.minClipSeconds} and ` +
          `${options.maxClipSeconds} seconds - go shorter within that range whenever the moment itself is ` +
          `naturally brief, and treat ${options.maxClipSeconds}s as a hard ceiling you only exceed by a few ` +
          `seconds when truly necessary to avoid cutting off a setup or payoff mid-sentence. ` +
          `Start and end times must be given in seconds, fall within [0, ${Math.round(info.duration)}], and ` +
          `clips must not overlap each other. For each clip also write a ready-to-post social caption with ` +
          `hashtags (see schema). Order the clips from best to worst.`,
      },
    ],
    response_format: zodResponseFormat(HighlightsSchema, "highlights"),
  });

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error("The model did not return a parseable list of clips - try again.");
  }

  const clips = parsed.clips
    .filter((clip) => clip.end > clip.start)
    .map((clip) => {
      const start = Math.max(0, clip.start);
      const end = Math.min(info.duration, clip.end);
      return {
        ...clip,
        start: Math.max(0, snapStart(start, segments)),
        end: Math.min(info.duration, snapEnd(end, segments)),
      };
    })
    .map((clip) => enforceMinDuration(clip, segments, options.minClipSeconds, info.duration))
    .filter((clip): clip is HighlightClip => clip !== null)
    .map((clip) => capDuration(clip, segments, options.maxClipSeconds));

  return dedupeOverlapping(clips).slice(0, options.clipCount);
}

// The prompt asks the model to never come in under the requested minimum, but (like the
// maximum) models don't reliably follow numeric limits - enforce it in code too, the same
// way capDuration enforces the maximum. Extends the end forward to the nearest real
// transcript boundary at or after start+minClipSeconds, so short clips grow to include
// natural follow-up/context instead of landing mid-sentence. If there isn't enough video
// left after this clip's start to reach the minimum at all (e.g. it starts right near the
// end of the video), the clip is dropped rather than shipped short.
export function enforceMinDuration(
  clip: HighlightClip,
  segments: TranscriptSegment[],
  minClipSeconds: number,
  videoDuration: number,
): HighlightClip | null {
  if (clip.end - clip.start >= minClipSeconds) return clip;

  const target = clip.start + minClipSeconds;
  let newEnd = Infinity;
  for (const segment of segments) {
    if (segment.end >= target && segment.end < newEnd) {
      newEnd = segment.end;
    }
  }
  if (!Number.isFinite(newEnd)) {
    newEnd = target;
  }
  newEnd = Math.min(newEnd, videoDuration);

  if (newEnd - clip.start < minClipSeconds) {
    return null;
  }
  return { ...clip, end: newEnd };
}

// The prompt asks the model to treat the max as a near-hard ceiling, but models don't
// always follow numeric limits reliably - enforce it in code too so "max length" is a
// real ceiling, not just a suggestion. The allowed overrun is deliberately small (just
// enough to finish a sentence/payoff, not a routine target) and scales down in relative
// terms for longer max lengths, where a big proportional overrun would be a lot of extra
// seconds: whichever is smaller of +25% or +20s flat. Trims the end back to the nearest
// transcript segment boundary at or before the cap so the clip still ends cleanly,
// rather than a hard mid-sentence cut.
export function capDuration(clip: HighlightClip, segments: TranscriptSegment[], maxClipSeconds: number): HighlightClip {
  const hardCapSeconds = maxClipSeconds + Math.min(20, maxClipSeconds * 0.25);
  if (clip.end - clip.start <= hardCapSeconds) return clip;

  const cappedEnd = clip.start + hardCapSeconds;
  let newEnd = clip.start;
  for (const segment of segments) {
    if (segment.end > clip.start && segment.end <= cappedEnd) {
      newEnd = Math.max(newEnd, segment.end);
    }
  }
  if (newEnd <= clip.start) newEnd = cappedEnd;

  return { ...clip, end: newEnd };
}

// Snapping to segment boundaries (above) can turn clips that were merely close into
// clips that now genuinely overlap. The model is also not perfectly reliable about
// "don't overlap" on its own. Belt and suspenders: drop any clip that overlaps an
// already-accepted, higher-ranked clip (the model orders best-to-worst) by more than
// a third of its own length, rather than shipping near-duplicate clips of one moment.
const MAX_OVERLAP_FRACTION = 1 / 3;

function dedupeOverlapping(clips: HighlightClip[]): HighlightClip[] {
  const accepted: HighlightClip[] = [];
  for (const clip of clips) {
    const clipLength = clip.end - clip.start;
    const overlapsExisting = accepted.some((existing) => {
      const overlap = Math.min(clip.end, existing.end) - Math.max(clip.start, existing.start);
      return overlap > clipLength * MAX_OVERLAP_FRACTION;
    });
    if (!overlapsExisting) {
      accepted.push(clip);
    }
  }
  return accepted;
}

// The model is good at picking *roughly* the right moment but imprecise down to the
// second, which can cut a clip off mid-word. Snap to the nearest transcript segment
// boundary within a small tolerance so cuts land on actual pauses in speech - this can
// only widen a clip (never shrink it), and only by a bounded amount.
const SNAP_TOLERANCE_SECONDS = 3;

function snapStart(start: number, segments: TranscriptSegment[]): number {
  let snapped = start;
  let bestDelta = SNAP_TOLERANCE_SECONDS;
  for (const segment of segments) {
    if (segment.start > start) continue;
    const delta = start - segment.start;
    if (delta < bestDelta) {
      bestDelta = delta;
      snapped = segment.start;
    }
  }
  return snapped;
}

function snapEnd(end: number, segments: TranscriptSegment[]): number {
  let snapped = end;
  let bestDelta = SNAP_TOLERANCE_SECONDS;
  for (const segment of segments) {
    if (segment.end < end) continue;
    const delta = segment.end - end;
    if (delta < bestDelta) {
      bestDelta = delta;
      snapped = segment.end;
    }
  }
  return snapped;
}
