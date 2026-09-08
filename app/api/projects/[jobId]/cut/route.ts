import fs from "fs/promises";
import path from "path";
import { isValidJobId } from "@/lib/jobId";
import { loadProject, setPendingHighlights, setStatus } from "@/lib/projects";
import { enqueueJob } from "@/lib/queue";
import type { HighlightClip } from "@/lib/types";
import { NextResponse } from "next/server";

const DATA_DIR = path.join(process.cwd(), "data");

function isValidHighlight(value: unknown): value is HighlightClip {
  if (!value || typeof value !== "object") return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.title === "string" &&
    h.title.trim().length > 0 &&
    typeof h.start === "number" &&
    typeof h.end === "number" &&
    Number.isFinite(h.start) &&
    Number.isFinite(h.end) &&
    h.end > h.start &&
    typeof h.reason === "string" &&
    typeof h.socialCaption === "string"
  );
}

/**
 * Approves (optionally edited) highlights from the review screen and resumes the
 * pipeline to actually cut them. The pipeline's own highlights.json checkpoint is
 * overwritten with whatever's submitted here so edits (trimmed times, retitled
 * clips, removed candidates) stick, and a "reviewed.flag" marker is dropped so a
 * resumed/retried run doesn't loop back into "reviewing" again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!isValidJobId(jobId)) {
    return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  }

  const project = await loadProject(jobId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  if (project.status !== "reviewing") {
    return NextResponse.json({ error: "This project isn't awaiting review." }, { status: 409 });
  }

  const body = await request.json().catch(() => null);
  const rawHighlights: unknown[] = Array.isArray(body?.highlights) ? body.highlights : [];
  const highlights = rawHighlights.filter(isValidHighlight);

  if (highlights.length === 0) {
    return NextResponse.json({ error: "At least one valid clip is required." }, { status: 400 });
  }

  const workDir = path.join(DATA_DIR, jobId);
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, "highlights.json"), JSON.stringify(highlights), "utf8");
  await fs.writeFile(path.join(workDir, "reviewed.flag"), "1", "utf8");

  await setPendingHighlights(jobId, null);
  await setStatus(jobId, "queued");
  enqueueJob(jobId, project.url, project.options);

  return NextResponse.json({ ok: true });
}
