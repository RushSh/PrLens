import type { RunDecoy, RunSuspectedBug } from "@bugcensus/shared";

/** The original file with line numbers; suspected bugs and decoy positions are marked in the gutter. */
export function CodeView({
  source,
  bugs,
  decoys,
}: {
  source: string;
  bugs: RunSuspectedBug[];
  decoys: RunDecoy[];
}) {
  const lines = source.replace(/\n$/, "").split("\n");
  const bugAt = (n: number) => bugs.some((b) => n >= b.startLine && n <= b.endLine);
  const decoysAt = (n: number) => decoys.filter((d) => d.line === n);

  return (
    <div className="overflow-x-auto rounded border border-stone-200 bg-stone-50">
      <pre className="min-w-max py-2 font-mono text-[12.5px] leading-5">
        {lines.map((text, i) => {
          const n = i + 1;
          const bug = bugAt(n);
          const ds = decoysAt(n);
          return (
            <div key={n} className={`flex ${bug ? "bg-orange-100/70" : ""}`}>
              <span className="w-12 shrink-0 select-none pr-3 text-right text-stone-400">{n}</span>
              <span className="w-3 shrink-0">
                {ds.length ? (
                  <span
                    className={`mt-1.5 inline-block h-2 w-2 rounded-full ${
                      ds.some((d) => d.notReviewed) ? "bg-amber-500" : ds.every((d) => d.caughtBy.length) ? "bg-emerald-500" : "bg-red-500"
                    }`}
                    title={ds.map((d) => `${d.copyName}: ${d.description}`).join("\n")}
                  />
                ) : null}
              </span>
              <code className="whitespace-pre pr-4 text-stone-800">{text || " "}</code>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
