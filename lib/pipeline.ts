import fs from "fs/promises";
import path from "path";
import { fetchCaptions } from "./captions";
import { cutClip, extractAudio, getVideoDimensions, supportsBurnedCaptions } from "./ffmpeg";
import { findHighlights } from "./highlights";
import { addClip, appendLog, loadProject, setPendingHighlights, setStatus, setTitle } from "./projects";
import { withRetry } from "./retry";
import { writeClipAss } from "./subtitles";
import { transcribeAudio } from "./transcribe";
import type { HighlightClip, ProcessOptions, TranscriptSegment, VideoInfo } from "./types";
import { checkDependencies, downloadVideo, getVideoInfo } from "./ytdlp";

const DATA_DIR = path.join(process.cwd(), "data");
const PUBLIC_CLIPS_DIR = path.join(process.cwd(), "public", "clips");

/**
 * Runs (or resumes) a job end to end, persisting progress to disk as it goes
 * (see lib/projects.ts) instead of holding everything in memory tied to one HTTP
 * request/response. This means:
 *  - A network drop on the browser side never loses anything - this keeps running
 *    server-side regardless, and the UI just re-polls the persisted state.
 *  - If a network-dependent step itself fails (the server's own connection drops
 *    mid-download/transcription/highlight-selection), each of those steps already
 *    retries a few times with backoff, and if it still fails, whatever succeeded
 *    earlier (the downloaded video, the transcript, the highlight list) is left on
 *    disk under data/<jobId>/ so a manual retry resumes from there instead of
 *    starting over.
 */
export async function runPipeline(jobId: string, url: string, options: ProcessOptions): Promise<void> {
  const workDir = path.join(DATA_DIR, jobId);
  const log = (message: string) => appendLog(jobId, message);

  try {
    await log("Checking that yt-dlp and ffmpeg are installed...");
    await checkDependencies();

    let burnCaptions = options.burnCaptions;
    if (burnCaptions && !(await supportsBurnedCaptions())) {
      await log(
        "This ffmpeg build has no subtitle support (libass) - generating clips without burned-in " +
          "captions. Reinstall ffmpeg (e.g. `brew reinstall ffmpeg` on macOS) to enable captions.",
      );
      burnCaptions = false;
    }

    await fs.mkdir(workDir, { recursive: true });

    await log("Fetching video info...");
    const info = await withRetry(() => getVideoInfo(url), {
      onRetry: (attempt) => log(`Fetching video info failed - retrying (attempt ${attempt + 1})...`),
    });
    await setTitle(jobId, info.title);

    const videoPath = await ensureVideoDownloaded(jobId, workDir, url, info, log);
    const segments = await ensureTranscript(jobId, workDir, url, videoPath, log);

    await log(`Transcript ready (${segments.length} segments). Asking the model to find the best parts...`);
    const highlights = await ensureHighlights(jobId, workDir, segments, info, options, log);

    if (highlights.length === 0) {
      throw new Error("The model didn't return any candidate clips - try a different video or lower the clip count.");
    }

    // If review-before-cutting is on, stop here and hand the candidate highlights to
    // the UI for editing/approval instead of cutting immediately. A "reviewed.flag"
    // marker (written by the /cut endpoint once the user approves) means this job
    // already went through review on a previous run - e.g. resuming after a retry -
    // so it should fall straight through to cutting instead of looping back to
    // "reviewing" forever.
    const reviewedFlagPath = path.join(workDir, "reviewed.flag");
    const alreadyReviewed = await fs
      .access(reviewedFlagPath)
      .then(() => true)
      .catch(() => false);
    if (options.reviewBeforeCutting && !alreadyReviewed) {
      await setPendingHighlights(jobId, highlights);
      await setStatus(jobId, "reviewing");
      await log("Candidate clips are ready for review - waiting for approval before cutting.");
      return;
    }

    await log(`Found ${highlights.length} candidate clips. Cutting video...`);

    const clipsDir = path.join(PUBLIC_CLIPS_DIR, jobId);
    await fs.mkdir(clipsDir, { recursive: true });

    let captionCanvas: { width: number; height: number } | null = null;
    // In vertical mode the sharp video is centered over a blurred fill, so we need to
    // know where its bottom edge actually lands to anchor captions just under it
    // rather than near the bottom of the whole padded canvas (see lib/subtitles.ts).
    let videoBottomY: number | null = null;

    if (burnCaptions) {
      if (options.vertical) {
        captionCanvas = { width: 1080, height: 1920 };
        const sourceDims = await getVideoDimensions(videoPath);
        const fgHeight = Math.round((captionCanvas.width * sourceDims.height) / sourceDims.width / 2) * 2;
        const fgTop = Math.round((captionCanvas.height - fgHeight) / 2);
        videoBottomY = fgTop + fgHeight;
      } else {
        captionCanvas = await getVideoDimensions(videoPath);
      }
    }

    // Resume support: a prior attempt may have already cut and recorded some clips
    // before failing later on - pick up right after the last one.
    const alreadyCut = (await loadProject(jobId))?.clips.length ?? 0;

    for (let index = alreadyCut; index < highlights.length; index++) {
      const highlight = highlights[index];
      await log(`Cutting clip ${index + 1}/${highlights.length}: ${highlight.title}`);

      let subtitlesPath: string | undefined;
      if (captionCanvas) {
        subtitlesPath = path.join(workDir, `clip-${index + 1}.ass`);
        await writeClipAss(
          segments,
          highlight.start,
          highlight.end,
          captionCanvas.width,
          captionCanvas.height,
          highlight.title,
          subtitlesPath,
          videoBottomY,
          options.animatedCaptions,
        );
      }

      const fileName = `clip-${index + 1}.mp4`;
      await cutClip(videoPath, path.join(clipsDir, fileName), highlight.start, highlight.end, {
        vertical: options.vertical,
        reframeStyle: options.reframeStyle,
        subtitlesPath,
      });

      await addClip(jobId, { ...highlight, url: `/clips/${jobId}/${fileName}` });
    }

    await setStatus(jobId, "done");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    await appendLog(jobId, `Error: ${message}`);
    await setStatus(jobId, "error", message);
    // Deliberately don't clean up workDir here - it holds the downloaded video and
    // any transcript/highlight checkpoints a retry can reuse instead of redoing them.
    return;
  }

  // Only clean up raw working files once the job actually finished successfully -
  // the generated clips themselves live in public/clips/<jobId>/ and are kept until
  // the user deletes the project.
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}

export async function ensureVideoDownloaded(
  jobId: string,
  workDir: string,
  url: string,
  info: VideoInfo,
  log: (message: string) => Promise<void>,
): Promise<string> {
  const existing = (await fs.readdir(workDir).catch(() => [] as string[])).find(
    (f) => f.startsWith("source.") && !f.endsWith(".part") && !f.endsWith(".ytdl"),
  );
  if (existing) {
    await log("Found a previously downloaded video for this job - resuming from there.");
    return path.join(workDir, existing);
  }

  await log(`Downloading "${info.title}"...`);
  return withRetry(() => downloadVideo(url, workDir), {
    onRetry: (attempt) => log(`Download failed - retrying (attempt ${attempt + 1})...`),
  });
}

export async function ensureTranscript(
  jobId: string,
  workDir: string,
  url: string,
  videoPath: string,
  log: (message: string) => Promise<void>,
): Promise<TranscriptSegment[]> {
  const transcriptPath = path.join(workDir, "transcript.json");

  const cached = await fs
    .readFile(transcriptPath, "utf8")
    .then((raw) => JSON.parse(raw) as TranscriptSegment[])
    .catch(() => null);
  if (cached) {
    await log("Found a previously fetched transcript for this job - resuming from there.");
    return cached;
  }

  await log("Checking for existing captions/subtitles...");
  let segments = await withRetry(() => fetchCaptions(url, workDir), {
    onRetry: (attempt) => log(`Checking captions failed - retrying (attempt ${attempt + 1})...`),
  });

  if (segments) {
    await log(`Found existing captions (${segments.length} lines) - skipping audio transcription.`);
  } else {
    await log("No captions available - extracting audio for transcription...");
    const audioPath = await extractAudio(videoPath, workDir);

    await log("Transcribing audio - this can take a while for long videos...");
    segments = await withRetry(() => transcribeAudio(audioPath, workDir, (message) => log(message)), {
      onRetry: (attempt) => log(`Transcription failed - retrying (attempt ${attempt + 1})...`),
    });
  }

  if (!segments || segments.length === 0) {
    throw new Error("Could not get a transcript - the video may have no speech to analyze.");
  }

  await fs.writeFile(transcriptPath, JSON.stringify(segments), "utf8");
  return segments;
}

export async function ensureHighlights(
  jobId: string,
  workDir: string,
  segments: TranscriptSegment[],
  info: VideoInfo,
  options: ProcessOptions,
  log: (message: string) => Promise<void>,
): Promise<HighlightClip[]> {
  const highlightsPath = path.join(workDir, "highlights.json");

  const cached = await fs
    .readFile(highlightsPath, "utf8")
    .then((raw) => JSON.parse(raw) as HighlightClip[])
    .catch(() => null);
  if (cached) {
    await log("Found previously selected highlights for this job - resuming from there.");
    return cached;
  }

  const highlights = await withRetry(() => findHighlights(segments, info, options), {
    onRetry: (attempt) => log(`Highlight selection failed - retrying (attempt ${attempt + 1})...`),
  });
  await fs.writeFile(highlightsPath, JSON.stringify(highlights), "utf8");
  return highlights;
}
