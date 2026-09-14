# Clipping

Paste one or more YouTube video or Twitch VOD links, and this app downloads them, gets a
transcript, asks an AI model to find the best moments, and cuts them into short clips - all
running on your own machine. Nothing is hosted or uploaded anywhere except to OpenAI (for
highlight selection, and transcription when needed).

## How it works

1. **Download** - [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) downloads the video locally.
2. **Get a transcript** - first it tries to pull YouTube's own captions (manually uploaded or
   auto-generated) directly via `yt-dlp` - free, and usually available for YouTube videos. If a
   video has no captions (most Twitch VODs, or a YouTube video with none), it falls back to
   `ffmpeg` extracting audio and sending it to OpenAI's Whisper API for a timestamped transcript,
   automatically chunked to stay under the API's 25MB upload limit.
3. **Find highlights** - the full transcript is sent to an OpenAI model, which returns a
   structured list of clip-worthy moments: a title, start/end time, why it's worth clipping,
   and a ready-to-post social caption with hashtags - funny moments, in-game highlights,
   emotional reactions, and hot takes/drama/callouts, spread across the whole video rather than
   clustered in one place. Each clip's start/end is then snapped to the nearest real transcript
   boundary so it doesn't get cut off mid-sentence, and overlapping/duplicate picks are dropped.
4. **(Optional) Review & trim** - if "Review & edit clip picks before cutting" is on, the
   pipeline pauses right after highlight selection instead of cutting anything. The project
   shows up as **reviewing** with an editable list of the AI's candidate clips - rename them,
   nudge start/end times, or remove ones you don't want - then **Approve & cut** resumes the
   pipeline with your edits.
5. **Cut clips** - `ffmpeg` cuts each highlight out of the downloaded video. By default clips are
   reformatted to 9:16 vertical with a bold title burned in at the top and captions at the
   bottom, generated from the same transcript, ready to post as-is. In "advanced options" you can:
   - Turn off vertical reformatting entirely, or turn off burned-in text.
   - Choose the vertical reframe style: **blur padding** (default - shrinks the full frame to
     fit width and fills the rest with a blurred copy of itself, so nothing is ever cropped out)
     or **crop to fill** (zooms into a centered 9:16 slice, edge-to-edge with no letterboxing, at
     the cost of cutting off the left/right edges of the source).
   - Turn on **animated word-by-word captions**, which pop each word into a highlight color as
     it's spoken (classic short-form caption style) instead of static caption cards. Falls back
     to static captions automatically wherever word-level timing isn't available.

   The social caption + hashtags are shown under each clip with a copy button - not burned into
   the video.

Clips can be browsed as a grid (with inline previews) or a compact list, and downloaded one at a
time or all together as a single ZIP - handy since TikTok's uploader lets you select up to 30
videos at once from a folder. Once TikTok is connected (see "Posting to TikTok" below), each
clip also has its own **Post to TikTok** button.

**If one clip came out wrong** (bad reframe, missing captions, whatever), **Regenerate this
clip** on it re-renders just that one - same moment, title, and caption, untouched - with
whatever reframe/caption settings you pick for that attempt, without re-picking highlights or
touching any other clip.

Paste multiple URLs (one per line) to batch-process several videos at once - each becomes its
own project, run through a small concurrency-limited queue (2 at a time) so batches don't
overwhelm your machine or hit API rate limits.

**Generate more clips, or re-run with different settings, without re-downloading.** The
downloaded video and its transcript are cached per URL (independent of any one project) - so
re-pasting a URL you've already processed, or clicking **Generate more** on a past project (which
prefills the form with that project's URL and settings for you to tweak), skips straight to
picking new highlights and cutting instead of re-downloading and re-transcribing.

Everything runs locally as a single Next.js app (UI + API routes) - there's no server to
deploy, no database, and no accounts. Only one API key is needed (OpenAI).

## Progress is saved - dropped connections don't lose your work

Each job runs as a background process on your machine, independent of the browser tab that
started it - the page just polls for progress. Up to 2 jobs run concurrently; the rest wait in a
queue and start automatically as slots free up. That means:

- **Closing the tab, a WiFi blip, or your laptop sleeping doesn't stop or lose the job.** Reopen
  the app and it picks the same project back up from wherever it got to.
- **Every step is checkpointed to disk**: the downloaded video and transcript are cached per URL
  under `data/cache/<hash>/` (shared across projects - see "Generate more" above), and the
  selected highlights are saved per project under `data/<job-id>/`. Network calls (download,
  transcription, highlight selection) also auto-retry a few times with backoff before giving up.
- **Live progress** for whatever's currently running - a percentage bar while downloading, chunk
  count while transcribing a long video, and clip count while cutting - shown above the full log
  (which stays tucked away behind a "Show full log" toggle unless you want to see everything).
- **If a job does fail** (e.g. your internet actually dropped for a while), it shows up in the
  **Projects** list with a **Retry** button. Retrying reuses whatever was already
  downloaded/transcribed/selected instead of starting over from scratch - it only redoes the
  step that failed (and any clips not yet cut).
- **Delete a project** from the list once you're done with it - this removes its generated
  clips, and any leftover working files, freeing up disk space. Nothing is deleted
  automatically.

## Prerequisites

- [Node.js](https://nodejs.org/) 18.18+
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp#installation) on your PATH
- [`ffmpeg`](https://ffmpeg.org/download.html) (includes `ffprobe`) on your PATH
- An [OpenAI API key](https://platform.openai.com/api-keys)

## Setup

```bash
npm install
cp .env.example .env.local
# then edit .env.local and add your OPENAI_API_KEY
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), paste a video URL, and click
**Generate clips**.

## Configuration

All configuration lives in `.env.local` (see `.env.example`):

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | yes | Used for Whisper transcription (fallback) and highlight selection. |
| `OPENAI_MODEL` | no | Overrides the model used to pick highlights (default `gpt-5.1`). |
| `YTDLP_COOKIES_FILE` | no | Non-default path to a `cookies.txt` export - see below. |
| `YTDLP_COOKIES_FROM_BROWSER` | no | Read cookies live from an installed browser instead (e.g. `chrome`) - see below. |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | no | Only for the "Post to TikTok" button - see "Posting to TikTok" below. |
| `TIKTOK_REDIRECT_URI` | no | Only if not running at the default `http://localhost:3000` - see below. |

You can also tune, per request, from the "advanced options" in the UI: how many clips to
generate, and the min/max length of each clip.

### If yt-dlp fails with "Sign in to confirm you're not a bot"

This is YouTube challenging yt-dlp, not this app - it happens especially often from a
server/VM IP, but can happen on any connection depending on the video. Fix it with cookies
from a browser you're logged into YouTube with, so yt-dlp looks like a real signed-in
session:

1. Install a "cookies.txt export" browser extension - e.g.
   [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
   for Chrome/Edge/Brave, or [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/)
   for Firefox.
2. Go to youtube.com while logged in, click the extension, and export/save the file as
   `cookies.txt`.
3. Drop that file at the **root of this project** (next to `package.json`), named exactly
   `cookies.txt`. It's picked up automatically - no env var or restart needed - and it's
   already in `.gitignore` so it can't get committed by accident.

If your cookies file lives somewhere else, or you'd rather have yt-dlp read cookies live
from an installed browser's profile instead of a file, set `YTDLP_COOKIES_FILE` or
`YTDLP_COOKIES_FROM_BROWSER` in `.env.local` (see `.env.example`) and restart `npm run dev`
- either one takes precedence over an auto-detected `cookies.txt`. See yt-dlp's
[cookies FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)
for more detail.

YouTube sessions expire eventually - if the bot check comes back after a while, just
re-export a fresh `cookies.txt` the same way.

## Posting to TikTok

Each clip has a **Post to TikTok** button. There are two ways to set it up - pick one:

### Option A: cookies (quick, but unofficial - read the risks)

Drop a `tiktok-cookies.txt` file (exported the same way as YouTube's `cookies.txt` - see above)
at the **root of this project**, and **Post to TikTok** will drive TikTok's own upload page with
a real, persistent browser profile authenticated as you - your actual installed Google Chrome if
it's on this machine, Playwright's bundled Chromium otherwise. The cookie file only seeds that
profile's very first login; after that the profile keeps its own session and evolves the same way
a real logged-in browser's does, rather than a disposable one rebuilt from the same static cookie
snapshot on every run. No developer app, no review, no waiting.

**This is not TikTok's official API - it's automating their website, which is against TikTok's
Terms of Service.** Know what you're accepting before using this:
- Real risk of your TikTok account being flagged or restricted for automated posting, and posts
  can end up with suppressed reach even when they otherwise look fine (public, playable) - TikTok
  is actively trying to detect exactly this kind of tool. A persistent, real-browser profile
  removes some obvious tells (a synthetic one-shot profile, a headless-only fingerprint, the same
  unchanging cookie snapshot every run) but there's no way to guarantee it evades TikTok's
  detection, now or after any future change on their end - see Option B if you need reliable reach.
- It can silently break whenever TikTok changes their upload page's markup - there's no
  changelog to follow like a real API has. If it stops working, check `data/tiktok-cookie-debug.png`
  (saved automatically on failure) to see what the page looked like when it broke.
- Your session cookie is as sensitive as your password - anyone with your `tiktok-cookies.txt`
  can act as you on TikTok, and so can anyone with the browser profile this creates at
  `data/tiktok-browser-profile/`. Both are already gitignored - keep it that way, and don't share
  either.
- Sessions expire. If it starts failing with a login redirect and there's no `tiktok-cookies.txt`
  to auto-seed a new one, run once with `TIKTOK_UPLOAD_HEADLESS=false` and log in by hand in the
  window that opens - it only needs to happen once per profile.

Setup:
0. If you already had this project checked out before Option A existed, run `npm install`
   first - `playwright` is a new dependency, and skipping this shows up as a
   `Module not found: Can't resolve 'playwright'` build error.
1. Install a "cookies.txt export" browser extension (the same one from the yt-dlp section
   above works for any site).
2. Go to tiktok.com while logged in, click the extension, export as `tiktok-cookies.txt`.
3. Drop that file at the project root, next to `package.json`.
4. Run `npx playwright install chromium` once (downloads a fallback browser for machines
   without Google Chrome installed - only needed the first time).
5. Generate some clips, then use **Post to TikTok** on one. It can take a minute - it's really
   uploading through the actual website. Set `TIKTOK_UPLOAD_HEADLESS=false` in `.env.local` if
   you want to watch the browser work (useful for figuring out what broke, if it does, and
   required the very first time if you're not relying on `tiktok-cookies.txt` to auto-log-in).

### Option B: TikTok's official Content Posting API (slower to set up, no ban risk)

If `tiktok-cookies.txt` isn't present, **Post to TikTok** instead uses TikTok's official
[Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started) via
OAuth - no ToS risk, but it requires registering a TikTok developer app and going through their
review process.

**Read this before setting it up**: unless your TikTok developer app has gone through TikTok's
own app review/audit, TikTok restricts what an app in that state can post to **private
(`SELF_ONLY`)** - visible only to you, not the public. This app always asks TikTok which privacy
levels your specific app + account combination is allowed to use and picks the most private one
available; it can't post publicly on your behalf until TikTok itself approves your app for that.
In practice that means: **Post to TikTok** uploads the video and creates the post, but you'll
still open the TikTok app afterward to actually publish it (change it from private to public) -
this button gets 90% of the way there (no manual upload, no re-typing the caption), it doesn't
fully eliminate the last tap. If you want genuinely one-tap public posting, you'd need to submit
your TikTok app for their audit, which is a separate process on TikTok's end, outside what this
app can do for you. The upside over Option A: it's fully sanctioned by TikTok, so there's no
account risk, and once audited it can post genuinely public.

Setup:

1. Go to [developers.tiktok.com](https://developers.tiktok.com/), sign in, and create an app.
2. Under that app's products, add **Login Kit** and **Content Posting API**.
3. In Login Kit's settings, add a redirect URI of exactly `http://localhost:3000/api/tiktok/callback`
   (or match whatever `TIKTOK_REDIRECT_URI` you set, if you changed the default port).
4. Under scopes, make sure `user.info.basic` and `video.publish` are enabled for the app (within
   Content Posting API's own product settings, not just the review form, there's usually a
   separate "Direct Post" toggle that needs to be on before `video.publish` becomes selectable).
5. Copy the app's **Client key** and **Client secret** into `.env.local` as `TIKTOK_CLIENT_KEY`
   and `TIKTOK_CLIENT_SECRET`, then restart `npm run dev`.
6. In the app, click **Connect TikTok** (top right) and approve access on TikTok's page - you're
   redirected back here once it's done.
7. Generate some clips, then use **Post to TikTok** on any of them. You can edit the caption
   (defaults to that clip's social caption) right before posting.

Your TikTok session (access + refresh token) is stored locally in `data/tiktok-tokens.json`
(gitignored along with the rest of `data/`) - it's refreshed automatically as needed, and
**Disconnect** next to "TikTok connected" removes it.

A few other TikTok-side details worth knowing:
- Unaudited apps also have a low daily post quota - if posting suddenly fails after several
  successful posts in a day, that's likely why; it resets the next day.
- Very long clips may need to be uploaded in multiple chunks - this app handles that
  automatically per TikTok's chunking rules, no size limit on your end beyond TikTok's own
  (a few GB).
- If `Post to TikTok` fails immediately, the error message is usually TikTok's own API error
  passed straight through - most say plainly what's wrong (expired session, disallowed privacy
  level, quota, etc).

## Cost

This app calls OpenAI in up to two ways per video:

- **Whisper transcription** (`whisper-1`) - only runs when the video has no usable captions
  (typical for Twitch VODs). Billed per minute of audio (~$0.006/min at time of writing); a
  2-hour VOD with no captions is roughly $0.72 to transcribe. Skipped entirely for most YouTube
  videos, which already have captions.
- **Highlight selection** - one request containing the full transcript.
  - `gpt-5.1` (default): highest quality, higher cost.
  - `gpt-5.1-mini` / `gpt-4.1-mini`: much cheaper, still strong at this task.
  - `gpt-5.1-nano` / `gpt-4.1-nano`: cheapest, fine for shorter/simple videos.

  A transcript runs roughly 100-150 tokens/minute of video, so a 2-hour VOD is only ~15-20K
  input tokens - a few cents even on the default model. Set `OPENAI_MODEL=gpt-5.1-mini` in
  `.env.local` if you want to cut cost further.

Downloading and cutting video with `yt-dlp`/`ffmpeg` is free (just your own compute/bandwidth).

## Notes & limitations

- The downloaded source video and its transcript live in `data/cache/<hash-of-url>/`, kept
  indefinitely (even after deleting every project that used them) so the same URL never gets
  re-downloaded or re-transcribed - see "Generate more" above. Per-project working files
  (selected highlights, in-progress caption/audio files) live in `data/<job-id>/` and are cleaned
  up once that project finishes successfully. Generated clips are kept in
  `public/clips/<job-id>/`, and the project's own record lives in `data/projects/<job-id>.json`;
  deleting a project from the UI removes those three but leaves the shared video/transcript cache
  alone. Delete `data/cache/` by hand if you want to reclaim that disk space too (a future
  "Generate more" on that URL will just re-download).
- Only download content you have the right to use. Respect YouTube's and Twitch's Terms of
  Service - this tool is intended for personal use (e.g. clipping your own streams/videos, or
  ones you're otherwise permitted to download).
- Caption fetching currently looks for English subtitles/auto-captions. Non-English videos
  without English captions will fall back to Whisper transcription instead.
- Very long VODs (many hours) will take a while end-to-end (download time scales with length,
  and transcription time too when Whisper is needed).
- Clips are re-encoded with `ffmpeg` (not stream-copied) so cut points land exactly on the
  timestamps the model picked, at the cost of a bit of processing time per clip.
- If this project's folder lives under a cloud-synced directory (e.g. `~/Documents` with iCloud
  Drive syncing enabled on macOS - a common default), that's fine: every clip is fully rendered in
  a local system temp directory first and only moved into `public/clips/` once finished, so the
  sync daemon can't interfere mid-write. (Earlier versions wrote directly into the synced folder,
  which could intermittently corrupt a clip with an "Unable to re-open ... for shifting data"
  ffmpeg error - if you still hit that, update to the latest version.)
- Burned-in captions require `ffmpeg` built with `libass` (the standard Homebrew/apt builds are).
  By default they're generated at whatever granularity the transcript source provides
  (per-sentence/phrase from captions or Whisper segments); turn on "animated word-by-word
  captions" for the pop-per-word style instead, which needs word-level timestamps (available
  from Whisper, and from YouTube's auto-generated captions - manually-uploaded YouTube captions
  usually don't carry per-word timing, in which case that clip falls back to static captions).
- A project awaiting review (`reviewing` status) keeps its per-project working files on disk
  until you approve or delete it - it isn't cleaned up until the clips are actually cut.
