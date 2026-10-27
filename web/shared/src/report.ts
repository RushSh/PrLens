/**
 * Runtime schemas for what the Python side writes (runs/*.json and realism analysis JSON).
 * Everything entering the database goes through these, so a malformed or older file fails loudly
 * at import instead of producing half-filled rows.
 *
 * schema_version 2 = files written from Oct 27 2026 on (model, provider and per-review details).
 * Older census files (no schema_version) are accepted by `legacyCensusReport` and the importer
 * fills what it can from logs/usage.jsonl, marking those values as inferred.
 */
import { z } from "zod";

const lineRange = z.tuple([z.number().int(), z.number().int()]);

export const findingBrief = z.object({
  reviewer: z.string(),
  lines: lineRange,
  category: z.string().nullable().optional(),
  explanation: z.string().nullable().optional(),
});
export type FindingBrief = z.infer<typeof findingBrief>;

export const modelInfo = z.object({
  reviewer: z.string(),
  model_id: z.string(),
  provider: z.string(),
  endpoint: z.string().nullable().optional(),
  open_weights: z.boolean().optional().default(false),
  reasoning_effort: z.string().nullable().optional(),
  max_tokens: z.number().int().nullable().optional(),
  inferred: z.boolean().optional().default(false),
});
export type ModelInfo = z.infer<typeof modelInfo>;

export const reviewInfo = z.object({
  reviewer: z.string(),
  version: z.string(),
  findings: z.number().int(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  seconds: z.number(),
  finish_reason: z.string().nullable().optional(),
  error: z.string().nullable(),
});

const decoyRow = z.object({
  copy: z.string(),
  decoy: z.string(),
  kind: z.string().optional(),
  function: z.string().optional(),
  line: z.number().int().optional(),
  line_in_copy: z.number().int().nullable().optional(),
  caught_by: z.array(z.string()),
  not_reviewed: z.boolean().optional().default(false),
  matched: z.array(findingBrief).optional().default([]),
  too_wide: z.array(findingBrief).optional().default([]),
});

const suspectedBug = z.object({
  lines: lineRange,
  reviewers: z.array(z.string()),
  explanations: z.array(z.string()),
});

const estimate = z.object({
  expected_hidden: z.number(),
  p_clean: z.number(),
  interval: lineRange,
  q_mean: z.number(),
  found: z.number().int(),
  decoys: z.number().int(),
  decoys_missed: z.number().int(),
  status: z.string(),
});

const commonCensus = {
  file: z.string(),
  changed_lines: z.number().int(),
  reviewers: z.array(z.string()),
  decoys_planted: z.number().int(),
  decoys_missed_by_all: z.number().int(),
  decoys: z.array(decoyRow),
  suspected_bugs: z.array(suspectedBug),
  found_counted: z.number().int(),
  found_is_verified: z.boolean(),
  extras_from_copies: z.array(z.unknown()).optional().default([]),
  findings_by_version: z.record(z.string(), z.array(findingBrief)).optional(),
  estimate: estimate.nullable(),
  verdict: z.string().optional(),
  errors: z.array(z.string()).default([]),
  tokens: z.object({ input: z.number().int(), output: z.number().int() }),
  seconds: z.number(),
};

export const censusReportV2 = z.object({
  schema_version: z.literal(2),
  run_id: z.string().min(8),
  kind: z.literal("census"),
  job_id: z.string().uuid().optional(),
  started_at: z.string(),
  finished_at: z.string(),
  git_sha: z.string().nullable(),
  prompt_sha: z.string(),
  settings: z.object({
    n_copies: z.number().int(),
    per_copy: z.number().int(),
    seed: z.number().int(),
    max_span: z.number().int(),
    line_ranges: z.array(lineRange).nullable(),
  }),
  models: z.array(modelInfo),
  reviews: z.array(reviewInfo),
  source: z.string().nullable(),
  decoy_free_lines: z.array(z.number().int()).optional().default([]),
  saved_to: z.string().optional(),
  ...commonCensus,
});
export type CensusReportV2 = z.infer<typeof censusReportV2>;

/** Census files written before Oct 27 2026 (no schema_version, no model details). */
export const legacyCensusReport = z.object({
  schema_version: z.undefined().optional(),
  ...commonCensus,
});
export type LegacyCensusReport = z.infer<typeof legacyCensusReport>;

export const realismResult = z.object({
  schema_version: z.literal(2),
  kind: z.literal("realism"),
  name: z.string(),
  analyzed_at: z.string(),
  units_file: z.string(),
  reviews_file: z.string(),
  bugs: z.number().int(),
  units: z.number().int(),
  repos: z.number().int(),
  max_span: z.number().int(),
  output_tokens: z.number().int(),
  models: z.array(modelInfo),
  reviewers: z.array(
    z.object({
      reviewer: z.string(),
      real_rate: z.number(),
      real_n: z.number().int(),
      decoy_rate: z.number(),
      decoy_n: z.number().int(),
      gap_logit: z.number(),
      ci_low: z.number(),
      ci_high: z.number(),
    }),
  ),
  miss_all: z.record(z.string(), z.object({ rate: z.number(), n: z.number().int() })),
  families: z.array(z.object({ family: z.string(), rate: z.number(), n: z.number().int() })),
});
export type RealismResult = z.infer<typeof realismResult>;
