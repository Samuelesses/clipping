import fs from "fs/promises";
import path from "path";
import { createOpenAIClient } from "./openaiKey";
import { run } from "./exec";
import { cacheDirFor } from "./videoCache";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

/** Fractions of the original full-resolution frame, all values in [0,1]. */
export interface FacecamBox { x: number; y: number; w: number; h: number }

const FacecamSchema = z.object({
  found: z.boolean(),
  x: z.number(), y: z.number(), w: z.number(), h: z.number(),
  confidence: z.number(),
});

type VisionPart = { type: "text"; text: string } |
  { type: "image_url"; image_url: { url: string; detail: "high" } };

function validBox(box: FacecamBox): boolean {
  const { x, y, w, h } = box;
  return [x,y,w,h].every(Number.isFinite) &&
    x >= 0 && y >= 0 && w >= 0.08 && h >= 0.08 &&
    x + w <= 1.001 && y + h <= 1.001 &&
    w <= 0.55 && h <= 0.72 && w*h < 0.30;
}

/** Source layout is cached per VOD; regeneration never needs to pay to re-detect it. */
export async function detectFacecam(
  url: string,
  videoPath: string,
  reviewStart: number,
  reviewEnd: number,
  log?: (message: string) => Promise<void>,
): Promise<FacecamBox | null> {
  const cacheDir = cacheDirFor(url);
  await fs.mkdir(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, "facecam-layout-v1.json");
  const saved = await fs.readFile(cachePath, "utf8")
    .then(raw => JSON.parse(raw) as FacecamBox | null | undefined).catch(() => undefined);
  if (saved !== undefined) return saved && validBox(saved) ? saved : null;

  const sampleDir = path.join(cacheDir, "facecam-samples");
  await fs.mkdir(sampleDir, { recursive: true });
  const interval = Math.max(0, reviewEnd - reviewStart);
  const times = [0.12, 0.55, 0.88]
    .map(f => reviewStart + Math.min(interval - 0.5, Math.max(0, interval*f)))
    .filter((t, i, arr) => i === 0 || t - arr[i-1] > 4);
  const parts: VisionPart[] = [{
    type: "text",
    text: "Identify the small, persistent REAL streamer's webcam/facecam overlay in these " +
      "screenshots of the same GTA livestream. DO NOT select a human character inside the game, " +
      "a cinematic face, NPC, avatar, minimap, or gameplay HUD. Only return found=true if a webcam " +
      "rectangle appears in a stable position in multiple images. Return ONE common bounding rectangle " +
      "of the webcam overlay in NORMALIZED full-frame coordinates (0..1), x/y top-left and w/h size. " +
      "Include the entire webcam box, not only the face. Ignore chat text and overlays outside it. " +
      "If uncertain, return found=false and zeros. confidence is 0..1."
  }];
  try {
    for (const [index, time] of times.entries()) {
      const file = path.join(sampleDir, `frame-${index}.jpg`);
      await run("ffmpeg", [
        "-v", "error", "-y", "-ss", time.toFixed(2), "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "3", file,
      ]);
      const bytes = await fs.readFile(file);
      parts.push({ type: "image_url", image_url: {
        url: `data:image/jpeg;base64,${bytes.toString("base64")}`, detail: "high",
      }});
    }
    const client = await createOpenAIClient();
    const response = await client.chat.completions.parse({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
      messages: [{ role: "user", content: parts }],
      response_format: zodResponseFormat(FacecamSchema, "gta_facecam_detection"),
    });
    const result = response.choices[0]?.message.parsed;
    const box = result?.found && result.confidence >= 0.75
      ? { x: result.x, y: result.y, w: result.w, h: result.h } : null;
    const valid = box && validBox(box) ? box : null;
    await fs.writeFile(cachePath, JSON.stringify(valid), "utf8");
    await log?.(valid
      ? "Automatically detected stream facecam. Using it for GTA vertical composition."
      : "Facecam could not be confidently detected. Using a gameplay-only vertical layout.");
    return valid;
  } catch (error) {
    await log?.("Automatic facecam detection unavailable; rendering gameplay without a guessed facecam crop.");
    return null;
  } finally {
    await fs.rm(sampleDir, { recursive: true, force: true }).catch(() => {});
  }
}
