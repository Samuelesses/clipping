import { disconnect } from "@/lib/tiktok";
import { NextResponse } from "next/server";

export async function POST() {
  await disconnect();
  return NextResponse.json({ ok: true });
}
