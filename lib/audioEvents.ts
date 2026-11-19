import { run } from "./exec";
import { getReviewWindow } from "./reviewRange";
import type { HighlightClip, ProcessOptions, VideoInfo } from "./types";

interface AudioWindow { at: number; db: number }

/**
 * Find unusual high-energy moments in a gaming VOD. These are *candidates*, not
 * confirmed highlights: loud music, ads and explosions can all register as peaks.
 * The vision pass checks them before they are selected for export.
 */
export async function findAudioEventCandidates(
  videoPath: string,
  info: VideoInfo,
  options: ProcessOptions,
  maxCandidates = 8,
): Promise<HighlightClip[]> {
  const window = getReviewWindow(options, info.duration);
  const output = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-loglevel", "error",
    ...(window.start > 0 ? ["-ss", String(window.start)] : []), "-i", videoPath,
    "-t", String(window.duration),
    "-vn", "-ac", "1", "-af",
    "aresample=8000,asetnsamples=n=24000:p=1,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f", "null", "-",
  ]);
  const windows: AudioWindow[] = [];
  let at: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    const frame = line.match(/pts_time:([\d.]+)/);
    if (frame) at = Number(frame[1]);
    const level = line.match(/^lavfi\.astats\.Overall\.RMS_level=([-\d.]+)/);
    if (level && at !== null) {
      const db = Number(level[1]);
      if (Number.isFinite(db)) windows.push({ at: window.start + at, db });
      at = null;
    }
  }
  if (windows.length < 3) return [];
  const sorted = windows.map(w => w.db).sort((a,b) => a-b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const minSeconds = Math.max(5, options.minClipSeconds);
  const length = Math.min(options.maxClipSeconds, Math.max(minSeconds, 55));
  if (window.duration < length) return [];
  const selected: AudioWindow[] = [];
  for (const window of windows.slice().sort((a,b) => b.db-a.db)) {
    // Require an actual spike above typical stream volume, not just constant music.
    if (window.db < Math.max(-36, median + 5)) break;
    if (selected.some(p => Math.abs(p.at-window.at) < Math.max(35, length))) continue;
    selected.push(window);
    if (selected.length === maxCandidates) break;
  }
  return selected.map(({ at }) => {
    const start = Math.max(window.start, Math.min(window.end-length, at-length*0.38));
    const end = Math.min(window.end, start+length);
    const timestamp = Math.floor(at / 60) + ":" + String(Math.floor(at % 60)).padStart(2, "0");
    return {
      title: `Potential gameplay moment at ${timestamp}`,
      start, end,
      reason: "Unusually loud audio moment. Requires visual review to confirm whether this is entertaining gameplay, a reaction, or just noise.",
      socialCaption: "",
    };
  });
}
