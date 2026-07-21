"use client";

// DuplicateModal — the Ad Creator's compose + DRY-RUN preview surface.
//
// Lets an operator describe one fresh ad (up to three image placements / primary
// text / headline / subheadline / destination + CTA) and PREVIEW where it would be
// recreated — one ad per selected store, on each store's OWN resolved Page. Built
// fresh, not copied. Nothing is written in this pass:
//   - the three dropzones are CLIENT-SIDE previews (thumbnail + aspect-ratio check),
//   - "✨ Generate Copy" sends the uploaded image(s) to the Anthropic API and fills
//     the three copy fields (editable afterwards),
//   - "Preview …" hits POST /api/duplicate/preview (a no-write planner),
//   - "Create paused ads" is disabled, gated on the Phase 1 live write engine.
//
// Presentational/self-contained: it owns its own form + preview state; the parent
// supplies the selection context and an onClose. Clean light theme.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import {
  X,
  ImageUp,
  CheckCircle2,
  TriangleAlert,
  Info,
  RotateCw,
  Trash2,
  Copy,
  Plus,
  Sparkles,
  Film,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import type {
  DuplicateMode,
  DuplicatePreviewResponse,
} from "@/app/api/duplicate/preview/route";
import type { CreateAdsResponse } from "@/app/api/create/route";

// The three placements, each with a target aspect ratio and a tolerance band.
interface Placement {
  key: "square" | "vertical" | "horizontal";
  label: string;
  spec: string;
  /** Acceptable aspect ratios (w/h) for this slot. */
  ratios: { ratio: number; name: string }[];
}

const PLACEMENTS: Placement[] = [
  {
    key: "square",
    label: "Square 1:1",
    spec: "1080 × 1080",
    ratios: [{ ratio: 1, name: "1:1" }],
  },
  {
    key: "vertical",
    label: "Vertical 4:5 / 9:16",
    spec: "1080 × 1350",
    ratios: [
      { ratio: 4 / 5, name: "4:5" },
      { ratio: 9 / 16, name: "9:16" },
    ],
  },
  {
    key: "horizontal",
    label: "Horizontal 1.91:1",
    spec: "1200 × 628",
    ratios: [{ ratio: 1200 / 628, name: "1.91:1" }],
  },
];

const ASPECT_TOLERANCE = 0.03; // ±~3%

// The three video aspect slots. Distinct from PLACEMENTS: link images want a 1.91:1
// horizontal, but VIDEO wants a true 16:9, and vertical video accepts 9:16 or 4:5.
// Each slot uploads independently; 2+ serve per placement via asset_feed_spec, 1 keeps
// the single-video creative.
interface VideoSlot {
  key: "square" | "vertical" | "horizontal";
  label: string;
  spec: string;
  ratios: { ratio: number; name: string }[];
}

const VIDEO_SLOTS: VideoSlot[] = [
  { key: "square", label: "Square 1:1", spec: "1080 × 1080", ratios: [{ ratio: 1, name: "1:1" }] },
  {
    key: "vertical",
    label: "Vertical 9:16",
    spec: "1080 × 1920",
    ratios: [
      { ratio: 9 / 16, name: "9:16" },
      { ratio: 4 / 5, name: "4:5" },
    ],
  },
  {
    key: "horizontal",
    label: "Horizontal 16:9",
    spec: "1920 × 1080",
    ratios: [{ ratio: 16 / 9, name: "16:9" }],
  },
];

// Full Meta call-to-action set. NO_BUTTON is the "no CTA" choice; the rest map
// 1:1 to Meta's call_to_action_type enum. Labels are the human-readable form.
const CTA_OPTIONS: { value: string; label: string }[] = [
  { value: "NO_BUTTON", label: "No Button" },
  { value: "SHOP_NOW", label: "Shop Now" },
  { value: "LEARN_MORE", label: "Learn More" },
  { value: "SIGN_UP", label: "Sign Up" },
  { value: "SUBSCRIBE", label: "Subscribe" },
  { value: "DOWNLOAD", label: "Download" },
  { value: "GET_OFFER", label: "Get Offer" },
  { value: "GET_QUOTE", label: "Get Quote" },
  { value: "GET_DIRECTIONS", label: "Get Directions" },
  { value: "CALL_NOW", label: "Call Now" },
  { value: "ORDER_NOW", label: "Order Now" },
  { value: "BUY_NOW", label: "Buy Now" },
  { value: "BOOK_TRAVEL", label: "Book Now" },
  { value: "CONTACT_US", label: "Contact Us" },
  { value: "SEND_MESSAGE", label: "Send Message" },
  { value: "APPLY_NOW", label: "Apply Now" },
  { value: "SEE_MENU", label: "See Menu" },
  { value: "REQUEST_TIME", label: "Request Time" },
  { value: "GET_SHOWTIMES", label: "Get Showtimes" },
  { value: "LISTEN_NOW", label: "Listen Now" },
  { value: "WATCH_MORE", label: "Watch More" },
  { value: "SAVE", label: "Save" },
];

interface ImageState {
  url: string; // object URL for the thumbnail
  file: File; // kept so we can base64-encode it for Generate Copy
  fileName: string;
  width: number;
  height: number;
  ratio: number;
  ok: boolean;
  matchedName: string | null;
  /** Set to the video slot key when this thumbnail was auto-derived from a video frame
   *  (so a video ad needs no separate image); absent when the operator uploaded it. */
  autoFrom?: VideoSlot["key"];
}

/** What the ad displays. Mirrors the create route's `format` field. */
type AdFormat = "single" | "video" | "carousel";

const FORMAT_OPTIONS: { value: AdFormat; label: string }[] = [
  { value: "single", label: "Static image" },
  { value: "video", label: "Video" },
  { value: "carousel", label: "Carousel" },
];

// Meta's child_attachments bounds.
const MIN_CARDS = 2;
const MAX_CARDS = 10;

/** One carousel card being composed: a square image + its own copy/link. */
interface CardState {
  id: number;
  image: ImageState | null;
  headline: string;
  description: string;
  link: string;
}

function emptyCard(id: number): CardState {
  return { id, image: null, headline: "", description: "", link: "" };
}

// Client-side ceiling for video picks; must stay <= the server's Blob token cap.
const MAX_VIDEO_MB = 512;

/**
 * One picked video and where it is in the pipeline:
 *   uploading   — browser -> Vercel Blob (direct; too big for a JSON API route)
 *   registering — Blob URL -> Meta act_<id>/advideos (Meta downloads it itself)
 *   processing  — Meta transcoding, polled via /api/video until ready
 *   ready       — usable in creatives (videoId is account-scoped, reused per store)
 */
interface VideoState {
  file: File;
  fileName: string;
  url: string; // object URL for the <video> preview
  sizeMB: number;
  duration: number | null;
  phase: "uploading" | "registering" | "processing" | "ready" | "error";
  uploadPct: number;
  processingPct: number | null;
  videoId: string | null;
  /** The uploaded Blob URL (kept so it can be deleted once Meta is done with it). */
  blobUrl: string | null;
  error: string | null;
  // Aspect-ratio check (advisory, like images) — null until the metadata probe lands.
  width: number | null;
  height: number | null;
  ratio: number | null;
  ok: boolean | null;
  matchedName: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Best-effort delete of an uploaded video's Blob object once Meta no longer needs it —
 * i.e. after processing settles to "ready" or "error". Fire-and-forget: a failed delete
 * just leaves the object for later cleanup and must never disrupt the ad flow.
 * `keepalive` lets it complete even if the modal closes right after.
 */
function cleanupVideoBlob(accountSlug: string, blobUrl: string): void {
  void fetch("/api/blob-upload", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountSlug, url: blobUrl }),
    keepalive: true,
  }).catch(() => {});
}

/** Closest target ratio + whether the image is within tolerance of any of them. */
function validateRatio(
  ratio: number,
  ratios: { ratio: number; name: string }[],
): { ok: boolean; matchedName: string | null } {
  let best: { name: string; diff: number } | null = null;
  for (const r of ratios) {
    const diff = Math.abs(ratio - r.ratio) / r.ratio;
    if (!best || diff < best.diff) best = { name: r.name, diff };
  }
  if (!best) return { ok: false, matchedName: null };
  return { ok: best.diff <= ASPECT_TOLERANCE, matchedName: best.name };
}

/** Read a File as a base64 data URL. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

// Longest-side cap for uploaded ad images. Meta re-compresses creatives anyway;
// shipping an 8MP phone photo as base64 JSON just slows the request down and risks
// serverless body limits.
const MAX_IMAGE_DIM = 2048;

// Encode each picked File exactly ONCE per session (keyed weakly so cleared images
// free their memory). Generate Copy + every create/resume chunk reuse the result.
const encodedImageCache = new WeakMap<File, Promise<string>>();

/**
 * File -> base64 data URL, downscaled to MAX_IMAGE_DIM on the longest side when
 * needed. PNGs stay PNG (alpha survives); everything else re-encodes as JPEG.
 * Falls back to the raw encoding if canvas work fails.
 */
function encodeImageFile(file: File): Promise<string> {
  const hit = encodedImageCache.get(file);
  if (hit) return hit;
  const job = (async () => {
    const raw = await readAsDataUrl(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Could not decode image"));
        el.src = raw;
      });
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scale = MAX_IMAGE_DIM / Math.max(w, h);
      if (!Number.isFinite(scale) || scale >= 1) return raw;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return raw;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return file.type === "image/png"
        ? canvas.toDataURL("image/png")
        : canvas.toDataURL("image/jpeg", 0.92);
    } catch {
      return raw;
    }
  })();
  encodedImageCache.set(file, job);
  return job;
}

/**
 * Grab a representative still frame from a video File, client-side, as a downscaled JPEG
 * (same longest-side cap as uploaded images). Used to AUTO-FILL the required square
 * thumbnail — and give Generate Copy something to read — so a video ad needs no separate
 * image upload. Returns null (and console.warns the reason) if the browser can't
 * decode/seek/paint the file; the caller then leaves the manual thumbnail slot open and
 * shows a note. Never throws.
 *
 * Robustness notes: several engines won't decode or paint a frame from a fully-detached,
 * never-played <video>, so we (1) attach it off-screen, (2) prime the decoder with a muted
 * play/pause, and (3) wait for an actually-presented frame via requestVideoFrameCallback
 * where available before drawing.
 */
type FrameGrab =
  | { ok: true; file: File; url: string; width: number; height: number }
  | { ok: false; stage: string };

async function extractVideoFrameFile(file: File): Promise<FrameGrab> {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.cssText =
    "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";

  const waitFor = (event: string, ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => {
        cleanup();
        reject(new Error(`${event} timeout`));
      }, ms);
      const ok = () => {
        cleanup();
        resolve();
      };
      const bad = () => {
        cleanup();
        reject(new Error(`${event} failed`));
      };
      const cleanup = () => {
        clearTimeout(to);
        video.removeEventListener(event, ok);
        video.removeEventListener("error", bad);
      };
      video.addEventListener(event, ok, { once: true });
      video.addEventListener("error", bad, { once: true });
    });

  let stage = "start";
  try {
    document.body.appendChild(video);
    video.src = objectUrl;
    stage = "metadata";
    await waitFor("loadedmetadata", 8_000);
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw new Error("no video dimensions");

    // Prime the decoder: several browsers paint a BLANK frame from a video that has never
    // played. A muted play (allowed by autoplay policy) then pause populates a real frame.
    // BOUNDED — a hung play() must never freeze the whole grab (that shows as "no
    // thumbnail, no note"); seeking alone often still yields a frame.
    stage = "prime";
    try {
      await Promise.race([
        video.play().then(() => video.pause()),
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error("play timeout")), 3_000)),
      ]);
    } catch {
      // priming failed/timed out — fall through to the seek.
    }

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    // A quarter in (capped at ~2s) dodges the black/blank opening frame; always a positive
    // offset so `seeked` actually fires (seeking to 0 while at 0 does not).
    const seekTo = duration > 0 ? Math.min(duration * 0.25, 2) : 0.5;
    stage = "seek";
    const seeked = waitFor("seeked", 8_000);
    video.currentTime = seekTo;
    await seeked;

    // Wait until a frame is actually presented, where supported — `seeked` can fire a beat
    // before the frame is paintable.
    const rvfc = (
      video as unknown as { requestVideoFrameCallback?: (cb: () => void) => number }
    ).requestVideoFrameCallback;
    if (typeof rvfc === "function") {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 800);
        rvfc.call(video, () => {
          clearTimeout(t);
          resolve();
        });
      });
    }

    stage = "draw";
    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    // Same-origin object URL, so the canvas is not tainted; toDataURL would throw (caught
    // below) if the draw were ever blocked.
    ctx.drawImage(video, 0, 0, cw, ch);
    stage = "encode";
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    if (!dataUrl.startsWith("data:image/jpeg") || dataUrl.length < 100) {
      throw new Error("empty frame");
    }
    const blob = await (await fetch(dataUrl)).blob();
    const frameFile = new File([blob], "video-frame.jpg", { type: "image/jpeg" });
    // Prime the encode cache so Generate Copy / create reuse the frame verbatim.
    encodedImageCache.set(frameFile, Promise.resolve(dataUrl));
    return { ok: true, file: frameFile, url: dataUrl, width: cw, height: ch };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[thumb] frame extraction failed at ${stage}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, stage };
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.remove();
    video.removeAttribute("src");
    try {
      video.load();
    } catch {
      /* ignore */
    }
  }
}

function Dropzone({
  placement,
  image,
  onPick,
  onClear,
}: {
  placement: Placement;
  image: ImageState | undefined;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file && file.type.startsWith("image/")) onPick(file);
  };

  // Each slot previews at its own target aspect so the three are distinguishable.
  const aspectClass =
    placement.key === "vertical"
      ? "aspect-[4/5]"
      : placement.key === "horizontal"
        ? "aspect-[1.91/1]"
        : "aspect-square";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="whitespace-nowrap text-fas-12 font-medium text-ink">{placement.label}</span>
        <span
          className="min-w-0 truncate font-mono text-fas-11 text-ink-muted"
          title={placement.spec}
        >
          {placement.spec}
        </span>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={[
          "relative flex w-full items-center justify-center overflow-hidden rounded-fas-md border border-dashed transition-colors",
          aspectClass,
          dragOver
            ? "border-accent bg-accent-tint"
            : "border-hairline-strong bg-surface-sunken hover:border-accent/60 hover:bg-accent-tint/40",
        ].join(" ")}
      >
        {image ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image.url}
              alt={`${placement.label} preview`}
              className="h-full w-full object-cover"
            />
            <button
              type="button"
              onClick={onClear}
              aria-label={`Remove ${placement.label} image`}
              className="fas-focus absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-fas-sm bg-surface/90 text-ink-muted shadow-fas-card hover:text-ink"
            >
              <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="fas-focus flex h-full w-full flex-col items-center justify-center gap-1.5 px-2 text-center text-ink-muted hover:text-ink"
          >
            <ImageUp size={20} strokeWidth={1.75} aria-hidden="true" />
            <span className="text-fas-11">Drop or choose</span>
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => handleFiles(e.target.files)}
          aria-label={`${placement.label} image`}
        />
      </div>
      {image ? (
        image.ok ? (
          <span className="inline-flex items-center gap-1 text-fas-11 text-status-ok">
            <CheckCircle2 size={12} strokeWidth={2} aria-hidden="true" />
            {image.matchedName} · {image.width}×{image.height}
          </span>
        ) : (
          <span
            className="inline-flex items-start gap-1 text-fas-11 text-status-mismatch"
            role="alert"
          >
            <TriangleAlert size={12} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
            <span>
              {image.width}×{image.height} — off the {placement.ratios.map((r) => r.name).join(" / ")}{" "}
              ratio. It may be cropped.
            </span>
          </span>
        )
      ) : (
        <span className="text-fas-11 text-ink-muted">No image yet</span>
      )}
    </div>
  );
}

/** Human status line for a picked video's pipeline phase. */
function videoStatusLine(v: VideoState): { text: string; tone: "ok" | "busy" | "bad" } {
  switch (v.phase) {
    case "uploading":
      return { text: `Uploading… ${Math.round(v.uploadPct)}%`, tone: "busy" };
    case "registering":
      return { text: "Handing to Meta…", tone: "busy" };
    case "processing":
      return {
        text: `Meta is processing${v.processingPct != null ? ` ${Math.round(v.processingPct)}%` : ""}…`,
        tone: "busy",
      };
    case "ready":
      return { text: `Ready · ${v.sizeMB.toFixed(1)}MB`, tone: "ok" };
    case "error":
      return { text: v.error ?? "Upload failed", tone: "bad" };
  }
}

function VideoDropzone({
  slot,
  video,
  onPick,
  onClear,
}: {
  slot: VideoSlot;
  video: VideoState | undefined;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file && file.type.startsWith("video/")) onPick(file);
  };

  // Each slot previews at its own target aspect so the three are distinguishable.
  const aspectClass =
    slot.key === "vertical"
      ? "aspect-[9/16]"
      : slot.key === "horizontal"
        ? "aspect-video"
        : "aspect-square";

  const status = video ? videoStatusLine(video) : null;
  // Advisory ratio badge — shown once the metadata probe has run (ok !== null).
  const showRatio = video && video.ok !== null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="whitespace-nowrap text-fas-12 font-medium text-ink">{slot.label}</span>
        <span
          className="min-w-0 truncate font-mono text-fas-11 text-ink-muted"
          title={`${slot.spec} · MP4 / MOV · up to ${MAX_VIDEO_MB}MB`}
        >
          {slot.spec}
        </span>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={[
          "relative flex w-full items-center justify-center overflow-hidden rounded-fas-md border border-dashed transition-colors",
          aspectClass,
          dragOver
            ? "border-accent bg-accent-tint"
            : "border-hairline-strong bg-surface-sunken hover:border-accent/60 hover:bg-accent-tint/40",
        ].join(" ")}
      >
        {video ? (
          <>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- operator's own upload preview */}
            <video src={video.url} controls muted playsInline className="h-full w-full object-contain" />
            <button
              type="button"
              onClick={onClear}
              aria-label={`Remove ${slot.label} video`}
              className="fas-focus absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-fas-sm bg-surface/90 text-ink-muted shadow-fas-card hover:text-ink"
            >
              <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="fas-focus flex h-full w-full flex-col items-center justify-center gap-1.5 px-2 text-center text-ink-muted hover:text-ink"
          >
            <Film size={20} strokeWidth={1.75} aria-hidden="true" />
            <span className="text-fas-11">Drop or choose</span>
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="sr-only"
          onChange={(e) => handleFiles(e.target.files)}
          aria-label={`${slot.label} video`}
        />
      </div>
      {status ? (
        <span
          className={[
            "inline-flex items-center gap-1 text-fas-11",
            status.tone === "ok"
              ? "text-status-ok"
              : status.tone === "bad"
                ? "text-status-mismatch"
                : "text-ink-muted",
          ].join(" ")}
          role={status.tone === "bad" ? "alert" : undefined}
        >
          {status.tone === "ok" ? (
            <CheckCircle2 size={12} strokeWidth={2} aria-hidden="true" />
          ) : status.tone === "bad" ? (
            <TriangleAlert size={12} strokeWidth={2} aria-hidden="true" />
          ) : (
            <RotateCw size={12} strokeWidth={2} aria-hidden="true" className="animate-spin" />
          )}
          {status.text}
        </span>
      ) : (
        <span className="text-fas-11 text-ink-muted">No video yet</span>
      )}
      {showRatio ? (
        video!.ok ? (
          <span className="inline-flex items-center gap-1 text-fas-11 text-status-ok">
            <CheckCircle2 size={12} strokeWidth={2} aria-hidden="true" />
            {video!.matchedName} · {video!.width}×{video!.height}
          </span>
        ) : (
          <span className="inline-flex items-start gap-1 text-fas-11 text-status-mismatch" role="alert">
            <TriangleAlert size={12} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
            <span>
              {video!.width}×{video!.height} — off the {slot.ratios.map((r) => r.name).join(" / ")}{" "}
              ratio. It may be cropped.
            </span>
          </span>
        )
      ) : null}
    </div>
  );
}

function Field({
  label,
  helper,
  htmlFor,
  required = false,
  children,
}: {
  label: string;
  helper?: string;
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-fas-14 font-medium text-ink">
        {label}
        {required ? (
          <span className="ml-0.5 text-accent" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {helper ? <p className="text-fas-12 text-ink-muted">{helper}</p> : null}
    </div>
  );
}

function PlanView({ plan }: { plan: DuplicatePreviewResponse }) {
  return (
    <div className="flex flex-col gap-3 rounded-fas-md border border-hairline bg-surface-sunken p-3">
      <div className="flex flex-wrap items-center gap-2 text-fas-12">
        <span className="rounded-fas-pill border border-hairline bg-surface px-2.5 py-0.5 font-mono text-ink-muted">
          {plan.count} ad{plan.count === 1 ? "" : "s"}
        </span>
        <span className="rounded-fas-pill border border-hairline bg-surface px-2.5 py-0.5 font-mono text-ink-muted">
          {plan.stores} store{plan.stores === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1 rounded-fas-pill border border-status-ok-border bg-status-ok-bg px-2.5 py-0.5 font-mono text-status-ok">
          <CheckCircle2 size={11} strokeWidth={2} aria-hidden="true" /> {plan.ready} ready
        </span>
        {plan.blocked > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-fas-pill border border-status-mismatch-border bg-status-mismatch-bg px-2.5 py-0.5 font-mono text-status-mismatch">
            <TriangleAlert size={11} strokeWidth={2} aria-hidden="true" /> {plan.blocked} blocked
          </span>
        ) : null}
      </div>

      <ul className="flex flex-col divide-y divide-hairline">
        {plan.rows.map((r) => (
          <li key={r.campaignId} className="flex items-start gap-2.5 py-2">
            <span className="mt-px shrink-0">
              {r.ready ? (
                <CheckCircle2 size={15} strokeWidth={2} className="text-status-ok" aria-hidden="true" />
              ) : (
                <TriangleAlert size={15} strokeWidth={2} className="text-status-mismatch" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-mono text-fas-12 font-medium text-ink">
                  {r.storeCode ?? <span className="font-sans text-ink-muted" aria-hidden="true">—</span>}
                </span>
                <span className="truncate text-fas-12 text-ink-muted" title={r.campaignName}>
                  {r.campaignName}
                </span>
              </div>
              <div className="mt-0.5 text-fas-11 text-ink-faint">
                {r.ready ? (
                  <>
                    Target Page{" "}
                    <span className="font-mono text-ink-mono" title={r.targetPage ?? undefined}>
                      {r.targetPage}
                    </span>
                    {r.mappedPage && !r.pageMatches ? (
                      <span className="ml-1 inline-flex items-center gap-1 text-split">
                        <TriangleAlert size={11} strokeWidth={2} aria-hidden="true" />
                        {plan.mode === "create"
                          ? "this store's live ads run on a different Page"
                          : `live Page differs from the mapping (${r.mappedPage})`}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-status-mismatch">{r.blockReason}</span>
                )}
              </div>
              {r.adsetName && r.adsetMatch !== false ? (
                <div className="mt-0.5 text-fas-11">
                  {r.adsetMatch === true ? (
                    <span className="inline-flex items-center gap-1 text-status-ok">
                      <CheckCircle2 size={11} strokeWidth={2} aria-hidden="true" />
                      Ad set: {r.adsetName}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-ink-muted">
                      <Info size={11} strokeWidth={2} aria-hidden="true" />
                      Ad set: {r.adsetName} (verified at create)
                    </span>
                  )}
                </div>
              ) : null}
              {plan.mode === "duplicate" && r.nameMatch != null ? (
                <div className="mt-0.5 text-fas-11">
                  {r.nameMatch === true ? (
                    <span className="inline-flex items-center gap-1 text-status-ok">
                      <CheckCircle2 size={11} strokeWidth={2} aria-hidden="true" />
                      {r.nameNote}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-ink-muted">
                      <Info size={11} strokeWidth={2} aria-hidden="true" />
                      {r.nameNote}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <p className="flex items-center gap-1.5 text-fas-11 text-ink-muted">
        <Info size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
        Preview only — no ads were {plan.mode === "create" ? "created" : "duplicated"}.
      </p>
    </div>
  );
}

/**
 * Live countdown from Meta's regain estimate. Purely informational — the resume
 * button stays enabled throughout (the estimate is often pessimistic).
 */
function RetryCountdown({ minutes }: { minutes: number }) {
  const [left, setLeft] = useState(minutes * 60);
  useEffect(() => {
    setLeft(minutes * 60);
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [minutes]);
  if (left <= 0) return <>Meta&apos;s estimate has elapsed — resuming should work now.</>;
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <>
      Meta estimates <span className="font-mono tabular-nums">{mm}:{ss}</span> until the limit
      lifts.
    </>
  );
}

/**
 * Merge a resume run's results onto the previous partial run: later rows win per
 * campaign, the stop flags (timedOut/rateLimited/remaining) come from the latest run.
 */
export function mergeCreateResults(
  prev: CreateAdsResponse,
  next: CreateAdsResponse,
): CreateAdsResponse {
  const redone = new Set(next.results.map((r) => r.campaignId));
  const results = [...prev.results.filter((r) => !redone.has(r.campaignId)), ...next.results];
  const created = results.filter((r) => r.ok).length;
  return {
    ...next,
    count: results.length,
    created,
    failed: results.length - created,
    results,
  };
}

/** Per-store results of a live create — never a blanket "all succeeded". */
function CreateResultView({
  result,
  creating,
  onResume,
}: {
  result: CreateAdsResponse;
  /** True while a (re)run is in flight — disables the resume button. */
  creating: boolean;
  /** Re-run just the remaining campaign ids. */
  onResume: () => void;
}) {
  const remaining = result.remaining ?? [];
  const stopped = (result.rateLimited || result.timedOut) && remaining.length > 0;
  return (
    <div className="flex flex-col gap-3 rounded-fas-md border border-hairline bg-surface-sunken p-3">
      <div className="flex flex-wrap items-center gap-2 text-fas-12">
        <span className="rounded-fas-pill border border-hairline bg-surface px-2.5 py-0.5 font-mono text-ink-muted">
          {result.count} attempted
        </span>
        <span className="inline-flex items-center gap-1 rounded-fas-pill border border-status-ok-border bg-status-ok-bg px-2.5 py-0.5 font-mono text-status-ok">
          <CheckCircle2 size={11} strokeWidth={2} aria-hidden="true" /> {result.created} created
        </span>
        {result.failed > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-fas-pill border border-status-mismatch-border bg-status-mismatch-bg px-2.5 py-0.5 font-mono text-status-mismatch">
            <TriangleAlert size={11} strokeWidth={2} aria-hidden="true" /> {result.failed} failed
          </span>
        ) : null}
      </div>

      {stopped ? (
        <div
          className="flex flex-col gap-2 rounded-fas-md border border-status-mismatch-border bg-status-mismatch-bg px-3 py-2.5"
          role="alert"
        >
          <p className="text-fas-12 font-semibold text-status-mismatch">
            {result.rateLimited
              ? `Meta's rate limit paused this run — ${remaining.length} store${remaining.length === 1 ? "" : "s"} still to do.`
              : `Stopped at the time limit — ${remaining.length} store${remaining.length === 1 ? "" : "s"} not attempted yet.`}
          </p>
          {result.rateLimited ? (
            <p className="text-fas-12 text-status-mismatch">
              {result.retryAfterMinutes && result.retryAfterMinutes > 0 ? (
                <RetryCountdown minutes={result.retryAfterMinutes} />
              ) : (
                "Give it a minute, then resume."
              )}
            </p>
          ) : null}
          <div>
            <button
              type="button"
              onClick={onResume}
              disabled={creating}
              className="fas-focus inline-flex items-center gap-2 rounded-fas-md border border-status-mismatch-border bg-surface px-3.5 py-1.5 text-fas-12 font-semibold text-status-mismatch transition-colors hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCw
                size={13}
                strokeWidth={2}
                aria-hidden="true"
                className={creating ? "animate-spin" : ""}
              />
              {creating ? "Resuming…" : `Resume (${remaining.length} remaining)`}
            </button>
          </div>
        </div>
      ) : null}

      <ul className="flex max-h-56 flex-col divide-y divide-hairline overflow-y-auto">
        {result.results.map((r) => (
          <li key={r.campaignId} className="flex items-start gap-2.5 py-2">
            <span className="mt-px shrink-0">
              {r.ok ? (
                <CheckCircle2 size={15} strokeWidth={2} className="text-status-ok" aria-hidden="true" />
              ) : (
                <TriangleAlert size={15} strokeWidth={2} className="text-status-mismatch" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-mono text-fas-12 font-medium text-ink">
                  {r.storeCode ?? <span className="font-sans text-ink-muted" aria-hidden="true">—</span>}
                </span>
                <span className="truncate text-fas-12 text-ink-muted" title={r.campaignName}>
                  {r.campaignName}
                </span>
              </div>
              <div className="mt-0.5 text-fas-11 text-ink-faint">
                {r.ok ? (
                  <>
                    Created ad <span className="font-mono text-ink-mono">{r.adId}</span> on Page{" "}
                    <span className="font-mono text-ink-mono">{r.pageId}</span>
                  </>
                ) : (
                  <span className="text-status-mismatch">{r.error}</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <p className="flex items-center gap-1.5 text-fas-11 text-ink-muted">
        <Info size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
        Created PAUSED — review each in Ads Manager (policy review is per-ad) before activating.
      </p>
    </div>
  );
}

/** A trimmed http(s) URL is a valid destination. */
function isValidUrl(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export default function DuplicateModal({
  mode,
  accountSlug,
  campaignIds,
  storeCount,
  writeEnabled,
  onClose,
}: {
  mode: DuplicateMode;
  accountSlug: string;
  campaignIds: string[];
  storeCount: number;
  /** Whether this account has Meta WRITE credentials (enables live creation). */
  writeEnabled: boolean;
  onClose: () => void;
}) {
  const n = campaignIds.length;
  const isCreate = mode === "create";

  const [primaryText, setPrimaryText] = useState("");
  const [headline, setHeadline] = useState("");
  const [subheadline, setSubheadline] = useState("");
  const [adName, setAdName] = useState("");
  // Duplicate mode only: optional name for the CREATED ads; blank keeps the source
  // ad's name (adName stays the finder).
  const [newAdName, setNewAdName] = useState("");
  const [adsetName, setAdsetName] = useState("");
  const [link, setLink] = useState("");
  const [cta, setCta] = useState<string>("");
  // Duplicate mode only: optional utm_content replacement across the clone's
  // tracking (url_tags + destination URLs); blank keeps the source ad's own.
  const [utmContent, setUtmContent] = useState("");

  const [images, setImages] = useState<Partial<Record<Placement["key"], ImageState>>>({});

  // Ad format (create mode): static image vs video vs carousel.
  const [format, setFormat] = useState<AdFormat>("single");
  // One video per aspect slot (same shape as `images`). Each uploads independently.
  const [videos, setVideos] = useState<Partial<Record<VideoSlot["key"], VideoState>>>({});
  // Per-slot generation counter so a cleared/replaced video cancels ONLY its own
  // in-flight pipeline, leaving sibling slots' uploads running.
  const videoGenRef = useRef<Record<string, number>>({ square: 0, vertical: 0, horizontal: 0 });
  // Carousel cards, in display order.
  const [cards, setCards] = useState<CardState[]>([emptyCard(1), emptyCard(2)]);
  const nextCardId = useRef(3);

  const [previewing, setPreviewing] = useState(false);
  const [plan, setPlan] = useState<DuplicatePreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Generate Copy (Anthropic) state.
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  // Set when auto-deriving a thumbnail from a picked video's frame failed, so the operator
  // isn't left staring at an empty thumbnail with no explanation.
  const [autoThumbErr, setAutoThumbErr] = useState<string | null>(null);

  // Live create (write) state. idle → confirm → creating.
  const [phase, setPhase] = useState<"idle" | "creating">("idle");
  const [createResult, setCreateResult] = useState<CreateAdsResponse | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  // Chunked-run progress ("Creating… 40/120"), null outside a run.
  const [createProgress, setCreateProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

  const dialogRef = useRef<HTMLDivElement>(null);

  const imageList = useMemo(
    () => Object.values(images).filter((i): i is ImageState => !!i),
    [images],
  );
  const hasImage = imageList.length > 0;

  // Submit gating. Duplicate needs only the ad name (creative is inherited).
  // Create requires EVERY field — name, URL, all copy, a CTA, and the media for the
  // chosen format: an image (static) or a PROCESSED video + square thumbnail (video).
  const linkOk = isValidUrl(link);
  const adNameOk = adName.trim().length > 0;
  const isVideo = isCreate && format === "video";
  const isCarousel = isCreate && format === "carousel";
  const videoList = useMemo(
    () => Object.values(videos).filter((v): v is VideoState => !!v),
    [videos],
  );
  // At least one slot fully processed, and NONE mid-pipeline — never fire a create that
  // silently drops a slot the operator is still waiting on. A slot in `error` doesn't
  // block (it just won't count); an empty slot is fine.
  const anyVideoReady = videoList.some((v) => v.phase === "ready" && !!v.videoId);
  const anyVideoBusy = videoList.some(
    (v) => v.phase === "uploading" || v.phase === "registering" || v.phase === "processing",
  );
  const videoReady = anyVideoReady && !anyVideoBusy;
  const hasThumb = !!images.square;
  // Every card needs its square image + a headline; the shared headline/subheadline
  // fields don't apply (each card carries its own).
  const cardsReady =
    cards.length >= MIN_CARDS && cards.every((c) => c.image && c.headline.trim().length > 0);
  // Video creatives carry the destination link ONLY in the CTA, so "No Button" is
  // not a valid choice for them.
  const ctaOk = isVideo ? cta.length > 0 && cta !== "NO_BUTTON" : cta.length > 0;
  const mediaOk = isVideo ? videoReady && hasThumb : isCarousel ? cardsReady : hasImage;
  const copyOk =
    primaryText.trim().length > 0 &&
    (isCarousel || (headline.trim().length > 0 && subheadline.trim().length > 0));
  const createReady = adNameOk && linkOk && copyOk && ctaOk && mediaOk;
  const canPreview = n > 0 && !previewing && (isCreate ? createReady : adNameOk);
  // Live create is gated on: real write creds, a complete form for the mode (create
  // needs every field; duplicate needs only the source ad name — its creative is
  // cloned, not typed — plus no video override still mid-pipeline), and not busy.
  const canCreate =
    writeEnabled &&
    (isCreate ? createReady : adNameOk && !anyVideoBusy) &&
    phase === "idle" &&
    !previewing;

  // Escape to close, plus full focus management: on open, save the previously
  // focused element and move focus into the dialog (first field); trap Tab inside
  // the dialog so it can't escape to the obscured page; restore focus on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const firstField = document.getElementById("dm-adname") as HTMLElement | null;
    (firstField ?? dialogRef.current)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose, isCreate]);

  // Revoke object URLs on unmount to avoid leaks.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => {
    return () => {
      Object.values(imagesRef.current).forEach((img) => {
        if (img) URL.revokeObjectURL(img.url);
      });
    };
  }, []);

  const pickImage = useCallback((placement: Placement, file: File) => {
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      const { width, height } = probe;
      const ratio = width / height;
      const { ok, matchedName } = validateRatio(ratio, placement.ratios);
      setImages((prev) => {
        const old = prev[placement.key];
        if (old) URL.revokeObjectURL(old.url);
        return {
          ...prev,
          [placement.key]: { url, file, fileName: file.name, width, height, ratio, ok, matchedName },
        };
      });
    };
    probe.onerror = () => URL.revokeObjectURL(url);
    probe.src = url;
  }, []);

  const clearImage = useCallback((key: Placement["key"]) => {
    setImages((prev) => {
      const old = prev[key];
      if (old) URL.revokeObjectURL(old.url);
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const clearVideo = useCallback((key: VideoSlot["key"]) => {
    videoGenRef.current[key] = (videoGenRef.current[key] ?? 0) + 1; // cancel this slot's chain
    setVideos((prev) => {
      const old = prev[key];
      if (old) URL.revokeObjectURL(old.url);
      const next = { ...prev };
      delete next[key];
      return next;
    });
    // Drop the auto-derived thumbnail if it came from THIS video (a manual upload, with no
    // autoFrom, stays put). The frame's url is a data: URL, so there's nothing to revoke.
    setImages((prev) => {
      if (prev.square?.autoFrom !== key) return prev;
      const next = { ...prev };
      delete next.square;
      return next;
    });
  }, []);

  // ── Carousel card handlers ──────────────────────────────────────────────────
  const addCard = useCallback(() => {
    setCards((prev) =>
      prev.length >= MAX_CARDS ? prev : [...prev, emptyCard(nextCardId.current++)],
    );
  }, []);

  const removeCard = useCallback((id: number) => {
    setCards((prev) => {
      if (prev.length <= MIN_CARDS) return prev;
      const gone = prev.find((c) => c.id === id);
      if (gone?.image) URL.revokeObjectURL(gone.image.url);
      return prev.filter((c) => c.id !== id);
    });
  }, []);

  const moveCard = useCallback((id: number, dir: -1 | 1) => {
    setCards((prev) => {
      const i = prev.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }, []);

  const setCardField = useCallback(
    (id: number, field: "headline" | "description" | "link", value: string) => {
      setCards((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
    },
    [],
  );

  const pickCardImage = useCallback((id: number, file: File) => {
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      const { width, height } = probe;
      const ratio = width / height;
      const { ok, matchedName } = validateRatio(ratio, PLACEMENTS[0]!.ratios);
      setCards((prev) =>
        prev.map((c) => {
          if (c.id !== id) return c;
          if (c.image) URL.revokeObjectURL(c.image.url);
          return {
            ...c,
            image: { url, file, fileName: file.name, width, height, ratio, ok, matchedName },
          };
        }),
      );
    };
    probe.onerror = () => URL.revokeObjectURL(url);
    probe.src = url;
  }, []);

  const clearCardImage = useCallback((id: number) => {
    setCards((prev) =>
      prev.map((c) => {
        if (c.id !== id || !c.image) return c;
        URL.revokeObjectURL(c.image.url);
        return { ...c, image: null };
      }),
    );
  }, []);

  // Revoke card image object URLs on unmount (same pattern as the placements).
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  useEffect(() => {
    return () => {
      cardsRef.current.forEach((c) => {
        if (c.image) URL.revokeObjectURL(c.image.url);
      });
    };
  }, []);

  // Revoke every slot's video object URL + cancel all polling on unmount.
  const videosRef = useRef(videos);
  videosRef.current = videos;
  useEffect(() => {
    const gens = videoGenRef.current; // stable ref object; capture for cleanup
    return () => {
      for (const key of Object.keys(gens)) gens[key] = (gens[key] ?? 0) + 1;
      Object.values(videosRef.current).forEach((v) => {
        if (v) URL.revokeObjectURL(v.url);
      });
    };
  }, []);

  /**
   * The full per-slot video pipeline, kicked off at pick time so the operator fills in
   * copy while Meta processes: browser -> Blob (direct client upload), Blob URL ->
   * /api/video (Meta pulls it), then poll /api/video until ready. Each aspect slot runs
   * its own chain keyed by `slot`; a bumped per-slot generation (clear/replace/close)
   * abandons only that slot's chain at the next checkpoint.
   */
  const pickVideo = useCallback(
    (slot: VideoSlot, file: File) => {
      const key = slot.key;
      videoGenRef.current[key] = (videoGenRef.current[key] ?? 0) + 1;
      const gen = videoGenRef.current[key];
      const url = URL.createObjectURL(file);
      const sizeMB = file.size / (1024 * 1024);
      // Update this slot only when its generation is still current.
      const patch = (fn: (v: VideoState) => VideoState) =>
        setVideos((prev) => {
          const cur = prev[key];
          if (!cur || videoGenRef.current[key] !== gen) return prev;
          return { ...prev, [key]: fn(cur) };
        });

      setVideos((prev) => {
        const old = prev[key];
        if (old) URL.revokeObjectURL(old.url);
        return {
          ...prev,
          [key]: {
            file,
            fileName: file.name,
            url,
            sizeMB,
            duration: null,
            phase: "uploading",
            uploadPct: 0,
            processingPct: null,
            videoId: null,
            blobUrl: null,
            error: null,
            width: null,
            height: null,
            ratio: null,
            ok: null,
            matchedName: null,
          },
        };
      });

      if (sizeMB > MAX_VIDEO_MB) {
        patch((v) => ({
          ...v,
          phase: "error",
          error: `Video is ${sizeMB.toFixed(0)}MB — the limit is ${MAX_VIDEO_MB}MB.`,
        }));
        return;
      }

      // Metadata probe: duration (informational) + dimensions for the advisory ratio check.
      const probe = document.createElement("video");
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        const width = probe.videoWidth;
        const height = probe.videoHeight;
        const ratio = height > 0 ? width / height : null;
        const { ok, matchedName } =
          ratio != null ? validateRatio(ratio, slot.ratios) : { ok: false, matchedName: null };
        patch((v) => ({
          ...v,
          duration: probe.duration,
          width,
          height,
          ratio,
          ok: ratio != null ? ok : null,
          matchedName,
        }));
      };
      probe.src = url;

      void (async () => {
        try {
          const blob = await upload(`ad-videos/${file.name}`, file, {
            access: "public",
            handleUploadUrl: "/api/blob-upload",
            clientPayload: JSON.stringify({ accountSlug }),
            // Upload in 8MB parts. Besides per-part retries (good for 100MB+ videos),
            // this is what makes the progress counter real: the default single-request
            // mode streams via fetch, whose "progress" counts bytes buffered by the
            // browser — not bytes sent — so the counter freezes. Multipart progress
            // advances as parts actually complete.
            multipart: true,
            onUploadProgress: ({ loaded, percentage }) => {
              // Derive the percentage from raw bytes against the known file size rather
              // than trusting the SDK's `percentage`: on some transports it reports a
              // total of 0 and pins the value to 0% for the whole upload (then jumps to
              // 100%). `file.size` is always accurate here, so loaded/size never does.
              const pct =
                file.size > 0 ? Math.min(100, (loaded / file.size) * 100) : percentage;
              patch((v) => ({ ...v, uploadPct: Math.max(v.uploadPct, pct) }));
            },
          });
          const blobUrl = blob.url;
          // Cleared/replaced mid-upload: Meta was never handed this URL, so the object
          // is a pure orphan — safe to delete right away.
          if (videoGenRef.current[key] !== gen) {
            cleanupVideoBlob(accountSlug, blobUrl);
            return;
          }
          patch((v) => ({ ...v, phase: "registering", blobUrl }));

          const res = await fetch("/api/video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountSlug, url: blob.url, name: file.name }),
          });
          const body = (await res.json().catch(() => ({}))) as {
            videoId?: string;
            error?: string;
          };
          if (!res.ok || !body.videoId) {
            throw new Error(body.error ?? `Video registration failed (HTTP ${res.status})`);
          }
          if (videoGenRef.current[key] !== gen) return;
          const videoId = body.videoId;
          patch((v) => ({ ...v, phase: "processing", videoId }));

          for (;;) {
            await sleep(3_000);
            if (videoGenRef.current[key] !== gen) return;
            const sres = await fetch(
              `/api/video?account=${encodeURIComponent(accountSlug)}&videoId=${encodeURIComponent(videoId)}`,
            );
            const sbody = (await sres.json().catch(() => ({}))) as {
              status?: string;
              progress?: number | null;
              error?: string;
            };
            if (!sres.ok) throw new Error(sbody.error ?? "Video status check failed");
            if (videoGenRef.current[key] !== gen) return;
            if (sbody.status === "ready") {
              patch((v) => ({ ...v, phase: "ready", processingPct: 100 }));
              // Meta has the processed copy now — the Blob upload is no longer needed.
              cleanupVideoBlob(accountSlug, blobUrl);
              return;
            }
            if (sbody.status === "error") {
              // A confirmed processing failure is also a safe deletion point: Meta is
              // done with the file and won't download it again.
              cleanupVideoBlob(accountSlug, blobUrl);
              throw new Error("Meta could not process this video — try a different file.");
            }
            patch((v) => ({ ...v, processingPct: sbody.progress ?? v.processingPct }));
          }
        } catch (err) {
          if (videoGenRef.current[key] !== gen) return;
          patch((v) => ({
            ...v,
            phase: "error",
            error: err instanceof Error ? err.message : "Video upload failed",
          }));
        }
      })();

      // In parallel with the upload: derive the square thumbnail from a frame of this
      // video, so a video ad needs no separate image upload (and Generate Copy has an
      // image to read). Never clobbers a thumbnail the operator uploaded; the square
      // slot's own frame is preferred over a non-square slot's.
      void (async () => {
        setAutoThumbErr(null);
        const frame = await extractVideoFrameFile(file);
        if (videoGenRef.current[key] !== gen) return;
        if (!frame.ok) {
          setAutoThumbErr(
            `Couldn't auto-make a thumbnail from this video (stopped at "${frame.stage}"). Drop a thumbnail image below to continue.`,
          );
          return;
        }
        setImages((prev) => {
          const cur = prev.square;
          if (cur && !cur.autoFrom) return prev; // operator's own upload always wins
          if (cur?.autoFrom === "square" && key !== "square") return prev; // keep square-derived
          return {
            ...prev,
            square: {
              url: frame.url,
              file: frame.file,
              fileName: frame.file.name,
              width: frame.width,
              height: frame.height,
              ratio: frame.height > 0 ? frame.width / frame.height : 1,
              ok: true,
              matchedName: null,
              autoFrom: key,
            },
          };
        });
      })();
    },
    [accountSlug],
  );

  // Generate Copy reads whatever media the current format shows: card images for a
  // carousel, the placement images otherwise.
  const hasGenSource = isCarousel ? cards.some((c) => c.image) : hasImage;

  async function generateCopy() {
    // The generate-copy API accepts at most 3 images; a carousel can have 10 cards,
    // so send the first three — plenty of signal for the model.
    const files = (
      isCarousel
        ? cards.map((c) => c.image?.file).filter((f): f is File => !!f)
        : imageList.map((i) => i.file)
    ).slice(0, 3);
    if (files.length === 0 || generating) return;
    setGenerating(true);
    setGenError(null);
    try {
      const dataUrls = await Promise.all(files.map((f) => encodeImageFile(f)));
      const res = await fetch("/api/generate-copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountSlug,
          mode,
          images: dataUrls.map((dataUrl) => ({ dataUrl })),
          link: link.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        primaryText?: string;
        headline?: string;
        subheadline?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `Generation failed (HTTP ${res.status})`);
      }
      setPrimaryText(body.primaryText ?? "");
      setHeadline(body.headline ?? "");
      setSubheadline(body.subheadline ?? "");
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function runPreview() {
    setPreviewing(true);
    setError(null);
    try {
      const res = await fetch("/api/duplicate/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountSlug,
          campaignIds,
          mode,
          adName: isCreate ? undefined : adName,
          adsetName: adsetName.trim() || undefined,
          link: link.trim() || undefined,
          creative: {
            primaryText,
            headline,
            subheadline,
            link: link.trim() || undefined,
            cta: cta || undefined,
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Preview failed (HTTP ${res.status})`);
      }
      setPlan((await res.json()) as DuplicatePreviewResponse);
    } catch (err) {
      setPlan(null);
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  // How many stores each POST /api/create carries. Small chunks keep every request
  // far from the server's 50s budget, surface per-store results as they land, and
  // dovetail with the rateLimited/timedOut resume contract.
  const CREATE_CHUNK = 20;

  // LIVE WRITE — create the paused ads for real. Triggered by the primary button, only in
  // create mode with write creds (canCreate gates it). Media is encoded ONCE (memoized,
  // downscaled) and the campaign ids run in chunks of CREATE_CHUNK, merging per-store
  // results into the panel as each chunk lands. With `idsOverride` (the resume path) it
  // re-runs ONLY those ids and merges onto the previous partial result. A rateLimited or
  // timedOut chunk stops the run; untried ids join `remaining` so resume covers them.
  async function doCreate(idsOverride?: string[]) {
    const ids = idsOverride ?? campaignIds;
    if (ids.length === 0) return;
    setPhase("creating");
    setCreateError(null);
    if (!idsOverride) setCreateResult(null);
    setCreateProgress({ done: 0, total: ids.length });
    try {
      const entries = Object.entries(images).filter(
        (e): e is [Placement["key"], ImageState] => !!e[1],
      );
      // Video mode sends ONLY the square slot (it rides along as the thumbnail);
      // carousel sends no placement images at all (each card carries its own).
      const sendEntries = isCarousel ? [] : isVideo ? entries.filter(([k]) => k === "square") : entries;
      const imgs = await Promise.all(
        sendEntries.map(async ([placement, st]) => ({
          placement,
          dataUrl: await encodeImageFile(st.file),
        })),
      );
      const cardPayload = isCarousel
        ? await Promise.all(
            cards.map(async (c) => ({
              dataUrl: await encodeImageFile(c.image!.file),
              headline: c.headline.trim(),
              description: c.description.trim() || undefined,
              link: c.link.trim() || undefined,
            })),
          )
        : undefined;
      // One entry per uploaded, ready slot (in canonical slot order). Create/video:
      // the ad's own videos (2+ serve per placement; 1 keeps the single-video
      // creative). Duplicate: OPTIONAL per-aspect overrides — sent only when at
      // least one slot was filled; empty means every ratio carries over from each
      // store's source ad.
      const readyVideoSlots = VIDEO_SLOTS.flatMap((s) => {
        const v = videos[s.key];
        return v?.phase === "ready" && v.videoId
          ? [{ placement: s.key, videoId: v.videoId }]
          : [];
      });
      const videoPayload = isVideo
        ? readyVideoSlots
        : !isCreate && readyVideoSlots.length > 0
          ? readyVideoSlots
          : undefined;
      const payloadBase = {
        accountSlug,
        mode,
        format: isVideo ? "video" : isCarousel ? "carousel" : "single",
        videos: videoPayload,
        cards: cardPayload,
        adName: adName.trim(),
        newAdName: isCreate ? undefined : newAdName.trim() || undefined,
        utmContent: isCreate ? undefined : utmContent.trim() || undefined,
        adsetName: adsetName.trim() || undefined,
        creative: {
          primaryText,
          headline,
          subheadline,
          link: link.trim(),
          cta: cta || undefined,
        },
        images: imgs,
      };

      let merged: CreateAdsResponse | null = idsOverride ? createResult : null;
      for (let i = 0; i < ids.length; i += CREATE_CHUNK) {
        const chunk = ids.slice(i, i + CREATE_CHUNK);
        const res = await fetch("/api/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payloadBase, campaignIds: chunk }),
        });
        const body = (await res.json().catch(() => ({}))) as CreateAdsResponse & {
          error?: string;
        };
        if (!res.ok) {
          throw new Error(body.error ?? `Create failed (HTTP ${res.status})`);
        }
        merged = merged ? mergeCreateResults(merged, body) : body;
        const stopped = body.rateLimited || body.timedOut;
        if (stopped) {
          // Untried chunks join the suspended chunk's leftovers for the resume.
          merged = {
            ...merged,
            remaining: [...(body.remaining ?? []), ...ids.slice(i + CREATE_CHUNK)],
          };
        }
        setCreateResult(merged);
        setCreateProgress({ done: Math.min(i + chunk.length, ids.length), total: ids.length });
        if (stopped) break;
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setPhase("idle");
      setCreateProgress(null);
    }
  }

  const titleId = useMemo(() => "duplicate-modal-title", []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6"
      style={{ backgroundColor: "var(--fas-scrim)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="my-6 flex max-h-[calc(100vh-3rem)] w-full max-w-[56rem] flex-col rounded-fas-lg border border-hairline bg-surface shadow-fas-modal focus:outline-none"
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-hairline px-6 py-5">
          <div className="flex items-start gap-2.5">
            <span
              className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-fas-md bg-accent-tint text-accent"
              aria-hidden="true"
            >
              {isCreate ? <Plus size={16} strokeWidth={2} /> : <Copy size={16} strokeWidth={2} />}
            </span>
            <div>
              <h2 id={titleId} className="font-display text-fas-18 font-bold tracking-tight text-ink">
                {isCreate
                  ? `Create new ad on ${storeCount} store${storeCount === 1 ? "" : "s"}`
                  : `Duplicate ad to ${storeCount} store${storeCount === 1 ? "" : "s"}`}
              </h2>
              <p className="mt-0.5 text-fas-13 text-ink-muted">
                {isCreate
                  ? "Build one fresh ad on each selected store’s own Page."
                  : "Clone the named ad onto each selected store’s own Page."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="fas-focus -mr-1 rounded-fas-md p-2 text-ink-muted hover:bg-surface-sunken hover:text-ink"
          >
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
          {/* Ad name — top of both modes. Duplicate: the exact ad to clone from
              each campaign. Create: the name for the new ad. */}
          <Field
            label={isCreate ? "Ad name" : "Ad name to duplicate"}
            helper={
              isCreate
                ? "The name for the new ad on each store."
                : "The exact ad name to clone from each selected campaign."
            }
            htmlFor="dm-adname"
            required
          >
            <input
              id="dm-adname"
              type="text"
              value={adName}
              onChange={(e) => setAdName(e.target.value)}
              placeholder={isCreate ? "Spring Sale" : "Template"}
              required
              className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink placeholder:text-ink-muted"
            />
          </Field>

          {/* Duplicate only: what to NAME the clones. Blank keeps the source name. */}
          {!isCreate ? (
            <Field
              label="New ad name"
              helper="Optional. The name for the created ads. Blank keeps the source ad's name."
              htmlFor="dm-newadname"
            >
              <input
                id="dm-newadname"
                type="text"
                value={newAdName}
                onChange={(e) => setNewAdName(e.target.value)}
                placeholder="e.g. June '26 Promo"
                className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink placeholder:text-ink-muted"
              />
            </Field>
          ) : null}

          <Field
            label="Ad set name"
            helper="Optional. Publish into an ad set whose name contains this, in each campaign. Blank uses the campaign's active ad set."
            htmlFor="dm-adsetname"
          >
            <input
              id="dm-adsetname"
              type="text"
              value={adsetName}
              onChange={(e) => setAdsetName(e.target.value)}
              placeholder="e.g. Bucket Sale"
              className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink placeholder:text-ink-muted"
            />
          </Field>

          {/* Format — create mode only. Video is gated on write creds because the
              upload registers against the ad account immediately. */}
          {isCreate ? (
            <div className="flex flex-col gap-2">
              <span className="text-fas-11 font-semibold uppercase tracking-caps text-ink-faint">
                Format
              </span>
              <div
                className="inline-flex gap-1 self-start rounded-fas-md border border-hairline bg-surface-sunken p-1"
                role="radiogroup"
                aria-label="Ad format"
              >
                {FORMAT_OPTIONS.map((o) => {
                  const disabled = o.value === "video" && !writeEnabled;
                  const active = format === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={disabled}
                      title={
                        disabled
                          ? "Add a Meta write token (META_SYSTEM_USER_TOKEN) to upload videos."
                          : undefined
                      }
                      onClick={() => {
                        setFormat(o.value);
                        // Video can't use "No Button" (the CTA carries the link);
                        // clear a stale pick so the select doesn't sit on a value
                        // that's no longer offered.
                        if (o.value === "video" && cta === "NO_BUTTON") setCta("");
                      }}
                      className={[
                        "fas-focus rounded-fas-sm px-3 py-1.5 text-fas-12 font-semibold transition-colors",
                        active
                          ? "bg-surface text-ink shadow-fas-card"
                          : disabled
                            ? "cursor-not-allowed text-ink-faint opacity-60"
                            : "text-ink-muted hover:text-ink",
                      ].join(" ")}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Media — first, so copy can be generated from it. */}
          <div className="flex flex-col gap-3">
            <span className="text-fas-11 font-semibold uppercase tracking-caps text-ink-faint">
              {!isCreate
                ? "Image override (optional)"
                : isVideo
                  ? "Video + thumbnail"
                  : isCarousel
                    ? "Cards"
                    : "Images"}
              {isCreate ? <span className="ml-0.5 text-accent" aria-hidden="true">*</span> : null}
            </span>
            {isVideo ? (
              <>
                <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-4">
                  {VIDEO_SLOTS.map((s) => (
                    <VideoDropzone
                      key={s.key}
                      slot={s}
                      video={videos[s.key]}
                      onPick={(file) => pickVideo(s, file)}
                      onClear={() => clearVideo(s.key)}
                    />
                  ))}
                  <Dropzone
                    placement={{ ...PLACEMENTS[0]!, label: "Thumbnail 1:1" }}
                    image={images.square}
                    onPick={(file) => pickImage(PLACEMENTS[0]!, file)}
                    onClear={() => clearImage("square")}
                  />
                </div>
                <p className="text-fas-11 text-ink-muted">
                  Upload up to three ratios — each placement (feed, Stories/Reels, in-stream)
                  serves its matching video. One is enough to start; the thumbnail is required —
                  it auto-fills from your video&apos;s first frame, or drop your own to replace it.
                </p>
              </>
            ) : isCarousel ? (
              <div className="flex flex-col gap-3">
                {cards.map((card, i) => (
                  <div
                    key={card.id}
                    className="flex flex-col gap-3 rounded-fas-md border border-hairline bg-surface-sunken p-3 sm:flex-row sm:items-start"
                  >
                    <div className="w-full shrink-0 sm:w-44">
                      <Dropzone
                        placement={{ ...PLACEMENTS[0]!, label: `Card ${i + 1}` }}
                        image={card.image ?? undefined}
                        onPick={(file) => pickCardImage(card.id, file)}
                        onClear={() => clearCardImage(card.id)}
                      />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <input
                        type="text"
                        value={card.headline}
                        onChange={(e) => setCardField(card.id, "headline", e.target.value)}
                        placeholder="Card headline *"
                        aria-label={`Card ${i + 1} headline`}
                        className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3 py-2 text-fas-13 text-ink placeholder:text-ink-muted"
                      />
                      <input
                        type="text"
                        value={card.description}
                        onChange={(e) => setCardField(card.id, "description", e.target.value)}
                        placeholder="Description (optional)"
                        aria-label={`Card ${i + 1} description`}
                        className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3 py-2 text-fas-13 text-ink placeholder:text-ink-muted"
                      />
                      <input
                        type="url"
                        value={card.link}
                        onChange={(e) => setCardField(card.id, "link", e.target.value)}
                        placeholder="Link (optional — defaults to the Destination URL)"
                        aria-label={`Card ${i + 1} link`}
                        className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3 py-2 text-fas-13 text-ink placeholder:text-ink-muted"
                      />
                    </div>
                    <div className="flex shrink-0 gap-1 sm:flex-col">
                      <button
                        type="button"
                        onClick={() => moveCard(card.id, -1)}
                        disabled={i === 0}
                        aria-label={`Move card ${i + 1} up`}
                        className="fas-focus inline-flex h-7 w-7 items-center justify-center rounded-fas-sm border border-hairline bg-surface text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <ChevronUp size={14} strokeWidth={2} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveCard(card.id, 1)}
                        disabled={i === cards.length - 1}
                        aria-label={`Move card ${i + 1} down`}
                        className="fas-focus inline-flex h-7 w-7 items-center justify-center rounded-fas-sm border border-hairline bg-surface text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeCard(card.id)}
                        disabled={cards.length <= MIN_CARDS}
                        aria-label={`Remove card ${i + 1}`}
                        className="fas-focus inline-flex h-7 w-7 items-center justify-center rounded-fas-sm border border-hairline bg-surface text-ink-muted hover:text-status-mismatch disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={addCard}
                    disabled={cards.length >= MAX_CARDS}
                    className="fas-focus inline-flex items-center gap-2 rounded-fas-md border border-hairline bg-surface px-3.5 py-2 text-fas-13 font-semibold text-ink transition-colors hover:border-hairline-strong disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus size={14} strokeWidth={2} aria-hidden="true" />
                    Add card ({cards.length}/{MAX_CARDS})
                  </button>
                  <span className="text-fas-11 text-ink-muted">
                    Cards without a link use the Destination URL (or the store&apos;s mapped
                    landing page).
                  </span>
                </div>
              </div>
            ) : !isCreate ? (
              // Duplicate mode: ONE slot. The upload REPLACES each clone's image
              // (and feeds Generate Copy); blank keeps each store's own image.
              <>
                <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3">
                  <Dropzone
                    placement={PLACEMENTS[0]!}
                    image={images.square}
                    onPick={(file) => pickImage(PLACEMENTS[0]!, file)}
                    onClear={() => clearImage("square")}
                  />
                </div>
                <p className="text-fas-11 text-ink-muted">
                  Replaces the cloned ad&apos;s image on every selected store. Blank keeps
                  each store&apos;s own image. (Video source ads use the video overrides
                  below instead.)
                </p>
              </>
            ) : (
              <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3">
                {PLACEMENTS.map((p) => (
                  <Dropzone
                    key={p.key}
                    placement={p}
                    image={images[p.key]}
                    onPick={(file) => pickImage(p, file)}
                    onClear={() => clearImage(p.key)}
                  />
                ))}
              </div>
            )}

            {autoThumbErr && !images.square ? (
              <p className="text-fas-11 text-status-mismatch" role="status">
                {autoThumbErr}
              </p>
            ) : null}

            {/* ✨ Generate Copy — suppressed (dimmed) until an image is uploaded. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={generateCopy}
                disabled={!hasGenSource || generating}
                title={
                  hasGenSource
                    ? undefined
                    : isVideo
                      ? "Add a video (its frame becomes the thumbnail) or upload one to generate copy"
                      : "Upload an image to generate copy"
                }
                className={[
                  "fas-focus inline-flex items-center gap-2 rounded-fas-pill border px-3.5 py-1.5 text-fas-13 font-semibold transition-all duration-[110ms] ease-fas",
                  hasGenSource && !generating
                    ? "border-accent/40 bg-accent-tint text-accent hover:border-accent hover:bg-accent-tint/80"
                    : "cursor-not-allowed border-hairline bg-surface-sunken text-ink-faint opacity-70",
                ].join(" ")}
              >
                {generating ? (
                  <RotateCw size={14} strokeWidth={2} aria-hidden="true" className="animate-spin" />
                ) : (
                  <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
                )}
                {generating ? "Generating…" : "Generate Copy"}
              </button>
              <span className="text-fas-11 text-ink-muted">
                {hasGenSource
                  ? "Powered by Anthropic — fills the copy fields from your image. Edit anything after."
                  : isVideo
                    ? "Add a video — its first frame becomes the thumbnail and feeds the copy — or upload your own."
                    : "Upload an image to generate copy with AI."}
              </span>
            </div>
            {genError ? (
              <p
                className="rounded-fas-md border border-status-mismatch-border bg-status-mismatch-bg px-3 py-2 text-fas-12 text-status-mismatch"
                role="alert"
              >
                {genError}
              </p>
            ) : null}
          </div>

          {/* Duplicate mode: OPTIONAL per-aspect video replacements. An empty slot
              keeps that ratio's video from each store's own source ad; a filled slot
              swaps in the new video. Needs write creds (uploads register against the
              ad account immediately), so hidden without them. */}
          {!isCreate && writeEnabled ? (
            <div className="flex flex-col gap-3">
              <span className="text-fas-11 font-semibold uppercase tracking-caps text-ink-faint">
                Video overrides (optional)
              </span>
              <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3">
                {VIDEO_SLOTS.map((s) => (
                  <VideoDropzone
                    key={s.key}
                    slot={s}
                    video={videos[s.key]}
                    onPick={(file) => pickVideo(s, file)}
                    onClear={() => clearVideo(s.key)}
                  />
                ))}
              </div>
              <p className="text-fas-11 text-ink-muted">
                Only for duplicating video ads. Leave a slot empty to keep that ratio&apos;s
                video from each store&apos;s source ad; drop a file to replace it everywhere.
              </p>
            </div>
          ) : null}

          <Field
            label="Primary text"
            helper="Main body / top text (maps to link_data.message)."
            htmlFor="dm-primary"
            required={isCreate}
          >
            <textarea
              id="dm-primary"
              value={primaryText}
              onChange={(e) => setPrimaryText(e.target.value)}
              rows={3}
              placeholder="Write the main body copy shown above the creative…"
              className="fas-focus w-full resize-y rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink placeholder:text-ink-muted"
            />
          </Field>

          {/* Shared headline/subheadline don't apply to carousels — each card has its own. */}
          {!isCarousel ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Headline"
              helper="Overwrites the link preview title (link_data.name)."
              htmlFor="dm-headline"
              required={isCreate}
            >
              <input
                id="dm-headline"
                type="text"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                placeholder="Headline here"
                className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink placeholder:text-ink-muted"
              />
            </Field>
            <Field
              label="Subheadline"
              helper="Facebook only — ignored on Instagram (link_data.description)."
              htmlFor="dm-subheadline"
              required={isCreate}
            >
              <input
                id="dm-subheadline"
                type="text"
                value={subheadline}
                onChange={(e) => setSubheadline(e.target.value)}
                placeholder="Subheadline here"
                className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink placeholder:text-ink-muted"
              />
            </Field>
          </div>
          ) : null}

          {/* Destination + CTA. URL is required in create mode, optional in duplicate. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={isCreate ? "Destination URL" : "Destination URL (optional)"}
              helper={
                isCreate
                  ? "Default link. Any store with a mapped landing page (the url column in your mapping CSV) uses its own instead."
                  : "If left blank, each ad inherits that store's existing Template link & CTA."
              }
              htmlFor="dm-link"
              required={isCreate}
            >
              <input
                id="dm-link"
                type="url"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://www.example.com/store-name"
                required={isCreate}
                aria-invalid={link.trim().length > 0 && !linkOk}
                className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink placeholder:text-ink-muted aria-[invalid=true]:border-status-mismatch aria-[invalid=true]:focus:border-status-mismatch"
              />
            </Field>
            <Field
              label={isCreate ? "Call-to-action" : "Call-to-action (optional)"}
              helper={
                isVideo ? "Video ads require a button — it carries the destination link." : undefined
              }
              htmlFor="dm-cta"
              required={isCreate}
            >
              <select
                id="dm-cta"
                value={cta}
                onChange={(e) => setCta(e.target.value)}
                className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink"
              >
                <option value="">{isCreate ? "Select…" : "— None —"}</option>
                {CTA_OPTIONS.filter((c) => !(isVideo && c.value === "NO_BUTTON")).map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Duplicate only: replace the utm_content tracking parameter. Input is
              sanitized live — a UTM value never legitimately contains spaces/&/#,
              and any of them would corrupt the query string it lands in. */}
          {!isCreate ? (
            <Field
              label="UTM content (optional)"
              helper="Replaces the utm_content tracking parameter wherever the cloned ad carries it — its URL parameters and url_tags. Blank keeps each store's own tracking as-is."
              htmlFor="dm-utmcontent"
            >
              <input
                id="dm-utmcontent"
                type="text"
                value={utmContent}
                onChange={(e) => setUtmContent(e.target.value.replace(/[\s&#]/g, ""))}
                placeholder="e.g. fall_prep_aug26"
                className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink placeholder:text-ink-muted"
              />
            </Field>
          ) : null}

          {/* Error */}
          {error ? (
            <p
              className="rounded-fas-md border border-status-mismatch-border bg-status-mismatch-bg px-3 py-2 text-fas-12 text-status-mismatch"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          {/* Plan (dry-run preview) */}
          {plan ? <PlanView plan={plan} /> : null}

          {/* Live create error + per-store results */}
          {createError ? (
            <p
              className="rounded-fas-md border border-status-mismatch-border bg-status-mismatch-bg px-3 py-2 text-fas-12 text-status-mismatch"
              role="alert"
            >
              {createError}
            </p>
          ) : null}
          {createResult ? (
            <CreateResultView
              result={createResult}
              creating={phase === "creating"}
              onResume={() => void doCreate(createResult.remaining ?? [])}
            />
          ) : null}
        </div>

        {/* Footer actions — one explicit step. Every ad is PAUSED (reversible), so no
            separate confirm gate; the caption + count make the scale clear up front. */}
        <div className="flex shrink-0 flex-col gap-2.5 border-t border-hairline px-5 py-4">
          <p className="text-fas-12 text-ink-muted">
            {isCreate ? "Creates" : "Duplicates"} <span className="font-semibold text-ink">{n}</span> paused ad
            {n === 1 ? "" : "s"} across <span className="font-semibold text-ink">{storeCount}</span> store
            {storeCount === 1 ? "" : "s"}
            {isCreate ? (
              ". "
            ) : (
              <>
                {" "}
                — each store&apos;s own <span className="font-mono text-ink-mono">{adName || "…"}</span> ad, cloned
                as-is (any typed copy or uploaded image/video above overrides just that piece)
                {newAdName.trim() ? (
                  <>
                    , created as <span className="font-mono text-ink-mono">{newAdName.trim()}</span>
                  </>
                ) : null}
                .{" "}
              </>
            )}
            Each is created <span className="font-semibold text-ink">PAUSED</span> — nothing goes live until you
            activate it in Ads Manager.
          </p>
          <div className="flex items-center justify-end gap-2.5">
            {/* SECONDARY — the no-write dry-run. */}
            <button
              type="button"
              onClick={runPreview}
              disabled={!canPreview}
              title={
                isCreate && !createReady
                  ? "Fill every required field (and add an image) to preview."
                  : !isCreate && !adNameOk
                    ? "Enter the ad name to duplicate to preview."
                    : undefined
              }
              className="fas-focus inline-flex items-center gap-2 rounded-fas-md border border-hairline bg-surface px-4 py-2 text-fas-13 font-semibold text-ink transition-colors hover:border-hairline-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCw size={14} strokeWidth={2} aria-hidden="true" className={previewing ? "animate-spin" : ""} />
              {previewing
                ? "Previewing…"
                : isCreate
                  ? `Preview new ad (${n})`
                  : `Preview duplication (${n})`}
            </button>
            {/* PRIMARY — the live write, one click. Gated on write creds + a complete form. */}
            <button
              type="button"
              onClick={() => void doCreate()}
              disabled={!canCreate}
              title={
                !writeEnabled
                  ? "Add a Meta write token (META_SYSTEM_USER_TOKEN) to enable live creation."
                  : isCreate
                    ? !createReady
                      ? isVideo
                        ? anyVideoBusy
                          ? "Wait for the video(s) to finish processing."
                          : "Fill every required field, plus at least one video and a square thumbnail."
                        : isCarousel
                          ? "Every card needs a square image and a headline (2 cards minimum)."
                          : "Fill every required field (and add an image) first."
                      : undefined
                    : !adNameOk
                      ? "Enter the exact ad name to duplicate."
                      : anyVideoBusy
                        ? "Wait for the override video(s) to finish processing."
                        : undefined
              }
              className="fas-focus inline-flex items-center gap-2 rounded-fas-md bg-accent px-4 py-2 text-fas-13 font-semibold text-ink-on-accent transition-colors duration-[110ms] ease-fas hover:bg-accent-hover active:bg-accent-pressed disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-faint disabled:hover:bg-surface-sunken"
            >
              {phase === "creating" ? (
                <RotateCw size={14} strokeWidth={2} aria-hidden="true" className="animate-spin" />
              ) : isCreate ? (
                <Plus size={14} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Copy size={14} strokeWidth={2} aria-hidden="true" />
              )}
              {phase === "creating"
                ? createProgress && createProgress.total > CREATE_CHUNK
                  ? `${isCreate ? "Creating" : "Duplicating"}… ${createProgress.done}/${createProgress.total}`
                  : isCreate
                    ? "Creating…"
                    : "Duplicating…"
                : isCreate
                  ? `Create ${n} paused ad${n === 1 ? "" : "s"}`
                  : `Duplicate ${n} paused ad${n === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
