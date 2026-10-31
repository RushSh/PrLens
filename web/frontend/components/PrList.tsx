"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { EVAL_LANGUAGES, type PrTriageSummary, type TriageList } from "@prlens/shared";
import { pct, when } from "@/lib/format";
import { prHref, prRef } from "@/lib/pr";
import { AgentIcon, CheckIcon, CommitIcon, LensIcon, PullIcon, XIcon } from "./Icons";
import { Counter, Pill, buttonPrimary, input } from "./ui";

type View = "live" | "agent" | "eval";

export function PrList({ list, offline }: { list: TriageList; offline: boolean }) {
  const live = list.prs.filter((p) => p.source === "live" || p.source === "sample");
  const agents = list.prs.filter((p) => p.source === "agent");
  const evals = list.prs.filter((p) => p.source === "eval");
  const [view, setView] = useState<View>(live.length ? "live" : "eval");
  const [q, setQ] = useState("");
  const [repo, setRepo] = useState("");
  const [language, setLanguage] = useState("");
  const [outcome, setOutcome] = useState<"" | "caught" | "missed">("");

  const rows = view === "live" ? live : view === "agent" ? agents : evals;
  const languages = EVAL_LANGUAGES.filter((l) => rows.some((p) => p.language === l.key));
  const repos = useMemo(
    () => [...new Set(rows.filter((p) => !language || p.language === language).map((p) => p.repo))].sort(),
    [rows, language],
  );
  const shown = rows.filter(
    (p) =>
      (!q || `${p.title} ${p.repo} ${p.branch}`.toLowerCase().includes(q.toLowerCase())) &&
      (!language || p.language === language) &&
      (!repo || p.repo === repo) &&
      (!outcome || (outcome === "caught" ? p.caughtByTriage === true : p.caughtByTriage === false)),
  );
  // the evaluation summary follows the language and repository filters (not the outcome filter it would trivially match)
  const scope = (view === "agent" ? agents : evals).filter((p) => (!language || p.language === language) && (!repo || p.repo === repo));
  const kept = scope.filter((p) => p.caughtByTriage).length;
  const readShare = scope.reduce((a, p) => a + p.readLines, 0) / Math.max(1, scope.reduce((a, p) => a + p.totalLines, 0));
  const evalLink = `/evaluation${language ? `?lang=${language}` : ""}`;

  return (
    <div className="space-y-4">
      {offline ? (
        <div className="rounded-md border border-attention/40 bg-attention-subtle px-4 py-2.5 text-sm text-fg">
          Can&apos;t reach the PR Lens backend. Start it with <span className="font-mono">npm run dev:backend</span> in{" "}
          <span className="font-mono">web/</span>.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${input} min-w-0 flex-1 sm:max-w-md`}
          placeholder="Search pull requests"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search pull requests"
        />
        <div className="ml-auto flex gap-2">
          <Link href="/triage" className={buttonPrimary}>
            New triage
          </Link>
        </div>
      </div>

      <div className="rounded-md border border-line">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-t-md border-b border-line bg-subtle px-4 py-3">
          <TabButton active={view === "live"} onClick={() => setView("live")} icon={<PullIcon />}>
            Triaged <Counter>{live.length}</Counter>
          </TabButton>
          {agents.length ? (
            <TabButton active={view === "agent"} onClick={() => setView("agent")} icon={<AgentIcon />}>
              Muse Code PRs <Counter>{agents.length}</Counter>
            </TabButton>
          ) : null}
          <TabButton active={view === "eval"} onClick={() => setView("eval")} icon={<CommitIcon />}>
            Evaluation set <Counter>{evals.length}</Counter>
          </TabButton>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm text-muted">
            {languages.length > 1 ? (
              <select
                aria-label="Language"
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  setRepo("");
                }}
                className="rounded-md bg-transparent py-0.5 text-sm text-muted hover:text-fg"
              >
                <option value="">Language</option>
                {languages.map((l) => (
                  <option key={l.key} value={l.key}>{l.label}</option>
                ))}
              </select>
            ) : null}
            <select aria-label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)} className="rounded-md bg-transparent py-0.5 text-sm text-muted hover:text-fg">
              <option value="">Repository</option>
              {repos.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            {view !== "live" ? (
              <select aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} className="rounded-md bg-transparent py-0.5 text-sm text-muted hover:text-fg">
                <option value="">Outcome</option>
                <option value="caught">Bug kept for review</option>
                <option value="missed">Bug skipped</option>
              </select>
            ) : null}
          </div>
        </div>

        {view === "eval" && scope.length ? (
          <p className="border-b border-line px-4 py-2.5 text-sm text-muted">
            Real commits that each introduced a bug fixed later, triaged without knowing where the bug was. PR Lens kept
            the bug for review in{" "}
            <span className="font-semibold text-fg">
              {kept} of {scope.length}
            </span>{" "}
            while leaving <span className="font-semibold text-fg">{pct(readShare)}</span> of lines to read.{" "}
            <Link href={evalLink} className="text-accent hover:underline">How this was measured</Link>
          </p>
        ) : null}

        {view === "agent" ? (
          <p className="border-b border-line px-4 py-2.5 text-sm text-muted">
            The Muse Code agent re-implemented evaluation commits from their messages; the later fix&apos;s tests then
            showed whether its change held a bug. PR Lens kept the bug for review in{" "}
            <span className="font-semibold text-fg">
              {scope.filter((p) => p.caughtByTriage).length} of {scope.filter((p) => p.caughtByTriage !== null).length}
            </span>{" "}
            agent PRs with one, leaving <span className="font-semibold text-fg">{pct(readShare)}</span> of lines to read.{" "}
            <Link href="/agent-study" className="text-accent hover:underline">The study and its funnel</Link>
          </p>
        ) : null}

        {shown.length ? (
          <ul>
            {shown.map((p) => (
              <Row key={`${p.set}:${p.id}`} pr={p} />
            ))}
          </ul>
        ) : (
          <div className="px-4 py-12 text-center text-muted">
            {view === "live" && !live.length ? (
              <>
                <LensIcon size={28} className="mx-auto mb-2" />
                <p className="text-base font-semibold text-fg">No pull requests triaged yet</p>
                <p className="mt-1">
                  Paste a GitHub pull request link on <Link href="/triage" className="text-accent hover:underline">Triage a PR</Link>,
                  or browse the evaluation set.
                </p>
              </>
            ) : (
              "No pull requests match these filters."
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 text-sm ${active ? "font-semibold text-fg" : "text-muted hover:text-fg"}`}
    >
      {icon}
      {children}
    </button>
  );
}

function Row({ pr }: { pr: PrTriageSummary }) {
  const share = pr.totalLines ? pr.readLines / pr.totalLines : 0;
  const isEval = pr.source === "eval";
  const isAgent = pr.source === "agent";
  return (
    <li className="flex gap-3 border-b border-line-muted px-4 py-2.5 last:border-b-0 hover:bg-subtle">
      <span className={`mt-0.5 ${isEval ? "text-done" : "text-success"}`}>{isEval ? <CommitIcon /> : isAgent ? <AgentIcon /> : <PullIcon />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link href={prHref(pr.id)} className="font-semibold text-fg hover:text-accent">
            {pr.title}
          </Link>
          {pr.caughtByTriage === true ? (
            <Pill tone="success" title="The real bug was in the review list">
              <CheckIcon size={12} /> bug kept for review
            </Pill>
          ) : pr.caughtByTriage === false ? (
            <Pill tone="danger" title="The real bug was in the skipped part">
              <XIcon size={12} /> bug skipped
            </Pill>
          ) : null}
          {pr.reviewCount ? <Pill tone="attention">{pr.reviewCount} to review</Pill> : <Pill tone="success">nothing to review</Pill>}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          <span className="font-mono">{pr.repo}</span> · {EVAL_LANGUAGES.find((l) => l.key === pr.language)?.label ?? pr.language} · {isAgent ? <>written by Muse Code · task from {when(pr.openedAt)}</> : <>{prRef(pr)} · {isEval ? "committed" : "opened"} {when(pr.openedAt)}</>}
        </div>
      </div>
      <div className="hidden w-40 shrink-0 text-right sm:block">
        <div className="tabular text-xs text-muted">
          read <span className="font-semibold text-fg">{pr.readLines}</span> of {pr.totalLines} lines
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line-muted" aria-hidden>
          <div className="h-1.5 rounded-full bg-accent" style={{ width: `${share * 100}%` }} />
        </div>
      </div>
    </li>
  );
}
