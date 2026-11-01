/**
 * Models the pipeline can use. The list and each model's readiness come from the Python side
 * (`prlens models --json`), so the dashboard never disagrees with what a step would use. Asking calls no model.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AvailableModel } from "@prlens/shared";
import { env } from "./env";

const run = promisify(execFile);

/** How each model is billed, for the pickers (measured where we have numbers). */
const COSTS: Record<string, string> = {
  spark_open: "Baseten, per token: ~$0.004 per region (Oct 28: 1,630 regions for ~$6)",
  spark: "Meta API credits, per token",
  wonder: "Meta API credits, per token (the most expensive)",
  glimmer: "free: runs on this Mac (slow)",
  glimmer_fw: "billed by GPU time (~$8/h on 1×H200) while the Fireworks deployment is up",
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
  const { stdout } = await run(env.PRLENS_PYTHON, ["-m", "prlens", "models", "--json"], {
    cwd: env.PRLENS_ROOT,
    timeout: 20_000,
    env: { ...process.env, PYTHONPATH: `${env.PRLENS_ROOT}/src` },
  });
  const models = (JSON.parse(stdout) as PyModel[]).map((m) => ({
    reviewer: m.reviewer,
    modelId: m.model_id,
    provider: m.provider,
    openWeights: m.open_weights,
    reasoningEffort: m.reasoning_effort,
    ready: m.ready,
    why: m.why,
    costNote: COSTS[m.reviewer] ?? "cost unknown",
  }));
  cache = { at: Date.now(), models };
  return models;
}
