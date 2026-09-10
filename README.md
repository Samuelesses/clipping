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
videos at once from a folder.

Paste multiple URLs (one per line) to batch-process several videos at once - each becomes its
own project, run through a small concurrency-limited queue (2 at a time) so batches don't
overwhelm your machine or hit API rate limits.

Everything runs locally as a single Next.js app (UI + API routes) - there's no server to
deploy, no database, and no accounts. Only one API key is needed (OpenAI).

## Progress is saved - dropped connections don't lose your work

Each job runs as a background process on your machine, independent of the browser tab that
started it - the page just polls for progress. Up to 2 jobs run concurrently; the rest wait in a
queue and start automatically as slots free up. That means:

- **Closing the tab, a WiFi blip, or your laptop sleeping doesn't stop or lose the job.** Reopen
  the app and it picks the same project back up from wherever it got to.
- **Every step is checkpointed to disk** (`data/<job-id>/`): the downloaded video, the
  transcript, and the selected highlights are each saved as soon as they're ready. Network calls
  (download, transcription, highlight selection) also auto-retry a few times with backoff before
  giving up.
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

- Downloaded source video and intermediate transcript/highlight checkpoints are written to
  `data/<job-id>/` and kept until the job finishes successfully (or you delete the project) -
  see "Progress is saved" above. Generated clips are kept in `public/clips/<job-id>/`, and the
  project's own record lives in `data/projects/<job-id>.json`; deleting a project from the UI
  removes all three.
- Only download content you have the right to use. Respect YouTube's and Twitch's Terms of
  Service - this tool is intended for personal use (e.g. clipping your own streams/videos, or
  ones you're otherwise permitted to download).
- Caption fetching currently looks for English subtitles/auto-captions. Non-English videos
  without English captions will fall back to Whisper transcription instead.
- Very long VODs (many hours) will take a while end-to-end (download time scales with length,
  and transcription time too when Whisper is needed).
- Clips are re-encoded with `ffmpeg` (not stream-copied) so cut points land exactly on the
  timestamps the model picked, at the cost of a bit of processing time per clip.
- Burned-in captions require `ffmpeg` built with `libass` (the standard Homebrew/apt builds are).
  By default they're generated at whatever granularity the transcript source provides
  (per-sentence/phrase from captions or Whisper segments); turn on "animated word-by-word
  captions" for the pop-per-word style instead, which needs word-level timestamps (available
  from Whisper, and from YouTube's auto-generated captions - manually-uploaded YouTube captions
  usually don't carry per-word timing, in which case that clip falls back to static captions).
- A project awaiting review (`reviewing` status) keeps its downloaded video and transcript
  checkpoint on disk until you approve or delete it - it isn't cleaned up until the clips are
  actually cut.
