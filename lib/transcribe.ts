import fs from "fs";
import fsp from "fs/promises";
import OpenAI from "openai";
import { getMediaDuration, splitAudioIntoChunks } from "./ffmpeg";
import type { TranscriptSegment } from "./types";

// The Whisper API rejects files over 25MB - stay safely under that per chunk.
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

export async function transcribeAudio(
  audioPath: string,
  workDir: string,
  onProgress?: (message: string) => void | Promise<void>,
): Promise<TranscriptSegment[]> {
  const stat = await fsp.stat(audioPath);

  if (stat.size <= MAX_UPLOAD_BYTES) {
    return transcribeFile(audioPath, 0);
  }

  const duration = await getMediaDuration(audioPath);
  const bytesPerSecond = stat.size / duration;
  const chunkSeconds = Math.max(60, Math.floor((MAX_UPLOAD_BYTES / bytesPerSecond) * 0.9));

  const chunks = await splitAudioIntoChunks(audioPath, workDir, chunkSeconds);
  const allSegments: TranscriptSegment[] = [];
  for (const [index, chunk] of chunks.entries()) {
    await onProgress?.(`Transcribing chunk ${index + 1}/${chunks.length}...`);
    const segments = await transcribeFile(chunk.path, chunk.offsetSeconds);
    allSegments.push(...segments);
  }
  return allSegments;
}

async function transcribeFile(filePath: string, offsetSeconds: number): Promise<TranscriptSegment[]> {
  const client = new OpenAI();
  const response = await client.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });

  const segments = (response as unknown as { segments?: Array<{ start: number; end: number; text: string }> }).segments ?? [];

  if (segments.length === 0 && response.text) {
    return [{ start: offsetSeconds, end: offsetSeconds, text: response.text.trim() }];
  }

  return segments.map((segment) => ({
    start: segment.start + offsetSeconds,
    end: segment.end + offsetSeconds,
    text: segment.text.trim(),
  }));
}
