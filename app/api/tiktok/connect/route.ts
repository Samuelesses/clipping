import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { generateState, getAuthorizeUrl, isConfigured } from "@/lib/tiktok";

export async function GET() {
  if (!isConfigured()) {
    return NextResponse.json(
      { error: "TikTok isn't configured - set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and TIKTOK_REDIRECT_URI in .env.local." },
      { status: 400 },
    );
  }

  const state = generateState();
  const cookieStore = await cookies();
  cookieStore.set("tiktok_oauth_state", state, {
    httpOnly: true,
    maxAge: 600,
    sameSite: "lax",
    path: "/",
  });

  return NextResponse.redirect(getAuthorizeUrl(state));
}
