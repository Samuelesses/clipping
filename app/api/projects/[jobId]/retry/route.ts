import { isValidJobId } from "@/lib/jobId";
import { appendLog, loadProject, setStatus } from "@/lib/projects";
import { enqueueJob } from "@/lib/queue";
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
  if (project.status === "running" || project.status === "queued") {
    return NextResponse.json({ error: "This project is already queued or running." }, { status: 409 });
  }
  if (project.status === "reviewing") {
    return NextResponse.json({ error: "This project is awaiting review - use the review screen instead." }, { status: 409 });
  }

  await setStatus(jobId, "queued");
  await appendLog(jobId, "Retrying - reusing whatever was already downloaded/transcribed/selected...");

  // Goes through the same concurrency-limited queue as a fresh job. runPipeline
  // resumes from whatever checkpoints (source video, transcript, highlights,
  // already-cut clips) it finds under data/<jobId>/ instead of starting over.
  enqueueJob(jobId, project.url, project.options);

  return NextResponse.json({ ok: true });
}
