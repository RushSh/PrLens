import type { JobStatus as Status } from "@bugcensus/shared";

const TONE: Record<Status, string> = {
  queued: "bg-stone-100 text-stone-700",
  running: "bg-sky-100 text-sky-800",
  succeeded: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-stone-100 text-stone-500",
};

export function JobStatus({ status }: { status: Status }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${TONE[status]}`}>{status}</span>;
}
