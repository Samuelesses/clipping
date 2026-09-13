import { isConnected } from "@/lib/tiktok";
import { hasTiktokCookies } from "@/lib/tiktokCookies";
import { NextResponse } from "next/server";

export async function GET() {
  const cookieMode = hasTiktokCookies();
  return NextResponse.json({
    connected: cookieMode || (await isConnected()),
    cookieMode,
  });
}
