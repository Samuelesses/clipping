import path from "path";
import { isValidJobId } from "@/lib/jobId";
import { loadProject } from "@/lib/projects";
import { fetchPublishStatus, publishVideo } from "@/lib/tiktok";
import { hasTiktokCookies } from "@/lib/tiktokCookies";
import { uploadViaCookies } from "@/lib/tiktokCookieUpload";
import { NextResponse } from "next/server";

const TERMINAL_STATUSES = new Set(["PUBLISH_COMPLETE", "FAILED"]);
const MAX_POLL_ATTEMPTS = 15;
const POLL_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Uploads one clip to TikTok and starts a Direct Post, then polls TikTok until the post
 * reaches a terminal status (or the poll budget runs out) so the response reflects what
 * actually happened rather than just "upload started". See lib/tiktok.ts for the
 * SELF_ONLY (private-only) limitation on unaudited apps.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; index: string }> }) {
  const { jobId, index } = await params;
  if (!isValidJobId(jobId)) {
    return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  }

  const clipIndex = Number(index);
  if (!Number.isInteger(clipIndex) || clipIndex < 0) {
    return NextResponse.json({ error: "Invalid clip index." }, { status: 400 });
  }

  const project = await loadProject(jobId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const clip = project.clips[clipIndex];
  if (!clip) {
    return NextResponse.json({ error: "Clip not found." }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const caption: string = typeof body?.caption === "string" && body.caption.trim() ? body.caption : clip.socialCaption;

  const relativePath = clip.url.split("?")[0];
  const filePath = path.join(process.cwd(), "public", relativePath);

  // tiktok-cookies.txt (dropped in by hand, no developer app/review needed) takes
  // precedence over the OAuth/official-API path when present - see
  // lib/tiktokCookies.ts for what this trades away.
  if (hasTiktokCookies()) {
    try {
      const { message } = await uploadViaCookies(filePath, caption);
      return NextResponse.json({ mode: "cookies", status: "PUBLISH_COMPLETE", message });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not post this clip to TikTok.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  try {
    const { publishId, privacyLevel } = await publishVideo(filePath, caption);

    let status = await fetchPublishStatus(publishId);
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS && !TERMINAL_STATUSES.has(status.status); attempt++) {
      await sleep(POLL_INTERVAL_MS);
      status = await fetchPublishStatus(publishId);
    }

    return NextResponse.json({
      mode: "api",
      publishId,
      privacyLevel,
      status: status.status,
      failReason: status.failReason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not post this clip to TikTok.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
