/**
 * The experiment steps the dashboard may launch. This is an allow-list: the browser sends an action id and
 * form values; the backend builds the command line itself from validated values. Nothing else can be run.
 *
 * Paid steps (those that call hosted models or a GPU) must be planned first: the plan step runs the script's
 * own --plan-only/plan mode (no model calls), shows calls and cost, and returns a token bound to exactly
 * those form values. Launching a paid step without that token is refused.
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ActionField, ExperimentAction } from "@bugcensus/shared";
import { env } from "./env";
import { UserError } from "./errors";

type Params = Record<string, string | number | boolean | string[]>;

interface ActionDef extends Omit<ExperimentAction, "fields"> {
  fields: (opts: Options) => ActionField[];
  /** argv for the real run (after the program) */
  argv: (p: Params) => string[];
  /** argv that prints the plan without calling models (paid steps only) */
  planArgv?: (p: Params) => string[];
  program?: "python" | "bash";
  schema: z.ZodType<Params>;
}

interface Options {
  unitsFiles: string[];
  reviewFiles: string[];
  calibrationTags: string[];
  rawDecoyFiles: string[];
  validatedDecoyFiles: string[];
}

const name = z.string().regex(/^[A-Za-z0-9_.\-]+$/, "letters, digits, _ . - only");
const label = z.string().min(1).max(120).regex(/^[^\n"'`$\\]+$/, "no quotes or special characters");
const dataFile = z.string().regex(/^data\/[A-Za-z0-9_.\-/]+\.jsonl?$/, "a file under data/");
const panel = z.array(z.string().regex(/^[a-z0-9_]+$/)).min(1).max(6);
const model = z.string().regex(/^[a-z0-9_]+$/);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const opt = <T extends z.ZodTypeAny>(t: T) => t.optional().or(z.literal("").transform(() => undefined));

const opts = (files: string[]) => files.map((f) => ({ value: f, label: f }));
const yes = ["--yes"];

const ACTIONS: ActionDef[] = [
  // ------------------------------------------------------------------ setup
  {
    id: "setup.envs",
    group: "Setup",
    title: "Set up repositories and test environments",
    description:
      "Clones every repository in scripts/repos_all.txt into data/raw and creates its test environment in data/envs. " +
      "Needed once on this machine before validating decoys or preparing realism units. Takes 10-30 minutes.",
    lane: "cpu",
    paid: false,
    fields: () => [],
    argv: () => ["scripts/setup_envs.py"],
    schema: z.object({}).passthrough() as unknown as z.ZodType<Params>,
  },
  // ------------------------------------------------------------------ decoys
  {
    id: "decoys.generate",
    group: "Decoys",
    title: "Write decoys with a model",
    description:
      "A model rewrites each fixed function with one subtle, realistic bug (multi-line allowed). Raw output; keep only " +
      "what passes 'Validate decoys'.",
    lane: "models",
    paid: true,
    fields: () => [
      { name: "model", label: "Model", type: "select", default: "spark", options: [
        { value: "spark", label: "Muse Spark (Meta API)" },
        { value: "glimmer_fw", label: "Muse Glimmer (Fireworks)" },
        { value: "glimmer", label: "Muse Glimmer (local MLX)" },
        { value: "wonder", label: "Muse Wonder (Meta API)" },
      ] },
      { name: "perBug", label: "Decoys per bug", type: "number", default: 3 },
      { name: "limit", label: "Only the first N bugs (0 = all)", type: "number", default: 0 },
    ],
    planArgv: (p) => ["scripts/decoys.py", "generate", ...decoyGen(p), "--plan-only"],
    argv: (p) => ["scripts/decoys.py", "generate", ...decoyGen(p), ...yes],
    schema: z.object({ model, perBug: int(1, 6), limit: int(0, 1000) }) as unknown as z.ZodType<Params>,
  },
  {
    id: "decoys.glimmer",
    group: "Decoys",
    title: "Token decoys from Glimmer's own probabilities",
    description:
      "Glimmer scores every token of each fixed function; where it found a different token nearly as plausible " +
      "(a near-miss), that swap becomes a candidate decoy. Local MLX is free but slow; Fireworks needs a deployment.",
    lane: "models",
    paid: true,
    fields: () => [
      { name: "backend", label: "Where Glimmer runs", type: "select", default: "mlx", options: [
        { value: "mlx", label: "This Mac (MLX, free)" },
        { value: "fireworks", label: "Fireworks deployment (paid by GPU time)" },
      ] },
      { name: "perBug", label: "Decoys per bug", type: "number", default: 4 },
      { name: "limit", label: "Only the first N bugs (0 = all)", type: "number", default: 0 },
    ],
    planArgv: (p) => ["scripts/decoys.py", "glimmer", ...glimmerArgs(p), "--plan-only"],
    argv: (p) => ["scripts/decoys.py", "glimmer", ...glimmerArgs(p), ...yes],
    schema: z.object({ backend: z.enum(["mlx", "fireworks"]), perBug: int(1, 10), limit: int(0, 1000) }) as unknown as z.ZodType<Params>,
  },
  {
    id: "decoys.validate",
    group: "Decoys",
    title: "Validate decoys with each fix's tests",
    description:
      "Keeps a candidate decoy only if the file still parses and the bug fix's own tests fail on it (so it really " +
      "changes behavior). Writes data/decoys_validated_<source>.jsonl. Needs 'Set up repositories' first.",
    lane: "cpu",
    paid: false,
    fields: (o) => [
      { name: "input", label: "Candidate decoys", type: "select", options: opts(o.rawDecoyFiles), required: true },
      { name: "limit", label: "Only the first N bugs (0 = all)", type: "number", default: 0 },
    ],
    argv: (p) => ["scripts/decoys.py", "validate", "--in", String(p.input), ...limit(p)],
    schema: z.object({ input: dataFile, limit: int(0, 1000) }) as unknown as z.ZodType<Params>,
  },
  // ------------------------------------------------------------------ realism
  {
    id: "realism.units",
    group: "Realism check",
    title: "Build realism units from validated decoys",
    description: "Real-bug units plus units with the new decoys, so a realism check can compare them.",
    lane: "cpu",
    paid: false,
    fields: (o) => [
      { name: "decoys", label: "Validated decoys", type: "select", options: opts(o.validatedDecoyFiles), required: true },
    ],
    argv: (p) => ["scripts/decoys.py", "realism-units", "--decoys", String(p.decoys)],
    schema: z.object({ decoys: dataFile }) as unknown as z.ZodType<Params>,
  },
  {
    id: "realism.review",
    group: "Realism check",
    title: "Review realism units",
    description: "Each panel model reviews every unit (real bugs and decoys, unlabeled). Resumable.",
    lane: "models",
    paid: true,
    fields: (o) => [
      { name: "units", label: "Units", type: "select", options: opts(o.unitsFiles.filter((f) => f.includes("realism"))), required: true },
      { name: "out", label: "Save reviews to", type: "text", default: "data/realism_reviews_v2.jsonl" },
      { name: "panel", label: "Reviewers", type: "panel", default: ["spark"] },
      { name: "limitUnits", label: "Only the first N units (0 = all)", type: "number", default: 0 },
      { name: "workers", label: "Calls at once", type: "number", default: 6 },
    ],
    planArgv: (p) => ["scripts/realism.py", "review", ...realismReview(p), "--plan-only"],
    argv: (p) => ["scripts/realism.py", "review", ...realismReview(p), ...yes],
    schema: z.object({ units: dataFile, out: dataFile, panel, limitUnits: int(0, 5000), workers: int(1, 32) }) as unknown as z.ZodType<Params>,
  },
  {
    id: "realism.analyze",
    group: "Realism check",
    title: "Analyze a realism check",
    description: "Catch rates for real bugs vs decoys, per reviewer and decoy family. Appears on Realism checks.",
    lane: "cpu",
    paid: false,
    fields: (o) => [
      { name: "units", label: "Units", type: "select", options: opts(o.unitsFiles.filter((f) => f.includes("realism"))), required: true },
      { name: "reviews", label: "Reviews", type: "select", options: opts(o.reviewFiles.filter((f) => f.includes("realism"))), required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "reviewers", label: "Only these reviewers (optional, comma list)", type: "text" },
      { name: "matcher", label: "Matching", type: "select", default: "line", options: matchers },
    ],
    argv: (p) => [
      "scripts/realism.py", "analyze", "--units", String(p.units), "--reviews", String(p.reviews), "--name", String(p.name),
      ...(p.reviewers ? ["--reviewers", String(p.reviewers)] : []), "--matcher", String(p.matcher),
    ],
    schema: z.object({ units: dataFile, reviews: dataFile, name: label, reviewers: opt(z.string().regex(/^[a-z0-9_,]+$/)), matcher: z.enum(["line", "judge"]) }) as unknown as z.ZodType<Params>,
  },
  // ------------------------------------------------------------------ calibration
  {
    id: "calibration.prepare",
    group: "Calibration",
    title: "Build calibration units",
    description:
      "Changes made of real bug fixes with a known number of real bugs, and a decoy menu per function. Add validated " +
      "decoy files to give every unit more, harder decoys.",
    lane: "cpu",
    paid: false,
    fields: (o) => [
      { name: "out", label: "Save units to", type: "text", default: "data/calibration_units_v2.jsonl" },
      { name: "extraDecoys", label: "Extra validated decoys (comma list of files, optional)", type: "text",
        help: o.validatedDecoyFiles.join(", ") || "none yet" },
    ],
    argv: (p) => ["scripts/calibration.py", "prepare", "--out", String(p.out),
      ...(p.extraDecoys ? ["--extra-decoys", String(p.extraDecoys)] : [])],
    schema: z.object({ out: dataFile, extraDecoys: opt(z.string().regex(/^(data\/[A-Za-z0-9_.\-/]+\.jsonl,?)+$/)) }) as unknown as z.ZodType<Params>,
  },
  {
    id: "calibration.dry_run",
    group: "Calibration",
    title: "Dry run with fake reviewers",
    description: "The whole calibration with two fake reviewers: checks the pipeline and the math. No model calls.",
    lane: "cpu",
    paid: false,
    fields: (o) => [
      { name: "units", label: "Units", type: "select", options: opts(o.unitsFiles.filter((f) => f.includes("calibration"))), default: "data/calibration_units.jsonl" },
      { name: "pReal", label: "Fake catch rate, real bugs", type: "number", default: 0.6 },
      { name: "pDecoy", label: "Fake catch rate, decoys", type: "number", default: 0.6 },
      { name: "seed", label: "Seed", type: "number", default: 0 },
    ],
    argv: (p) => ["scripts/calibration.py", "dry-run", "--units", String(p.units), "--p-real", String(p.pReal), "--p-decoy", String(p.pDecoy), "--seed", String(p.seed)],
    schema: z.object({ units: dataFile, pReal: num(0, 1), pDecoy: num(0, 1), seed: int(0, 1000) }) as unknown as z.ZodType<Params>,
  },
  {
    id: "calibration.bench",
    group: "Calibration",
    title: "Bench: measure speed on a deployment",
    description: "A few real reviews to measure output speed and reply length, then a projection for the full run.",
    lane: "models",
    paid: true,
    fields: (o) => [
      { name: "units", label: "Units", type: "select", options: opts(o.unitsFiles.filter((f) => f.includes("calibration"))), default: "data/calibration_units.jsonl" },
      { name: "panel", label: "Reviewers", type: "panel", default: ["glimmer_fw"] },
      { name: "n", label: "Units to review", type: "number", default: 8 },
      { name: "workers", label: "Calls at once", type: "number", default: 8 },
    ],
    planArgv: (p) => ["scripts/calibration.py", "bench", ...bench(p), "--plan-only"],
    argv: (p) => ["scripts/calibration.py", "bench", ...bench(p), ...yes],
    schema: z.object({ units: dataFile, panel, n: int(1, 32), workers: int(1, 32) }) as unknown as z.ZodType<Params>,
  },
  {
    id: "calibration.run",
    group: "Calibration",
    title: "Run a calibration",
    description: "Census every unit with the chosen panel: originals first, then seeded copies. Resumable: run again to retry failures.",
    lane: "models",
    paid: true,
    fields: (o) => [
      { name: "units", label: "Units", type: "select", options: opts(o.unitsFiles.filter((f) => f.includes("calibration"))), default: "data/calibration_units.jsonl" },
      { name: "tag", label: "Experiment tag", type: "text", required: true, help: "results go to data/calibration/<tag>/" },
      { name: "panel", label: "Reviewers", type: "panel", default: ["spark", "glimmer_fw"] },
      { name: "copies", label: "Seeded copies per unit", type: "number", default: 2 },
      { name: "workers", label: "Calls at once", type: "number", default: 16 },
      { name: "fwTps", label: "Fireworks output tokens/s (from bench)", type: "number", default: 950 },
      { name: "limitUnits", label: "Only the first N units (0 = all)", type: "number", default: 0 },
    ],
    planArgv: (p) => ["scripts/calibration.py", "plan", ...calRun(p, false)],
    argv: (p) => ["scripts/calibration.py", "run", ...calRun(p, true), ...yes],
    schema: z.object({ units: dataFile, tag: name, panel, copies: int(1, 6), workers: int(1, 32), fwTps: num(10, 100000), limitUnits: int(0, 5000) }) as unknown as z.ZodType<Params>,
  },
  {
    id: "calibration.analyze",
    group: "Calibration",
    title: "Analyze a calibration",
    description: "Predicted vs actual hidden bugs for every estimator variant. Appears on the Calibration page.",
    lane: "cpu",
    paid: false,
    fields: (o) => [
      { name: "tag", label: "Experiment", type: "select", options: opts(o.calibrationTags), required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "reviewers", label: "Only these reviewers (optional, comma list)", type: "text" },
      { name: "matcher", label: "Matching", type: "select", default: "line", options: matchers },
    ],
    argv: (p) => ["scripts/calibration.py", "analyze", "--tag", String(p.tag), "--name", String(p.name),
      ...(p.reviewers ? ["--reviewers", String(p.reviewers)] : []), "--matcher", String(p.matcher)],
    schema: z.object({ tag: name, name: label, reviewers: opt(z.string().regex(/^[a-z0-9_,]+$/)), matcher: z.enum(["line", "judge"]) }) as unknown as z.ZodType<Params>,
  },
  // ------------------------------------------------------------------ judge
  {
    id: "judge.run",
    group: "Judge",
    title: "Judge findings against bugs",
    description:
      "A model decides whether each nearby finding really describes the bug (real or decoy), plus a placebo check on " +
      "wrong pairs. Answers are cached; then analyze with Matching = judge.",
    lane: "models",
    paid: true,
    fields: (o) => [
      { name: "source", label: "Results to judge", type: "select", required: true, options: [
        ...o.calibrationTags.map((t) => ({ value: `calibration:${t}`, label: `calibration ${t}` })),
        ...o.reviewFiles.filter((f) => f.includes("realism")).map((f) => ({ value: `realism:${f}`, label: `realism ${f}` })),
      ] },
      { name: "model", label: "Judge model", type: "select", default: "spark", options: [
        { value: "spark", label: "Muse Spark (Meta API)" },
        { value: "glimmer_fw", label: "Muse Glimmer (Fireworks)" },
        { value: "wonder", label: "Muse Wonder (Meta API)" },
      ] },
      { name: "workers", label: "Calls at once", type: "number", default: 8 },
    ],
    planArgv: (p) => ["scripts/judge.py", ...judge(p), "--plan-only"],
    argv: (p) => ["scripts/judge.py", ...judge(p), ...yes],
    schema: z.object({ source: z.string().regex(/^(calibration:[A-Za-z0-9_.\-]+|realism:data\/[A-Za-z0-9_.\-/]+\.jsonl)$/), model, workers: int(1, 32) }) as unknown as z.ZodType<Params>,
  },
  // ------------------------------------------------------------------ fireworks
  {
    id: "fireworks.status",
    group: "Fireworks",
    title: "Deployment status",
    description: "Shows the Glimmer deployment named in .env (firectl deployment get).",
    lane: "ops",
    paid: false,
    program: "bash",
    fields: () => [],
    argv: () => ["scripts/fireworks_glimmer.sh", "status"],
    schema: z.object({}).passthrough() as unknown as z.ZodType<Params>,
  },
  {
    id: "fireworks.down",
    group: "Fireworks",
    title: "Delete the deployment",
    description: "Deletes the Glimmer deployment named in .env so it stops billing. Create a new one from the terminal.",
    lane: "ops",
    paid: false,
    confirm: "Delete the Fireworks deployment named in .env? Running reviews on it will fail.",
    program: "bash",
    fields: () => [],
    argv: () => ["scripts/fireworks_glimmer.sh", "down"],
    schema: z.object({}).passthrough() as unknown as z.ZodType<Params>,
  },
];

const matchers = [
  { value: "line", label: "Line rule (finding within ±1 line, ≤ 6 lines long)" },
  { value: "judge", label: "Judge (needs 'Judge findings' run first)" },
];

function limit(p: Params): string[] {
  return Number(p.limit) ? ["--limit", String(p.limit)] : [];
}
function decoyGen(p: Params): string[] {
  return ["--model", String(p.model), "--per-bug", String(p.perBug), ...limit(p)];
}
function glimmerArgs(p: Params): string[] {
  return ["--backend", String(p.backend), "--per-bug", String(p.perBug), ...limit(p)];
}
function realismReview(p: Params): string[] {
  return ["--units", String(p.units), "--out", String(p.out), "--panel", (p.panel as string[]).join(","),
    "--workers", String(p.workers), ...(Number(p.limitUnits) ? ["--limit-units", String(p.limitUnits)] : [])];
}
function bench(p: Params): string[] {
  return ["--units", String(p.units), "--panel", (p.panel as string[]).join(","), "--n", String(p.n), "--workers", String(p.workers)];
}
function calRun(p: Params, run: boolean): string[] {
  const out = ["--units", String(p.units), "--panel", (p.panel as string[]).join(","), "--fw-tps", String(p.fwTps),
    "--copies", String(p.copies), ...(Number(p.limitUnits) ? ["--limit-units", String(p.limitUnits)] : [])];
  return run ? [...out, "--tag", String(p.tag), "--workers", String(p.workers)] : out;
}
function judge(p: Params): string[] {
  const [kind, value] = String(p.source).split(/:(.*)/s);
  const src = kind === "calibration" ? ["--tag", value!] : ["--realism-reviews", value!];
  return [...src, "--model", String(p.model), "--workers", String(p.workers)];
}

async function listFiles(dir: string, test: (f: string) => boolean, prefix: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(test).sort().map((f) => `${prefix}/${f}`);
  } catch {
    return [];
  }
}

async function options(root: string): Promise<Options> {
  const data = path.join(root, "data");
  const tags = await (async () => {
    try {
      const entries = await readdir(path.join(data, "calibration"), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith("dryrun")).map((e) => e.name).sort();
    } catch {
      return [];
    }
  })();
  return {
    unitsFiles: await listFiles(data, (f) => /units.*\.jsonl$/.test(f) && !/_[ab]\d?\.jsonl$/.test(f), "data"),
    reviewFiles: await listFiles(data, (f) => /reviews.*\.jsonl$/.test(f), "data"),
    calibrationTags: tags,
    rawDecoyFiles: await listFiles(data, (f) => /^decoys_.*_raw\.jsonl$/.test(f), "data"),
    validatedDecoyFiles: await listFiles(data, (f) => /^decoys_validated_.*\.jsonl$/.test(f), "data"),
  };
}

export async function listActions(root: string = env.BUGCENSUS_ROOT): Promise<ExperimentAction[]> {
  const o = await options(root);
  return ACTIONS.map(({ fields, argv: _a, planArgv: _p, schema: _s, program: _g, ...rest }) => ({ ...rest, fields: fields(o) }));
}

export function getAction(id: string): ActionDef {
  const a = ACTIONS.find((x) => x.id === id);
  if (!a) throw new UserError(`unknown action: ${id}`);
  return a;
}

/** Validate form values and fill defaults from the field list. */
export async function parseParams(a: ActionDef, raw: Params, root: string = env.BUGCENSUS_ROOT): Promise<Params> {
  const withDefaults: Params = {};
  for (const f of a.fields(await options(root))) {
    const v = raw[f.name];
    withDefaults[f.name] = v === undefined || v === "" ? (f.default as Params[string]) ?? "" : v;
    if (f.required && (withDefaults[f.name] === "" || withDefaults[f.name] === undefined)) {
      throw new UserError(`${f.label} is required`);
    }
  }
  const parsed = a.schema.safeParse(withDefaults);
  if (!parsed.success) {
    throw new UserError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  for (const [k, v] of Object.entries(parsed.data)) {
    if (typeof v === "string" && v.startsWith("data/") && /input|units|reviews|decoys/.test(k) && !existsSync(path.join(root, v))) {
      throw new UserError(`${v} does not exist`);
    }
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
  return a.program === "bash" ? { program: "bash", args } : { program: env.BUGCENSUS_PYTHON, args };
}
