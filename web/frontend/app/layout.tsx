import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "BugCensus",
  description: "Census runs, reviewer models and realism checks",
};

const NAV = [
  { href: "/", label: "Runs" },
  { href: "/new", label: "New run" },
  { href: "/jobs", label: "Jobs" },
  { href: "/realism", label: "Realism checks" },
  { href: "/calibration", label: "Calibration" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
            <Link href="/" className="text-sm font-bold tracking-tight text-stone-900">
              BugCensus
            </Link>
            <nav className="flex gap-1 overflow-x-auto">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="whitespace-nowrap rounded px-2.5 py-1.5 text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-900"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
