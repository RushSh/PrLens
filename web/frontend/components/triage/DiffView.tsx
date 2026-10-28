import type { DiffLine } from "@bugcensus/shared";

/** A unified diff of one hunk, with old/new line numbers; lines the triage points at get a marker. */
export function DiffView({ header, lines }: { header: string; lines: DiffLine[] }) {
  return (
    <div className="overflow-x-auto rounded border border-stone-200 bg-white">
      <div className="border-b border-stone-200 bg-stone-50 px-3 py-1 font-mono text-[11px] text-stone-500">{header}</div>
      <table className="w-full min-w-max border-collapse font-mono text-[12px] leading-5">
        <tbody>
          {lines.map((l, i) => {
            const tone =
              l.kind === "add" ? "bg-emerald-50" : l.kind === "del" ? "bg-red-50" : "";
            return (
              <tr key={i} className={`${tone} ${l.flagged ? "outline outline-1 -outline-offset-1 outline-amber-400" : ""}`}>
                <td className="w-1 p-0">
                  {l.flagged ? <span className="block h-5 w-1 bg-amber-500" aria-label="flagged line" /> : null}
                </td>
                <td className="w-10 select-none px-2 text-right text-stone-400">{l.oldNo ?? ""}</td>
                <td className="w-10 select-none px-2 text-right text-stone-400">{l.newNo ?? ""}</td>
                <td className="w-4 select-none text-center text-stone-500">
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                </td>
                <td className="whitespace-pre pr-4 text-stone-800">{l.text || " "}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
