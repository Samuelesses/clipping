"use client";

import { useEffect, useRef, useState } from "react";
import type { GeneratedClip, HighlightClip, ProjectState, ReframeStyle } from "@/lib/types";

type ViewMode = "grid" | "list";

interface RegenerateDefaults {
  vertical: boolean;
  reframeStyle: ReframeStyle;
  burnCaptions: boolean;
  animatedCaptions: boolean;
}

type RegenerateOverrides = Partial<RegenerateDefaults>;

const ACTIVE_JOB_KEY = "clipping.activeJobId";
const POLL_INTERVAL_MS = 1500;

export default function Home() {
  const [urlsText, setUrlsText] = useState("");
  const [clipCount, setClipCount] = useState(5);
  const [minClipSeconds, setMinClipSeconds] = useState(20);
  const [maxClipSeconds, setMaxClipSeconds] = useState(120);
  const [vertical, setVertical] = useState(true);
  const [reframeStyle, setReframeStyle] = useState<ReframeStyle>("blur");
  const [burnCaptions, setBurnCaptions] = useState(true);
  const [animatedCaptions, setAnimatedCaptions] = useState(false);
  const [reviewBeforeCutting, setReviewBeforeCutting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectState | null>(null);
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [reviewDrafts, setReviewDrafts] = useState<HighlightClip[]>([]);
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    refreshProjects();
    const stored = window.localStorage.getItem(ACTIVE_JOB_KEY);
    if (stored) setActiveJobId(stored);
  }, []);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!activeJobId) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${activeJobId}`);
        if (!res.ok) return; // transient failure - just try again next tick
        const data: ProjectState = await res.json();
        setProject(data);
        if (data.status !== "running" && data.status !== "queued" && pollRef.current) {
          clearInterval(pollRef.current);
          refreshProjects();
        }
      } catch {
        // Network blip - nothing lost, the server-side job keeps running regardless.
      }
    };

    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeJobId]);

  // Seed the editable review draft once a job enters "reviewing" - keyed on jobId so
  // it doesn't clobber in-progress edits on every poll tick while still on that job.
  useEffect(() => {
    if (project && project.status === "reviewing" && project.jobId !== reviewJobId) {
      setReviewDrafts(project.pendingHighlights ?? []);
      setReviewJobId(project.jobId);
      setReviewError(null);
    }
    if (project && project.status !== "reviewing" && reviewJobId === project.jobId) {
      setReviewJobId(null);
    }
  }, [project, reviewJobId]);

  async function refreshProjects() {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      setProjects(data.projects ?? []);
    } catch {
      // Non-fatal - the list just won't refresh this time.
    }
  }

  function selectJob(jobId: string) {
    setSubmitError(null);
    window.localStorage.setItem(ACTIVE_JOB_KEY, jobId);
    setActiveJobId(jobId);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const urls = urlsText
      .split("\n")
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0 || submitting) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      const response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls,
          clipCount,
          minClipSeconds,
          maxClipSeconds,
          vertical,
          reframeStyle,
          burnCaptions,
          animatedCaptions,
          reviewBeforeCutting,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed with status ${response.status}`);

      const jobIds: string[] = data.jobIds ?? [];
      if (jobIds.length > 0) {
        setProject(null);
        selectJob(jobIds[0]);
      }
      setUrlsText("");
      refreshProjects();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRetry(jobId: string) {
    setSubmitError(null);
    try {
      const res = await fetch(`/api/projects/${jobId}/retry`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not retry this project.");
      selectJob(jobId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not retry this project.");
    }
  }

  async function handleDelete(jobId: string) {
    await fetch(`/api/projects/${jobId}`, { method: "DELETE" });
    if (jobId === activeJobId) {
      window.localStorage.removeItem(ACTIVE_JOB_KEY);
      setActiveJobId(null);
      setProject(null);
    }
    refreshProjects();
  }

  /** Prefills the form from a past project's URL + settings so tweaking a setting and
   * generating more/different clips reuses the video (and transcript) already fetched
   * for that URL instead of starting from scratch - see lib/videoCache.ts. */
  function handleReuseSettings(p: ProjectState) {
    setUrlsText(p.url);
    setClipCount(p.options.clipCount);
    setMinClipSeconds(p.options.minClipSeconds);
    setMaxClipSeconds(p.options.maxClipSeconds);
    setVertical(p.options.vertical);
    setReframeStyle(p.options.reframeStyle);
    setBurnCaptions(p.options.burnCaptions);
    setAnimatedCaptions(p.options.animatedCaptions);
    setReviewBeforeCutting(p.options.reviewBeforeCutting);
    setShowAdvanced(true);
    setSubmitError(null);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updateDraft(index: number, patch: Partial<HighlightClip>) {
    setReviewDrafts((drafts) => drafts.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function removeDraft(index: number) {
    setReviewDrafts((drafts) => drafts.filter((_, i) => i !== index));
  }

  /** Re-renders one clip in place - same moment/title/caption, just re-cut (optionally
   * with different reframe/caption settings) - and swaps it into the current project's
   * clips array once done. */
  async function handleRegenerateClip(index: number, overrides: RegenerateOverrides) {
    if (!project) return;
    const res = await fetch(`/api/projects/${project.jobId}/clips/${index}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overrides),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not regenerate this clip.");
    setProject((prev) => {
      if (!prev) return prev;
      const clips = prev.clips.slice();
      clips[index] = data.clip;
      return { ...prev, clips };
    });
  }

  async function handleApproveCut(jobId: string) {
    setReviewSubmitting(true);
    setReviewError(null);
    try {
      const res = await fetch(`/api/projects/${jobId}/cut`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ highlights: reviewDrafts }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start cutting.");
      setReviewJobId(null);
      refreshProjects();
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : "Could not start cutting.");
    } finally {
      setReviewSubmitting(false);
    }
  }

  const clips: GeneratedClip[] = project?.clips ?? [];
  const urlCount = urlsText.split("\n").map((u) => u.trim()).filter(Boolean).length;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Clipping</h1>
        <p className="text-neutral-400">
          Paste one or more YouTube video or Twitch VOD links (one per line). Each downloads locally, gets
          a transcript, and asks AI to pick the best moments, cut into vertical clips with captions ready
          to post. Progress is saved as it goes, so a dropped connection never loses your place.
        </p>
      </header>

      <form ref={formRef} onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="urls" className="text-sm font-medium text-neutral-300">
              Video URL{urlCount > 1 ? "s" : ""} {urlCount > 1 && <span className="text-neutral-500">({urlCount})</span>}
            </label>
            <span className="text-xs text-neutral-500">
              Re-pasting a URL you've already generated clips for reuses the download - no need to wait again.
            </span>
          </div>
          <textarea
            id="urls"
            required
            rows={3}
            placeholder={
              "https://www.youtube.com/watch?v=...\nhttps://www.twitch.tv/videos/...\n(one URL per line to batch-process multiple videos)"
            }
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            className="w-full resize-y rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-2.5 text-sm outline-none focus:border-neutral-500"
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

            {vertical && (
              <div className="space-y-1.5">
                <span className="text-sm font-medium text-neutral-300">Vertical reframe style</span>
                <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                  <RadioField
                    label="Blur padding (keeps full frame, blurred fill top/bottom)"
                    checked={reframeStyle === "blur"}
                    onChange={() => setReframeStyle("blur")}
                  />
                  <RadioField
                    label="Crop to fill (zooms in, no padding, may cut off edges)"
                    checked={reframeStyle === "crop"}
                    onChange={() => setReframeStyle("crop")}
                  />
                </div>
              </div>
            )}

            {burnCaptions && (
              <CheckboxField
                label="Animated word-by-word captions (highlights each word as it's spoken)"
                checked={animatedCaptions}
                onChange={setAnimatedCaptions}
              />
            )}

            <CheckboxField
              label="Review & edit clip picks before cutting (pause after AI selects moments)"
              checked={reviewBeforeCutting}
              onChange={setReviewBeforeCutting}
            />
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || urlCount === 0}
          className="w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Starting..." : urlCount > 1 ? `Generate clips (${urlCount} videos)` : "Generate clips"}
        </button>

        {submitError && <p className="text-sm text-red-400">{submitError}</p>}
      </form>

      {projects.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-neutral-300">Projects</h2>
          <div className="space-y-2">
            {projects.map((p) => (
              <div
                key={p.jobId}
                className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-sm ${
                  p.jobId === activeJobId ? "border-neutral-500 bg-neutral-900" : "border-neutral-800 bg-neutral-900/50"
                }`}
              >
                <button type="button" onClick={() => selectJob(p.jobId)} className="min-w-0 flex-1 truncate text-left">
                  <span className="font-medium">{p.title || p.url}</span>
                  <span className="ml-2 text-neutral-500">
                    {p.clips.length} clip{p.clips.length === 1 ? "" : "s"}
                  </span>
                </button>
                <StatusBadge status={p.status} />
                {p.status === "error" && (
                  <button
                    type="button"
                    onClick={() => handleRetry(p.jobId)}
                    className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleReuseSettings(p)}
                  className="text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
                >
                  Generate more
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(p.jobId)}
                  className="text-neutral-500 underline underline-offset-2 hover:text-red-400"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {project && (
        <>
          {project.log.length > 0 && (
            <section className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-neutral-300">Progress</h2>
                <StatusBadge status={project.status} />
              </div>

              <div className="flex items-start gap-2.5">
                {project.status === "running" && (
                  <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-blue-400" />
                )}
                <p className="text-sm text-neutral-200">{project.log[project.log.length - 1]}</p>
              </div>

              {project.progress && (
                <ProgressBar
                  label={project.progress.label}
                  current={project.progress.current}
                  total={project.progress.total}
                />
              )}

              <button
                type="button"
                onClick={() => setShowLog((v) => !v)}
                className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-300"
              >
                {showLog ? "Hide full log" : "Show full log"}
              </button>

              {showLog && (
                <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg bg-neutral-950 p-3 font-mono text-xs text-neutral-400">
                  {project.log.map((message, i) => (
                    <li key={i}>{message}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {project.status === "error" && project.errorMessage && (
            <div className="space-y-2 rounded-xl border border-red-900 bg-red-950/50 p-4 text-sm text-red-300">
              <p>{project.errorMessage}</p>
              <button
                type="button"
                onClick={() => handleRetry(project.jobId)}
                className="rounded-lg bg-red-900/50 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-900"
              >
                Retry (resumes from what's already done)
              </button>
            </div>
          )}

          {project.status === "reviewing" && (
            <section className="space-y-4 rounded-xl border border-amber-900 bg-amber-950/20 p-6">
              <div className="space-y-1">
                <h2 className="text-lg font-medium text-amber-200">Review clip picks</h2>
                <p className="text-sm text-amber-200/70">
                  The AI found {reviewDrafts.length} candidate clip{reviewDrafts.length === 1 ? "" : "s"}. Trim the
                  start/end times, rename, remove any you don't want, then approve to start cutting.
                </p>
              </div>

              <div className="space-y-3">
                {reviewDrafts.map((clip, i) => (
                  <div key={i} className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <input
                        type="text"
                        value={clip.title}
                        onChange={(e) => updateDraft(i, { title: e.target.value })}
                        className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-sm font-medium outline-none focus:border-neutral-500"
                      />
                      <button
                        type="button"
                        onClick={() => removeDraft(i)}
                        className="flex-shrink-0 text-sm text-neutral-500 underline underline-offset-2 hover:text-red-400"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1.5 text-xs text-neutral-400">
                        Start (s)
                        <input
                          type="number"
                          value={Math.round(clip.start)}
                          min={0}
                          onChange={(e) => updateDraft(i, { start: Number(e.target.value) })}
                          className="w-20 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm outline-none focus:border-neutral-500"
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-neutral-400">
                        End (s)
                        <input
                          type="number"
                          value={Math.round(clip.end)}
                          min={0}
                          onChange={(e) => updateDraft(i, { end: Number(e.target.value) })}
                          className="w-20 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm outline-none focus:border-neutral-500"
                        />
                      </label>
                      <span className="text-xs text-neutral-500">
                        {Math.max(0, Math.round(clip.end - clip.start))}s
                      </span>
                    </div>
                    <p className="text-sm text-neutral-400">{clip.reason}</p>
                  </div>
                ))}
                {reviewDrafts.length === 0 && (
                  <p className="text-sm text-amber-200/70">
                    No clips left - remove was maybe a bit too enthusiastic. Retry the project to get a fresh set of
                    candidates.
                  </p>
                )}
              </div>

              {reviewError && <p className="text-sm text-red-400">{reviewError}</p>}

              <button
                type="button"
                disabled={reviewSubmitting || reviewDrafts.length === 0}
                onClick={() => handleApproveCut(project.jobId)}
                className="w-full rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-medium text-black transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reviewSubmitting ? "Starting..." : `Approve & cut ${reviewDrafts.length} clip${reviewDrafts.length === 1 ? "" : "s"}`}
              </button>
            </section>
          )}
        </>
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
              {activeJobId && (
                <a
                  href={`/api/clips/${activeJobId}/download`}
                  className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-black hover:bg-white"
                >
                  Download all as ZIP
                </a>
              )}
            </div>
          </div>

          <p className="text-xs text-neutral-500">
            TikTok lets you bulk-upload up to 30 videos at once - unzip and select them all in the
            upload picker. Done with this project? Delete it above to free up disk space.
          </p>

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
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-medium">
                      <span className="text-neutral-500">{i + 1}.</span> {clip.title}
                    </h3>
                    <CopyButton
                      text={clip.title}
                      label="Copy title"
                      className="flex-shrink-0 text-xs text-blue-400 underline underline-offset-2 hover:text-blue-300"
                    />
                  </div>
                  <p className="text-sm text-neutral-400">{clip.reason}</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <a href={clip.url} download className="text-sm text-blue-400 underline underline-offset-2 hover:text-blue-300">
                      Download
                    </a>
                  </div>
                  <CaptionBox text={clip.socialCaption} />
                  <RegeneratePanel defaultOptions={project!.options} onRegenerate={(overrides) => handleRegenerateClip(i, overrides)} />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {clips.map((clip, i) => (
                <ClipRow
                  key={i}
                  clip={clip}
                  number={i + 1}
                  defaultOptions={project!.options}
                  onRegenerate={(overrides) => handleRegenerateClip(i, overrides)}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function ProgressBar({ label, current, total }: { label: string; current: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className="h-full rounded-full bg-blue-400 transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ProjectState["status"] }) {
  const styles =
    status === "done"
      ? "bg-green-950/50 text-green-300 border-green-900"
      : status === "error"
        ? "bg-red-950/50 text-red-300 border-red-900"
        : status === "reviewing"
          ? "bg-amber-950/50 text-amber-300 border-amber-900"
          : "bg-neutral-800 text-neutral-300 border-neutral-700";
  return <span className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-xs ${styles}`}>{status}</span>;
}

function ClipRow({
  clip,
  number,
  defaultOptions,
  onRegenerate,
}: {
  clip: GeneratedClip;
  number: number;
  defaultOptions: RegenerateDefaults;
  onRegenerate: (overrides: RegenerateOverrides) => Promise<void>;
}) {
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
          <h3 className="truncate font-medium">
            <span className="text-neutral-500">{number}.</span> {clip.title}
          </h3>
          <p className="truncate text-sm text-neutral-400">{clip.reason}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-3">
          <CopyButton
            text={clip.title}
            label="Copy title"
            className="text-sm text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
          />
          <CopyButton
            text={clip.socialCaption}
            label="Copy caption"
            className="text-sm text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
          />
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
          <RegeneratePanel defaultOptions={defaultOptions} onRegenerate={onRegenerate} />
        </div>
      )}
    </div>
  );
}

/**
 * Lets you re-render one already-picked clip (same moment/title/caption, untouched) with
 * different reframe/caption settings - for a clip that came out wrong, without
 * re-running highlight selection or touching any other clip.
 */
function RegeneratePanel({
  defaultOptions,
  onRegenerate,
}: {
  defaultOptions: RegenerateDefaults;
  onRegenerate: (overrides: RegenerateOverrides) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [vertical, setVertical] = useState(defaultOptions.vertical);
  const [reframeStyle, setReframeStyle] = useState(defaultOptions.reframeStyle);
  const [burnCaptions, setBurnCaptions] = useState(defaultOptions.burnCaptions);
  const [animatedCaptions, setAnimatedCaptions] = useState(defaultOptions.animatedCaptions);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
      >
        Regenerate this clip
      </button>
    );
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await onRegenerate({ vertical, reframeStyle, burnCaptions, animatedCaptions });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not regenerate this clip.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <p className="text-xs text-neutral-500">
        Re-renders this exact moment (same start/end, title, caption) with different settings -
        doesn't touch any other clip.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
        <CheckboxField label="Vertical 9:16" checked={vertical} onChange={setVertical} />
        <CheckboxField label="Burn in captions" checked={burnCaptions} onChange={setBurnCaptions} />
      </div>
      {vertical && (
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
          <RadioField label="Blur padding" checked={reframeStyle === "blur"} onChange={() => setReframeStyle("blur")} />
          <RadioField label="Crop to fill" checked={reframeStyle === "crop"} onChange={() => setReframeStyle("crop")} />
        </div>
      )}
      {burnCaptions && (
        <CheckboxField label="Animated word-by-word captions" checked={animatedCaptions} onChange={setAnimatedCaptions} />
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={submitting}
          onClick={handleSubmit}
          className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Regenerating..." : "Regenerate clip"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-neutral-500 underline underline-offset-2 hover:text-neutral-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A button that copies fixed text to the clipboard, showing "Copied!" briefly after. */
function CopyButton({ text, label, className }: { text: string; label: string; className: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) - fail silently,
      // the text is still selectable/copyable by hand from wherever it's shown.
    }
  }

  return (
    <button type="button" onClick={handleCopy} className={className}>
      {copied ? "Copied!" : label}
    </button>
  );
}

function CaptionBox({ text }: { text: string }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Caption &amp; hashtags
        </span>
        <CopyButton
          text={text}
          label="Copy"
          className="text-xs text-blue-400 underline underline-offset-2 hover:text-blue-300"
        />
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

function RadioField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-neutral-300">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 border-neutral-700 bg-neutral-950 accent-white"
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
