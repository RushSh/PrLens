/**
 * The pipeline steps the dashboard may launch. This is an allow-list: the browser sends an action id and
 * form values; the backend builds the `prlens <step>` command line itself from validated values. Nothing else
 * can be run.
 *
 * Paid steps (those that call hosted models or a GPU) must be planned first: the plan runs the step's own
 * --plan-only mode (no model calls), shows calls and cost, and returns a token bound to exactly those form
 * values. Launching a paid step without that token is refused.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ActionField, Lane, PipelineAction } from "@prlens/shared";
import { env } from "./env";
import { UserError } from "./errors";

type Params = Record<string, string | number | boolean>;

interface ActionDef extends Omit<PipelineAction, "fields"> {
  fields: (opts: Options) => ActionField[];
  /** argv for the real run, after the program */
  argv: (p: Params) => string[];
  /** argv that prints the plan without calling models (paid steps only) */
  planArgv?: (p: Params) => string[];
  program?: "python" | "bash";
  schema: z.ZodType<Params>;
}

interface Options {
  repoLists: string[];
  candidateFiles: string[];
  bugFiles: string[];
}

/** A GitHub pull request page; nothing else reaches the command line. */
export const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(\/[A-Za-z0-9_./-]*)?$/;

const dataFile = z.string().regex(/^data\/[A-Za-z0-9_.\-/]+\.(jsonl|txt)$/, "a file under data/");
const model = z.enum(["spark_open", "spark", "wonder", "glimmer_fw", "glimmer"]);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const bool = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape) as unknown as z.ZodType<Params>;

const MODEL_FIELD: ActionField = {
  name: "model",
  label: "Model",
  type: "select",
  default: "spark_open",
  options: [
    { value: "spark_open", label: "Muse Spark Open (Baseten)" },
    { value: "spark", label: "Muse Spark (Meta API)" },
    { value: "wonder", label: "Muse Wonder (Meta API)" },
    { value: "glimmer_fw", label: "Muse Glimmer (Fireworks deployment)" },
    { value: "glimmer", label: "Muse Glimmer (local MLX)" },
  ],
};
const opts = (files: string[]) => files.map((f) => ({ value: f, label: f }));
const language = z.enum(["python", "typescript", "csharp"]);
const LANGUAGE_FIELD: ActionField = {
  name: "language",
  label: "Language",
  type: "select",
  default: "python",
  options: [
    { value: "python", label: "Python" },
    { value: "typescript", label: "TypeScript" },
    { value: "csharp", label: "C#" },
  ],
};
const yes = ["--yes"];

const ACTIONS: ActionDef[] = [
  // ------------------------------------------------------------------ live
  {
    id: "triage-pr",
    group: "Triage",
    title: "Triage a GitHub pull request",
    description:
      "Fetches a public PR and its diff, skips what needs no model, scores every other region and saves the result. " +
      "It then opens like any other PR. About $0.004 per region with Spark Open.",
    lane: "models",
    paid: true,
    fields: () => [
      { name: "url", label: "Pull request link", type: "text", required: true, help: "https://github.com/owner/repo/pull/123" },
      MODEL_FIELD,
    ],
    planArgv: (p) => ["triage-pr", String(p.url), "--model", String(p.model), "--plan-only"],
    argv: (p) => ["triage-pr", String(p.url), "--model", String(p.model), ...yes],
    schema: obj({ url: z.string().trim().regex(PR_URL, "a GitHub pull request link"), model }),
  },
  // ------------------------------------------------------------------ evaluation set
  {
    id: "mine",
    group: "1. Bug data",
    title: "Mine bug-fix commits",
    description: "Recent fix commits that change one or two source files and come with a test. Git only; no installs.",
    lane: "cpu",
    paid: false,
    fields: (o) => [
      LANGUAGE_FIELD,
      { name: "repos", label: "Repositories", type: "select", options: opts(o.repoLists), required: true },
      { name: "since", label: "Fixes since (YYYY-MM-DD)", type: "text", default: "2025-06-01" },
      { name: "out", label: "Save candidates to", type: "text", default: "data/candidates_new.jsonl" },
    ],
    argv: (p) => ["mine", "--language", String(p.language), "--repos", String(p.repos), "--since", String(p.since), "--out", String(p.out)],
    schema: obj({ language, repos: dataFile, since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), out: dataFile }),
  },
  {
    id: "validate",
    group: "1. Bug data",
    title: "Confirm bugs with their tests",
    description:
      "Keeps a candidate only if its tests fail before the fix and pass after (Python: pytest; TypeScript: vitest or jest; " +
      "C#: dotnet test, .NET 10 SDK). Resumable; installs each repository once.",
    lane: "cpu",
    paid: false,
    fields: (o) => [
      { name: "candidates", label: "Candidates", type: "select", options: opts(o.candidateFiles), required: true },
      { name: "repos", label: "Repositories", type: "select", options: opts(o.repoLists), required: true },
      { name: "out", label: "Save confirmed bugs to", type: "text", default: "data/bugs_new.jsonl" },
    ],
    argv: (p) => ["validate", "--candidates", String(p.candidates), "--repos", String(p.repos), "--out", String(p.out)],
    schema: obj({ candidates: dataFile, repos: dataFile, out: dataFile }),
  },
  {
    id: "index",
    group: "1. Bug data",
    title: "Add confirmed bugs to the index",
    description: "Appends confirmed bugs to data/bug_fixes.jsonl, which tracing reads. Safe to repeat.",
    lane: "cpu",
    paid: false,
    fields: (o) => [{ name: "bugs", label: "Confirmed bugs", type: "select", options: opts(o.bugFiles), required: true }],
    argv: (p) => ["index", "--bugs", String(p.bugs)],
    schema: obj({ bugs: dataFile }),
  },
  {
    id: "trace",
    group: "2. Evaluation PRs",
    title: "Trace bugs to the PRs that introduced them",
    description: "Blames the lines each fix changed and turns the commit that wrote them into a labelled PR. Resumable.",
    lane: "cpu",
    paid: false,
    fields: () => [{ name: "budget", label: "Seconds of blaming per run (rerun to continue)", type: "number", default: 600 }],
    argv: (p) => ["trace", "--budget", String(p.budget)],
    schema: obj({ budget: int(30, 7200) }),
  },
  {
    id: "baseline",
    group: "2. Evaluation PRs",
    title: "Free baseline",
    description: "No-model skips and simple rankings on the traced PRs, against the reading gate.",
    lane: "cpu",
    paid: false,
    fields: () => [
      { name: "unit", label: "Unit", type: "select", default: "region", options: [
        { value: "region", label: "Regions (up to ~25 lines)" },
        { value: "hunk", label: "Whole hunks" },
      ] },
      { name: "strict", label: "Only bugs traced from changed lines", type: "checkbox", default: false },
    ],
    argv: (p) => ["baseline", "--unit", String(p.unit), ...(p.strict ? ["--strict"] : [])],
    schema: obj({ unit: z.enum(["region", "hunk"]), strict: bool }),
  },
  {
    id: "score",
    group: "3. Score and calibrate",
    title: "Score every region with a model",
    description: "One call per region (resumes where it stopped). Rate-limited calls are retried.",
    lane: "models",
    paid: true,
    fields: () => [
      MODEL_FIELD,
      { name: "bench", label: "Only this many regions, as a test (0 = all)", type: "number", default: 0 },
      { name: "workers", label: "Calls at once", type: "number", default: 4 },
    ],
    planArgv: (p) => ["score", ...scoreArgs(p), "--plan-only"],
    argv: (p) => ["score", ...scoreArgs(p), ...yes],
    schema: obj({ model, bench: int(0, 5000), workers: int(1, 16) }),
  },
  {
    id: "fit",
    group: "3. Score and calibrate",
    title: "Fit the combiner and the skip threshold",
    description: "Cross-fitted by repository; prints the reading curve and the held-out check, saves the weights.",
    lane: "cpu",
    paid: false,
    fields: () => [
      LANGUAGE_FIELD,
      { ...MODEL_FIELD, label: "Scores from" },
      { name: "alpha", label: "Miss bound (0.2 = at most 20%)", type: "number", default: 0.2 },
    ],
    argv: (p) => ["fit", "--language", String(p.language), "--model", String(p.model), "--alpha", String(p.alpha), "--save"],
    schema: obj({ language, model, alpha: num(0.01, 0.5) }),
  },
  {
    id: "export",
    group: "3. Score and calibrate",
    title: "Publish the evaluation set to the dashboard",
    description: "Writes data/triage_eval.json (Python) or data/triage_eval_<language>.json; the dashboard updates on its own.",
    lane: "cpu",
    paid: false,
    fields: () => [
      LANGUAGE_FIELD,
      { ...MODEL_FIELD, label: "Scores from" },
      { name: "alpha", label: "Miss bound", type: "number", default: 0.2 },
    ],
    argv: (p) => ["export", "--language", String(p.language), "--model", String(p.model), "--alpha", String(p.alpha)],
    schema: obj({ language, model, alpha: num(0.01, 0.5) }),
  },
  // ------------------------------------------------------------------ infrastructure
  {
    id: "fireworks.status",
    group: "Models",
    title: "Fireworks deployment status",
    description: "Shows whether the Glimmer deployment named in .env is up (it bills while up).",
    lane: "ops",
    paid: false,
    program: "bash",
    fields: () => [],
    argv: () => ["infra/fireworks_glimmer.sh", "status"],
    schema: obj({}),
  },
  {
    id: "fireworks.down",
    group: "Models",
    title: "Delete the Fireworks deployment",
    description: "Deletes the Glimmer deployment named in .env so it stops billing.",
    lane: "ops",
    paid: false,
    confirm: "Delete the Fireworks deployment named in .env? Anything running on it will fail.",
    program: "bash",
    fields: () => [],
    argv: () => ["infra/fireworks_glimmer.sh", "down"],
    schema: obj({}),
  },
];

function scoreArgs(p: Params): string[] {
  return ["--model", String(p.model), "--workers", String(p.workers), ...(Number(p.bench) ? ["--bench", String(p.bench)] : [])];
}

async function listFiles(dir: string, test: (f: string) => boolean, prefix: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(test).sort().map((f) => `${prefix}/${f}`);
  } catch {
    return [];
  }
}

async function options(root: string): Promise<Options> {
  return {
    repoLists: await listFiles(path.join(root, "data", "repos"), (f) => f.endsWith(".txt"), "data/repos"),
    candidateFiles: await listFiles(path.join(root, "data"), (f) => /^candidates.*\.jsonl$/.test(f), "data"),
    bugFiles: await listFiles(path.join(root, "data"), (f) => /^bugs.*\.jsonl$/.test(f) && !f.includes(".rejected"), "data"),
  };
}

export async function listActions(root: string = env.PRLENS_ROOT): Promise<PipelineAction[]> {
  const o = await options(root);
  return ACTIONS.map(({ fields, argv: _a, planArgv: _p, schema: _s, program: _g, ...rest }) => ({ ...rest, fields: fields(o) }));
}

export function getAction(id: string): ActionDef {
  const a = ACTIONS.find((x) => x.id === id);
  if (!a) throw new UserError(`unknown action: ${id}`);
  return a;
}

/** Validate form values and fill defaults from the field list. */
export async function parseParams(a: ActionDef, raw: Params, root: string = env.PRLENS_ROOT): Promise<Params> {
  const withDefaults: Params = {};
  for (const f of a.fields(await options(root))) {
    const v = raw[f.name];
    withDefaults[f.name] = v === undefined || v === "" ? (f.default ?? "") : v;
    if (f.required && withDefaults[f.name] === "") throw new UserError(`${f.label} is required`);
  }
  const parsed = a.schema.safeParse(withDefaults);
  if (!parsed.success) {
    throw new UserError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

const secret = randomBytes(32);

/** Token that binds a confirmation to exactly these values (valid until the backend restarts). */
export function confirmToken(action: string, params: Params): string {
  const canonical = JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
  return createHmac("sha256", secret).update(`${action}\n${canonical}`).digest("hex").slice(0, 32);
}

export function command(a: ActionDef, p: Params, plan = false): { program: string; args: string[] } {
  const args = plan ? a.planArgv?.(p) : a.argv(p);
  if (!args) throw new UserError("this step has no plan");
  return a.program === "bash" ? { program: "bash", args } : { program: env.PRLENS_PYTHON, args: ["-m", "prlens", ...args] };
}

export type { Lane };
