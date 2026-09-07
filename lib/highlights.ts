import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { HighlightClip, ProcessOptions, TranscriptSegment, VideoInfo } from "./types";

const DEFAULT_MODEL = "claude-opus-5";

const ClipSchema = z.object({
  title: z.string(),
  start: z.number(),
  end: z.number(),
  reason: z.string(),
});

const HighlightsSchema = z.object({
  clips: z.array(ClipSchema),
});

// Hand-written JSON schema for the API request, paired with a zod `.parse()` for
// runtime validation of the response. Avoids depending on the SDK's zod-to-JSON-schema
// helper, which requires a newer zod major version than this project pins.
const highlightsOutputFormat = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      clips: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short, catchy title for the clip (under 60 characters)" },
            start: { type: "number", description: "Clip start time, in seconds from the start of the video" },
            end: { type: "number", description: "Clip end time, in seconds from the start of the video" },
            reason: { type: "string", description: "One sentence on why this moment is worth clipping" },
          },
          required: ["title", "start", "end", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["clips"],
    additionalProperties: false,
  },
  parse: (content: string) => HighlightsSchema.parse(JSON.parse(content)),
};

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
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const transcript = segments
    .map((s) => `[${formatTime(s.start)} - ${formatTime(s.end)}] ${s.text}`)
    .join("\n");

  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    system:
      "You are an expert short-form video editor. You read transcripts of long-form videos and streams " +
      "and find the moments most likely to work as standalone short clips (e.g. YouTube Shorts, TikTok, " +
      "Twitter clips): a clear hook, a punchline, an emotional peak, a funny exchange, or a self-contained " +
      "story or take. Clips must make sense without any extra context.",
    messages: [
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
    output_format: highlightsOutputFormat,
  });

  if (!response.parsed_output) {
    throw new Error("Claude did not return a parseable list of clips - try again.");
  }

  return response.parsed_output.clips
    .filter((clip): clip is z.infer<typeof ClipSchema> => clip.end > clip.start)
    .map((clip) => ({
      ...clip,
      start: Math.max(0, clip.start),
      end: Math.min(info.duration, clip.end),
    }));
}
