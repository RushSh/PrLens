import type { ViewLine } from "@/lib/pr";

const ROW: Record<ViewLine["kind"], string> = { add: "bg-diff-add", del: "bg-diff-del", ctx: "" };
const NUM: Record<ViewLine["kind"], string> = { add: "bg-diff-add-num", del: "bg-diff-del-num", ctx: "" };

/** Table rows for diff lines, GitHub unified style: old number, new number, sign, code. */
export function DiffRows({ lines, marker }: { lines: ViewLine[]; marker?: string }) {
  return (
    <>
      {lines.map((l, i) => (
        <tr key={i} className={ROW[l.kind]}>
          <td className={`p-0 ${marker ?? ""}`} aria-hidden />
          <td className={`tabular select-none px-1.5 text-right align-top text-muted ${NUM[l.kind]}`}>{l.oldNo ?? ""}</td>
          <td className={`tabular select-none px-1.5 text-right align-top text-muted ${NUM[l.kind]}`}>{l.newNo ?? ""}</td>
          <td className="select-none text-center align-top text-muted">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}</td>
          <td className="whitespace-pre-wrap pr-3 align-top text-fg [overflow-wrap:anywhere]">{l.text || " "}</td>
        </tr>
      ))}
    </>
  );
}

export function HunkHeader({ header }: { header: string }) {
  return (
    <tr className="bg-hunk">
      <td colSpan={5} className="px-3 py-1 text-muted">
        {header}
      </td>
    </tr>
  );
}

/** Column widths for diff tables (fixed layout, so long lines wrap instead of scrolling sideways). */
export function DiffCols() {
  return (
    <colgroup>
      <col style={{ width: 4 }} />
      <col className="w-9 sm:w-12" />
      <col className="w-9 sm:w-12" />
      <col style={{ width: 20 }} />
      <col />
    </colgroup>
  );
}
