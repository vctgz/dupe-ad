// Login portal — a branded, centered sign-in card matching the dupe.ad site:
// the two-tone logo + wordmark over a white card on the soft frame. The form is a
// client component wrapped in Suspense because it reads ?next= for post-login redirect.
import type { Metadata } from "next";
import { Suspense } from "react";
import LoginForm from "./LoginForm";

// Page-specific title; the rest of the app keeps the root "Dupe.Ad".
export const metadata: Metadata = {
  title: "Dupe.Ad · Log in",
};

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-void px-6 py-12">
      <div className="w-full max-w-[26.5rem]">
        {/* Brand mark, centered above the card */}
        <div className="mb-6 flex items-center justify-center gap-3">
          <svg width="33" height="33" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="8" y="3.4" width="12.6" height="12.6" rx="3.4" fill="#bcd3e8" />
            <rect x="3.4" y="8" width="12.6" height="12.6" rx="3.4" fill="#2b5c8a" />
          </svg>
          <span className="font-display text-[24px] font-bold tracking-tight text-ink">
            dupe<span className="text-accent">.ad</span>
          </span>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-hairline-strong bg-surface p-[34px] shadow-[0_24px_56px_-24px_rgba(20,34,58,0.30),0_8px_18px_-10px_rgba(20,34,58,0.14)]">
          <h1 className="font-display text-fas-24 font-bold tracking-tight text-ink">Sign in</h1>
          <p className="mt-1.5 text-fas-13 leading-relaxed text-ink-muted">
            Enter your account name and password to continue.
          </p>

          <Suspense
            fallback={<div className="mt-6 text-fas-13 text-ink-faint">Loading…</div>}
          >
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
