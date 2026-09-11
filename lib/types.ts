export interface VideoInfo {
  title: string;
  duration: number;
}

export interface TranscriptWord {
  start: number;
  text: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Per-word start times within this segment, when available (Whisper, or YouTube's
   * auto-caption inline tags) - a word's end is the next word's start, or the segment's
   * own end for the last word. Used for word-by-word animated captions; segments
   * without this (e.g. manually-uploaded captions with no per-word timing) fall back
   * to a plain static caption line. */
  words?: TranscriptWord[];
}

export interface HighlightClip {
  title: string;
  start: number;
  end: number;
  reason: string;
  socialCaption: string;
}

export interface GeneratedClip extends HighlightClip {
  url: string;
}

export type ReframeStyle = "blur" | "crop";

export interface ProcessOptions {
  url: string;
  clipCount: number;
  minClipSeconds: number;
  maxClipSeconds: number;
  vertical: boolean;
  reframeStyle: ReframeStyle;
  burnCaptions: boolean;
  animatedCaptions: boolean;
  reviewBeforeCutting: boolean;
}

export type ProjectStatus = "queued" | "running" | "reviewing" | "done" | "error";

/** Fine-grained progress within the current pipeline stage (e.g. download percent, or
 * clip N of M) - separate from the plain-text log, which is a history rather than a
 * single "how far along is this" number. Cleared between stages, so it only ever
 * reflects what's actively happening right now. */
export interface JobProgress {
  label: string;
  current: number;
  total: number;
}

/**
 * Persisted, on-disk state for one job (data/projects/<jobId>.json). This is the
 * source of truth the frontend polls - it survives page reloads, network drops, and
 * dev-server restarts (the in-flight pipeline itself does not survive a server
 * restart, but everything it had already saved does, so a retry resumes instead of
 * starting over).
 */
export interface ProjectState {
  jobId: string;
  url: string;
  title: string | null;
  options: ProcessOptions;
  status: ProjectStatus;
  log: string[];
  /** Fine-grained progress for whatever the pipeline is doing right now (see
   * JobProgress) - null between stages, while queued/reviewing/done, or on error. */
  progress: JobProgress | null;
  /** Set when status is "reviewing" - the AI's proposed clips, editable before cutting. */
  pendingHighlights: HighlightClip[] | null;
  clips: GeneratedClip[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
