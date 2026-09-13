import path from "path";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { hasTiktokCookies, loadTiktokCookies } from "./tiktokCookies";

const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?from=upload";
const DEBUG_SCREENSHOT_PATH = path.join(process.cwd(), "data", "tiktok-cookie-debug.png");
const POST_RESULT_SCREENSHOT_PATH = path.join(process.cwd(), "data", "tiktok-post-result.png");

/** Set TIKTOK_UPLOAD_HEADLESS=false to watch the browser work - the most useful way to
 * diagnose this when TikTok changes their upload page and a selector below stops matching. */
function isHeadless(): boolean {
  return process.env.TIKTOK_UPLOAD_HEADLESS !== "false";
}

export interface CookieUploadResult {
  message: string;
}

/**
 * TikTok Studio shows a react-joyride onboarding tour on some accounts/sessions - its
 * overlay sits on top of the page (including the caption box) and blocks every click
 * until dismissed, which is what produced the "intercepts pointer events" timeouts.
 * Its buttons aren't reliably clickable (no stable accessible name to target, and
 * clicking through the overlay just hits the overlay itself), so instead of trying to
 * dismiss the tour through its own UI, this permanently disables the overlay with a
 * CSS override injected before it can ever block anything. It's a page-level
 * stylesheet keyed by selector, not a reference to a specific element, so it still
 * applies even if the tour portal mounts (or remounts) after this runs.
 */
async function neutralizeOnboardingTour(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      #react-joyride-portal, .react-joyride__overlay, .react-joyride__spotlight {
        display: none !important;
        pointer-events: none !important;
      }
    `,
  });
}

/**
 * A fresh (cookieless-consent) browser context gets TikTok's own cookie-consent banner
 * every run, fixed across the bottom of the page - which is right where the Post button
 * lives, so it blocks that click the same way the onboarding tour blocked the caption
 * box. Unlike the tour, this one has real, clickable buttons - just dismiss it via
 * whichever one is present rather than hiding it, since burying a *consent* banner with
 * CSS instead of answering it feels like the wrong call even though this is headless.
 */
async function dismissCookieBanner(page: Page): Promise<void> {
  const decline = page.getByRole("button", { name: /decline optional cookies/i }).first();
  const declined = await decline
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (declined) return;

  await page
    .getByRole("button", { name: /allow all/i })
    .first()
    .click({ timeout: 2_000 })
    .catch(() => {});
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

      await neutralizeOnboardingTour(page);
      await dismissCookieBanner(page);

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
      // The cookie banner can take a moment to render after navigation, so it's
      // possible it wasn't there yet the first time this was called - check again now
      // that we're right by the button it tends to cover.
      await dismissCookieBanner(page);

      const previousUrl = page.url();
      await postButton.click();

      // Clicking Post without throwing doesn't mean TikTok actually accepted the post -
      // that click has silently no-op'd before (e.g. still-processing upload, an
      // overlay we don't know about yet). Wait for one of: TikTok navigating away from
      // the upload page, an upload/posted status message appearing, or an error message
      // appearing - and only report success if we actually saw one of the first two.
      const [navigated, statusShown, errorShown] = await Promise.all([
        page
          .waitForURL((url) => url.toString() !== previousUrl, { timeout: 45_000 })
          .then(() => true)
          .catch(() => false),
        page
          .getByText(/uploading|posted successfully|your video is (live|posted)|processing your video/i)
          .first()
          .waitFor({ state: "visible", timeout: 45_000 })
          .then(() => true)
          .catch(() => false),
        page
          .getByText(/failed|something went wrong|please try again|error occurred/i)
          .first()
          .waitFor({ state: "visible", timeout: 45_000 })
          .then(() => true)
          .catch(() => false),
      ]);

      await page.screenshot({ path: POST_RESULT_SCREENSHOT_PATH }).catch(() => {});

      if (errorShown) {
        throw new Error(
          `TikTok showed an error after clicking Post - check ${POST_RESULT_SCREENSHOT_PATH} to see what it said.`,
        );
      }
      if (!navigated && !statusShown) {
        throw new Error(
          "Clicked Post, but nothing on the page confirmed TikTok actually registered it (no redirect or " +
            `upload status appeared) - check ${POST_RESULT_SCREENSHOT_PATH} to see what the page looked like. ` +
            "Check TikTok directly before retrying, in case it did post and this would post it twice.",
        );
      }

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
