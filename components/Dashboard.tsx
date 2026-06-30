"use client";

// Dashboard shell (client). The session is locked to ONE ad account (the client
// logs in as their account), so there is no account switching here. It owns:
//  - fetching /api/discovery for the session's account
//  - loading / empty / error states
//  - the status/SG filter, free-text filter (store code / campaign name), Re-scan
//  - the Ad Creator selection + the Duplicate/Create modal launch
// Presentational pieces (SummaryBar, DiscoveryTable, StatusBadge, DuplicateModal)
// are isolated so the design system restyles them without touching this logic.
//
// Visual direction: clean, neutral light (Linear/Vercel-light) — white over cool
// slate with one indigo accent. The active account is shown in the header so a
// "wrong account" mistake is structurally hard.
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { RotateCw, Search, X, MapPin, Copy, Plus, SearchX } from "lucide-react";
import type {
  AccountInfo,
  CampaignRow,
  DiscoveryResponse,
  FilterValue,
} from "@/lib/types";
import SummaryBar from "@/components/SummaryBar";
import DiscoveryTable from "@/components/DiscoveryTable";
import BulkSelect, { type BulkSelectResult } from "@/components/BulkSelect";

// The Duplicate modal is the heaviest leaf in the / client tree (form state,
// drag-drop dropzones, client-side Image() aspect-ratio probing, the PlanView
// renderer). It's only reachable after a deliberate click, so lazy-load it — none
// of that ships in the initial / chunk. ssr:false is safe: it only renders behind
// the client `modalMode` state, never on the server.
const DuplicateModal = dynamic(() => import("@/components/DuplicateModal"), {
  ssr: false,
});

export default function Dashboard({
  account,
  authEnabled = false,
}: {
  account: AccountInfo;
  authEnabled?: boolean;
}) {
  const router = useRouter();
  const activeSlug = account.slug;

  const [discovery, setDiscovery] = useState<DiscoveryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterValue>("ALL");
  const [query, setQuery] = useState("");
  // Ad Creator selection — campaignIds. Survives filtering (we keep selected ids
  // even when a row is filtered out); select-all acts only on visible rows.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // The modal launches in one of two modes; null means closed.
  const [modalMode, setModalMode] = useState<"duplicate" | "create" | null>(null);

  const load = useCallback(async (slug: string, refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/discovery?account=${encodeURIComponent(slug)}${refresh ? "&refresh=1" : ""}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Discovery failed (HTTP ${res.status})`);
      }
      setDiscovery((await res.json()) as DiscoveryResponse);
    } catch (err) {
      setDiscovery(null);
      setError(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(activeSlug);
  }, [activeSlug, load]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  // Discovery mode — 'reconcile' vs 'storelist'. Both now
  // render campaign rows; mode selects the special column (Tier vs SG) + overview.
  const mode: "reconcile" | "storelist" =
    discovery?.mode === "storelist" ? "storelist" : "reconcile";
  const isStoreList = mode === "storelist";

  const rows = useMemo<CampaignRow[]>(() => discovery?.rows ?? [], [discovery]);
  // The input stays controlled by `query` (instant); filtering keys off a deferred
  // copy so fast typing doesn't block on re-rendering the table. Memoized so
  // non-search renders (selection toggles, modal open/close) don't re-run it.
  const deferredQuery = useDeferredValue(query);
  const filteredRows = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "SG") {
        if (r.sg !== "Y") return false;
      } else if (filter === "ACTIVE") {
        if (!(r.status ?? "").toUpperCase().includes("ACTIVE")) return false;
      } else if (filter === "T1" || filter === "T2" || filter === "T3") {
        const want = filter === "T1" ? "Tier 1" : filter === "T2" ? "Tier 2" : "Tier 3";
        if (r.tier !== want) return false;
      } else if (filter !== "ALL" && r.reconcile !== filter) {
        return false;
      }
      if (q) {
        const code = (r.storeCode ?? "").toLowerCase();
        const name = (r.campaignName ?? "").toLowerCase();
        const city = (r.cityState ?? "").toLowerCase();
        if (!code.includes(q) && !name.includes(q) && !city.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filter, deferredQuery]);

  /** Stable selection id for a row: campaignId (every row now carries one). */
  const rowSelectId = useCallback(
    (r: CampaignRow): string | null =>
      r.campaignId ?? (r.storeCode ? `store:${r.storeCode}` : null),
    [],
  );

  // --- Selection (Ad Creator) -------------------------------------------------
  const toggleRow = useCallback((campaignId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(campaignId);
      else next.delete(campaignId);
      return next;
    });
  }, []);

  // Select-all over CURRENTLY-VISIBLE (filtered) rows only; existing off-screen
  // selections are untouched.
  const toggleVisible = useCallback((ids: string[], selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Bulk-select by pasted store numbers. Matches each token against every row's
  // store code (padding-agnostic — "62" matches "062"), adds ALL matching
  // campaigns to the selection, and reports matched stores + not-found tokens.
  const bulkSelect = useCallback(
    (tokens: string[]): BulkSelectResult => {
      const strip = (s: string) => s.replace(/^0+(?=\d)/, "");
      const byCode = new Map<string, string[]>();
      for (const r of rows) {
        if (!r.storeCode) continue;
        const id = rowSelectId(r);
        if (!id) continue;
        for (const key of new Set([r.storeCode, strip(r.storeCode)])) {
          const list = byCode.get(key) ?? [];
          list.push(id);
          byCode.set(key, list);
        }
      }
      const matchedIds = new Set<string>();
      const matchedStores = new Set<string>();
      const notFound: string[] = [];
      for (const tok of tokens) {
        const ids = byCode.get(tok) ?? byCode.get(strip(tok));
        if (ids && ids.length > 0) {
          ids.forEach((id) => matchedIds.add(id));
          matchedStores.add(strip(tok));
        } else {
          notFound.push(tok);
        }
      }
      if (matchedIds.size > 0) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          matchedIds.forEach((id) => next.add(id));
          return next;
        });
      }
      return { matched: matchedStores.size, notFound };
    },
    [rows, rowSelectId],
  );

  const selectedRows = useMemo<CampaignRow[]>(() => {
    const ids = selectedIds;
    return rows.filter((r) => {
      const id = rowSelectId(r);
      return id != null && ids.has(id);
    });
  }, [rows, selectedIds, rowSelectId]);
  const selectedCampaignIds = useMemo(
    () => selectedRows.map((r) => r.campaignId).filter((id): id is string => !!id),
    [selectedRows],
  );
  const selectedStoreCount = useMemo(
    () => new Set(selectedRows.map((r) => r.storeCode).filter((s): s is string => !!s)).size,
    [selectedRows],
  );
  const selectedCount = selectedRows.length;
  const sgCount = useMemo(() => rows.filter((r) => r.sg === "Y").length, [rows]);
  const activeCount = useMemo(
    () => rows.filter((r) => (r.status ?? "").toUpperCase().includes("ACTIVE")).length,
    [rows],
  );
  const tierCounts = useMemo(() => {
    let t1 = 0, t2 = 0, t3 = 0;
    for (const r of rows) {
      if (r.tier === "Tier 1") t1++;
      else if (r.tier === "Tier 2") t2++;
      else if (r.tier === "Tier 3") t3++;
    }
    return { t1, t2, t3 };
  }, [rows]);

  return (
    <div className="min-h-screen bg-void">
      {/* App shell header */}
      <header className="sticky top-0 z-20 border-b border-hairline bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="flex items-center gap-2">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="8" y="3.4" width="12.6" height="12.6" rx="3.4" fill="#bcd3e8" />
              <rect x="3.4" y="8" width="12.6" height="12.6" rx="3.4" fill="#2b5c8a" />
            </svg>
            <span className="font-display text-fas-18 font-bold tracking-tight text-ink">
              dupe<span className="text-accent">.ad</span>
            </span>
          </span>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-fas-md border border-hairline bg-surface-sunken px-3 py-1.5">
              <span className="text-fas-11 font-semibold uppercase tracking-caps text-ink-muted">
                Account
              </span>
              <span className="text-fas-13 font-medium text-ink">{account.label}</span>
            </span>
            {authEnabled && (
              <button
                type="button"
                onClick={logout}
                className="fas-focus rounded-fas-md border border-hairline bg-surface px-3 py-1.5 text-fas-13 text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
              >
                Log out
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        {/* Title — the active account name. */}
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-display text-fas-24 font-bold tracking-tight text-ink">{account.label}</h1>
          <button
            type="button"
            onClick={() => load(activeSlug, true)}
            disabled={loading}
            className="fas-focus inline-flex items-center gap-2 rounded-fas-md border border-hairline bg-surface px-3.5 py-2 text-fas-13 font-semibold text-ink transition-colors hover:border-hairline-strong disabled:opacity-50"
          >
            <RotateCw size={14} strokeWidth={2} aria-hidden="true" className={loading ? "animate-spin" : ""} />
            {loading ? "Scanning…" : discovery ? "Re-scan" : "Run discovery"}
          </button>
        </div>

        <div className="mb-4">
          <SummaryBar
            summary={discovery?.summary ?? null}
            total={rows.length}
            source={discovery?.source ?? null}
            fetchedAt={discovery?.fetchedAt ?? null}
            splitPageCodes={discovery?.splitPageCodes ?? []}
            sgCount={sgCount}
            activeCount={activeCount}
            tierCounts={tierCounts}
            activeStatus={filter}
            onFilter={setFilter}
            mode={mode}
          />
        </div>

        {/* States */}
        {loading && (
          <div className="rounded-fas-lg border border-hairline bg-surface p-8 text-center text-fas-13 text-ink-muted shadow-fas-card">
            Scanning campaigns for <span className="font-medium text-ink">{account.label}</span>…
          </div>
        )}

        {!loading && error && (
          <div
            className="rounded-fas-lg border border-status-missing-api-border bg-status-missing-api-bg p-6 text-fas-13 text-status-missing-api"
            role="alert"
          >
            <p className="font-semibold">Discovery failed</p>
            <p className="mt-1">{error}</p>
            <button
              type="button"
              onClick={() => load(activeSlug)}
              className="fas-focus mt-3 rounded-fas-md border border-status-missing-api-border bg-surface px-3 py-1.5 text-status-missing-api transition-colors hover:brightness-110"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && discovery && rows.length === 0 && (
          <div className="rounded-fas-lg border border-hairline bg-surface p-8 text-center shadow-fas-card">
            <MapPin size={22} strokeWidth={1.75} aria-hidden="true" className="mx-auto mb-2 text-ink-faint" />
            <p className="text-fas-14 font-semibold text-ink">No campaigns to show</p>
            <p className="mt-1 text-fas-13 text-ink-muted">
              {discovery.note ?? `No campaigns were returned for ${account.label}.`}
            </p>
          </div>
        )}

        {!loading && !error && discovery && rows.length > 0 && (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <div className="relative w-full sm:w-80">
                  <Search
                    size={14}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
                  />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter by store code or campaign name…"
                    className="fas-focus w-full rounded-fas-md border border-hairline bg-surface-sunken py-2 pl-9 pr-9 text-fas-13 text-ink placeholder:text-ink-muted"
                    aria-label="Filter by store code or campaign name"
                  />
                  {query ? (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Clear filter"
                      className="fas-focus absolute right-1.5 top-1/2 -translate-y-1/2 rounded-fas-sm p-1.5 text-ink-faint hover:text-ink"
                    >
                      <X size={14} strokeWidth={2} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <BulkSelect onApply={bulkSelect} />
              </div>
              <span className="font-mono text-fas-11 text-ink-muted">
                Showing {filteredRows.length} of {rows.length}
              </span>
            </div>
            {filteredRows.length === 0 ? (
              <div className="rounded-fas-lg border border-hairline bg-surface p-8 text-center shadow-fas-card">
                <SearchX size={22} strokeWidth={1.75} aria-hidden="true" className="mx-auto mb-2 text-ink-faint" />
                <p className="text-fas-14 font-semibold text-ink">No campaigns match the current filters</p>
                <p className="mt-1 text-fas-13 text-ink-muted">
                  Adjust the filter or the search text to see more rows.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setFilter("ALL");
                    setQuery("");
                  }}
                  className="fas-focus mt-3 rounded-fas-md border border-hairline bg-surface px-3.5 py-2 text-fas-13 font-semibold text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <DiscoveryTable
                rows={filteredRows}
                mode={mode}
                splitPageCodes={discovery.splitPageCodes ?? []}
                selectedIds={selectedIds}
                onToggleRow={toggleRow}
                onToggleVisible={toggleVisible}
              />
            )}
          </>
        )}

        {/* Spacer so the sticky selection bar never hides the last rows. */}
        {selectedCount > 0 ? <div aria-hidden="true" className="h-20" /> : null}
      </main>

      {/* Sticky SELECTION ACTION BAR — appears when ≥1 campaign is selected.
          Suppressed while the modal is open so its CTAs never read through the
          scrim and collide with the modal footer's primary action. */}
      {selectedCount > 0 && !modalMode ? (
        <div className="sticky bottom-0 z-30 border-t border-hairline-strong bg-surface/95 shadow-fas-pop backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-2 text-fas-13">
              <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-fas-pill bg-accent px-2 font-mono text-fas-12 font-semibold tabular-nums text-ink-on-accent">
                {selectedCount}
              </span>
              <span className="text-ink">campaign{selectedCount === 1 ? "" : "s"} selected</span>
              <span className="text-ink-faint">·</span>
              <span className="font-mono text-fas-12 tabular-nums text-ink-muted">
                {selectedStoreCount} store{selectedStoreCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={clearSelection}
                className="fas-focus rounded-fas-md border border-hairline bg-surface px-3.5 py-2 text-fas-13 text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setModalMode("duplicate")}
                className="fas-focus inline-flex items-center gap-2 rounded-fas-md border border-hairline bg-surface px-3.5 py-2 text-fas-13 font-semibold text-ink transition-colors hover:border-hairline-strong"
              >
                <Copy size={14} strokeWidth={2} aria-hidden="true" />
                Duplicate ad
              </button>
              <button
                type="button"
                onClick={() => setModalMode("create")}
                className="fas-focus inline-flex items-center gap-2 rounded-fas-md bg-accent px-4 py-2 text-fas-13 font-semibold text-ink-on-accent transition-colors duration-[110ms] ease-fas hover:bg-accent-hover active:bg-accent-pressed"
              >
                <Plus size={14} strokeWidth={2} aria-hidden="true" />
                Create new ad
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Duplicate / Create modal — selection + compose + dry-run preview. */}
      {modalMode ? (
        <DuplicateModal
          mode={modalMode}
          accountSlug={activeSlug}
          campaignIds={selectedCampaignIds}
          storeCount={selectedStoreCount}
          writeEnabled={discovery?.writeEnabled ?? false}
          onClose={() => setModalMode(null)}
        />
      ) : null}
    </div>
  );
}
