/** Calibration analyses written by scripts/calibration.py analyze, and their API shape. */
import { z } from "zod";
import { modelInfo } from "./report";

const nullableNum = z.number().nullable();
const ci = z.tuple([nullableNum, nullableNum]);

export const calibrationVariant = z.object({
  name: z.string(),
  label: z.string(),
  totals: z.object({ predicted: z.number(), actual: z.number(), actual_over_predicted: nullableNum, ci }),
  slope: z.object({ value: nullableNum, ci }),
  coverage90: z.object({ rate: z.number(), n: z.number().int() }),
  clear_rule: z.object({ cleared: z.number().int(), share_cleared: z.number(), false_clear_rate: nullableNum }),
  auc_anything_hidden: z.object({ estimate: nullableNum, findings_count_baseline: nullableNum }),
  bins: z.array(
    z.object({
      lo: z.number(),
      hi: z.number(),
      n: z.number().int(),
      pred_mean: z.number(),
      actual_mean: z.number(),
      ci_low: nullableNum,
      ci_high: nullableNum,
    }),
  ),
  pclean_bins: z.array(
    z.object({ lo: z.number(), hi: z.number(), n: z.number().int(), mean_p_clean: z.number(), frac_clean: z.number() }),
  ),
  priors_by_repo: z.record(z.string(), z.record(z.string(), z.number())).optional(),
});
export type CalibrationVariant = z.infer<typeof calibrationVariant>;

const prediction = z.object({
  expected_hidden: z.number(),
  p_clean: z.number(),
  interval: z.tuple([z.number(), z.number()]),
  status: z.string(),
  q_mean: z.number(),
});

export const calibrationResult = z.object({
  schema_version: z.literal(2),
  kind: z.literal("calibration"),
  name: z.string().min(1),
  tag: z.string().min(1),
  analyzed_at: z.string(),
  dry_run: z.boolean(),
  models: z.array(modelInfo),
  design: z.record(z.string(), z.unknown()),
  n_units: z.number().int(),
  repos: z.number().int(),
  decoys_per_unit: z.number(),
  decoy_miss_rate: z.number(),
  calls: z.object({ total: z.number().int(), errors: z.number().int(), output_tokens: z.number().int() }),
  variants: z.array(calibrationVariant).min(1),
  units: z.array(
    z.object({
      unit_id: z.string(),
      repo: z.string(),
      k: z.number().int(),
      lines: z.number().int(),
      found_verified: z.number().int(),
      found_unverified: z.number().int(),
      decoys: z.number().int(),
      missed: z.number().int(),
      actual_hidden: z.number().int(),
      pred: z.record(z.string(), prediction),
    }),
  ),
  notes: z.array(z.string()).default([]),
});
export type CalibrationResult = z.infer<typeof calibrationResult>;

export interface CalibrationExperiment {
  id: string;
  name: string;
  tag: string;
  analyzedAt: string;
  dryRun: boolean;
  nUnits: number;
  repos: number;
  decoysPerUnit: number;
  decoyMissRate: number;
  models: { reviewer: string; modelId: string; provider: string; reasoningEffort: string | null }[];
  design: Record<string, unknown>;
  calls: { total: number; errors: number; output_tokens: number };
  variants: CalibrationVariant[];
  notes: string[];
}
