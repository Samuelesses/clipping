import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { isValidJobId } from "@/lib/jobId";
import { loadProject, setStatus } from "@/lib/projects";
import { enqueueJob } from "@/lib/queue";

export const runtime = "nodejs";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/** Approve paid Whisper transcription or explicitly skip it, then resume the job. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const { jobId } = await params;
  if (!isValidJobId(jobId)) return NextResponse.json({ error: "Invalid job ID." }, { status: 400 });
  const body = await request.json().catch(() => null);
  if (body?.decision !== "approve" && body?.decision !== "skip") {
    return NextResponse.json({ error: "Select approve or skip." }, { status: 400 });
  }
  const project = await loadProject(jobId);
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  if (project.status !== "awaiting_transcription") {
    return NextResponse.json({ error: "This project is not waiting for transcription approval." }, { status: 409 });
  }
  const workDir = path.join(process.cwd(), "data", jobId);
  await fs.mkdir(workDir, { recursive: true });
  const flag = body.decision === "approve" ? "transcription-approved.flag" : "transcription-skipped.flag";
  await fs.writeFile(path.join(workDir, flag), "1", { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await setStatus(jobId, "queued");
  enqueueJob(jobId, project.url, project.options);
  return NextResponse.json({ ok: true, decision: body.decision });
}
