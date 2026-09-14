import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { hasTiktokCookies, loadTiktokCookies } from "./tiktokCookies";

const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?from=upload";
const DEBUG_SCREENSHOT_PATH = path.join(process.cwd(), "data", "tiktok-cookie-debug.png");
const POST_RESULT_SCREENSHOT_PATH = path.join(process.cwd(), "data", "tiktok-post-result.png");

// A real, persistent browser profile - not a fresh disposable one rebuilt from a static
// cookie snapshot on every run. That distinction matters: a profile whose entire
// existence is "load tiktok.com/upload, post, close" every single time, with the exact
// same cookies re-injected each run instead of the session evolving naturally the way a
// real logged-in browser's does, is itself a pattern that looks nothing like an actual
// person's browser. Using a persistent profile - ideally your actual installed Chrome,
// not Playwright's bundled Chromium - means the session, cookies, and local storage
// persist and update across runs exactly the way they would if this were a browser
// window you kept open and reused yourself, because that's genuinely what it is.
const PROFILE_DIR = path.join(process.cwd(), "data", "tiktok-browser-profile");

// How long to wait, when running headed, for a human to actually finish logging in by
// hand (find the window, decide how to log in, maybe scan a QR code with their phone).
// Every other wait in this file is tuned for an automated step taking seconds - this one
// is fundamentally different and needs real minutes, not a login-page-detection timeout.
const MANUAL_LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Set TIKTOK_UPLOAD_HEADLESS=false to watch the browser work - the most useful way to
 * diagnose this when TikTok changes their upload page and a selector below stops matching,
 * and required for the very first run if this profile has never logged into TikTok before. */
function isHeadless(): boolean {
  return process.env.TIKTOK_UPLOAD_HEADLESS !== "false";
}

export interface CookieUploadResult {
  message: string;
}

/**
 * Launches the persistent profile in PROFILE_DIR, preferring your actual installed
 * Google Chrome (channel "chrome") over Playwright's bundled Chromium - it's the real
 * browser binary you'd otherwise use by hand, not a synthetic one. Falls back to bundled
 * Chromium only if Chrome isn't installed on this machine; the persistent-profile
 * benefit still applies either way, just not with the identical binary.
 */
async function launchTiktokContext(): Promise<BrowserContext> {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const options = { headless: isHeadless(), viewport: { width: 1280, height: 900 } };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel: "chrome" });
  } catch {
    return await chromium.launchPersistentContext(PROFILE_DIR, options);
  }
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
 * A brand new profile gets TikTok's own cookie-consent banner on its first visit, fixed
 * across the bottom of the page - which is right where the Post button lives, so it
 * blocks that click the same way the onboarding tour blocked the caption box. A
 * persistent profile only sees this once (the choice is remembered for later runs), but
 * still needs handling the first time. Unlike the tour, this one has real, clickable
 * buttons - just dismiss it via whichever one is present rather than hiding it, since
 * burying a *consent* banner with CSS instead of answering it feels like the wrong call.
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
 * Whether the page is currently showing TikTok's login screen. Checking the URL alone
 * (e.g. for "/login") isn't reliable - TikTok can gate an unauthenticated visit to the
 * upload page behind a login screen that doesn't necessarily change the path the way a
 * dedicated /login route would, and guessing wrong here means silently waiting on
 * upload-page elements that will never appear instead of seeding a session or failing
 * with a clear message. getByText (not getByRole) is deliberate here: the login
 * screen's "Log in to TikTok" heading is plain styled text with no ARIA heading role in
 * TikTok's markup, so matching by role found nothing - matching by rendered text works
 * regardless of what element/role it's actually written as.
 */
async function isOnLoginScreen(page: Page): Promise<boolean> {
  if (/\/login/.test(page.url())) return true;

  const loginHeadingVisible = await page
    .getByText(/log in to tiktok/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (loginHeadingVisible) return true;

  // Independent second signal in case the heading text itself is ever split across
  // elements in a way getByText's substring match misses - "Use QR code" is a real
  // button unique to this screen, not something that could appear on the upload page.
  return page
    .getByRole("button", { name: /use qr code/i })
    .first()
    .isVisible()
    .catch(() => false);
}

/**
 * Polls until the login screen is gone (i.e. a human logged in by hand) or timeoutMs
 * elapses. Playwright's built-in waitFor* helpers wait for one specific element to
 * appear/disappear, but "logged in" here is defined by isOnLoginScreen's own multi-signal
 * check rather than a single locator, so this drives that check with a plain poll loop
 * instead.
 */
async function waitForManualLogin(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isOnLoginScreen(page))) return true;
    await page.waitForTimeout(2_000);
  }
  return false;
}

/**
 * TikTok Studio's "Who can watch this video" control keeps whatever it was last set to
 * for this account/session rather than defaulting to Everyone on every upload - and
 * this flow never touches it, so a post silently inherits that ambient setting. A
 * restricted post (Friends, or Only me) looks identical to a successful public one from
 * here: no error, the same "posted" confirmation. Force it to Everyone explicitly
 * instead of trusting whatever's already selected. Best-effort: if TikTok's markup for
 * this control doesn't match (it's one of the more likely things to change/vary by
 * account), this doesn't fail the whole upload - the video still posts, just with
 * whatever visibility was already selected.
 */
async function ensurePublicVisibility(page: Page): Promise<void> {
  const select = page.locator("select").filter({ has: page.getByRole("option", { name: /^everyone$/i }) }).first();
  const viaSelect = await select
    .selectOption({ label: "Everyone" })
    .then(() => true)
    .catch(() => false);
  if (viaSelect) return;

  // Older/alternate layout: a button/combobox that opens a listbox of choices rather
  // than a native <select>.
  const trigger = page.getByText(/who can watch this video/i).first();
  const opened = await trigger
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return;

  await page
    .getByRole("option", { name: /^everyone$/i })
    .first()
    .click({ timeout: 5_000 })
    .catch(() => {});
}

/**
 * Uploads and posts a video via TikTok's own upload page, driving a persistent, real
 * browser profile (see PROFILE_DIR/launchTiktokContext) rather than a disposable one -
 * see lib/tiktokCookies.ts for why this exists at all and its real risks/limitations.
 * This drives real page UI (not TikTok's internal APIs, which are protected by
 * request-signing this doesn't attempt to replicate), so it's slower than a true API
 * call and depends on TikTok's markup not having changed since this was written - if a
 * step below times out, that's the most likely reason.
 */
export async function uploadViaCookies(videoPath: string, caption: string, uploadUrl: string = UPLOAD_URL): Promise<CookieUploadResult> {
  const context = await launchTiktokContext();
  try {
    const page = context.pages()[0] ?? (await context.newPage());

    try {
      await page.goto(uploadUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

      // First run of a fresh profile: not logged in yet. Seed it from tiktok-cookies.txt
      // if one's been dropped in (same convention as YouTube's cookies.txt), then retry -
      // after this, the profile carries its own session going forward and this branch
      // won't run again.
      if ((await isOnLoginScreen(page)) && hasTiktokCookies()) {
        await context.addCookies(await loadTiktokCookies());
        await page.goto(uploadUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      }

      if (await isOnLoginScreen(page)) {
        if (isHeadless()) {
          throw new Error(
            "This browser profile isn't logged into TikTok yet, and there's no visible window to log into by " +
              "hand (TIKTOK_UPLOAD_HEADLESS isn't set to false). Set TIKTOK_UPLOAD_HEADLESS=false in " +
              ".env.local, restart the dev server, and try again - a real browser window will open and wait " +
              "for you to log in.",
          );
        }
        // Headed and not logged in: wait for a real human to actually finish logging in
        // (QR scan, password, whatever) instead of giving up after one check - the rest
        // of this flow's timeouts are tuned for automated steps taking seconds, nowhere
        // near enough time to notice the window, click through, and complete a login.
        const loggedIn = await waitForManualLogin(page, MANUAL_LOGIN_TIMEOUT_MS);
        if (!loggedIn) {
          throw new Error(
            `Still not logged into TikTok after waiting ${MANUAL_LOGIN_TIMEOUT_MS / 60_000} minutes - log in ` +
              `in the browser window, then try again. The profile at ${PROFILE_DIR} keeps the session once ` +
              "you do, so this only needs to happen once.",
          );
        }
        // The login redirect may have landed somewhere other than the upload page.
        await page.goto(uploadUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
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

      await ensurePublicVisibility(page);

      const postButton = page.getByRole("button", { name: /^post$/i }).first();
      await postButton.waitFor({ state: "visible", timeout: 30_000 });
      // The cookie banner can take a moment to render after navigation, so it's
      // possible it wasn't there yet the first time this was called - check again now
      // that we're right by the button it tends to cover.
      await dismissCookieBanner(page);

      const previousUrl = page.url();
      await postButton.click();

      // TikTok's own moderation ("Content check lite") takes ~10 minutes, and posting
      // before it finishes pops a "Continue to post?" confirmation dialog asking
      // whether to post anyway - click through it if it appears (it won't for a video
      // whose check has already completed by the time we get here).
      await page
        .getByRole("button", { name: /post now/i })
        .first()
        .click({ timeout: 10_000 })
        .catch(() => {});

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
    await context.close();
  }
}
