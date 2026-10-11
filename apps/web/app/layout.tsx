import type { Metadata } from "next";

import { fontVariables } from "@/lib/fonts";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "kept",
    template: "%s · kept",
  },
  description: "Anonymous-first page hosting that just stays up.",
  // The mascot, served by `app/favicon.ico`, `app/icon.svg` and
  // `app/apple-touch-icon.png` (E06a §8) — dotted paths the middleware skips.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="light"
      className={fontVariables}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-bg font-body text-text antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
