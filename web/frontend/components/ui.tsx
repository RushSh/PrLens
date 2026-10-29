/** Small GitHub-style building blocks shared by every page. */
import type { ReactNode } from "react";
import type { Priority } from "@prlens/shared";

export function Box({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-md border border-line bg-canvas ${className}`}>
      {title ? (
        <header className="flex flex-wrap items-center justify-between gap-2 rounded-t-md border-b border-line bg-subtle px-4 py-2.5">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {right}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export type Tone = "neutral" | "accent" | "success" | "danger" | "attention" | "done";

const TONES: Record<Tone, string> = {
  neutral: "border-line text-muted",
  accent: "border-accent/40 bg-accent-subtle text-accent",
  success: "border-success/40 bg-success-subtle text-success",
  danger: "border-danger/40 bg-danger-subtle text-danger",
  attention: "border-attention/40 bg-attention-subtle text-attention",
  done: "border-done/40 bg-done-subtle text-done",
};

/** A GitHub label pill. */
export function Pill({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-px text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/** A number in a rounded counter, as on GitHub tabs. */
export function Counter({ children }: { children: ReactNode }) {
  return <span className="tabular ml-1.5 rounded-full bg-line-muted px-1.5 py-px text-xs font-medium text-fg">{children}</span>;
}

export const PRIORITY_TONE: Record<Priority, Tone> = { P0: "danger", P1: "attention", P2: "neutral" };

export function PriorityPill({ priority }: { priority: Priority }) {
  return <Pill tone={PRIORITY_TONE[priority]}>{priority}</Pill>;
}

/** A round avatar with the first letter of a name (no external images). */
export function Avatar({ name, bot = false, size = 32 }: { name: string; bot?: boolean; size?: number }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center font-semibold text-white ${bot ? "rounded-md" : "rounded-full"}`}
      style={{ width: size, height: size, fontSize: size * 0.42, background: bot ? "var(--gh-done)" : `hsl(${hue} 45% 45%)` }}
    >
      {(name[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-line p-8 text-center text-sm text-muted">{children}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className="tabular truncate text-2xl font-semibold text-fg">{value}</div>
      {sub ? <div className="text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

export const button =
  "inline-flex items-center gap-1.5 rounded-md border border-line bg-subtle px-3 py-1.5 text-sm font-medium text-fg hover:bg-line-muted disabled:cursor-not-allowed disabled:opacity-50";
export const buttonPrimary =
  "inline-flex items-center gap-1.5 rounded-md border border-black/10 bg-success-emph px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";
export const input = "w-full rounded-md border border-line bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";
