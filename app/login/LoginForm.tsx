"use client";

// Login form (client). Client name + password -> POST /api/auth/login, which sets
// the signed httpOnly session cookie locked to that account, then redirects to that
// account's dashboard (/<slug>) or a SAFE originally-requested ?next= path.
//
// SEAM: magic-link / SSO replaces this form in a later phase; the dashboard and
// route guards stay identical (they only care about the session cookie).
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeInternalPath } from "@/lib/safe-path";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [client, setClient] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client, password }),
      });
      if (res.ok) {
        // Prefer a SAFE internal ?next= target; otherwise land on the account the
        // session is now locked to (returned by the login route). safeInternalPath()
        // closes the open-redirect a pen test flagged.
        const body = (await res.json().catch(() => ({}))) as { slug?: string };
        const rawNext = params.get("next");
        const next = rawNext
          ? safeInternalPath(rawNext)
          : body.slug
            ? `/${body.slug}`
            : "/";
        router.replace(next);
        router.refresh();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Incorrect client name or password");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <div className="space-y-1.5">
        <label className="block text-fas-13 font-medium text-ink" htmlFor="client">
          Client
        </label>
        <input
          id="client"
          name="client"
          type="text"
          autoComplete="username"
          value={client}
          onChange={(e) => setClient(e.target.value)}
          aria-invalid={error ? true : undefined}
          className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 text-fas-14 text-ink placeholder:text-ink-muted focus:border-accent"
          placeholder="Your account name"
          autoFocus
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-fas-13 font-medium text-ink" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          className="fas-focus w-full rounded-fas-md border border-hairline bg-surface px-3.5 py-2.5 font-mono text-fas-14 tracking-[0.12em] text-ink placeholder:tracking-normal placeholder:text-ink-muted focus:border-accent"
          placeholder="••••••••••••"
        />
      </div>

      {error && (
        <p
          id="login-error"
          className="rounded-fas-md border border-status-mismatch-border bg-status-mismatch-bg px-3 py-2 text-fas-12 text-status-mismatch"
          role="alert"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || client.length === 0 || password.length === 0}
        className="fas-focus mt-1 w-full rounded-fas-md bg-accent px-3.5 py-3 font-display text-fas-14 font-semibold text-ink-on-accent shadow-fas-card transition-colors duration-[110ms] ease-fas hover:bg-accent-hover active:bg-accent-pressed disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-faint disabled:shadow-none"
      >
        {submitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
