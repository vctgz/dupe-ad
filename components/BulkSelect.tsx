"use client";

// BulkSelect — a paste-a-list-of-store-numbers selector. Sits next to the table
// filter box. The operator drops store numbers (one per line OR comma-separated,
// padded or not — "62" matches "062"), and every campaign for those stores is
// added to the selection. Reports how many stores matched and which numbers
// weren't found, so a typo can't silently drop a store.
//
// Presentational/self-contained: it owns the popover + textarea state; the parent
// supplies `onApply(tokens)` which does the matching against the live rows and
// returns the result for feedback.
import { useEffect, useRef, useState } from "react";
import { ClipboardList, X, Check, TriangleAlert } from "lucide-react";

export interface BulkSelectResult {
  matched: number;
  notFound: string[];
}

export default function BulkSelect({
  onApply,
}: {
  onApply: (tokens: string[]) => BulkSelectResult;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState<BulkSelectResult | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    taRef.current?.focus();
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function apply() {
    const tokens = [
      ...new Set(
        text
          .split(/[\s,;]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ];
    if (tokens.length === 0) {
      setResult({ matched: 0, notFound: [] });
      return;
    }
    setResult(onApply(tokens));
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="fas-focus inline-flex items-center gap-2 whitespace-nowrap rounded-fas-md border border-hairline bg-surface px-3 py-2 text-fas-13 font-medium text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
      >
        <ClipboardList size={14} strokeWidth={2} aria-hidden="true" />
        Bulk select
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Bulk-select by store number"
          className="absolute left-0 z-40 mt-2 w-[20rem] rounded-fas-lg border border-hairline bg-surface p-3 shadow-fas-pop"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-fas-13 font-semibold text-ink">Select by store number</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="fas-focus -mr-1 rounded-fas-sm p-1 text-ink-faint hover:text-ink"
            >
              <X size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1 text-fas-11 text-ink-muted">
            Paste store numbers — one per line or comma-separated. Adds every matching
            campaign to your selection.
          </p>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
            rows={5}
            placeholder={"062\n067\n103\n\nor  62, 67, 103"}
            className="fas-focus mt-2 w-full resize-y rounded-fas-md border border-hairline bg-surface-sunken px-2.5 py-2 font-mono text-fas-12 leading-5 text-ink placeholder:text-ink-faint"
          />

          {result ? (
            <div className="mt-2 flex flex-col gap-1 text-fas-12">
              <span className="inline-flex items-center gap-1.5 text-status-ok">
                <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                Selected {result.matched} store{result.matched === 1 ? "" : "s"}
              </span>
              {result.notFound.length > 0 ? (
                <span className="inline-flex items-start gap-1.5 text-ink-muted">
                  <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0 text-status-missing-map" />
                  <span>
                    {result.notFound.length} not found:{" "}
                    <span className="font-mono text-ink">
                      {result.notFound.slice(0, 15).join(", ")}
                      {result.notFound.length > 15 ? "…" : ""}
                    </span>
                  </span>
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setText("");
                setResult(null);
                taRef.current?.focus();
              }}
              className="fas-focus rounded-fas-md border border-hairline bg-surface px-3 py-1.5 text-fas-12 font-medium text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={text.trim().length === 0}
              className="fas-focus inline-flex items-center gap-1.5 rounded-fas-md bg-accent px-3.5 py-1.5 text-fas-12 font-semibold text-ink-on-accent transition-colors duration-[110ms] ease-fas hover:bg-accent-hover active:bg-accent-pressed disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-faint"
            >
              Select
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
