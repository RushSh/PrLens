import type { RunSummary } from "@bugcensus/shared";
import { RunsTable } from "@/components/RunsTable";
import { Empty } from "@/components/ui";
import { serverGet } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await serverGet<RunSummary[]>("/api/runs");
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">Runs</h1>
        <p className="text-sm text-stone-500">
          Every census, newest first. Tick two or more to compare them side by side.
        </p>
      </div>
      {runs.length ? (
        <RunsTable runs={runs} />
      ) : (
        <Empty>
          No runs yet. Start one from <a className="underline" href="/new">New run</a>, or load saved runs with{" "}
          <code className="rounded bg-stone-100 px-1">npm run import</code> in <code>web/backend</code>.
        </Empty>
      )}
    </div>
  );
}
