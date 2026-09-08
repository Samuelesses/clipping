import { NextResponse } from "next/server";
import { disconnect, getConnectionStatus, isConfigured } from "@/lib/tiktok";

export async function GET() {
  const status = await getConnectionStatus();
  return NextResponse.json({ configured: isConfigured(), ...status });
}

export async function DELETE() {
  await disconnect();
  return NextResponse.json({ ok: true });
}
