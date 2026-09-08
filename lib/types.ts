export interface VideoInfo {
  title: string;
  duration: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
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

export interface ProcessOptions {
  url: string;
  clipCount: number;
  minClipSeconds: number;
  maxClipSeconds: number;
  vertical: boolean;
  burnCaptions: boolean;
}

export type ProjectStatus = "running" | "done" | "error";

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
  clips: GeneratedClip[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
