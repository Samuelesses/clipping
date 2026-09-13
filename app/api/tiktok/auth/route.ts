import { randomUUID } from "crypto";
import { buildAuthorizeUrl, generatePkce } from "@/lib/tiktok";
import { NextResponse } from "next/server";

const COOKIE_MAX_AGE_SECONDS = 600;

/** Kicks off TikTok's OAuth flow: generates a PKCE pair + CSRF state, stashes them in
 * short-lived cookies (read back in the callback route), and redirects to TikTok's own
 * authorization screen. */
export async function GET(request: Request) {
  const homeUrl = new URL("/", request.url);

  let authorizeUrl: string;
  let state: string;
  let verifier: string;
  try {
    const pkce = generatePkce();
    verifier = pkce.verifier;
    state = randomUUID();
    authorizeUrl = buildAuthorizeUrl(state, pkce.challenge);
  } catch (err) {
    homeUrl.searchParams.set("tiktokError", err instanceof Error ? err.message : "Could not start TikTok connection.");
    return NextResponse.redirect(homeUrl);
  }

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set("tiktok_oauth_state", state, {
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax",
  });
  response.cookies.set("tiktok_oauth_verifier", verifier, {
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax",
  });
  return response;
}
