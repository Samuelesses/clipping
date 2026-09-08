"use client";

import { useEffect, useRef, useState } from "react";
import type { GeneratedClip, ProcessEvent } from "@/lib/types";

type Status = "idle" | "running" | "done" | "error";

interface TikTokStatus {
  configured: boolean;
  connected: boolean;
  username?: string;
}

interface TikTokClipStatus {
  status: "posting" | "posted" | "error";
  message: string;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [clipCount, setClipCount] = useState(5);
  const [minClipSeconds, setMinClipSeconds] = useState(20);
  const [maxClipSeconds, setMaxClipSeconds] = useState(120);
  const [vertical, setVertical] = useState(true);
  const [burnCaptions, setBurnCaptions] = useState(true);
  const [autoPostToTikTok, setAutoPostToTikTok] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [status, setStatus] = useState<Status>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [clips, setClips] = useState<GeneratedClip[]>([]);
  const [tiktokStatuses, setTiktokStatuses] = useState<Record<number, TikTokClipStatus>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [tiktok, setTiktok] = useState<TikTokStatus>({ configured: false, connected: false });
  const [tiktokBanner, setTiktokBanner] = useState<string | null>(null);

  useEffect(() => {
    refreshTikTokStatus();

    const params = new URLSearchParams(window.location.search);
    const connected = params.get("tiktok_connected");
    const error = params.get("tiktok_error");
    if (connected) setTiktokBanner("TikTok account connected.");
    if (error) setTiktokBanner(`TikTok connection failed: ${error}`);
    if (connected || error) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function refreshTikTokStatus() {
    try {
      const res = await fetch("/api/tiktok/status");
      const json = await res.json();
      setTiktok(json);
    } catch {
      // Ignore - the connect button will surface a clearer error if TikTok isn't set up.
    }
  }

  async function handleDisconnectTikTok() {
    await fetch("/api/tiktok/status", { method: "DELETE" });
    setAutoPostToTikTok(false);
    refreshTikTokStatus();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || status === "running") return;

    setStatus("running");
    setLog([]);
    setClips([]);
    setTiktokStatuses({});
    setErrorMessage(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          clipCount,
          minClipSeconds,
          maxClipSeconds,
          vertical,
          burnCaptions,
          autoPostToTikTok: autoPostToTikTok && tiktok.connected,
        }),
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
    } else if (event.type === "tiktok") {
      setTiktokStatuses((prev) => ({ ...prev, [event.clipIndex]: { status: event.status, message: event.message } }));
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

      <section className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
        <div className="text-sm">
          <span className="font-medium text-neutral-300">TikTok: </span>
          {tiktok.connected ? (
            <span className="text-green-400">Connected{tiktok.username ? ` as @${tiktok.username}` : ""}</span>
          ) : (
            <span className="text-neutral-500">Not connected</span>
          )}
        </div>
        {tiktok.connected ? (
          <button
            type="button"
            onClick={handleDisconnectTikTok}
            className="text-sm text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
          >
            Disconnect
          </button>
        ) : (
          <a
            href="/api/tiktok/connect"
            className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-black hover:bg-white"
          >
            Connect TikTok
          </a>
        )}
      </section>

      {tiktokBanner && (
        <div className="rounded-xl border border-neutral-700 bg-neutral-900 p-4 text-sm text-neutral-300">
          {tiktokBanner}
        </div>
      )}

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
            <div>
              <CheckboxField
                label="Auto-post every clip to TikTok"
                checked={autoPostToTikTok}
                onChange={setAutoPostToTikTok}
                disabled={!tiktok.connected}
              />
              {!tiktok.connected && (
                <p className="mt-1 text-xs text-neutral-500">Connect your TikTok account above to enable this.</p>
              )}
              {tiktok.connected && autoPostToTikTok && (
                <p className="mt-1 text-xs text-neutral-500">
                  Posts as private/self-only unless your TikTok app has passed review - see the README.
                </p>
              )}
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
                <CaptionBox text={clip.socialCaption} />
                {tiktokStatuses[i] && <TikTokStatusBadge status={tiktokStatuses[i]} />}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function TikTokStatusBadge({ status }: { status: TikTokClipStatus }) {
  const styles =
    status.status === "posted"
      ? "border-green-900 bg-green-950/50 text-green-300"
      : status.status === "error"
        ? "border-red-900 bg-red-950/50 text-red-300"
        : "border-neutral-700 bg-neutral-900 text-neutral-300";
  return <div className={`rounded-lg border p-2 text-xs ${styles}`}>{status.message}</div>;
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
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 text-sm text-neutral-300 ${disabled ? "opacity-50" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
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
