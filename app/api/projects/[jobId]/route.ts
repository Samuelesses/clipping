import { isJobActive, cancelQueuedJob, ensureQueueRecovered } from "@/lib/queue";
import { deleteProject, loadProject } from "@/lib/projects";
import { isValidJobId } from "@/lib/jobId";
import { NextResponse } from "next/server";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!isValidJobId(jobId)) {
    return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  }
  ensureQueueRecovered();
  const project = await loadProject(jobId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  return NextResponse.json(project);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!isValidJobId(jobId)) {
    return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  }
  if (isJobActive(jobId)) {
    return NextResponse.json({ error: "This project is still processing. Wait for it to finish before deleting it." }, { status: 409 });
  }
  cancelQueuedJob(jobId);
  await deleteProject(jobId);
  return NextResponse.json({ ok: true });
}
