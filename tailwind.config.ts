import type { Config } from "tailwindcss";

// Clean, neutral light theme (Linear/Vercel-light): white surfaces, cool slate
// neutrals, one indigo accent. Every value is backed by a CSS custom property
// defined in app/globals.css (mirrored in design/tokens.css), so the light
// default and the authored dark variant are a token swap — components never
// change. See docs/design/DESIGN-SYSTEM.md.
const v = (name: string) => `var(--fas-${name})`;

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    // NOTE: design/ is an independent set of static mocks, imported by nothing in
    // app/, components/, or lib/ (and already excluded in tsconfig). Scanning it
    // forced Tailwind to keep utilities only those mocks use. Dropped to trim the
    // emitted CSS and speed the content scan.
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces & structure
        void: v("void"),
        canvas: v("canvas"),
        surface: {
          DEFAULT: v("surface"),
          raised: v("surface-raised"),
          sunken: v("surface-sunken"),
          alt: v("surface-alt"),
        },
        hairline: {
          DEFAULT: v("hairline"),
          strong: v("hairline-strong"),
        },
        gridtick: v("grid-tick"),

        // Ink
        ink: {
          DEFAULT: v("ink"),
          muted: v("ink-muted"),
          faint: v("ink-faint"),
          mono: v("ink-mono"),
          "on-accent": v("ink-on-accent"),
        },

        // Action accent
        accent: {
          DEFAULT: v("accent"),
          hover: v("accent-hover"),
          pressed: v("accent-pressed"),
          tint: v("accent-tint"),
          ring: v("accent-ring"),
        },

        // Reconciliation status (the 6 real states) — fg / bg / border per state.
        status: {
          ok: v("ok"),
          "ok-bg": v("ok-bg"),
          "ok-border": v("ok-border"),
          mismatch: v("mismatch"),
          "mismatch-bg": v("mismatch-bg"),
          "mismatch-border": v("mismatch-border"),
          "missing-api": v("missing-api"),
          "missing-api-bg": v("missing-api-bg"),
          "missing-api-border": v("missing-api-border"),
          "missing-map": v("missing-map"),
          "missing-map-bg": v("missing-map-bg"),
          "missing-map-border": v("missing-map-border"),
          "no-code": v("no-code"),
          "no-code-bg": v("no-code-bg"),
          "no-code-border": v("no-code-border"),
          "api-error": v("api-error"),
          "api-error-bg": v("api-error-bg"),
          "api-error-border": v("api-error-border"),
          // Legacy aliases retained so any older reference keeps resolving.
          okBg: v("ok-bg"),
          mismatchBg: v("mismatch-bg"),
          missing: v("mismatch"),
          missingBg: v("mismatch-bg"),
          neutral: v("no-code"),
          neutralBg: v("no-code-bg"),
        },

        // Split-page hazard
        split: {
          DEFAULT: v("split"),
          bg: v("split-bg"),
          border: v("split-border"),
          rail: v("split-rail"),
        },

        // Delivery axis (effective_status)
        deliver: {
          active: v("deliver-active"),
          paused: v("deliver-paused"),
          review: v("deliver-review"),
        },

        // Connection health
        health: {
          ok: v("health-ok"),
          degraded: v("health-degraded"),
          down: v("health-down"),
        },
      },
      fontFamily: {
        sans: ["var(--fas-font-sans)"],
        display: ["var(--fas-font-display)"],
        mono: ["var(--fas-font-mono)"],
      },
      fontSize: {
        "fas-11": ["11px", { lineHeight: "16px" }],
        "fas-12": ["12px", { lineHeight: "16px" }],
        "fas-13": ["13px", { lineHeight: "18px" }],
        "fas-14": ["14px", { lineHeight: "20px" }],
        "fas-18": ["18px", { lineHeight: "24px" }],
        "fas-24": ["24px", { lineHeight: "30px" }],
      },
      borderRadius: {
        "fas-sm": v("radius-sm"),
        "fas-md": v("radius-md"),
        "fas-lg": v("radius-lg"),
        "fas-pill": v("radius-pill"),
      },
      letterSpacing: {
        caps: "var(--fas-tracking-caps)",
        "caps-tight": "var(--fas-tracking-caps-tight)",
      },
      boxShadow: {
        bezel: v("bezel"),
        "fas-card": v("shadow-card"),
        "fas-pop": v("shadow-pop"),
        "fas-modal": v("shadow-modal"),
      },
      transitionTimingFunction: {
        fas: "cubic-bezier(0.2, 0, 0, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
