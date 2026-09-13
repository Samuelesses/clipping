import path from "path";
import { chromium } from "playwright";
import { hasTiktokCookies, loadTiktokCookies } from "./tiktokCookies";

const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?from=upload";
const DEBUG_SCREENSHOT_PATH = path.join(process.cwd(), "data", "tiktok-cookie-debug.png");

/** Set TIKTOK_UPLOAD_HEADLESS=false to watch the browser work - the most useful way to
 * diagnose this when TikTok changes their upload page and a selector below stops matching. */
function isHeadless(): boolean {
  return process.env.TIKTOK_UPLOAD_HEADLESS !== "false";
}

export interface CookieUploadResult {
  message: string;
}

/**
 * Uploads and posts a video via TikTok's own upload page, authenticated with the
 * cookies in tiktok-cookies.txt - see lib/tiktokCookies.ts for why this exists and its
 * real risks/limitations. This drives real page UI (not TikTok's internal APIs, which
 * are protected by request-signing this doesn't attempt to replicate), so it's slower
 * than a true API call and depends on TikTok's markup not having changed since this was
 * written - if a step below times out, that's the most likely reason.
 */
export async function uploadViaCookies(
  videoPath: string,
  caption: string,
  // Overridable only for testing the interaction sequence against a stand-in page -
  // production callers always get the real TikTok upload URL.
  uploadUrl: string = UPLOAD_URL,
): Promise<CookieUploadResult> {
  if (!hasTiktokCookies()) {
    throw new Error(
      "No tiktok-cookies.txt found at the project root - export one from a browser tab logged into " +
        "tiktok.com (same way as YouTube's cookies.txt) and drop it there.",
    );
  }
  const cookies = await loadTiktokCookies();

  const browser = await chromium.launch({ headless: isHeadless() });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies(cookies);
    const page = await context.newPage();

    try {
      await page.goto(uploadUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

      if (/\/login/.test(page.url())) {
        throw new Error(
          "TikTok redirected to its login page - the cookies in tiktok-cookies.txt are missing or expired. " +
            "Re-export cookies.txt from a browser tab where you're currently logged into tiktok.com.",
        );
      }

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.waitFor({ state: "attached", timeout: 30_000 });
      await fileInput.setInputFiles(videoPath);

      // TikTok processes the upload (thumbnail generation, etc.) before the caption
      // editor becomes interactive - this can take a while for a fresh video, so wait
      // on that state rather than a fixed delay.
      const captionBox = page.locator('[contenteditable="true"]').first();
      await captionBox.waitFor({ state: "visible", timeout: 180_000 });

      // Replace whatever TikTok pre-filled (usually the filename) with our own caption.
      await captionBox.click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await captionBox.type(caption, { delay: 8 });

      const postButton = page.getByRole("button", { name: /^post$/i }).first();
      await postButton.waitFor({ state: "visible", timeout: 30_000 });
      await postButton.click();

      // No official confirmation to poll here (unlike the OAuth API's publish-status
      // endpoint) - TikTok's own UI feedback (a redirect or success toast) is the best
      // signal available, so give it a moment to appear.
      await page.waitForTimeout(5000);

      return { message: "Uploaded and posted via TikTok's own upload page." };
    } catch (err) {
      await page.screenshot({ path: DEBUG_SCREENSHOT_PATH }).catch(() => {});
      const message = err instanceof Error ? err.message : "Could not post via TikTok's upload page.";
      throw new Error(`${message} A screenshot of what the page looked like was saved to ${DEBUG_SCREENSHOT_PATH}.`);
    }
  } finally {
    await browser.close();
  }
}
