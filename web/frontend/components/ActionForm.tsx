"use client";

import { useId, useState } from "react";
import type { ActionField, AvailableModel, PipelineAction, PipelinePlan } from "@prlens/shared";
import { clientFetch } from "@/lib/api";
import { button, buttonPrimary, input } from "./ui";

export type Values = Record<string, string | number | boolean>;

export function initial(fields: ActionField[]): Values {
  const v: Values = {};
  for (const f of fields) {
    if (f.default !== undefined) v[f.name] = f.default;
    else if (f.type === "select" && f.options?.length) v[f.name] = f.options[0]!.value;
    else if (f.type === "checkbox") v[f.name] = false;
    else v[f.name] = "";
  }
  return v;
}

/**
 * One pipeline step: its form, then Run (free steps) or Check cost → Confirm and run (paid steps). Any change to
 * the form after checking the cost needs a new check; the backend refuses a paid run without it.
 */
export function ActionForm({
  action,
  models,
  onStarted,
  submitLabel,
}: {
  action: PipelineAction;
  models: AvailableModel[];
  onStarted: (jobId: string) => void;
  submitLabel?: string;
}) {
  const [values, setValues] = useState<Values>(() => initial(action.fields));
  const [plan, setPlan] = useState<PipelinePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const set = (name: string, v: Values[string]) => {
    setValues((s) => ({ ...s, [name]: v }));
    setPlan(null);
    setConfirming(false);
  };

  async function doPlan() {
    setBusy(true);
    setError(null);
    try {
      setPlan(await clientFetch<PipelinePlan>("/api/pipeline/plan", { method: "POST", body: { action: action.id, params: values } }));
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
      const { id } = await clientFetch<{ id: string }>("/api/pipeline/run", {
        method: "POST",
        body: { action: action.id, params: values, confirmToken: plan?.confirmToken ?? undefined },
      });
      setPlan(null);
      onStarted(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {action.fields.map((f) => (
        <Field key={f.name} field={f} value={values[f.name]} models={models} onChange={(v) => set(f.name, v)} />
      ))}
      {plan ? (
        <div>
          <div className={`text-xs font-medium ${plan.ok ? "text-muted" : "text-danger"}`}>
            {plan.ok ? "Plan (nothing has been called yet):" : "The plan failed:"}
          </div>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-inset p-2 font-mono text-xs leading-5 text-fg">
            {plan.output || "(no output)"}
          </pre>
        </div>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {action.paid ? (
          <>
            <button type="button" disabled={busy} onClick={doPlan} className={button}>
              {busy && !plan ? "Checking…" : plan ? "Check again" : "Check cost"}
            </button>
            <button type="button" disabled={busy || !plan?.ok} onClick={run} className={buttonPrimary}>
              {submitLabel ?? "Confirm and run"}
            </button>
          </>
        ) : action.confirm && !confirming ? (
          <button type="button" onClick={() => setConfirming(true)} className={`${button} text-danger`}>
            {action.title}…
          </button>
        ) : (
          <>
            {action.confirm ? <span className="mr-auto text-xs text-danger">{action.confirm}</span> : null}
            <button type="button" disabled={busy} onClick={run} className={action.confirm ? `${button} text-danger` : buttonPrimary}>
              {busy ? "Starting…" : action.confirm ? "Yes, do it" : (submitLabel ?? "Run")}
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
  const label = (
    <label htmlFor={id} className="mb-1 block text-sm font-semibold text-fg">
      {field.label}
      {field.required ? <span className="text-danger"> *</span> : null}
    </label>
  );
  const help = field.help ? <p className="mt-1 text-xs text-muted">{field.help}</p> : null;
  if (field.type === "select") {
    const status = new Map(models.map((m) => [m.reviewer, m]));
    return (
      <div>
        {label}
        <select id={id} className={input} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {!field.options?.length ? <option value="">(nothing available yet)</option> : null}
          {field.options?.map((o) => {
            const m = status.get(o.value);
            return (
              <option key={o.value} value={o.value}>
                {o.label}
                {m && !m.ready ? ` (not ready: ${m.why})` : ""}
              </option>
            );
          })}
        </select>
        {status.get(String(value)) ? <p className="mt-1 text-xs text-muted">{status.get(String(value))!.costNote}</p> : help}
      </div>
    );
  }
  if (field.type === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {field.label}
      </label>
    );
  }
  return (
    <div>
      {label}
      <input
        id={id}
        className={input}
        type={field.type === "number" ? "number" : "text"}
        step="any"
        placeholder={field.help}
        value={String(value ?? "")}
        onChange={(e) => onChange(field.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
      />
    </div>
  );
}

export type { PipelineAction };
