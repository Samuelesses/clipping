import { isValidJobId } from "@/lib/jobId";
import { loadProject } from "@/lib/projects";
import { regenerateClip, type ClipRenderOverrides } from "@/lib/pipeline";
import type { ReframeStyle } from "@/lib/types";
import { NextResponse } from "next/server";

/**
 * Re-renders one already-selected clip in place - same moment/title/caption as before,
 * optionally with different reframe/caption settings. Does not touch highlight
 * selection or any other clip.
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
  if (project.status === "running" || project.status === "queued") {
    return NextResponse.json({ error: "Wait for the project to finish before regenerating a clip." }, { status: 409 });
  }
  if (!project.clips[clipIndex]) {
    return NextResponse.json({ error: "Clip not found." }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const overrides: ClipRenderOverrides = {};
  if (typeof body?.vertical === "boolean") overrides.vertical = body.vertical;
  if (body?.reframeStyle === "blur" || body?.reframeStyle === "crop") {
    overrides.reframeStyle = body.reframeStyle as ReframeStyle;
  }
  if (typeof body?.burnCaptions === "boolean") overrides.burnCaptions = body.burnCaptions;
  if (typeof body?.animatedCaptions === "boolean") overrides.animatedCaptions = body.animatedCaptions;

  try {
    const clip = await regenerateClip(jobId, clipIndex, overrides);
    return NextResponse.json({ clip });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not regenerate this clip.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
