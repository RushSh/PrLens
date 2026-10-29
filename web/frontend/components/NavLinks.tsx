"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Pull requests", match: (p: string) => p === "/" || p.startsWith("/pr/") },
  { href: "/evaluation", label: "Evaluation", match: (p: string) => p.startsWith("/evaluation") },
  { href: "/triage", label: "Triage a PR", match: (p: string) => p.startsWith("/triage") },
  { href: "/pipeline", label: "Pipeline", match: (p: string) => p.startsWith("/pipeline") },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto" aria-label="Main">
      {NAV.map((n) => {
        const active = n.match(path);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap rounded-md px-2.5 py-1 text-sm font-medium ${
              active ? "bg-white/15 text-header-fg" : "text-header-muted hover:text-header-fg"
            }`}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
