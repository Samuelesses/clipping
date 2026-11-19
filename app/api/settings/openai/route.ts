import { NextResponse } from "next/server";
import { clearOpenAIKey, hasOpenAIKey, saveOpenAIKey } from "@/lib/openaiKey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host &&
      new URL(origin).protocol === new URL(request.url).protocol;
  } catch {
    return false;
  }
}

const headers = { "Cache-Control": "no-store" };

export async function GET() {
  return NextResponse.json({ configured: await hasOpenAIKey() }, { headers });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403, headers });
  }
  const body = await request.json().catch(() => null);
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey.startsWith("sk-") || apiKey.length > 512 || apiKey.length < 12) {
    return NextResponse.json({ error: "Enter a valid-looking OpenAI API key (starting with sk-)." }, { status: 400, headers });
  }
  try {
    await saveOpenAIKey(apiKey);
    return NextResponse.json({ configured: true }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not save the key on this Mac." }, { status: 500, headers });
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403, headers });
  }
  try {
    await clearOpenAIKey();
    return NextResponse.json({ configured: await hasOpenAIKey() }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not remove the saved key." }, { status: 500, headers });
  }
}
