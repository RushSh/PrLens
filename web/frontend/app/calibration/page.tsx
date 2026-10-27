import type { CalibrationExperiment, CalibrationVariant } from "@bugcensus/shared";
import { CalibrationChart } from "@/components/CalibrationChart";
import { Card, Empty, ModelChip, Td, Th } from "@/components/ui";
import { serverGet } from "@/lib/api";
import { int, pct, when } from "@/lib/format";

export const dynamic = "force-dynamic";

const r2 = (x: number | null | undefined) => (x === null || x === undefined ? "–" : x.toFixed(2));
const ci = (c: [number | null, number | null]) => (c[0] === null ? "" : ` (95% CI ${r2(c[0])}–${r2(c[1])})`);

const ROWS: { label: string; help: string; value: (v: CalibrationVariant) => string }[] = [
  {
    label: "Actual ÷ predicted, all units",
    help: "1 is perfect; below 1 the estimate is too cautious, above 1 too optimistic",
    value: (v) => `${r2(v.totals.actual_over_predicted)}${ci(v.totals.ci)}`,
  },
  {
    label: "Hidden bugs, predicted vs actual",
    help: "summed over all units",
    value: (v) => `${v.totals.predicted.toFixed(1)} vs ${v.totals.actual.toFixed(0)}`,
  },
  {
    label: "Slope (actual on predicted)",
    help: "1 means higher predictions really mean more hidden bugs",
    value: (v) => `${r2(v.slope.value)}${ci(v.slope.ci)}`,
  },
  { label: "90% interval covers the truth", help: "should be about 90%", value: (v) => pct(v.coverage90.rate) },
  {
    label: "Cleared by the Clear rule",
    help: "units with P(clean) ≥ 90%",
    value: (v) => `${v.clear_rule.cleared} (${pct(v.clear_rule.share_cleared)})`,
  },
  {
    label: "…of which still had a hidden bug",
    help: "false-clear rate; should be about 10% or less",
    value: (v) => (v.clear_rule.false_clear_rate === null ? "–" : pct(v.clear_rule.false_clear_rate)),
  },
  {
    label: "AUC: spotting units with anything hidden",
    help: "the estimate vs simply counting findings (0.5 = guessing)",
    value: (v) => `${r2(v.auc_anything_hidden.estimate)} vs ${r2(v.auc_anything_hidden.findings_count_baseline)}`,
  },
];

export default async function CalibrationPage() {
  const exps = await serverGet<CalibrationExperiment[]>("/api/calibration");
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">Calibration</h1>
        <p className="max-w-3xl text-sm text-stone-500">
          When BugCensus says a change still hides N bugs, does it? Each unit is a small change built from real bug fixes
          with a known number of real bugs. The census runs on it as on any PR, and its prediction is compared with the truth.
        </p>
      </div>
      {!exps.length ? (
        <Empty>
          No calibration results yet. Prepare with <code className="rounded bg-stone-100 px-1">python scripts/calibration.py prepare</code>,
          try <code className="rounded bg-stone-100 px-1">dry-run</code>, then <code className="rounded bg-stone-100 px-1">run</code> and{" "}
          <code className="rounded bg-stone-100 px-1">analyze</code>. Results appear here automatically.
        </Empty>
      ) : null}
      {exps.map((e) => (
        <Card
          key={e.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              {e.name}
              {e.dryRun ? (
                <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-stone-600 ring-1 ring-inset ring-stone-300">
                  DRY RUN · fake reviewers
                </span>
              ) : null}
            </span>
          }
          right={<span className="text-xs text-stone-500">analyzed {when(e.analyzedAt)}</span>}
        >
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-stone-600">
            <span>{e.nUnits} units</span>
            <span>{e.repos} repositories</span>
            <span>{e.decoysPerUnit.toFixed(1)} decoys per unit</span>
            <span>{pct(e.decoyMissRate)} of decoys missed by every reviewer</span>
            <span>
              {int(e.calls.total)} review calls{e.calls.errors ? `, ${e.calls.errors} failed` : ""}
              {e.calls.output_tokens ? `, ${int(e.calls.output_tokens)} output tokens` : ""}
            </span>
            <span className="flex flex-wrap gap-1">
              {e.models.map((m) => (
                <ModelChip
                  key={m.reviewer}
                  model={{ ...m, endpoint: null, openWeights: false, maxTokens: null, inferred: false }}
                />
              ))}
            </span>
          </div>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,640px)_1fr]">
            <CalibrationChart variants={e.variants} />
            <div className="min-w-0 space-y-4">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-stone-200">
                      <Th>Measure</Th>
                      {e.variants.map((v) => (
                        <Th key={v.name}>{v.label}</Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map((row) => (
                      <tr key={row.label} className="border-b border-stone-100">
                        <Td>
                          <div>{row.label}</div>
                          <div className="text-xs text-stone-500">{row.help}</div>
                        </Td>
                        {e.variants.map((v) => (
                          <Td key={v.name} className="tabular">{row.value(v)}</Td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
                  Is P(clean) honest? (units grouped by P(clean))
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead>
                      <tr className="border-b border-stone-200">
                        <Th>Variant</Th>
                        <Th>P(clean) range</Th>
                        <Th className="text-right">Units</Th>
                        <Th className="text-right">Said clean</Th>
                        <Th className="text-right">Were clean</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.variants.flatMap((v) =>
                        v.pclean_bins.map((b) => (
                          <tr key={`${v.name}-${b.lo}`} className="border-b border-stone-100">
                            <Td className="text-xs">{v.name}</Td>
                            <Td>{pct(b.lo)}–{pct(b.hi)}</Td>
                            <Td className="tabular text-right">{b.n}</Td>
                            <Td className="tabular text-right">{pct(b.mean_p_clean)}</Td>
                            <Td className="tabular text-right">{pct(b.frac_clean)}</Td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
          {e.notes.length ? (
            <ul className="mt-4 list-disc space-y-0.5 pl-5 text-xs text-stone-500">
              {e.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
