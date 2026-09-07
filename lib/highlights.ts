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
          "Twitter clips): a clear hook, a punchline, an emotional peak, a funny exchange, or a self-contained " +
          "story or take. Clips must make sense without any extra context.",
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
    .map((clip) => ({
      ...clip,
      start: Math.max(0, clip.start),
      end: Math.min(info.duration, clip.end),
    }));
}
