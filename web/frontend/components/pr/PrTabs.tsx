"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckIcon, CommentIcon, FileIcon } from "../Icons";
import { Counter } from "../ui";

export function PrTabs({ base, files, toReview }: { base: string; files: number; toReview: number }) {
  const path = usePathname();
  const tabs = [
    { href: base, label: "Conversation", icon: <CommentIcon />, count: null as number | null },
    { href: `${base}/files`, label: "Files changed", icon: <FileIcon />, count: files },
    { href: `${base}/checks`, label: "Checks", icon: <CheckIcon />, count: 1 },
  ];
  return (
    <nav className="-mx-4 flex overflow-x-auto border-b border-line px-4 md:mx-0 md:px-0" aria-label="Pull request">
      {tabs.map((t) => {
        const active = path === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              active ? "border-[#fd8c73] font-semibold text-fg" : "border-transparent text-muted hover:border-line hover:text-fg"
            }`}
          >
            {t.icon}
            {t.label}
            {t.count !== null ? <Counter>{t.count}</Counter> : null}
          </Link>
        );
      })}
      <span className="ml-auto hidden items-center pl-4 text-xs text-muted sm:flex">
        {toReview ? (
          <>
            <span className="tabular mr-1 font-semibold text-attention">{toReview}</span> regions need a human
          </>
        ) : (
          <span className="text-success">nothing needs a human</span>
        )}
      </span>
    </nav>
  );
}
