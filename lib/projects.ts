import fs from "fs/promises";
import path from "path";
import type { GeneratedClip, ProcessOptions, ProjectState, ProjectStatus } from "./types";

const PROJECTS_DIR = path.join(process.cwd(), "data", "projects");
const CLIPS_DIR = path.join(process.cwd(), "public", "clips");
const WORK_DIR = path.join(process.cwd(), "data");

function projectPath(jobId: string): string {
  return path.join(PROJECTS_DIR, `${jobId}.json`);
}

/** Atomic write (write to a temp file, then rename) so a crash mid-write can't corrupt state. */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function createProject(jobId: string, url: string, options: ProcessOptions): Promise<ProjectState> {
  const now = new Date().toISOString();
  const state: ProjectState = {
    jobId,
    url,
    title: null,
    options,
    status: "running",
    log: [],
    clips: [],
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonAtomic(projectPath(jobId), state);
  return state;
}

export async function loadProject(jobId: string): Promise<ProjectState | null> {
  try {
    const raw = await fs.readFile(projectPath(jobId), "utf8");
    return JSON.parse(raw) as ProjectState;
  } catch {
    return null;
  }
}

async function updateProject(jobId: string, mutate: (state: ProjectState) => void): Promise<void> {
  const state = await loadProject(jobId);
  if (!state) return;
  mutate(state);
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(projectPath(jobId), state);
}

export async function appendLog(jobId: string, message: string): Promise<void> {
  await updateProject(jobId, (state) => {
    state.log.push(message);
  });
}

export async function setTitle(jobId: string, title: string): Promise<void> {
  await updateProject(jobId, (state) => {
    state.title = title;
  });
}

export async function addClip(jobId: string, clip: GeneratedClip): Promise<void> {
  await updateProject(jobId, (state) => {
    state.clips.push(clip);
  });
}

export async function setStatus(jobId: string, status: ProjectStatus, errorMessage?: string): Promise<void> {
  await updateProject(jobId, (state) => {
    state.status = status;
    state.errorMessage = errorMessage ?? null;
  });
}

export async function listProjects(): Promise<ProjectState[]> {
  let fileNames: string[];
  try {
    fileNames = await fs.readdir(PROJECTS_DIR);
  } catch {
    return [];
  }
  const states = await Promise.all(
    fileNames
      .filter((f) => f.endsWith(".json"))
      .map((f) => fs.readFile(path.join(PROJECTS_DIR, f), "utf8").then((raw) => JSON.parse(raw) as ProjectState)),
  );
  return states.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Removes a project's persisted state, its generated clips, and any leftover working files. */
export async function deleteProject(jobId: string): Promise<void> {
  await fs.rm(projectPath(jobId), { force: true });
  await fs.rm(path.join(CLIPS_DIR, jobId), { recursive: true, force: true });
  await fs.rm(path.join(WORK_DIR, jobId), { recursive: true, force: true });
}
