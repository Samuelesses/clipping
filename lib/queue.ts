import { runPipeline } from "./pipeline";
import { listProjects, setStatus } from "./projects";
import type { ProcessOptions } from "./types";

// A simple in-process FIFO queue with a concurrency cap, so submitting a big batch of
// URLs doesn't try to run yt-dlp/ffmpeg/OpenAI calls for all of them at once on one
// machine. This is intentionally lightweight (no persistence of the queue order itself)
// - see recoverStuckJobs() below for what happens across a server restart.
const MAX_CONCURRENT_JOBS = 2;

interface QueuedJob {
  jobId: string;
  url: string;
  options: ProcessOptions;
}

let activeCount = 0;
const pending: QueuedJob[] = [];
let recoveryPromise: Promise<void> | null = null;
const activeJobIds = new Set<string>();
const cancelledJobIds = new Set<string>();

/** Prevent new work from starting for a deleted project. Running work must finish before deletion. */
export function isJobActive(jobId: string): boolean { return activeJobIds.has(jobId); }
export function cancelQueuedJob(jobId: string): void {
  cancelledJobIds.add(jobId);
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].jobId === jobId) pending.splice(i, 1);
  }
}

/** Start recovery from a read endpoint too, not only when submitting a new job. */
export function ensureQueueRecovered(): void { void recoverStuckJobs(); }

export function enqueueJob(jobId: string, url: string, options: ProcessOptions): void {
  void recoverStuckJobs().then(() => {
    if (!cancelledJobIds.has(jobId) && !activeJobIds.has(jobId) && !pending.some((job) => job.jobId === jobId)) {
      pending.push({ jobId, url, options });
    }
    tryStartNext();
  });
}

function tryStartNext(): void {
  while (activeCount < MAX_CONCURRENT_JOBS && pending.length > 0) {
    const job = pending.shift();
    if (!job) break;
    if (cancelledJobIds.has(job.jobId) || activeJobIds.has(job.jobId)) continue;
    activeJobIds.add(job.jobId);
    activeCount++;
    setStatus(job.jobId, "running")
      .then(() => runPipeline(job.jobId, job.url, job.options))
      .catch(() => {
        // runPipeline persists its own error state - nothing more to do here.
      })
      .finally(() => {
        activeCount--;
        activeJobIds.delete(job.jobId);
        tryStartNext();
      });
  }
}

/**
 * The queue above only lives in memory, so a dev-server restart forgets any job that
 * was "queued" (never started) or "running" (was killed mid-flight along with the old
 * process). On the next queue use, re-enqueue those - runPipeline's own checkpointing
 * (see lib/pipeline.ts) means a "running" job resumes from whatever it already
 * finished rather than starting over.
 */
function recoverStuckJobs(): Promise<void> {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = listProjects().then((projects) => {
    for (const project of projects) {
      if ((project.status === "queued" || project.status === "running") &&
          !cancelledJobIds.has(project.jobId) && !activeJobIds.has(project.jobId) &&
          !pending.some((job) => job.jobId === project.jobId)) {
        pending.push({ jobId: project.jobId, url: project.url, options: project.options });
      }
    }
    tryStartNext();
  }).catch((error) => {
    recoveryPromise = null;
    console.error("Could not recover clipping queue:", error);
  });
  return recoveryPromise;
}
