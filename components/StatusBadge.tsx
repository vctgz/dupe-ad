// StatusBadge — the hero reconciliation signal (clean, neutral light theme).
//
// TRIPLE-ENCODED, never color alone: every state carries a distinct HUE + a
// distinct ICON SILHOUETTE + a TEXT LABEL, so it is fully decodable in greyscale
// and for all color-vision types (WCAG AA on white). The two "missing" states
// use DIFFERENT hues (slate vs amber) AND different glyphs (dashed circle vs
// dashed square), so "the live account is broken" never reads as "your CSV is
// incomplete." MISMATCH is the only OCTAGON, in the loudest red ("stop").
//
// The loud states (MISMATCH / API_ERROR) carry a subtle reinforcing ring; the
// quieter states stay flat so the table is calm and only wrong rows draw the eye.
//
// Tokens (status.*) are defined in app/globals.css and surfaced via
// tailwind.config.ts, so the light default and dark variant are a token swap.
import { memo } from "react";
import {
  CheckCircle2,
  OctagonAlert,
  CircleDashed,
  SquareDashedBottom,
  MinusCircle,
  OctagonX,
  PlugZap,
  CircleSlash,
  type LucideIcon,
} from "lucide-react";
import type { ReconcileStatus } from "@/lib/types";

export type StatusBadgeSize = "sm" | "md";

interface StatusMeta {
  /** Short uppercase label shown in the chip. */
  label: string;
  /** Distinct geometric icon — silhouette alone disambiguates in greyscale. */
  Icon: LucideIcon;
  /** Tailwind class fragments built from semantic tokens. */
  text: string;
  bg: string;
  border: string;
  /** Loud states glow; quiet states (OK / NO_CODE) do not. */
  halo: string | null;
  /** Screen-reader sentence. */
  describe: string;
  /** Plain-English "what this means / what to do next" copy (info popover). */
  guidance: string;
}

// Maps 1:1 to the REAL ReconcileStatus union in lib/discovery/types.ts.
const STATUS_META: Record<ReconcileStatus, StatusMeta> = {
  OK: {
    label: "OK",
    Icon: CheckCircle2,
    text: "text-status-ok",
    bg: "bg-status-ok-bg",
    border: "border-status-ok-border",
    halo: null,
    describe: "Reconciliation: OK. The live page matches your mapping.",
    guidance:
      "Live page binding matches your CSV. This row is reconciled — nothing to do.",
  },
  MISMATCH: {
    label: "MISMATCH",
    Icon: OctagonAlert,
    text: "text-status-mismatch",
    bg: "bg-status-mismatch-bg",
    border: "border-status-mismatch-border",
    halo: "var(--fas-mismatch-border)",
    describe:
      "Reconciliation: mismatch. The live page differs from your mapping.",
    guidance:
      "The live ad's page (from the API) differs from the page in your CSV. Confirm which page should own this code, then fix the mapping CSV or the campaign. No writes happen here — discovery is read-only.",
  },
  MISSING_API: {
    label: "MISSING · API",
    Icon: CircleDashed,
    text: "text-status-missing-api",
    bg: "bg-status-missing-api-bg",
    border: "border-status-missing-api-border",
    halo: null,
    describe:
      "Reconciliation: missing on Meta. Your mapping has a page, the API returned none.",
    guidance:
      "Your CSV lists a page but Meta returned none for this campaign — the live read-back is broken, not your CSV. Check the System User is assigned to the page, then re-scan.",
  },
  MISSING_MAPPING: {
    label: "MISSING · MAP",
    Icon: SquareDashedBottom,
    text: "text-status-missing-map",
    bg: "bg-status-missing-map-bg",
    border: "border-status-missing-map-border",
    halo: null,
    describe:
      "Reconciliation: missing in mapping. Meta has a page, your CSV has no row.",
    guidance:
      "Meta returned a page but your CSV has no row for this store code. Add the store to the mapping CSV (operator-fixable).",
  },
  NO_CODE: {
    label: "NO CODE",
    Icon: MinusCircle,
    text: "text-status-no-code",
    bg: "bg-status-no-code-bg",
    border: "border-status-no-code-border",
    halo: null,
    describe:
      "Reconciliation: no code. No store code could be parsed from the campaign name.",
    guidance:
      "No store code could be extracted from this campaign name, so it can't be joined to the mapping. A state, not an error — rename the campaign to include a code if it should reconcile.",
  },
  API_ERROR: {
    label: "API ERROR",
    Icon: OctagonX,
    text: "text-status-api-error",
    bg: "bg-status-api-error-bg",
    border: "border-status-api-error-border",
    halo: "var(--fas-api-error-border)",
    describe:
      "Reconciliation: API error. The Meta API errored for this campaign.",
    guidance:
      "The Meta API returned an error while reconciling this campaign. Re-scan; if it persists, check token health and page assignment.",
  },
  // --- Store-list states (mapping source, store-list mode) -------------------
  // These describe a STORE row, not a reconciliation. MAPPED reuses the calm
  // OK-green ("ready to use"); NO_PAGE reuses the muted NO_CODE-gray ("nothing
  // wrong, just no page yet"). Distinct glyphs keep them decodable in greyscale.
  MAPPED: {
    label: "MAPPED",
    Icon: PlugZap,
    text: "text-status-ok",
    bg: "bg-status-ok-bg",
    border: "border-status-ok-border",
    halo: null,
    describe: "Store list: mapped. This store has a Page and is ready to use.",
    guidance:
      "This store resolves to a Page in the mapping CSV — it's ready to receive a duplicated ad. Nothing to do.",
  },
  NO_PAGE: {
    label: "NO PAGE",
    Icon: CircleSlash,
    text: "text-status-no-code",
    bg: "bg-status-no-code-bg",
    border: "border-status-no-code-border",
    halo: null,
    describe: "Store list: no page. This store has no Page in the mapping.",
    guidance:
      "The mapping CSV has this store but no Page id, so an ad can't be targeted yet. Add a page_id for this store (operator-fixable). A state, not an error.",
  },
};

/**
 * DeliveryPill — the campaign delivery status (Active / Paused / In review) as a
 * compact pill. A SEPARATE grammar from reconciliation: a small leading dot in the
 * delivery hue + a title-cased value (never a caps alarm label), so it reads as a
 * state, not an error. Greyscale-decodable via the label text.
 */
export const DeliveryPill = memo(function DeliveryPill({
  status,
}: {
  status: string | null;
}) {
  if (!status) {
    return <span className="text-ink-muted" aria-hidden="true">—</span>;
  }
  const s = status.toUpperCase();
  const active = s.includes("ACTIVE");
  const review = s.includes("REVIEW") || s.includes("PENDING");
  const label = active ? "Active" : review ? "In review" : "Paused";
  const dot = active
    ? "bg-deliver-active"
    : review
      ? "bg-deliver-review"
      : "bg-deliver-paused";
  // Active gets a faint green well; the quieter states stay on the neutral sunken
  // surface so a wall of paused rows reads calm and only live ads draw the eye.
  const chrome = active
    ? "border-status-ok-border bg-status-ok-bg text-status-ok"
    : review
      ? "border-status-missing-map-border bg-status-missing-map-bg text-status-missing-map"
      : "border-hairline bg-surface-sunken text-ink-muted";
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-fas-pill border px-2 py-0.5 text-fas-12 font-medium ${chrome}`}
      aria-label={`Delivery: ${label}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-fas-pill ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
});

export function statusLabel(status: ReconcileStatus): string {
  return STATUS_META[status].label;
}

export function statusMeta(status: ReconcileStatus): StatusMeta {
  return STATUS_META[status];
}

// memo: props are primitives (status + size), so a row that didn't change its
// status skips this re-render entirely — cheap insurance for sort/filter renders
// where row identity is preserved but the table re-renders.
const StatusBadge = memo(function StatusBadge({
  status,
  size = "md",
}: {
  status: ReconcileStatus;
  size?: StatusBadgeSize;
}) {
  const meta = STATUS_META[status];
  const iconPx = size === "sm" ? 12 : 13;
  const pad = size === "sm" ? "px-1.5 py-px" : "px-2 py-0.5";
  const labelSize = size === "sm" ? "text-fas-11" : "text-fas-12";

  return (
    <span
      className={[
        "fas-halo inline-flex items-center gap-1.5 whitespace-nowrap rounded-fas-md border font-semibold uppercase tracking-caps-tight",
        pad,
        labelSize,
        meta.text,
        meta.bg,
        meta.border,
      ].join(" ")}
      style={meta.halo ? ({ ["--halo-ring" as string]: meta.halo } as React.CSSProperties) : undefined}
      aria-label={meta.describe}
      title={meta.guidance}
    >
      <meta.Icon size={iconPx} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      <span className="leading-none">{meta.label}</span>
    </span>
  );
});

export default StatusBadge;
