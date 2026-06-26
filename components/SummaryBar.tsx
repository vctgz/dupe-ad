"use client";

// Summary bar: a hero count + scan stamp, plus filter pills.
//
//  - Store-list mode: All + SG, and a warning when stores have no Page.
//  - Reconcile mode: All + Active + Tier 1/2/3, and the split-page note.
//
// Presentational; reads from props so the data-fetching shell can be swapped.
import { GitFork, CircleSlash } from "lucide-react";
import type {
  DiscoverySource,
  DiscoverySummary,
  FilterValue,
} from "@/lib/types";

/** The "All" pill (left of every filter row). */
function AllPlate({
  total,
  active,
  onClick,
}: {
  total: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "fas-focus inline-flex items-center gap-1.5 rounded-fas-md border px-2.5 py-1 text-fas-12 font-semibold uppercase tracking-caps-tight transition-colors duration-[110ms]",
        active
          ? "border-accent bg-accent-tint text-accent"
          : "border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink",
      ].join(" ")}
    >
      <span className="tabular-nums">{total}</span> All
    </button>
  );
}

/** A count + label filter pill (SG / Active / Tier N). Disabled when count is 0. */
function CountPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const zero = count === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={zero}
      title={`Show only ${label}`}
      className={[
        "fas-focus inline-flex items-center gap-1.5 rounded-fas-md border px-2.5 py-1 text-fas-12 font-semibold uppercase tracking-caps-tight transition-colors duration-[110ms]",
        zero ? "cursor-not-allowed opacity-40" : "",
        active
          ? "border-accent bg-accent-tint text-accent"
          : "border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink",
      ].join(" ")}
    >
      <span className="tabular-nums">{count}</span> {label}
    </button>
  );
}

// Friendlier labels for the data-source pill. A live pull reads as freshly "Updated";
// snapshot/mapping keep their names.
const SOURCE_LABEL: Record<DiscoverySource, string> = {
  live: "Updated",
  snapshot: "Snapshot",
  mapping: "Mapping",
};

function SourcePill({
  source,
  fetchedAt,
}: {
  source: DiscoverySource | null;
  fetchedAt: string | null;
}) {
  if (!source) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-fas-pill border border-hairline bg-surface-sunken px-3 py-1 font-mono text-fas-11 leading-none text-ink-faint">
        scanning…
      </span>
    );
  }
  const live = source === "live";
  const stamp = fetchedAt ? new Date(fetchedAt).toLocaleString() : null;
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-fas-pill border border-hairline bg-surface-sunken px-3 py-1 font-mono text-fas-11 leading-none text-ink-muted"
      title={stamp ?? undefined}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-fas-pill ${live ? "bg-health-ok" : "bg-ink-faint"}`}
        aria-hidden="true"
      />
      <span className="uppercase tracking-caps-tight">{SOURCE_LABEL[source]}</span>
      {stamp ? <span className="text-ink-faint">· {stamp}</span> : null}
    </span>
  );
}

export default function SummaryBar({
  summary,
  total,
  source,
  fetchedAt,
  splitPageCodes,
  sgCount,
  activeCount,
  tierCounts,
  activeStatus,
  onFilter,
  mode = "reconcile",
}: {
  summary: DiscoverySummary | null;
  total: number;
  source: DiscoverySource | null;
  fetchedAt: string | null;
  splitPageCodes: string[];
  /** SG=Y count (store-list mode). */
  sgCount: number;
  /** ACTIVE-delivery count (reconcile mode). */
  activeCount: number;
  /** Tier 1/2/3 counts (reconcile mode). */
  tierCounts: { t1: number; t2: number; t3: number };
  activeStatus: FilterValue;
  onFilter: (status: FilterValue) => void;
  /** 'reconcile' or 'storelist'. */
  mode?: "reconcile" | "storelist";
}) {
  const filtered = activeStatus !== "ALL";
  const isStoreList = mode === "storelist";

  const heroCount = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-baseline gap-2.5">
        <span className="text-fas-24 font-semibold tabular-nums text-ink">{total}</span>
        <span className="text-fas-12 uppercase tracking-caps text-ink-muted">
          campaign{total === 1 ? "" : "s"}
        </span>
      </div>
      <SourcePill source={source} fetchedAt={fetchedAt} />
    </div>
  );

  const clearLink = filtered ? (
    <button
      type="button"
      onClick={() => onFilter("ALL")}
      className="fas-focus ml-auto rounded-fas-md text-fas-12 text-accent underline-offset-2 hover:underline"
    >
      Clear · show all {total}
    </button>
  ) : null;

  // ── Store-list mode: All + SG, with a no-Page warning. ──────────────────────
  if (isStoreList) {
    const noPage = summary?.NO_PAGE ?? 0;
    return (
      <div className="flex flex-col gap-3 rounded-fas-lg border border-hairline bg-surface-raised p-4 shadow-fas-card">
        {heroCount}
        <div className="flex flex-wrap items-center gap-2">
          <AllPlate total={total} active={!filtered} onClick={() => onFilter("ALL")} />
          <CountPill
            label="SG"
            count={sgCount}
            active={activeStatus === "SG"}
            onClick={() => onFilter(activeStatus === "SG" ? "ALL" : "SG")}
          />
          {clearLink}
        </div>
        {noPage > 0 ? (
          <div
            className="flex items-start gap-2 rounded-fas-md border border-status-missing-map-border bg-status-missing-map-bg px-3 py-2 text-fas-12 text-status-missing-map"
            role="alert"
          >
            <CircleSlash size={14} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
            <p>
              <span className="font-semibold uppercase tracking-caps-tight">No Page:</span>{" "}
              {noPage} store{noPage === 1 ? "" : "s"} {noPage === 1 ? "has" : "have"} no Facebook Page
              in the mapping — an ad can&rsquo;t be created for {noPage === 1 ? "it" : "them"} until a
              Page is added.
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  // ── Reconcile mode: All + Active + Tier 1/2/3 + split-page note. ────────────
  return (
    <div className="flex flex-col gap-3 rounded-fas-lg border border-hairline bg-surface-raised p-4 shadow-fas-card">
      {heroCount}
      <div className="flex flex-wrap items-center gap-2">
        <AllPlate total={total} active={!filtered} onClick={() => onFilter("ALL")} />
        <CountPill
          label="Active"
          count={activeCount}
          active={activeStatus === "ACTIVE"}
          onClick={() => onFilter(activeStatus === "ACTIVE" ? "ALL" : "ACTIVE")}
        />
        <CountPill
          label="Tier 1"
          count={tierCounts.t1}
          active={activeStatus === "T1"}
          onClick={() => onFilter(activeStatus === "T1" ? "ALL" : "T1")}
        />
        <CountPill
          label="Tier 2"
          count={tierCounts.t2}
          active={activeStatus === "T2"}
          onClick={() => onFilter(activeStatus === "T2" ? "ALL" : "T2")}
        />
        <CountPill
          label="Tier 3"
          count={tierCounts.t3}
          active={activeStatus === "T3"}
          onClick={() => onFilter(activeStatus === "T3" ? "ALL" : "T3")}
        />
        {clearLink}
      </div>

      {/* Split-page hazard, spelled out (per-row it's flagged by the page icon). */}
      {splitPageCodes.length > 0 ? (
        <div
          className="flex items-start gap-2 rounded-fas-md border border-split-border bg-split-bg px-3 py-2 text-fas-12 text-split"
          role="alert"
        >
          <GitFork size={14} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0 rotate-90" />
          <p>
            <span className="font-semibold uppercase tracking-caps-tight">
              Split page{splitPageCodes.length === 1 ? "" : "s"}:
            </span>{" "}
            {splitPageCodes.length} store code{splitPageCodes.length === 1 ? "" : "s"} resolve
            {splitPageCodes.length === 1 ? "s" : ""} to more than one distinct Page —{" "}
            <span className="font-mono font-semibold text-ink">{splitPageCodes.join(", ")}</span>. Confirm
            which page is correct <span className="font-semibold">before any write</span>.
          </p>
        </div>
      ) : null}
    </div>
  );
}
