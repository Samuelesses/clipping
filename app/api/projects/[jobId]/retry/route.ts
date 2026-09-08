import { isValidJobId } from "@/lib/jobId";
import { runPipeline } from "@/lib/pipeline";
import { appendLog, loadProject, setStatus } from "@/lib/projects";
import { NextResponse } from "next/server";

export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!isValidJobId(jobId)) {
    return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  }

  const project = await loadProject(jobId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  if (project.status === "running") {
    return NextResponse.json({ error: "This project is already running." }, { status: 409 });
  }

  await setStatus(jobId, "running");
  await appendLog(jobId, "Retrying - reusing whatever was already downloaded/transcribed/selected...");

  // Fire-and-forget, same as a fresh job - runPipeline resumes from whatever
  // checkpoints (source video, transcript, highlights, already-cut clips) it finds
  // under data/<jobId>/ instead of starting over.
  runPipeline(jobId, project.url, project.options).catch(() => {
    // runPipeline already persists its own error state.
  });

  return NextResponse.json({ ok: true });
}
