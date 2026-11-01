import Link from "next/link";
import { PrList } from "@/components/PrList";
import { button, buttonPrimary } from "@/components/ui";
import { prHref } from "@/lib/pr";
import { loadTriageList } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

/** The Muse Code PR the demo opens on: the one bug the agent wrote itself, which PR Lens kept for review. */
const DEMO_PR = "agent:more-itertools/more-itertools@eb24d3927a";

export default async function PullRequestsPage() {
  const { list, offline } = await loadTriageList();
  const demo = list.prs.find((p) => p.id === DEMO_PR);
  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-semibold text-fg md:text-[28px]">A review budget for AI-agent merges</h1>
          <p className="mt-1.5 text-muted">
            Agents write pull requests faster than anyone can read them. PR Lens tells the reviewer which regions still need
            human eyes and which are safe to skip, with a stated miss rate: the Muse Code agent writes the change, Muse Spark
            Open scores every region, and the Muse Spark Model API notes what to check.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {demo ? (
            <Link
              href={prHref(demo.id, "files")}
              className={buttonPrimary}
            >
              Open a Muse Code PR
            </Link>
          ) : null}
          <Link
            href="/evaluation"
            className={button}
          >
            How it is measured
          </Link>
        </div>
      </section>
      <PrList list={list} offline={offline} />
    </div>
  );
}
