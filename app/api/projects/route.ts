import { ensureQueueRecovered } from "@/lib/queue";
import { listProjects } from "@/lib/projects";
import { NextResponse } from "next/server";

export async function GET() {
  ensureQueueRecovered();
  const projects = await listProjects();
  return NextResponse.json({ projects });
}
