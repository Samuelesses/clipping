import { ZipArchive } from "archiver";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  if (!UUID_RE.test(jobId)) {
    return new Response("Invalid job id.", { status: 400 });
  }

  const clipsDir = path.join(process.cwd(), "public", "clips", jobId);

  let fileNames: string[];
  try {
    fileNames = (await fs.readdir(clipsDir)).filter((f) => f.endsWith(".mp4")).sort();
  } catch {
    return new Response("No clips found for this job - they may have already been cleaned up.", { status: 404 });
  }

  if (fileNames.length === 0) {
    return new Response("No clips found for this job.", { status: 404 });
  }

  const archive = new ZipArchive({ zlib: { level: 6 } });
  for (const fileName of fileNames) {
    archive.file(path.join(clipsDir, fileName), { name: fileName });
  }
  archive.finalize();

  return new Response(Readable.toWeb(archive) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="clips-${jobId.slice(0, 8)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
