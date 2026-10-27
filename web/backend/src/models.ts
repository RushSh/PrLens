/**
 * Reviewers the launcher can offer. The list and each model's readiness come from the Python side
 * (`bugcensus models --list --json`), so the dashboard never disagrees with what a run would use.
 * Asking for the list calls no model.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AvailableModel } from "@bugcensus/shared";
import { env } from "./env";

const run = promisify(execFile);

/**
 * Rough cost of one review call. Measured from the Oct 26 realism check (316 calls each, low
 * reasoning effort, function-sized code): Spark $5.46 and Wonder $28.37 in total. Bigger files cost more.
 */
const COSTS: Record<string, { perCall: number | null; note: string }> = {
  spark: { perCall: 0.017, note: "≈ $0.017 per call (Oct 26 average); uses Meta credits" },
  wonder: { perCall: 0.09, note: "≈ $0.09 per call (Oct 26 average); uses Meta credits" },
  glimmer: { perCall: 0, note: "free: runs on this Mac (about 5 min per call)" },
  glimmer_fw: {
    perCall: null,
    note: "billed by GPU time (~$8/h on 1×H200) while the Fireworks deployment is up, not per call",
  },
  spark_open: { perCall: null, note: "billed by Baseten; price not measured yet" },
};

interface PyModel {
  reviewer: string;
  model_id: string;
  provider: string;
  open_weights: boolean;
  reasoning_effort: string | null;
  ready: boolean;
  why: string;
}

let cache: { at: number; models: AvailableModel[] } | null = null;

export async function availableModels(force = false): Promise<AvailableModel[]> {
  if (!force && cache && Date.now() - cache.at < 15_000) return cache.models;
  const { stdout } = await run(env.BUGCENSUS_PYTHON, ["-m", "bugcensus.cli", "models", "--list", "--json"], {
    cwd: env.BUGCENSUS_ROOT,
    timeout: 20_000,
    env: { ...process.env, PYTHONPATH: `${env.BUGCENSUS_ROOT}/src` },
  });
  const models = (JSON.parse(stdout) as PyModel[]).map((m) => ({
    reviewer: m.reviewer,
    modelId: m.model_id,
    provider: m.provider,
    openWeights: m.open_weights,
    reasoningEffort: m.reasoning_effort,
    ready: m.ready,
    why: m.why,
    costPerCall: COSTS[m.reviewer]?.perCall ?? null,
    costNote: COSTS[m.reviewer]?.note ?? "cost unknown",
  }));
  cache = { at: Date.now(), models };
  return models;
}
