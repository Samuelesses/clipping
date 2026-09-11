import fs from "fs/promises";
import path from "path";
import { fetchCaptions } from "./captions";
import { cutClip, extractAudio, getVideoDimensions, supportsBurnedCaptions } from "./ffmpeg";
import { findHighlights } from "./highlights";
import { addClip, appendLog, loadProject, setPendingHighlights, setProgress, setStatus, setTitle } from "./projects";
import { withRetry } from "./retry";
import { writeClipAss } from "./subtitles";
import { transcribeAudio } from "./transcribe";
import type { HighlightClip, ProcessOptions, TranscriptSegment, VideoInfo } from "./types";
import { cacheDirFor } from "./videoCache";
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
 *    earlier is left on disk so a manual retry resumes from there instead of starting
 *    over: the highlight list under data/<jobId>/ (job-specific, since it depends on
 *    that job's own settings), and the downloaded video/transcript under
 *    data/cache/<hash-of-url>/ (shared across jobs, so generating more clips or
 *    re-running with different settings for the same URL never re-downloads or
 *    re-transcribes it - see lib/videoCache.ts).
 */
export async function runPipeline(jobId: string, url: string, options: ProcessOptions): Promise<void> {
  const workDir = path.join(DATA_DIR, jobId);
  const log = (message: string) => appendLog(jobId, message);

  try {
    await log("Checking that yt-dlp and ffmpeg are installed...");
    await checkDependencies();
    // Clear out whatever progress a previous attempt left behind (e.g. "Downloading
    // video 45%" from a run that then failed) so a retry doesn't show stale progress
    // before its first real update arrives.
    await setProgress(jobId, null);

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

    const videoPath = await ensureVideoDownloaded(jobId, url, info, log);
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
      await setProgress(jobId, null);
      await setPendingHighlights(jobId, highlights);
      await setStatus(jobId, "reviewing");
      await log("Candidate clips are ready for review - waiting for approval before cutting.");
      return;
    }

    await log(`Found ${highlights.length} candidate clips. Cutting video...`);
    await setProgress(jobId, null);

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
      await setProgress(jobId, { label: "Cutting clips", current: index + 1, total: highlights.length });

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

    await setProgress(jobId, null);
    await setStatus(jobId, "done");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    await appendLog(jobId, `Error: ${message}`);
    await setProgress(jobId, null);
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
  url: string,
  info: VideoInfo,
  log: (message: string) => Promise<void>,
): Promise<string> {
  // Cached by URL, not by job id: generating more clips or re-running with different
  // settings for a video already downloaded (in this job or any other, past or
  // present) finds it here and skips straight to using it.
  const cacheDir = cacheDirFor(url);
  await fs.mkdir(cacheDir, { recursive: true });

  const existing = (await fs.readdir(cacheDir).catch(() => [] as string[])).find(
    (f) => f.startsWith("source.") && !f.endsWith(".part") && !f.endsWith(".ytdl"),
  );
  if (existing) {
    await log("This video was already downloaded previously - reusing it instead of re-downloading.");
    return path.join(cacheDir, existing);
  }

  await log(`Downloading "${info.title}"...`);
  let lastReported = -1;
  return withRetry(
    () =>
      downloadVideo(url, cacheDir, (percent) => {
        const rounded = Math.min(100, Math.round(percent));
        if (rounded === lastReported) return;
        lastReported = rounded;
        // This callback is synchronous (called straight from yt-dlp's stdout parser), so
        // the write can't be awaited here - but it must not be a bare fire-and-forget
        // either: an unawaited rejection (e.g. a transient disk error) would surface as
        // an unhandled promise rejection and crash the whole process. Swallow it instead
        // - losing one progress tick is harmless, the next one supersedes it seconds later.
        setProgress(jobId, { label: "Downloading video", current: rounded, total: 100 }).catch(() => {});
      }),
    { onRetry: (attempt) => log(`Download failed - retrying (attempt ${attempt + 1})...`) },
  );
}

export async function ensureTranscript(
  jobId: string,
  workDir: string,
  url: string,
  videoPath: string,
  log: (message: string) => Promise<void>,
): Promise<TranscriptSegment[]> {
  // Same idea as the video itself: cached by URL so a transcript, once fetched or
  // transcribed, is never redone for the same video again.
  const cacheDir = cacheDirFor(url);
  const transcriptPath = path.join(cacheDir, "transcript.json");

  const cached = await fs
    .readFile(transcriptPath, "utf8")
    .then((raw) => JSON.parse(raw) as TranscriptSegment[])
    .catch(() => null);
  if (cached) {
    await log("This video was already transcribed previously - reusing that transcript.");
    return cached;
  }

  await setProgress(jobId, null);
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
    segments = await withRetry(
      () =>
        transcribeAudio(audioPath, workDir, async (message, chunkProgress) => {
          await log(message);
          if (chunkProgress) {
            await setProgress(jobId, { label: "Transcribing audio", current: chunkProgress.current, total: chunkProgress.total });
          }
        }),
      { onRetry: (attempt) => log(`Transcription failed - retrying (attempt ${attempt + 1})...`) },
    );
  }

  if (!segments || segments.length === 0) {
    throw new Error("Could not get a transcript - the video may have no speech to analyze.");
  }

  await setProgress(jobId, null);
  await fs.mkdir(cacheDir, { recursive: true });
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
