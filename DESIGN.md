---
version: alpha
colors:
  background: "#100d19"
  panel: "#1c1726"
  stroke: "#3d3045"
  brand: "#ff6b9c"
  warmAccent: "#ffcb87"
  coolAccent: "#72d6d3"
  foreground: "#f9f0ee"
typography:
  display:
    fontFamily: "Impact, Arial Narrow, sans-serif"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
  clipHook:
    fontFamily: "Pricedown, Anton, sans-serif"
  clipDialogue:
    fontFamily: "Pricedown, Montserrat ExtraBold, sans-serif"
rounded:
  control: "0.5rem"
  card: "0.75rem"
omitted:
  - section: spacing
    reason: "Runtime Tailwind spacing scale is the existing source of truth."
---

# Vicecut — GTA livestream editing

## Overview
A desktop creator tool for turning GTA livestream moments into readable TikTok-ready 9:16 clips. The design reference is Rockstar-era cinematic title treatment, not a generic analytics SaaS. The signature is a **full-bleed two-panel portrait video**: streamer reaction on top, uninterrupted gameplay below. Avoid large blurred or black padding bands and gratuitous decorative neon separators.

## Colors
The UI uses an asphalt-night foundation and sunset pink/gold with restrained cyan highlights. Runtime tokens are owned by CSS variables in `app/globals.css` (model B); this document mirrors those values. Clip text prioritizes white with a black outline for readability rather than relying on brand accent color for contrast.

## Typography
The product brand may use Impact. Clip titles use locally uploaded Pricedown Black when available, or bundled Anton. Dialogue captions use the uploaded font when supplied, or Montserrat ExtraBold. Font files are only uploaded locally and are never checked into the Git repo.

## Layout
**Portrait video:** canvas 1080×1920. If a streamer webcam is confidently detected, render facecam at y=0–540 and gameplay at y=540–1920, both edge-to-edge. If no webcam is detected, gameplay fills the canvas. No black letterboxing. Place the 2.7-second opening hook at approximately y=570; dialogue captions are in the gameplay's safe middle, rather than the bottom description or right action rail. These are pragmatic safe zones; TikTok overlays vary by device and version. Gameplay is always the visual priority and should not be masked by a tall permanent title block.

**Dashboard:** existing sidebar/navigation and responsive app layout remain canonical. Do not apply video-frame geometry to web page elements.

## Elevation & Depth
In video, use a restrained dark seam where facecam meets gameplay, plus readable type outline. Avoid thick decorative bars, fake progress lines and busy frames that compete with motion.

## Shapes
Browser input and card radius follow the existing application CSS. Video panels are square-cornered and aligned edge-to-edge rather than generic floating cards.

## Components
- **GTA portrait renderer:** `lib/ffmpeg.ts` owns all layout coordinates and filtergraph wiring.
- **Facecam detector:** `lib/facecam.ts` owns normalized crop coordinates and caching.
- **Caption renderer:** `lib/subtitles.ts` owns ASS word timing, font and safe margins.
- **Project/re-generation flow:** `lib/pipeline.ts` passes the same crop and caption contracts.
- **Studio shell:** `app/globals.css` is the owner of web theme values.

## Do's and Don'ts
Do fill the whole video frame, keep gameplay prominent, use a single readable title and let the soundtrack carry the moment. Do test the output with actual FFmpeg filtergraph rendering. Don't cover TikTok's bottom caption tray, duplicate the source webcam or create oversized blank letterbox areas. Do not imply that sampled webcam location is full-motion face tracking.
