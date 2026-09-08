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

export type ProcessEvent =
  | { type: "status"; message: string }
  | { type: "clip"; clip: GeneratedClip }
  | { type: "done"; jobId: string; title: string; clips: GeneratedClip[] }
  | { type: "error"; message: string };
