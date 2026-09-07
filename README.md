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
   structured list of clip-worthy moments (title, start/end time, and why it's worth clipping) -
   funny moments, in-game highlights, emotional reactions, and hot takes/drama/callouts. Each
   clip's start/end is then snapped to the nearest real transcript boundary so it doesn't get cut
   off mid-sentence.
4. **Cut clips** - `ffmpeg` cuts each highlight out of the downloaded video. By default clips are
   reformatted to 9:16 vertical (blurred, filled background - like TikTok/Shorts/Reels) with
   burned-in captions generated from the same transcript, ready to post as-is. Both are toggles
   in "advanced options" if you'd rather keep the original aspect ratio or skip captions.

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

You can also tune, per request, from the "advanced options" in the UI: how many clips to
generate, and the min/max length of each clip.

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
