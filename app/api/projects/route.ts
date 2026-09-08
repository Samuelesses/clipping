import { listProjects } from "@/lib/projects";
import { NextResponse } from "next/server";

export async function GET() {
  const projects = await listProjects();
  return NextResponse.json({ projects });
}
