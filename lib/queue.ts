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
let recovered = false;

export function enqueueJob(jobId: string, url: string, options: ProcessOptions): void {
  recoverStuckJobs();
  pending.push({ jobId, url, options });
  tryStartNext();
}

function tryStartNext(): void {
  while (activeCount < MAX_CONCURRENT_JOBS && pending.length > 0) {
    const job = pending.shift();
    if (!job) break;
    activeCount++;
    setStatus(job.jobId, "running")
      .then(() => runPipeline(job.jobId, job.url, job.options))
      .catch(() => {
        // runPipeline persists its own error state - nothing more to do here.
      })
      .finally(() => {
        activeCount--;
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
function recoverStuckJobs(): void {
  if (recovered) return;
  recovered = true;
  listProjects()
    .then((projects) => {
      for (const project of projects) {
        if (project.status === "queued" || project.status === "running") {
          pending.push({ jobId: project.jobId, url: project.url, options: project.options });
        }
      }
      tryStartNext();
    })
    .catch(() => {
      // Best-effort recovery - if this fails, those jobs just need a manual retry.
    });
}
