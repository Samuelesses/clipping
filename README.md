# Clipping

Paste a YouTube video or Twitch VOD link, and this app downloads it, transcribes it, asks
Claude to find the best moments, and cuts them into short clips - all running on your own
machine. Nothing is hosted or uploaded anywhere except to OpenAI (for transcription) and
Anthropic (to pick the highlights).

## How it works

1. **Download** - [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) downloads the video locally.
2. **Extract audio** - `ffmpeg` pulls out a small mono audio track.
3. **Transcribe** - the audio is sent to OpenAI's Whisper API (`whisper-1`) to get a
   timestamped transcript. Long videos are automatically split into chunks to stay under the
   API's 25MB upload limit.
4. **Find highlights** - the full transcript is sent to Claude, which returns a structured
   list of clip-worthy moments (title, start/end time, and why it's worth clipping).
5. **Cut clips** - `ffmpeg` cuts each highlight out of the downloaded video and the app serves
   them for preview/download.

Everything runs locally as a single Next.js app (UI + API routes) - there's no server to
deploy, no database, and no accounts.

## Prerequisites

- [Node.js](https://nodejs.org/) 18.18+
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp#installation) on your PATH
- [`ffmpeg`](https://ffmpeg.org/download.html) (includes `ffprobe`) on your PATH
- An [OpenAI API key](https://platform.openai.com/api-keys) (for transcription)
- An [Anthropic API key](https://console.anthropic.com/) (for highlight selection)

## Setup

```bash
npm install
cp .env.example .env.local
# then edit .env.local and add your OPENAI_API_KEY and ANTHROPIC_API_KEY
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), paste a video URL, and click
**Generate clips**.

## Configuration

All configuration lives in `.env.local` (see `.env.example`):

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | yes | Used for the Whisper transcription call. |
| `ANTHROPIC_API_KEY` | yes | Used for the Claude highlight-selection call. |
| `ANTHROPIC_MODEL` | no | Overrides the Claude model (default `claude-opus-5`). |

You can also tune, per request, from the "advanced options" in the UI: how many clips to
generate, and the min/max length of each clip.

## Cost

This app calls two paid APIs per video:

- **OpenAI Whisper** (`whisper-1`): billed per minute of audio (~$0.006/min at time of
  writing). A 2-hour VOD is roughly $0.72 to transcribe.
- **Anthropic Claude**: billed per token on one request containing the full transcript.
  - `claude-opus-5` (default): $5 / $25 per million input/output tokens - highest quality,
    highest cost.
  - `claude-sonnet-5`: $2 / $10 per million tokens - much cheaper, still strong at this task.
  - `claude-haiku-4-5`: $1 / $5 per million tokens - cheapest, fine for shorter/simple videos.

  A transcript runs roughly 150 tokens/minute of video, so a 2-hour VOD is ~18K input tokens -
  a few cents even on `claude-opus-5`. Set `ANTHROPIC_MODEL=claude-sonnet-5` (or `claude-haiku-4-5`)
  in `.env.local` if you want to cut cost further.

Downloading and cutting video with `yt-dlp`/`ffmpeg` is free (just your own compute/bandwidth).

## Notes & limitations

- Downloaded source video and intermediate audio are written to `data/<job-id>/` and deleted
  once a job finishes (successfully or not). Generated clips are kept in `public/clips/<job-id>/`
  so you can preview/download them - delete that folder yourself to reclaim disk space.
- Only download content you have the right to use. Respect YouTube's and Twitch's Terms of
  Service - this tool is intended for personal use (e.g. clipping your own streams/videos, or
  ones you're otherwise permitted to download).
- Very long VODs (many hours) will take a while end-to-end (download + transcription time
  scales with length) and cost more in Whisper minutes.
- Clips are re-encoded with `ffmpeg` (not stream-copied) so cut points land exactly on the
  timestamps Claude picked, at the cost of a bit of processing time per clip.
