# Clipping

Paste a YouTube video or Twitch VOD link, and this app downloads it, gets a transcript, asks
an AI model to find the best moments, and cuts them into short clips - all running on your own
machine. Nothing is hosted or uploaded anywhere except to OpenAI (for highlight selection, and
transcription when needed).

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
4. **Cut clips** - `ffmpeg` cuts each highlight out of the downloaded video. By default clips are
   reformatted to 9:16 vertical (blurred, filled background - like TikTok/Shorts/Reels) with a
   bold title burned in at the top and captions at the bottom, generated from the same
   transcript, ready to post as-is. Both are toggles in "advanced options" if you'd rather keep
   the original aspect ratio or skip the burned-in text. The social caption + hashtags are shown
   under each clip with a copy button - not burned into the video.

Everything runs locally as a single Next.js app (UI + API routes) - there's no server to
deploy, no database, and no accounts. Only one API key is needed (OpenAI).

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
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` / `TIKTOK_REDIRECT_URI` | no | Only needed for TikTok auto-posting - see below. |
| `TIKTOK_PRIVACY_LEVEL` | no | Requested privacy level for posts - see the TikTok section's limitations. |

You can also tune, per request, from the "advanced options" in the UI: how many clips to
generate, and the min/max length of each clip.

## TikTok auto-posting (optional)

The app can automatically post every generated clip straight to TikTok via the
[Content Posting API](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video),
using each clip's AI-generated caption/hashtags. This needs some one-time setup and comes with
real platform limitations - read this whole section before turning it on.

### 1. Create a TikTok developer app

1. Go to [developers.tiktok.com](https://developers.tiktok.com/) and create an app.
2. Add the **Content Posting API** product to the app and request the `video.publish` scope.
3. Under the app's settings, add a **Redirect URI** for OAuth - it must be HTTPS. For local dev,
   run a tunnel (e.g. `ngrok http 3000`) and use the HTTPS URL it gives you, e.g.
   `https://abc123.ngrok-free.app/api/tiktok/callback`.
4. New apps start in **Sandbox** mode - under the app's Sandbox settings, add your own TikTok
   account as a **Target User** so you can authorize and test the flow before/without a full
   app review.
5. Copy the app's **Client Key** and **Client Secret** into `.env.local`:
   ```
   TIKTOK_CLIENT_KEY=...
   TIKTOK_CLIENT_SECRET=...
   TIKTOK_REDIRECT_URI=https://abc123.ngrok-free.app/api/tiktok/callback
   ```
   The redirect URI must match exactly what you registered in step 3. Restart `npm run dev`
   after editing `.env.local`.

### 2. Connect your account

Open the app - there's a **Connect TikTok** button at the top. It walks you through TikTok's
OAuth consent screen and stores the resulting tokens locally in `data/tiktok-tokens.json`
(already gitignored, never sent anywhere but TikTok). Once connected, check
**"Auto-post every clip to TikTok"** under advanced options before generating clips.

### Important limitations - read before relying on this

- **Unaudited apps can only post privately.** Until TikTok reviews and approves your app,
  every post is forced to `SELF_ONLY` (visible only to your own account) no matter what
  privacy level is requested - this is enforced by TikTok's API itself, not something this app
  controls. Public posting requires submitting your app for review.
- **No preview/confirmation step.** "Auto-post" here means exactly that - each clip is posted
  the moment it's cut, using the AI-written caption, with no human review in between. TikTok's
  own platform guidelines generally expect apps to show the user what's about to be posted
  before it's posted; this app skips that by design (per your original request), which is a
  reasonable tradeoff for a personal tool posting privately to your own account, but is worth
  knowing if you ever submit this app for TikTok's review process.
- **Tokens expire.** Access tokens are refreshed automatically using the stored refresh token;
  if the refresh token itself expires (TikTok's docs list a lifetime, currently ~365 days) or
  gets revoked, you'll need to click **Connect TikTok** again.
- A failed TikTok post doesn't fail the whole job - you'll see an error status under that
  specific clip in the UI, and the rest of the run continues normally.

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

- Downloaded source video and intermediate audio/caption files are written to `data/<job-id>/`
  and deleted once a job finishes (successfully or not). Generated clips are kept in
  `public/clips/<job-id>/` so you can preview/download them - delete that folder yourself to
  reclaim disk space.
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
  They're generated at whatever granularity the transcript source provides (per-sentence/phrase
  from captions or Whisper segments) - not word-by-word animated captions.
