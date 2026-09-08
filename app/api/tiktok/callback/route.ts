import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/tiktok";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("tiktok_oauth_state")?.value;
  cookieStore.delete("tiktok_oauth_state");

  const redirectTo = new URL("/", url.origin);

  if (errorParam) {
    redirectTo.searchParams.set("tiktok_error", errorParam);
    return NextResponse.redirect(redirectTo);
  }

  if (!code || !state || state !== expectedState) {
    redirectTo.searchParams.set("tiktok_error", "State mismatch or missing code - please try connecting again.");
    return NextResponse.redirect(redirectTo);
  }

  try {
    await exchangeCodeForTokens(code);
    redirectTo.searchParams.set("tiktok_connected", "1");
  } catch (err) {
    redirectTo.searchParams.set("tiktok_error", err instanceof Error ? err.message : "Failed to connect TikTok.");
  }

  return NextResponse.redirect(redirectTo);
}
