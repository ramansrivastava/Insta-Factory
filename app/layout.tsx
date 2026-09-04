import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Instagram Creator OS",
  description: "Raw idea in — distinct hook options and a full Reel script out, in your voice.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
