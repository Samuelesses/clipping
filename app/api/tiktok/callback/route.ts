import { exchangeCodeForTokens } from "@/lib/tiktok";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/** TikTok redirects here after the user approves (or denies) access on its own
 * authorization screen. Validates the CSRF state against the cookie set by
 * /api/tiktok/auth, exchanges the code for tokens, and redirects back to the app. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const homeUrl = new URL("/", request.url);

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("tiktok_oauth_state")?.value;
  const verifier = cookieStore.get("tiktok_oauth_verifier")?.value;

  function fail(message: string) {
    homeUrl.searchParams.set("tiktokError", message);
    const res = NextResponse.redirect(homeUrl);
    res.cookies.delete("tiktok_oauth_state");
    res.cookies.delete("tiktok_oauth_verifier");
    return res;
  }

  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return fail(url.searchParams.get("error_description") || errorParam);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !verifier || state !== expectedState) {
    return fail("TikTok authorization failed or expired - try connecting again.");
  }

  try {
    await exchangeCodeForTokens(code, verifier);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Could not complete TikTok authorization.");
  }

  homeUrl.searchParams.set("tiktokConnected", "1");
  const res = NextResponse.redirect(homeUrl);
  res.cookies.delete("tiktok_oauth_state");
  res.cookies.delete("tiktok_oauth_verifier");
  return res;
}
