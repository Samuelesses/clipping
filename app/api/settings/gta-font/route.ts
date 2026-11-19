import { NextResponse } from "next/server";
import { getGtaFontPath, saveUserGtaFont } from "@/lib/gtaFont";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  try { return request.headers.get("origin") === new URL(request.url).origin; }
  catch { return false; }
}

export async function GET() {
  return NextResponse.json({ installed: Boolean(await getGtaFontPath()) }, { headers: { "Cache-Control": "no-store" }});
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("font");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a .ttf or .otf font file." }, { status: 400 });
  const ext = file.name.toLowerCase().endsWith(".ttf") ? "ttf" : file.name.toLowerCase().endsWith(".otf") ? "otf" : null;
  if (!ext || file.size < 1000 || file.size > 8_000_000) return NextResponse.json({ error: "Only TTF/OTF fonts smaller than 8 MB are supported." }, { status: 400 });
  const bytes = Buffer.from(await file.arrayBuffer());
  const signature = bytes.toString("ascii", 0, 4);
  if (signature !== "OTTO" && signature !== "true" && bytes.readUInt32BE(0) !== 0x00010000) {
    return NextResponse.json({ error: "Invalid OpenType/TrueType font file." }, { status: 400 });
  }
  await saveUserGtaFont(bytes, ext);
  return NextResponse.json({ installed: true });
}
