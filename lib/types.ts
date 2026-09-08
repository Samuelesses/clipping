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
  /** Set when status is "reviewing" - the AI's proposed clips, editable before cutting. */
  pendingHighlights: HighlightClip[] | null;
  clips: GeneratedClip[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
