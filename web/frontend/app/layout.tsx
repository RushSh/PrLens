import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { LensIcon } from "@/components/Icons";
import { NavLinks } from "@/components/NavLinks";
import "./globals.css";

export const metadata: Metadata = {
  title: "PR Lens",
  description: "Which parts of a pull request need a human reviewer, and which are safe to skip",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-sm antialiased">
        <header className="bg-header text-header-fg">
          <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-6">
            <Link href="/" className="flex items-center gap-2 text-base font-semibold">
              <LensIcon size={22} />
              PR Lens
            </Link>
            <NavLinks />
          </div>
        </header>
        <main className="mx-auto max-w-[1280px] px-4 py-6 md:px-6">{children}</main>
      </body>
    </html>
  );
}
