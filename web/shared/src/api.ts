/** Request and response shapes of the backend HTTP API (besides triage.ts), shared with the frontend. */
import { z } from "zod";
import { FEEDBACK_OUTCOMES, type FeedbackOutcome } from "./adaptive";

/** A model the pipeline can use, with whether it is set up right now (from `prlens models --json`). */
export interface AvailableModel {
  reviewer: string;
  modelId: string;
  provider: string;
  openWeights: boolean;
  reasoningEffort: string | null;
  ready: boolean;
  why: string;
  costNote: string;
}

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type Lane = "models" | "cpu" | "ops";

/** One pipeline step started from the dashboard. */
export interface Job {
  id: string;
  status: JobStatus;
  action: string;
  title: string;
  lane: Lane;
  args: string[];
  settings: Record<string, unknown>;
  note: string | null;
  log: string;
  error: string | null;
  /** Set when the job produced a PR to open (e.g. "Triage a PR"). */
  prId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** One field of a pipeline action's form. */
export interface ActionField {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "checkbox";
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  help?: string;
  required?: boolean;
}

/** An allow-listed pipeline step the dashboard can launch. */
export interface PipelineAction {
  id: string;
  group: string;
  title: string;
  description: string;
  lane: Lane;
  /** Paid steps must be planned first; the plan shows calls and cost and returns a token to confirm with. */
  paid: boolean;
  /** Free steps that still deserve a confirmation (e.g. deleting a cloud deployment). */
  confirm?: string;
  fields: ActionField[];
}

export const pipelineRequest = z.object({
  action: z.string().regex(/^[a-z_.-]+$/),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  confirmToken: z.string().optional(),
  note: z.string().max(500).optional(),
});
export type PipelineRequest = z.infer<typeof pipelineRequest>;

export interface PipelinePlan {
  output: string;
  ok: boolean;
  confirmToken: string | null;
}

/** The client header every non-GET request must carry (see the backend's onRequest hook). */
export const CLIENT_HEADER = "X-PRLens-Client";

export const feedbackRequest = z.object({
  /** Where a bug surfaced: in skipped code, in reviewed code, or none (recorded, does not move the threshold). */
  outcome: z.enum(FEEDBACK_OUTCOMES),
  /** The skipped items where the bug was (bug_skipped only). */
  itemIds: z.array(z.string().max(300)).max(50).default([]),
  note: z.string().max(500).optional(),
});
export type FeedbackRequest = z.infer<typeof feedbackRequest>;

/** What was recorded for one PR. */
export interface PrFeedback {
  prId: string;
  scope: string;
  outcome: FeedbackOutcome;
  itemIds: string[];
  note: string | null;
  at: string;
}
