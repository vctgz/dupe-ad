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

/** Read a File as a base64 data URL (for the Generate Copy request). */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
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

/** Per-store results of a live create — never a blanket "all succeeded". */
function CreateResultView({ result }: { result: CreateAdsResponse }) {
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
  const [link, setLink] = useState("");
  const [cta, setCta] = useState<string>("");

  const [images, setImages] = useState<Partial<Record<Placement["key"], ImageState>>>({});

  const [previewing, setPreviewing] = useState(false);
  const [plan, setPlan] = useState<DuplicatePreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Generate Copy (Anthropic) state.
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // Live create (write) state. idle → confirm → creating.
  const [phase, setPhase] = useState<"idle" | "confirm" | "creating">("idle");
  const [createResult, setCreateResult] = useState<CreateAdsResponse | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);

  const imageList = useMemo(
    () => Object.values(images).filter((i): i is ImageState => !!i),
    [images],
  );
  const hasImage = imageList.length > 0;

  // Submit gating. Duplicate needs only the ad name (creative is inherited).
  // Create requires EVERY field — name, URL, all copy, a CTA, and an image.
  const linkOk = isValidUrl(link);
  const adNameOk = adName.trim().length > 0;
  const createReady =
    adNameOk &&
    linkOk &&
    primaryText.trim().length > 0 &&
    headline.trim().length > 0 &&
    subheadline.trim().length > 0 &&
    cta.length > 0 &&
    hasImage;
  const canPreview = n > 0 && !previewing && (isCreate ? createReady : adNameOk);
  // Live create is gated on: create mode, real write creds, a complete form, and
  // not already busy. Duplicate-mode live cloning is a deliberate follow-up.
  const canCreate = isCreate && writeEnabled && createReady && phase === "idle" && !previewing;

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

  async function generateCopy() {
    if (!hasImage || generating) return;
    setGenerating(true);
    setGenError(null);
    try {
      const dataUrls = await Promise.all(imageList.map((img) => readAsDataUrl(img.file)));
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

  // LIVE WRITE — create the paused ads for real. Only reachable from the confirm
  // step, only in create mode with write creds. Sends the uploaded image(s) so the
  // server can register the account-scoped image_hash and build a per-store creative.
  async function doCreate() {
    setPhase("creating");
    setCreateError(null);
    setCreateResult(null);
    try {
      const entries = Object.entries(images).filter(
        (e): e is [Placement["key"], ImageState] => !!e[1],
      );
      const imgs = await Promise.all(
        entries.map(async ([placement, st]) => ({
          placement,
          dataUrl: await readAsDataUrl(st.file),
        })),
      );
      const res = await fetch("/api/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountSlug,
          mode,
          adName: adName.trim(),
          campaignIds,
          creative: {
            primaryText,
            headline,
            subheadline,
            link: link.trim(),
            cta: cta || undefined,
          },
          images: imgs,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as CreateAdsResponse & { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `Create failed (HTTP ${res.status})`);
      }
      setCreateResult(body);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setPhase("idle");
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

          {/* Images — first, so copy can be generated from them. */}
          <div className="flex flex-col gap-3">
            <span className="text-fas-11 font-semibold uppercase tracking-caps text-ink-faint">
              Images
              {isCreate ? <span className="ml-0.5 text-accent" aria-hidden="true">*</span> : null}
            </span>
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

            {/* ✨ Generate Copy — suppressed (dimmed) until an image is uploaded. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={generateCopy}
                disabled={!hasImage || generating}
                title={hasImage ? undefined : "Upload an image to generate copy"}
                className={[
                  "fas-focus inline-flex items-center gap-2 rounded-fas-pill border px-3.5 py-1.5 text-fas-13 font-semibold transition-all duration-[110ms] ease-fas",
                  hasImage && !generating
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
                {hasImage
                  ? "Powered by Anthropic — fills the copy fields from your image. Edit anything after."
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
                aria-invalid={isCreate && link.trim().length > 0 && !linkOk}
                className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink placeholder:text-ink-muted aria-[invalid=true]:border-status-mismatch aria-[invalid=true]:focus:border-status-mismatch"
              />
            </Field>
            <Field
              label={isCreate ? "Call-to-action" : "Call-to-action (optional)"}
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
                {CTA_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

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
          {createResult ? <CreateResultView result={createResult} /> : null}
        </div>

        {/* Footer actions */}
        {phase === "idle" ? (
          <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-hairline px-5 py-4">
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
            {/* PRIMARY — the live write. Gated on write creds + a complete form. */}
            <button
              type="button"
              onClick={() => setPhase("confirm")}
              disabled={!canCreate}
              title={
                !isCreate
                  ? "Live duplication is coming next — use Preview for now."
                  : !writeEnabled
                    ? "Add a Meta write token (META_SYSTEM_USER_TOKEN) to enable live creation."
                    : !createReady
                      ? "Fill every required field (and add an image) first."
                      : undefined
              }
              className="fas-focus inline-flex items-center gap-2 rounded-fas-md bg-accent px-4 py-2 text-fas-13 font-semibold text-ink-on-accent transition-colors duration-[110ms] ease-fas hover:bg-accent-hover active:bg-accent-pressed disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-faint disabled:hover:bg-surface-sunken"
            >
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
              Create paused ads
            </button>
          </div>
        ) : (
          // Confirm + creating: an explicit, deliberate gate before any live write.
          <div className="flex shrink-0 flex-col gap-2.5 border-t border-hairline px-5 py-4">
            <p className="text-fas-12 text-ink-muted">
              Create <span className="font-semibold text-ink">{n}</span> paused ad{n === 1 ? "" : "s"} across{" "}
              <span className="font-semibold text-ink">{storeCount}</span> store{storeCount === 1 ? "" : "s"}? Each is
              created <span className="font-semibold text-ink">PAUSED</span> — nothing goes live until you activate it
              in Ads Manager.
            </p>
            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setPhase("idle")}
                disabled={phase === "creating"}
                className="fas-focus rounded-fas-md border border-hairline bg-surface px-4 py-2 text-fas-13 font-semibold text-ink transition-colors hover:border-hairline-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={doCreate}
                disabled={phase === "creating"}
                className="fas-focus inline-flex items-center gap-2 rounded-fas-md bg-accent px-4 py-2 text-fas-13 font-semibold text-ink-on-accent transition-colors duration-[110ms] ease-fas hover:bg-accent-hover active:bg-accent-pressed disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-faint disabled:hover:bg-surface-sunken"
              >
                {phase === "creating" ? (
                  <RotateCw size={14} strokeWidth={2} aria-hidden="true" className="animate-spin" />
                ) : (
                  <Plus size={14} strokeWidth={2} aria-hidden="true" />
                )}
                {phase === "creating" ? "Creating…" : `Create ${n} paused ad${n === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
