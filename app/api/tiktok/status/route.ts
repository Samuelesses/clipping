import { isConnected } from "@/lib/tiktok";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ connected: await isConnected() });
}
