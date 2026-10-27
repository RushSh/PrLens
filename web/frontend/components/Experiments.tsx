"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import type { ActionField, AvailableModel, ExperimentAction, ExperimentPlan } from "@bugcensus/shared";
import { clientFetch } from "@/lib/api";
import { providerLabel } from "./ui";

type Values = Record<string, string | number | boolean | string[]>;

const LANE: Record<ExperimentAction["lane"], string> = {
  models: "calls models",
  cpu: "runs on this machine",
  ops: "admin",
};

export function Experiments() {
  const [actions, setActions] = useState<ExperimentAction[] | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      clientFetch<ExperimentAction[]>("/api/experiments/actions"),
      clientFetch<AvailableModel[]>("/api/models").catch(() => [] as AvailableModel[]),
    ])
      .then(([a, m]) => {
        setActions(a);
        setModels(m);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const groups = useMemo(() => {
    const out = new Map<string, ExperimentAction[]>();
    for (const a of actions ?? []) out.set(a.group, [...(out.get(a.group) ?? []), a]);
    return [...out.entries()];
  }, [actions]);

  if (error) return <p className="text-sm text-red-700">Could not load experiment steps: {error}. Is the backend running?</p>;
  if (!actions) return <p className="text-sm text-stone-500">Loading…</p>;

  return (
    <div className="space-y-8">
      {groups.map(([group, list]) => (
        <section key={group} className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">{group}</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {list.map((a) => (
              <ActionCard key={a.id} action={a} models={models} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function initial(fields: ActionField[]): Values {
  const v: Values = {};
  for (const f of fields) {
    if (f.default !== undefined) v[f.name] = f.default;
    else if (f.type === "select" && f.options?.length) v[f.name] = f.options[0]!.value;
    else if (f.type === "panel") v[f.name] = [];
    else if (f.type === "checkbox") v[f.name] = false;
    else v[f.name] = "";
  }
  return v;
}

function ActionCard({ action, models }: { action: ExperimentAction; models: AvailableModel[] }) {
  const router = useRouter();
  const [values, setValues] = useState<Values>(() => initial(action.fields));
  const [plan, setPlan] = useState<ExperimentPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const set = (name: string, v: Values[string]) => {
    setValues((s) => ({ ...s, [name]: v }));
    setPlan(null); // any change invalidates the plan
    setConfirming(false);
  };

  async function doPlan() {
    setBusy(true);
    setError(null);
    try {
      setPlan(await clientFetch<ExperimentPlan>("/api/experiments/plan", { method: "POST", body: { action: action.id, params: values } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { id } = await clientFetch<{ id: string }>("/api/experiments/run", {
        method: "POST",
        body: { action: action.id, params: values, confirmToken: plan?.confirmToken ?? undefined },
      });
      router.push(`/jobs/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col rounded-lg border border-stone-200 bg-white">
      <div className="border-b border-stone-200 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-stone-900">{action.title}</h3>
          <span className="text-xs text-stone-500">
            {LANE[action.lane]}
            {action.paid ? " · paid: plan first" : " · free"}
          </span>
        </div>
        <p className="mt-1 text-xs text-stone-600">{action.description}</p>
      </div>
      <div className="flex-1 space-y-3 px-4 py-3">
        {action.fields.map((f) => (
          <Field key={f.name} field={f} value={values[f.name]} models={models} onChange={(v) => set(f.name, v)} />
        ))}
        {!action.fields.length ? <p className="text-xs text-stone-500">No settings.</p> : null}
        {plan ? (
          <div>
            <div className={`text-xs font-medium ${plan.ok ? "text-stone-700" : "text-red-700"}`}>
              {plan.ok ? "Plan (nothing has been called yet):" : "The plan failed:"}
            </div>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-stone-900 p-2 font-mono text-[11px] leading-4 text-stone-100">{plan.output || "(no output)"}</pre>
          </div>
        ) : null}
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-100 px-4 py-3">
        {action.paid ? (
          <>
            <button type="button" disabled={busy} onClick={doPlan}
              className="rounded border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-50 disabled:opacity-50">
              {busy && !plan ? "Planning…" : plan ? "Plan again" : "Plan and show cost"}
            </button>
            <button type="button" disabled={busy || !plan?.ok} onClick={run}
              className="rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-stone-300">
              Confirm and run
            </button>
          </>
        ) : action.confirm && !confirming ? (
          <button type="button" onClick={() => setConfirming(true)}
            className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-800 hover:bg-red-50">
            {action.title}…
          </button>
        ) : (
          <>
            {action.confirm ? <span className="mr-auto text-xs text-red-800">{action.confirm}</span> : null}
            <button type="button" disabled={busy} onClick={run}
              className={`rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${action.confirm ? "bg-red-700" : "bg-stone-900"}`}>
              {busy ? "Starting…" : action.confirm ? "Yes, do it" : "Run"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({
  field,
  value,
  models,
  onChange,
}: {
  field: ActionField;
  value: Values[string] | undefined;
  models: AvailableModel[];
  onChange: (v: Values[string]) => void;
}) {
  const id = useId();
  const labelEl = (
    <label htmlFor={id} className="block text-xs font-medium text-stone-700">
      {field.label}
      {field.required ? <span className="text-red-700"> *</span> : null}
    </label>
  );
  const help = field.help ? <p className="mt-0.5 text-[11px] text-stone-500">{field.help}</p> : null;
  const input = "mt-1 w-full rounded border border-stone-300 px-2 py-1 text-sm";

  if (field.type === "panel") {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset>
        <legend className="text-xs font-medium text-stone-700">{field.label}</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {models.map((m) => (
            <label key={m.reviewer} className={`inline-flex items-center gap-1.5 text-sm ${m.ready ? "" : "opacity-50"}`} title={m.ready ? m.costNote : m.why}>
              <input
                type="checkbox"
                disabled={!m.ready && !chosen.includes(m.reviewer)}
                checked={chosen.includes(m.reviewer)}
                onChange={() => onChange(chosen.includes(m.reviewer) ? chosen.filter((x) => x !== m.reviewer) : [...chosen, m.reviewer])}
              />
              {m.reviewer}
              <span className="text-xs text-stone-500">{providerLabel(m.provider)}</span>
            </label>
          ))}
        </div>
        {models.some((m) => chosen.includes(m.reviewer) && !m.ready) ? (
          <p className="mt-0.5 text-[11px] text-amber-700">A selected reviewer is not ready right now; the plan will say why.</p>
        ) : null}
      </fieldset>
    );
  }
  if (field.type === "select") {
    return (
      <div>
        {labelEl}
        <select id={id} className={input} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {!field.options?.length ? <option value="">(nothing available yet)</option> : null}
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {help}
      </div>
    );
  }
  if (field.type === "checkbox") {
    return (
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {field.label}
      </label>
    );
  }
  return (
    <div>
      {labelEl}
      <input
        id={id}
        className={input}
        type={field.type === "number" ? "number" : "text"}
        step="any"
        value={String(value ?? "")}
        onChange={(e) => onChange(field.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
      />
      {help}
    </div>
  );
}
