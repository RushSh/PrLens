import Link from "next/link";
import { PullIcon } from "@/components/Icons";
import { TriageForm } from "@/components/TriageForm";
import { Box } from "@/components/ui";
import { when } from "@/lib/format";
import { prHref } from "@/lib/pr";
import { loadTriageList } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

export default async function TriagePage() {
  const { list } = await loadTriageList();
  const live = list.prs.filter((p) => p.source === "live");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-fg">Triage a pull request</h1>
        <p className="mt-1 text-muted">
          Paste a public GitHub pull request. PR Lens fetches its diff, skips what needs no model, scores every other region and
          shows the result like a GitHub review. Nothing is called until you confirm the cost.
        </p>
      </div>
      <Box title="Pull request">
        <div className="p-4">
          <TriageForm />
        </div>
      </Box>
      {live.length ? (
        <Box title="Triaged before">
          <ul>
            {live.map((p) => (
              <li key={p.id} className="flex items-center gap-2 border-b border-line-muted px-4 py-2 last:border-b-0">
                <PullIcon className="text-success" />
                <Link href={prHref(p.id)} className="min-w-0 truncate font-semibold text-fg hover:text-accent">
                  {p.title}
                </Link>
                <span className="ml-auto shrink-0 text-xs text-muted">
                  {p.repo} #{p.number} · {when(p.openedAt)}
                </span>
              </li>
            ))}
          </ul>
        </Box>
      ) : null}
    </div>
  );
}
