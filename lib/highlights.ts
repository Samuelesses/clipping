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
          "right after a sentence/thought completes, so the clip doesn't feel cut off.",
      },
      {
        role: "user",
        content:
          `Video title: ${info.title}\n` +
          `Video duration: ${formatTime(info.duration)} (${Math.round(info.duration)} seconds)\n\n` +
          `Transcript with timestamps:\n${transcript}\n\n` +
          `Pick the ${options.clipCount} best, most engaging, self-contained moments to turn into clips. ` +
          `Each clip must be between ${options.minClipSeconds} and ${options.maxClipSeconds} seconds long. ` +
          `Start and end times must be given in seconds, fall within [0, ${Math.round(info.duration)}], and ` +
          `clips must not overlap each other. Order the clips from best to worst.`,
      },
    ],
    response_format: zodResponseFormat(HighlightsSchema, "highlights"),
  });

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error("The model did not return a parseable list of clips - try again.");
  }

  return parsed.clips
    .filter((clip) => clip.end > clip.start)
    .map((clip) => {
      const start = Math.max(0, clip.start);
      const end = Math.min(info.duration, clip.end);
      return {
        ...clip,
        start: Math.max(0, snapStart(start, segments)),
        end: Math.min(info.duration, snapEnd(end, segments)),
      };
    });
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
