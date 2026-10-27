/** Request and response shapes of the backend HTTP API, shared with the frontend. */
import { z } from "zod";

export const PROVIDERS = ["meta", "mlx-local", "fireworks", "baseten", "fake"] as const;

export interface RunModel {
  reviewer: string;
  modelId: string;
  provider: string;
  endpoint: string | null;
  openWeights: boolean;
  reasoningEffort: string | null;
  maxTokens: number | null;
  inferred: boolean;
}

export interface RunSummary {
  id: string;
  runKey: string;
  filePath: string;
  finishedAt: string | null;
  verdict: string;
  hiddenStatus: string | null;
  expectedHidden: number | null;
  pClean: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  foundCounted: number;
  decoysCounted: number;
  decoysMissed: number;
  decoysNotReviewed: number;
  tokensIn: number | null;
  tokensOut: number | null;
  seconds: number | null;
  promptSha: string | null;
  gitSha: string | null;
  metadataInferred: boolean;
  note: string | null;
  errors: string[];
  models: RunModel[];
}

export interface RunReview {
  reviewer: string;
  version: string;
  findingsCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  seconds: number | null;
  finishReason: string | null;
  error: string | null;
  inferred: boolean;
}

export interface RunFinding {
  reviewer: string;
  version: string;
  startLine: number;
  endLine: number;
  category: string | null;
  explanation: string | null;
}

export interface RunDecoy {
  copyName: string;
  kind: string | null;
  functionName: string | null;
  line: number | null;
  lineInCopy: number | null;
  description: string;
  caughtBy: string[];
  notReviewed: boolean;
  matched: { reviewer: string; lines: [number, number]; explanation?: string | null }[];
  tooWide: { reviewer: string; lines: [number, number]; explanation?: string | null }[];
}

export interface RunSuspectedBug {
  startLine: number;
  endLine: number;
  reviewers: string[];
  explanations: string[];
}

export interface RunDetail extends RunSummary {
  source: string | null;
  settings: Record<string, unknown>;
  changedLines: number | null;
  qMean: number | null;
  foundIsVerified: boolean;
  jobId: string | null;
  reviews: RunReview[];
  findings: RunFinding[];
  decoys: RunDecoy[];
  suspectedBugs: RunSuspectedBug[];
}

export interface RealismExperiment {
  id: string;
  name: string;
  analyzedAt: string;
  bugs: number;
  units: number;
  repos: number;
  maxSpan: number;
  outputTokens: number;
  models: RunModel[];
  missAll: Record<string, { rate: number; n: number }>;
  reviewers: {
    reviewer: string;
    realRate: number;
    realN: number;
    decoyRate: number;
    decoyN: number;
    gapLogit: number;
    ciLow: number;
    ciHigh: number;
  }[];
  families: { family: string; rate: number; n: number }[];
}

/** A reviewer the launcher can offer, with whether it is set up right now. */
export interface AvailableModel {
  reviewer: string;
  modelId: string;
  provider: string;
  openWeights: boolean;
  reasoningEffort: string | null;
  ready: boolean;
  why: string;
  /** Rough cost of one review call in US dollars, or null when billed another way. */
  costPerCall: number | null;
  costNote: string;
}

export const launchRequest = z.object({
  file: z.string().min(1).max(500),
  panel: z.array(z.string().regex(/^[a-z0-9_]+$/)).min(1).max(6),
  copies: z.number().int().min(1).max(6).default(2),
  perCopy: z.number().int().min(1).max(12).default(5),
  seed: z.number().int().min(0).max(1_000_000).default(0),
  lines: z
    .string()
    .regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/, "use ranges like 10-40,55-60")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  note: z.string().max(500).optional(),
});
export type LaunchRequest = z.infer<typeof launchRequest>;

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: string;
  status: JobStatus;
  filePath: string;
  panel: string[];
  settings: Record<string, unknown>;
  note: string | null;
  log: string;
  error: string | null;
  runId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const noteUpdate = z.object({ note: z.string().max(2000).nullable() });
