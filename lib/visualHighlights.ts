import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { run } from "./exec";
import type { HighlightClip } from "./types";

const RankedSchema = z.object({
  rankedIndexes: z.array(z.number().int()),
});

type VisionPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "low" } };

/**
 * Re-rank transcript-nominated VOD moments using two actual gameplay frames per
 * candidate. This is intentionally a lightweight second pass, not a motion detector:
 * it can notice visible action, streamer layouts and important on-screen changes,
 * but screenshots alone cannot discover completely silent events elsewhere in a VOD.
 */
export async function rankVisualHighlights(
  videoPath: string,
  workDir: string,
  candidates: HighlightClip[],
  requestedCount: number,
): Promise<HighlightClip[]> {
  const inspectionDir = path.join(workDir, "visual-review");
  await fs.mkdir(inspectionDir, { recursive: true });
  const parts: VisionPart[] = [{
    type: "text",
    text:
      "These are candidates already discovered from a long gaming livestream's transcript. " +
      "Re-rank them for entertaining short-form clips, using BOTH the transcript-based descriptions " +
      "and the screenshots. Prioritise visible exciting gameplay, surprise, action, comedy, streamer " +
      "reactions and a satisfying payoff. A screenshot can miss action occurring between frames: " +
      "do not invent events or assume an explosion/crash happened without evidence. A good verbal " +
      "story can beat dull gameplay. Return EVERY zero-based index exactly once, strongest first. " +
      "These pictures are supporting evidence, not a substitute for watching the motion."
  }];

  for (let index = 0; index < candidates.length; index++) {
    const clip = candidates[index];
    parts.push({
      type: "text",
      text: `Candidate ${index}: ${clip.title}. ${clip.reason}. ` +
        `Source timestamps ${clip.start.toFixed(1)}-${clip.end.toFixed(1)}s. ` +
        "Two screenshots, early and late:",
    });
    for (const fraction of [0.2, 0.8]) {
      const position = clip.start + (clip.end - clip.start) * fraction;
      const filename = path.join(inspectionDir, `candidate-${index}-${fraction}.jpg`);
      await run("ffmpeg", [
        "-v", "error", "-y", "-ss", position.toFixed(3), "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", filename,
      ]);
      const data = await fs.readFile(filename);
      parts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${data.toString("base64")}`, detail: "low" },
      });
    }
  }

  const client = new OpenAI();
  const completion = await client.chat.completions.parse({
    model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
    messages: [{
      role: "user",
      content: parts,
    }],
    response_format: zodResponseFormat(RankedSchema, "visual_highlight_ranking"),
  });
  const ranked = completion.choices[0]?.message.parsed?.rankedIndexes;
  if (!ranked || ranked.length !== candidates.length ||
      new Set(ranked).size !== candidates.length ||
      ranked.some((index) => index < 0 || index >= candidates.length)) {
    throw new Error("Visual review returned an invalid candidate order.");
  }
  return ranked.slice(0, requestedCount).map((index) => candidates[index]);
}
