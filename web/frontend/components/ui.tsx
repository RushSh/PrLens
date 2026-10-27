import type { ReactNode } from "react";
import type { RunModel } from "@bugcensus/shared";

export function verdictTone(verdict: string): string {
  if (verdict === "CLEAR") return "bg-emerald-50 text-emerald-800 ring-emerald-600/25";
  if (verdict === "LOOK HERE") return "bg-amber-50 text-amber-800 ring-amber-600/25";
  if (verdict === "NEEDS REVIEW") return "bg-red-50 text-red-800 ring-red-600/25";
  if (verdict.startsWith("FIX")) return "bg-orange-50 text-orange-800 ring-orange-600/25";
  return "bg-stone-100 text-stone-600 ring-stone-500/20";
}

export function Verdict({ verdict, hidden }: { verdict: string; hidden?: string | null }) {
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={`inline-flex w-fit items-center rounded px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${verdictTone(verdict)}`}>
        {verdict}
      </span>
      {hidden && verdict !== hidden ? (
        <span className="text-[11px] text-stone-500">rest of file: {hidden.toLowerCase()}</span>
      ) : null}
    </span>
  );
}

const PROVIDER: Record<string, { label: string; tone: string }> = {
  meta: { label: "Meta API", tone: "bg-sky-50 text-sky-800 ring-sky-600/20" },
  "mlx-local": { label: "local MLX", tone: "bg-violet-50 text-violet-800 ring-violet-600/20" },
  fireworks: { label: "Fireworks", tone: "bg-orange-50 text-orange-800 ring-orange-600/20" },
  baseten: { label: "Baseten", tone: "bg-teal-50 text-teal-800 ring-teal-600/20" },
  fake: { label: "offline test", tone: "bg-stone-100 text-stone-600 ring-stone-500/20" },
};

export const providerLabel = (p: string) => PROVIDER[p]?.label ?? p;

export function ModelChip({ model, detail = false }: { model: RunModel; detail?: boolean }) {
  const p = PROVIDER[model.provider] ?? { label: model.provider, tone: "bg-stone-100 text-stone-700 ring-stone-500/20" };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ring-1 ring-inset ${p.tone}`}
      title={`${model.modelId} via ${p.label}${model.reasoningEffort ? `, effort ${model.reasoningEffort}` : ""}${model.inferred ? " (inferred: run saved before model details were recorded)" : ""}`}
    >
      <span className="font-medium">{model.reviewer}</span>
      {detail ? <span className="opacity-75">· {model.modelId}</span> : null}
      <span className="opacity-60">· {p.label}</span>
      {model.inferred ? <span className="opacity-60">*</span> : null}
    </span>
  );
}

export function Card({ title, children, right }: { title?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white">
      {title ? (
        <header className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-stone-800">{title}</h2>
          {right}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-stone-500">{label}</div>
      <div className="tabular truncate text-lg font-semibold text-stone-900">{value}</div>
      {sub ? <div className="text-xs text-stone-500">{sub}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-stone-300 bg-white p-8 text-center text-sm text-stone-500">{children}</div>;
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-left text-xs font-medium text-stone-500 ${className}`}>{children}</th>;
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top text-sm ${className}`}>{children}</td>;
}
