import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { fetchCaptions } from "@/lib/captions";
import { cutClip, extractAudio, getVideoDimensions, supportsBurnedCaptions } from "@/lib/ffmpeg";
import { findHighlights } from "@/lib/highlights";
import { writeClipAss } from "@/lib/subtitles";
import { transcribeAudio } from "@/lib/transcribe";
import type { GeneratedClip, ProcessEvent, ProcessOptions, TranscriptSegment } from "@/lib/types";
import { checkDependencies, downloadVideo, getVideoInfo } from "@/lib/ytdlp";

export const runtime = "nodejs";

const DATA_DIR = path.join(process.cwd(), "data");
const PUBLIC_CLIPS_DIR = path.join(process.cwd(), "public", "clips");

function isValidUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

  if (!body || !isValidUrl(body.url)) {
    return new Response(JSON.stringify({ type: "error", message: "A valid video URL is required." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const options: ProcessOptions = {
    url: body.url,
    clipCount: clamp(Number(body.clipCount) || 5, 1, 15),
    minClipSeconds: clamp(Number(body.minClipSeconds) || 20, 5, 600),
    maxClipSeconds: clamp(Number(body.maxClipSeconds) || 90, 5, 600),
    vertical: body.vertical !== false,
    burnCaptions: body.burnCaptions !== false,
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ProcessEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      const jobId = randomUUID();
      const workDir = path.join(DATA_DIR, jobId);

      try {
        send({ type: "status", message: "Checking that yt-dlp and ffmpeg are installed..." });
        await checkDependencies();

        let burnCaptions = options.burnCaptions;
        if (burnCaptions && !(await supportsBurnedCaptions())) {
          send({
            type: "status",
            message:
              "This ffmpeg build has no subtitle support (libass) - generating clips without burned-in " +
              "captions. Reinstall ffmpeg (e.g. `brew reinstall ffmpeg` on macOS) to enable captions.",
          });
          burnCaptions = false;
        }

        await fs.mkdir(workDir, { recursive: true });

        send({ type: "status", message: "Fetching video info..." });
        const info = await getVideoInfo(options.url);

        send({ type: "status", message: "Checking for existing captions/subtitles..." });
        let segments: TranscriptSegment[] | null = await fetchCaptions(options.url, workDir);

        send({ type: "status", message: `Downloading "${info.title}"...` });
        const videoPath = await downloadVideo(options.url, workDir);

        if (segments) {
          send({
            type: "status",
            message: `Found existing captions (${segments.length} lines) - skipping audio transcription.`,
          });
        } else {
          send({ type: "status", message: "No captions available - extracting audio for transcription..." });
          const audioPath = await extractAudio(videoPath, workDir);

          send({ type: "status", message: "Transcribing audio - this can take a while for long videos..." });
          segments = await transcribeAudio(audioPath, workDir, (message) => send({ type: "status", message }));
        }

        if (!segments || segments.length === 0) {
          throw new Error("Could not get a transcript - the video may have no speech to analyze.");
        }

        send({
          type: "status",
          message: `Transcript ready (${segments.length} segments). Asking the model to find the best parts...`,
        });
        const highlights = await findHighlights(segments, info, options);

        if (highlights.length === 0) {
          throw new Error("The model didn't return any candidate clips - try a different video or lower the clip count.");
        }

        send({ type: "status", message: `Found ${highlights.length} candidate clips. Cutting video...` });

        const clipsDir = path.join(PUBLIC_CLIPS_DIR, jobId);
        await fs.mkdir(clipsDir, { recursive: true });

        // Caption font/margins are sized relative to this canvas - vertical mode always
        // renders at a fixed 1080x1920, otherwise clips keep the source video's own size.
        const captionCanvas = burnCaptions
          ? options.vertical
            ? { width: 1080, height: 1920 }
            : await getVideoDimensions(videoPath)
          : null;

        const clips: GeneratedClip[] = [];
        for (const [index, highlight] of highlights.entries()) {
          send({
            type: "status",
            message: `Cutting clip ${index + 1}/${highlights.length}: ${highlight.title}`,
          });

          let subtitlesPath: string | undefined;
          if (captionCanvas) {
            subtitlesPath = path.join(workDir, `clip-${index + 1}.ass`);
            await writeClipAss(
              segments,
              highlight.start,
              highlight.end,
              captionCanvas.width,
              captionCanvas.height,
              subtitlesPath,
            );
          }

          const fileName = `clip-${index + 1}.mp4`;
          await cutClip(videoPath, path.join(clipsDir, fileName), highlight.start, highlight.end, {
            vertical: options.vertical,
            subtitlesPath,
          });
          const clip: GeneratedClip = { ...highlight, url: `/clips/${jobId}/${fileName}` };
          clips.push(clip);
          send({ type: "clip", clip });
        }

        send({ type: "done", jobId, title: info.title, clips });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong.";
        send({ type: "error", message });
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
