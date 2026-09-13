import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import type { Cookie } from "playwright";

/**
 * Unofficial alternative to lib/tiktok.ts's OAuth flow: drives TikTok's actual upload
 * page with a real (headless) browser, authenticated with a session cookie you export
 * yourself - the same "export cookies.txt from a logged-in browser tab" pattern already
 * used for YouTube (see lib/ytdlp.ts's cookieArgs). No TikTok developer app, no review,
 * no audit - but also no official support: this automates TikTok's own website rather
 * than an API TikTok publishes for this purpose, which is against TikTok's Terms of
 * Service and carries real risk of the account being flagged, and it can silently break
 * whenever TikTok changes their upload page's markup. Used only when tiktok-cookies.txt
 * is present at the project root; the OAuth path in lib/tiktok.ts is otherwise used.
 */
export const TIKTOK_COOKIES_PATH = path.join(process.cwd(), "tiktok-cookies.txt");

export function hasTiktokCookies(): boolean {
  return existsSync(TIKTOK_COOKIES_PATH);
}

/**
 * Parses a Netscape-format cookies.txt (what browser cookie-export extensions produce)
 * into Playwright's cookie shape. Handles the "#HttpOnly_" prefix some exporters use to
 * mark httpOnly cookies (TikTok's session cookie is httpOnly, so this matters).
 */
export function parseNetscapeCookies(content: string): Cookie[] {
  const cookies: Cookie[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;

    let line = rawLine;
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue;
    }

    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const [domain, , cookiePath, secureFlag, expiration, name, value] = fields;
    if (!name) continue;

    cookies.push({
      name,
      value,
      domain,
      path: cookiePath || "/",
      expires: Number(expiration) || -1,
      httpOnly,
      secure: secureFlag === "TRUE",
      sameSite: "Lax",
    });
  }
  return cookies;
}

export async function loadTiktokCookies(): Promise<Cookie[]> {
  const raw = await fs.readFile(TIKTOK_COOKIES_PATH, "utf8");
  const cookies = parseNetscapeCookies(raw);
  if (cookies.length === 0) {
    throw new Error(`${TIKTOK_COOKIES_PATH} exists but contains no usable cookies - re-export it.`);
  }
  return cookies;
}
