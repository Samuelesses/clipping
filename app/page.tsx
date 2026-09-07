"use client";

import { useRef, useState } from "react";
import type { GeneratedClip, ProcessEvent } from "@/lib/types";

type Status = "idle" | "running" | "done" | "error";

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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || status === "running") return;

    setStatus("running");
    setLog([]);
    setClips([]);
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
          <h2 className="text-lg font-medium">Clips</h2>
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
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
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
