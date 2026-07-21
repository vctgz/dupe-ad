"use client";

// Discovery table (clean, neutral light theme): one row PER CAMPAIGN, identical
// column structure for both modes. Columns:
//   Select · Status · Campaign Name · [SG | Tier] · Meta Page ID
// where the 4th column is SG (storelist) or Tier (reconcile). Surfaces are white;
// only genuine ANOMALIES carry color.
//
// Scan affordances at 60–90 dense rows:
//  - a 4px left rail, colored ONLY on anomalies (MISMATCH; split-page),
//    neutral otherwise, so a stray bar is caught peripherally against a calm column.
//  - mono + tabular page IDs (slashed zero), truncated with a full-value tooltip.
//  - on a MISMATCH the live page carries a small amber flag whose
//    tooltip names the page the mapping expected (the divergence stays legible
//    even though the dual-page columns are gone).
//
// SELECTION: the leftmost checkbox lifts campaignIds into the Dashboard. There is
// no select-all header checkbox (by request) — the header cell is just "Select".
// Selected rows get a subtle indigo highlight. Presentational — pure props in.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { GitFork, TriangleAlert } from "lucide-react";
import type { CampaignRow } from "@/lib/types";
// NOTE: `ReconcileStatus` is only needed by the (currently disabled) left status
// rail — re-add it to this import when you re-enable RAIL_VAR below.
import { DeliveryPill } from "@/components/StatusBadge";

// 'reconcile' (Tier column) vs 'storelist' (SG column).
export type DiscoveryMode = "reconcile" | "storelist";

type Row = CampaignRow;
type SortKey = "status" | "campaignName" | "special" | "pageId";

/* DISABLED for now (the per-row alerts aren't severe enough to warrant it) —
   the left "LED rail" that colored anomaly rows. Re-enable by uncommenting this,
   re-adding `ReconcileStatus` to the import above, and restoring `railShadow` +
   the first cell's `style={{ boxShadow: railShadow }}` in DiscoveryRow.

const RAIL_VAR: Record<ReconcileStatus, string> = {
  OK: "transparent",
  MISMATCH: "var(--fas-mismatch)",
  MISSING_API: "var(--fas-missing-api)",
  MISSING_MAPPING: "var(--fas-missing-map)",
  NO_CODE: "transparent",
  API_ERROR: "var(--fas-api-error)",
  MAPPED: "transparent",
  NO_PAGE: "transparent",
};
*/

// Design-system checkbox: a drawn appearance-none box. Indigo box + white glyph
// when checked. The check is an inline data-URI SVG so the control needs no extra
// markup.
const CHECK_SVG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3.5 8.5l3 3 6-7'/%3E%3C/svg%3E\")";
const DASH_SVG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='M4 8h8'/%3E%3C/svg%3E\")";

const CHECKBOX_CLASS =
  "fas-focus h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-fas-sm border border-hairline-strong bg-surface bg-center bg-no-repeat transition-colors hover:border-accent checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent";

const checkboxStyle: React.CSSProperties = {
  backgroundImage: "var(--cbx-img)",
  backgroundSize: "100% 100%",
};

/** Tri-state header checkbox (none / some / all of the visible rows selected) —
 *  the Meta-Ads-style select-all control. */
function HeaderCheckbox({
  state,
  onToggle,
}: {
  state: "none" | "some" | "all";
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "all"}
      onChange={onToggle}
      aria-label={state === "all" ? "Deselect all visible campaigns" : "Select all visible campaigns"}
      className={CHECKBOX_CLASS}
      style={{
        ...checkboxStyle,
        ["--cbx-img" as string]: state === "some" ? DASH_SVG : state === "all" ? CHECK_SVG : "none",
      }}
    />
  );
}

/** Render a long page ID: mono, tabular, truncated with a full-value tooltip. */
const PageId = memo(function PageId({ value }: { value: string | null }) {
  if (!value) {
    return <span className="font-mono text-fas-12 text-ink-muted">— no page</span>;
  }
  return (
    <span
      title={value}
      className="block max-w-[16ch] truncate font-mono text-fas-12 tabular-nums text-ink-mono"
    >
      {value}
    </span>
  );
});

/** A MISMATCH page cell (reconcile mode): the live page + an amber flag whose tooltip
 *  names the page the mapping expected. */
const MismatchPageId = memo(function MismatchPageId({
  value,
  expected,
}: {
  value: string | null;
  expected: string | null;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        title={value ?? undefined}
        className="block max-w-[14ch] truncate font-mono text-fas-12 font-medium tabular-nums text-ink"
      >
        {value ?? "—"}
      </span>
      <span
        className="inline-flex shrink-0 items-center text-status-missing-map"
        title={expected ? `Mapping expects Page ${expected}` : "Differs from the mapping"}
        aria-label={expected ? `Differs from mapping, which expects page ${expected}` : "Differs from mapping"}
      >
        <TriangleAlert size={12} strokeWidth={2} aria-hidden="true" />
      </span>
    </span>
  );
});

/** The SG cell (store-list mode): a quiet "Y" badge, or a muted dash for N. */
const SgCell = memo(function SgCell({ sg }: { sg?: "Y" | "N" }) {
  if (sg === "Y") {
    return (
      <span className="inline-flex items-center rounded-fas-pill border border-accent/30 bg-accent-tint px-2 py-0.5 text-fas-11 font-semibold text-accent">
        SG
      </span>
    );
  }
  return <span className="text-fas-12 text-ink-faint" aria-label="Not SG">—</span>;
});

/** The Tier cell (reconcile mode): the parsed tier label, or a muted dash. */
const TierCell = memo(function TierCell({ tier }: { tier?: string | null }) {
  if (tier) {
    return <span className="text-fas-13 text-ink-muted">{tier}</span>;
  }
  return <span className="text-fas-12 text-ink-faint" aria-hidden="true">—</span>;
});

/** A row is selectable iff it carries an id we can lift into the selection. */
function selectableIdOf(row: Row): string | null {
  return row.campaignId ?? (row.storeCode ? `store:${row.storeCode}` : null);
}

/** The "Meta Page ID" for a row: the live page for reconcile (fallback mapping),
 *  the mapping page for store-list. */
function pageIdOf(row: Row, isStoreList: boolean): string | null {
  return isStoreList ? row.mappedPage : row.actualPage ?? row.mappedPage;
}

interface DiscoveryRowProps {
  row: Row;
  isStoreList: boolean;
  isSplit: boolean;
  selectable: boolean;
  isSelected: boolean;
  rowId: string | null;
  onToggleRow?: (id: string, selected: boolean) => void;
}

// One table row, memoized. Takes `isSelected` as a BOOLEAN so toggling one
// checkbox re-renders only the affected row, not all 90 rows.
const DiscoveryRow = memo(function DiscoveryRow({
  row,
  isStoreList,
  isSplit,
  selectable,
  isSelected,
  rowId,
  onToggleRow,
}: DiscoveryRowProps) {
  const verdict = row.reconcile;
  const isMismatch = verdict === "MISMATCH";
  const pageId = pageIdOf(row, isStoreList);
  // Left status rail disabled for now — see the commented RAIL_VAR above.
  // const railShadow = `inset 4px 0 0 0 ${RAIL_VAR[verdict]}`;
  return (
    <tr
      className={[
        "border-b border-hairline last:border-b-0",
        isSelected
          ? "bg-accent-tint"
          : isMismatch
            ? "bg-status-mismatch-bg/40 hover:bg-surface-sunken"
            : "bg-surface hover:bg-surface-sunken",
        "transition-colors duration-[110ms] ease-fas",
      ].join(" ")}
    >
      {/* Select (the left status rail via inset shadow is disabled for now) */}
      {selectable ? (
        <td className="px-3 py-2.5 text-center align-middle">
          {rowId ? (
            <label className="inline-flex cursor-pointer items-center justify-center p-1.5">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={(e) => onToggleRow!(rowId, e.target.checked)}
                aria-label={`Select campaign ${row.campaignName || row.storeCode || rowId}`}
                className={CHECKBOX_CLASS}
                style={{ ...checkboxStyle, ["--cbx-img" as string]: isSelected ? CHECK_SVG : "none" }}
              />
            </label>
          ) : (
            <span className="text-ink-muted" aria-hidden="true">—</span>
          )}
        </td>
      ) : null}

      {/* Status */}
      <td className="whitespace-nowrap px-3 py-2 align-middle">
        <DeliveryPill status={row.status} />
      </td>

      {/* Campaign Name (+ campaign id) */}
      <td className="px-3 py-2 align-middle">
        <div
          className="truncate text-fas-13 font-medium leading-tight text-ink"
          title={row.campaignName || undefined}
        >
          {row.campaignName || <span className="text-ink-muted" aria-hidden="true">—</span>}
        </div>
        {row.campaignId ? (
          <div className="font-mono text-fas-11 leading-tight tabular-nums text-ink-mono">
            {row.campaignId}
          </div>
        ) : null}
      </td>

      {/* SG (storelist) / Tier (reconcile) */}
      <td className="px-3 py-2 align-middle">
        {isStoreList ? <SgCell sg={row.sg} /> : <TierCell tier={row.tier} />}
      </td>

      {/* Meta Page ID */}
      <td className="border-l border-gridtick px-3 py-2 align-middle">
        <div className="flex items-center gap-1.5">
          {isMismatch && pageId ? (
            <MismatchPageId value={pageId} expected={row.mappedPage} />
          ) : (
            <PageId value={pageId} />
          )}
          {isSplit ? (
            <span
              className="inline-flex shrink-0 items-center text-split"
              title="Shared Page — this store's Page is also used by another store"
              aria-label="Shared page"
            >
              <GitFork size={11} strokeWidth={2} aria-hidden="true" className="rotate-90" />
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
});

export default function DiscoveryTable({
  rows,
  mode = "reconcile",
  splitPageCodes = [],
  selectedIds,
  onToggleRow,
  onToggleVisible,
}: {
  rows: CampaignRow[];
  /** 'reconcile' (Tier) or 'storelist' (SG). */
  mode?: DiscoveryMode;
  splitPageCodes?: string[];
  /** Set of selected ids (selection is optional — table works without it). */
  selectedIds?: Set<string>;
  /** Toggle a single row's selection (campaignId). */
  onToggleRow?: (id: string, selected: boolean) => void;
  /** Select / deselect ALL currently-visible (selectable) rows at once. */
  onToggleVisible?: (ids: string[], selected: boolean) => void;
}) {
  const isStoreList = mode === "storelist";
  const allRows = rows as Row[];
  const [sortKey, setSortKey] = useState<SortKey>("campaignName");
  const [asc, setAsc] = useState(true);
  const splitSet = useMemo(() => new Set(splitPageCodes), [splitPageCodes]);

  const selectable = !!(selectedIds && onToggleRow && onToggleVisible);
  const selected = useMemo(() => selectedIds ?? new Set<string>(), [selectedIds]);

  const sortValue = useMemo(
    () => (row: Row): string => {
      switch (sortKey) {
        case "status":
          return row.status ?? "";
        case "special":
          return isStoreList ? row.sg ?? "" : row.tier ?? "";
        case "pageId":
          return pageIdOf(row, isStoreList) ?? "";
        case "campaignName":
        default:
          return row.campaignName ?? "";
      }
    },
    [sortKey, isStoreList],
  );

  const sorted = useMemo(() => {
    const copy = [...allRows];
    copy.sort((a, b) => {
      const cmp = sortValue(a).localeCompare(sortValue(b));
      return asc ? cmp : -cmp;
    });
    return copy;
  }, [allRows, sortValue, asc]);

  // Visible selectable ids (for the tri-state select-all header).
  const visibleSelectableIds = useMemo(
    () => sorted.map((r) => selectableIdOf(r)).filter((id): id is string => !!id),
    [sorted],
  );
  const selectedVisibleCount = useMemo(
    () => visibleSelectableIds.filter((id) => selected.has(id)).length,
    [visibleSelectableIds, selected],
  );
  const headerState: "none" | "some" | "all" =
    selectedVisibleCount === 0
      ? "none"
      : selectedVisibleCount === visibleSelectableIds.length
        ? "all"
        : "some";

  function toggleSort(key: SortKey) {
    if (key === sortKey) setAsc((v) => !v);
    else {
      setSortKey(key);
      setAsc(true);
    }
  }

  function sortState(key: SortKey): "ascending" | "descending" | "none" {
    if (key !== sortKey) return "none";
    return asc ? "ascending" : "descending";
  }

  function header(key: SortKey, label: string) {
    const active = key === sortKey;
    return (
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="fas-focus group inline-flex select-none items-center gap-1 rounded-fas-sm text-fas-11 font-semibold uppercase tracking-caps text-ink-muted transition-colors hover:text-ink"
      >
        {label}
        {/* Inactive columns keep the ↕ hint invisible-but-present (opacity, not
            display) so revealing it on hover/focus never shifts the header. */}
        <span
          className={`text-[10px] transition-opacity duration-[110ms] ${
            active
              ? "text-ink-muted"
              : "text-ink-faint opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
          }`}
          aria-hidden="true"
        >
          {active ? (asc ? "▲" : "▼") : "↕"}
        </span>
      </button>
    );
  }

  return (
    <div className="overflow-x-auto rounded-fas-lg border border-hairline bg-surface shadow-fas-card">
      {/* table-fixed + an explicit colgroup lock header and body columns together
          (no auto-layout drift / sticky-header misalignment); Campaign Name has no
          fixed width so it flexes to absorb the available space. */}
      <table className="w-full min-w-[720px] table-fixed border-separate border-spacing-0 text-fas-13">
        {/* Percentage widths (fixed layout) so Campaign Name reliably takes the
            bulk and no idle gutter forms before Meta Page ID. */}
        <colgroup>
          {selectable ? <col style={{ width: "4%" }} /> : null}
          <col style={{ width: "13%" }} />
          <col style={{ width: "49%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "26%" }} />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-surface-sunken shadow-[0_1px_0_var(--fas-hairline-strong)]">
          <tr className="border-b border-hairline-strong bg-surface-sunken text-left">
            {selectable ? (
              <th scope="col" className="px-3 py-2.5 text-center align-middle">
                <span className="inline-flex items-center justify-center">
                  <HeaderCheckbox
                    state={headerState}
                    onToggle={() => onToggleVisible!(visibleSelectableIds, headerState !== "all")}
                  />
                </span>
              </th>
            ) : null}
            <th scope="col" aria-sort={sortState("status")} className="px-3 py-2.5">
              {header("status", "Status")}
            </th>
            <th scope="col" aria-sort={sortState("campaignName")} className="px-3 py-2.5">
              {header("campaignName", "Campaign Name")}
            </th>
            <th scope="col" aria-sort={sortState("special")} className="px-3 py-2.5">
              {header("special", isStoreList ? "SG" : "Tier")}
            </th>
            <th scope="col" aria-sort={sortState("pageId")} className="whitespace-nowrap border-l border-gridtick px-3 py-2.5">
              {header("pageId", "Meta Page ID")}
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, idx) => {
            const isSplit = row.storeCode != null && splitSet.has(row.storeCode);
            const rowId = selectableIdOf(row);
            const isSelected = !!(rowId && selected.has(rowId));
            return (
              <DiscoveryRow
                key={`${rowId ?? "norow"}-${idx}`}
                row={row}
                isStoreList={isStoreList}
                isSplit={isSplit}
                selectable={selectable}
                isSelected={isSelected}
                rowId={rowId}
                onToggleRow={onToggleRow}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
