import crypto from "crypto";
import path from "path";

const CACHE_DIR = path.join(process.cwd(), "data", "cache");

/**
 * Stable, per-URL cache directory for the downloaded source video and its transcript.
 * Keyed by a hash of the URL rather than any one job's id, so re-submitting a URL - to
 * generate more clips, or with different settings - reuses what's already downloaded
 * and transcribed instead of redoing either. Independent of job lifecycle: it survives
 * a job failing/retrying, and even that job being deleted, until the cache entry itself
 * is removed by hand (data/cache/<hash>/).
 */
export function cacheDirFor(url: string): string {
  const hash = crypto.createHash("sha1").update(url).digest("hex");
  return path.join(CACHE_DIR, hash);
}
