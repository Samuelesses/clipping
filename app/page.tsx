"use client";

import { useRef, useState } from "react";
import type { GeneratedClip, ProcessEvent } from "@/lib/types";

type Status = "idle" | "running" | "done" | "error";
type ViewMode = "grid" | "list";

export default function Home() {
  const [url, setUrl] = useState("");
  const [clipCount, setClipCount] = useState(5);
  const [minClipSeconds, setMinClipSeconds] = useState(20);
  const [maxClipSeconds, setMaxClipSeconds] = useState(120);
  const [vertical, setVertical] = useState(true);
  const [burnCaptions, setBurnCaptions] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [status, setStatus] = useState<Status>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [clips, setClips] = useState<GeneratedClip[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || status === "running") return;

    setStatus("running");
    setLog([]);
    setClips([]);
    setJobId(null);
    setErrorMessage(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, clipCount, minClipSeconds, maxClipSeconds, vertical, burnCaptions }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `Request failed with status ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;
          handleEvent(JSON.parse(line) as ProcessEvent);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "Something went wrong.");
      }
    }
  }

  function handleEvent(event: ProcessEvent) {
    if (event.type === "status") {
      setLog((prev) => [...prev, event.message]);
    } else if (event.type === "clip") {
      setClips((prev) => [...prev, event.clip]);
    } else if (event.type === "done") {
      setStatus("done");
      setJobId(event.jobId);
    } else if (event.type === "error") {
      setStatus("error");
      setErrorMessage(event.message);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Clipping</h1>
        <p className="text-neutral-400">
          Paste a YouTube video or Twitch VOD link. It downloads locally, gets a transcript, and asks
          AI to pick the best moments, cut into vertical clips with captions ready to post.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="url" className="text-sm font-medium text-neutral-300">
            Video URL
          </label>
          <input
            id="url"
            type="url"
            required
            placeholder="https://www.youtube.com/watch?v=... or https://www.twitch.tv/videos/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={status === "running"}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-2.5 text-sm outline-none focus:border-neutral-500 disabled:opacity-50"
          />
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-sm text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
        >
          {showAdvanced ? "Hide" : "Show"} advanced options
        </button>

        {showAdvanced && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <NumberField label="Number of clips" value={clipCount} onChange={setClipCount} min={1} max={15} />
              <NumberField label="Min clip length (s)" value={minClipSeconds} onChange={setMinClipSeconds} min={5} max={600} />
              <NumberField label="Max clip length (s)" value={maxClipSeconds} onChange={setMaxClipSeconds} min={5} max={600} />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
              <CheckboxField
                label="Vertical 9:16 (for phone/Shorts/Reels)"
                checked={vertical}
                onChange={setVertical}
              />
              <CheckboxField label="Burn in title & captions" checked={burnCaptions} onChange={setBurnCaptions} />
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={status === "running" || !url.trim()}
          className="w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "running" ? "Working..." : "Generate clips"}
        </button>
      </form>

      {log.length > 0 && (
        <section className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
          <h2 className="text-sm font-medium text-neutral-300">Progress</h2>
          <ul className="space-y-1 font-mono text-xs text-neutral-400">
            {log.map((message, i) => (
              <li key={i}>{message}</li>
            ))}
          </ul>
        </section>
      )}

      {status === "error" && errorMessage && (
        <div className="rounded-xl border border-red-900 bg-red-950/50 p-4 text-sm text-red-300">
          {errorMessage}
        </div>
      )}

      {clips.length > 0 && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium">Clips ({clips.length})</h2>
            <div className="flex items-center gap-3">
              <div className="flex rounded-lg border border-neutral-700 p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode("grid")}
                  className={`rounded-md px-3 py-1 text-sm ${viewMode === "grid" ? "bg-neutral-100 text-black" : "text-neutral-400"}`}
                >
                  Grid
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className={`rounded-md px-3 py-1 text-sm ${viewMode === "list" ? "bg-neutral-100 text-black" : "text-neutral-400"}`}
                >
                  List
                </button>
              </div>
              {jobId && (
                <a
                  href={`/api/clips/${jobId}/download`}
                  className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-black hover:bg-white"
                >
                  Download all as ZIP
                </a>
              )}
            </div>
          </div>

          {jobId && (
            <p className="text-xs text-neutral-500">
              TikTok lets you bulk-upload up to 30 videos at once - unzip and select them all in the
              upload picker.
            </p>
          )}

          {viewMode === "grid" ? (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {clips.map((clip, i) => (
                <div key={i} className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
                  <video
                    controls
                    preload="metadata"
                    src={clip.url}
                    className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg bg-black"
                  />
                  <h3 className="font-medium">{clip.title}</h3>
                  <p className="text-sm text-neutral-400">{clip.reason}</p>
                  <a href={clip.url} download className="inline-block text-sm text-blue-400 underline underline-offset-2 hover:text-blue-300">
                    Download
                  </a>
                  <CaptionBox text={clip.socialCaption} />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {clips.map((clip, i) => (
                <ClipRow key={i} clip={clip} />
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function ClipRow({ clip }: { clip: GeneratedClip }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3">
      <div className="flex items-center gap-4">
        <video
          preload="metadata"
          src={clip.url}
          muted
          className="h-24 w-auto flex-shrink-0 rounded-md bg-black"
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{clip.title}</h3>
          <p className="truncate text-sm text-neutral-400">{clip.reason}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-sm text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
          >
            {expanded ? "Hide" : "Details"}
          </button>
          <a
            href={clip.url}
            download
            className="text-sm text-blue-400 underline underline-offset-2 hover:text-blue-300"
          >
            Download
          </a>
        </div>
      </div>
      {expanded && (
        <div className="mt-3 space-y-3 border-t border-neutral-800 pt-3">
          <video controls preload="metadata" src={clip.url} className="mx-auto max-h-[60vh] w-auto max-w-full rounded-lg bg-black" />
          <CaptionBox text={clip.socialCaption} />
        </div>
      )}
    </div>
  );
}

function CaptionBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) - fail silently,
      // the text is still selectable/copyable by hand from the box below.
    }
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Caption &amp; hashtags
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="text-xs text-blue-400 underline underline-offset-2 hover:text-blue-300"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <p className="whitespace-pre-wrap text-sm text-neutral-300">{text}</p>
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-neutral-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-neutral-700 bg-neutral-950 accent-white"
      />
      {label}
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-neutral-300">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
      />
    </label>
  );
}
