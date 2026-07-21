import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Sora, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Type stack mirrors the dupe.ad landing page so the app and the site read as one
// product: Sora for display (wordmark + headings), Hanken Grotesk for UI/content,
// JetBrains Mono for IDs/counts (0 vs O is load-bearing on a page_id). Exposed as
// the CSS vars the tokens consume. The neutral light theme is the default —
// <html> carries no forced data-theme, so :root (light) wins.
const sans = Hanken_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-hanken",
});

const display = Sora({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  display: "swap",
  variable: "--font-sora",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  // Lowercase to match the wordmark — the tab title and the header read as one brand.
  title: "dupe.ad",
  description: "Bulk-duplicate Meta ads across all your Pages.",
};

// Tint the browser chrome (mobile URL bar, PWA title bar) to the app frame.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#EDEFF2" },
    { media: "(prefers-color-scheme: dark)", color: "#0A0C10" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
