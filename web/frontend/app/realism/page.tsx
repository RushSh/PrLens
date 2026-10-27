import type { RealismExperiment } from "@bugcensus/shared";
import { Card, Empty, ModelChip, Td, Th } from "@/components/ui";
import { serverGet } from "@/lib/api";
import { int, pct, signed, when } from "@/lib/format";

export const dynamic = "force-dynamic";

function Bar({ value, tone }: { value: number; tone: string }) {
  return (
    <div className="h-2 w-28 rounded-sm bg-stone-100" aria-hidden>
      <div className={`h-2 rounded-sm ${tone}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export default async function RealismPage() {
  const exps = await serverGet<RealismExperiment[]>("/api/realism");
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">Realism checks</h1>
        <p className="max-w-3xl text-sm text-stone-500">
          Do reviewers catch decoys about as often as real bugs? A gap near zero means decoys are a fair stand-in;
          a positive gap means decoys are easier, so estimates lean optimistic.
        </p>
      </div>
      {!exps.length ? (
        <Empty>
          No realism checks loaded. Run{" "}
          <code className="rounded bg-stone-100 px-1">python scripts/realism.py analyze --json data/realism_NAME.json</code> then{" "}
          <code className="rounded bg-stone-100 px-1">npm run import</code>.
        </Empty>
      ) : null}
      {exps.map((e) => (
        <Card
          key={e.id}
          title={e.name}
          right={<span className="text-xs text-stone-500">analyzed {when(e.analyzedAt)}</span>}
        >
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-stone-600">
            <span>{e.bugs} real bugs</span>
            <span>{e.units} review units</span>
            <span>{e.repos} repositories</span>
            <span>{int(e.outputTokens)} output tokens</span>
            <span className="flex flex-wrap gap-1">
              {e.models.map((m) => (
                <ModelChip key={m.reviewer} model={m} />
              ))}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-stone-200">
                  <Th>Reviewer</Th>
                  <Th>Real bugs caught</Th>
                  <Th>Decoys caught</Th>
                  <Th className="text-right">Gap (logit)</Th>
                  <Th className="text-right">95% CI</Th>
                </tr>
              </thead>
              <tbody>
                {e.reviewers.map((r) => (
                  <tr key={r.reviewer} className={`border-b border-stone-100 ${r.reviewer === "panel" ? "font-semibold" : ""}`}>
                    <Td>{r.reviewer === "panel" ? "Panel (any reviewer)" : r.reviewer}</Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <Bar value={r.realRate} tone="bg-stone-700" />
                        <span className="tabular">{pct(r.realRate)}</span>
                        <span className="text-xs font-normal text-stone-400">n={r.realN}</span>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <Bar value={r.decoyRate} tone="bg-sky-600" />
                        <span className="tabular">{pct(r.decoyRate)}</span>
                        <span className="text-xs font-normal text-stone-400">n={r.decoyN}</span>
                      </div>
                    </Td>
                    <Td className="tabular text-right">{signed(r.gapLogit)}</Td>
                    <Td className={`tabular text-right ${r.ciLow > 0 ? "text-amber-700" : ""}`}>
                      {signed(r.ciLow)} to {signed(r.ciHigh)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Missed by every reviewer</h3>
              <ul className="text-sm">
                {Object.entries(e.missAll).map(([kind, v]) => (
                  <li key={kind}>
                    {kind === "real" ? "Real bugs" : "Decoys"}: <span className="tabular font-medium">{pct(v.rate)}</span>{" "}
                    <span className="text-stone-400">of {v.n}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-stone-500">This is the rate the estimator relies on.</p>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Decoys caught by family (panel)</h3>
              <ul className="space-y-1 text-sm">
                {e.families.map((f) => (
                  <li key={f.family} className="flex items-center gap-2">
                    <span className="w-28 font-mono text-xs">{f.family}</span>
                    <Bar value={f.rate} tone="bg-sky-600" />
                    <span className="tabular">{pct(f.rate)}</span>
                    <span className="text-xs text-stone-400">n={f.n}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
