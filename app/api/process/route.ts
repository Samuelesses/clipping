import { randomUUID } from "crypto";
import { runPipeline } from "@/lib/pipeline";
import { createProject } from "@/lib/projects";
import type { ProcessOptions } from "@/lib/types";
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

  if (!body || !isValidUrl(body.url)) {
    return NextResponse.json({ error: "A valid video URL is required." }, { status: 400 });
  }

  const options: ProcessOptions = {
    url: body.url,
    clipCount: clamp(Number(body.clipCount) || 5, 1, 15),
    minClipSeconds: clamp(Number(body.minClipSeconds) || 20, 5, 600),
    maxClipSeconds: clamp(Number(body.maxClipSeconds) || 120, 5, 600),
    vertical: body.vertical !== false,
    burnCaptions: body.burnCaptions !== false,
  };

  const jobId = randomUUID();
  await createProject(jobId, options.url, options);

  // Deliberately not awaited: the job runs independently of this request/response,
  // persisting its own progress (see lib/projects.ts) so a dropped connection on
  // the client never loses anything - the frontend just polls GET /api/projects/:id.
  runPipeline(jobId, options.url, options).catch(() => {
    // runPipeline already persists its own error state - nothing more to do here.
  });

  return NextResponse.json({ jobId });
}
