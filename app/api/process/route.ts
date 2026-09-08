import { randomUUID } from "crypto";
import { enqueueJob } from "@/lib/queue";
import { createProject } from "@/lib/projects";
import type { ProcessOptions, ReframeStyle } from "@/lib/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function isValidUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

  const rawUrls: unknown[] = Array.isArray(body?.urls) ? body.urls : isValidUrl(body?.url) ? [body.url] : [];
  const urls = rawUrls.filter(isValidUrl);

  if (!body || urls.length === 0) {
    return NextResponse.json({ error: "At least one valid video URL is required." }, { status: 400 });
  }

  const reframeStyle: ReframeStyle = body.reframeStyle === "crop" ? "crop" : "blur";

  const sharedOptions = {
    clipCount: clamp(Number(body.clipCount) || 5, 1, 15),
    minClipSeconds: clamp(Number(body.minClipSeconds) || 20, 5, 600),
    maxClipSeconds: clamp(Number(body.maxClipSeconds) || 120, 5, 600),
    vertical: body.vertical !== false,
    reframeStyle,
    burnCaptions: body.burnCaptions !== false,
    animatedCaptions: body.animatedCaptions === true,
    reviewBeforeCutting: body.reviewBeforeCutting === true,
  };

  const jobIds: string[] = [];
  for (const url of urls) {
    const options: ProcessOptions = { url, ...sharedOptions };
    const jobId = randomUUID();
    await createProject(jobId, url, options);
    // Deliberately not awaited: jobs run independently of this request/response via
    // the queue (see lib/queue.ts), persisting their own progress (lib/projects.ts)
    // so a dropped connection on the client never loses anything - the frontend just
    // polls GET /api/projects/:id.
    enqueueJob(jobId, url, options);
    jobIds.push(jobId);
  }

  return NextResponse.json({ jobIds });
}
