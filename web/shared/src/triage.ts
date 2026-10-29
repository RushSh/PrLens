/**
 * PR Lens triage: which parts of a pull request a human should read, and which are safe to skip.
 *
 * Every hunk of a PR lands in one of two tiers:
 *   - ReviewItem  ("Action required"): needs a human, with the specific reasons and a risk score;
 *   - SkippedItem ("Safe to skip"):     filtered out of the review queue, with its skip category.
 * Rules always win over scores: verified findings, sensitive paths and public API changes are never skipped.
 *
 * These types are the contract between the triage backend and the dashboard tab. `prlens export` and `prlens triage-pr` write
 * them (data/triage_*.json), the backend validates them with `prTriageSchema` on import and serves them at
 * /api/triage/prs; the tab falls back to sample data when none are imported.
 */
import { z } from "zod";

/** Why a hunk needs a human. */
export const REVIEW_REASONS = {
  bug_risk: { label: "Bug risk", help: "Risk signals suggest a functional bug the AI review may have missed." },
  ai_finding: { label: "AI finding", help: "An AI reviewer reported a problem here; a human should confirm or dismiss it." },
  intent_check: { label: "Intent check", help: "The change goes beyond, or differs from, what the task asked for." },
  security_sensitive: { label: "Security-sensitive", help: "Touches authentication, permissions, secrets or untrusted input." },
  public_api: { label: "Public API change", help: "Changes a signature, contract or behavior other code depends on." },
  data_migration: { label: "Data migration", help: "Changes stored data or schema; hard to undo." },
  duplicates_existing: { label: "Duplicates existing code", help: "Re-implements something the codebase already has." },
  weak_tests: { label: "Weak tests", help: "Tests would pass even if the change were wrong, or the change has none." },
} as const;
export type ReviewReasonCode = keyof typeof REVIEW_REASONS;

/** Why a hunk was filtered out of the review queue. */
export const SKIP_CATEGORIES = {
  config: { label: "Config", help: "Configuration with no executable logic." },
  formatting: { label: "Formatting only", help: "Whitespace, line wrapping or import order; no change in behavior." },
  generated: { label: "Generated", help: "Produced by a tool; review its source instead." },
  dependency_lock: { label: "Lock file", help: "Resolved dependency versions." },
  docs: { label: "Docs", help: "Documentation and comments only." },
  test_fixture: { label: "Test fixture", help: "Static test data." },
  low_risk_refactor: { label: "Low-risk refactor", help: "Rename or move with no change in behavior." },
  low_score: { label: "Low risk score", help: "Scored below the calibrated skip threshold." },
} as const;
export type SkipCategory = keyof typeof SKIP_CATEGORIES;

export type Priority = "P0" | "P1" | "P2";

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  /** Line number in the old file (null for added lines). */
  oldNo: number | null;
  /** Line number in the new file (null for deleted lines). */
  newNo: number | null;
  text: string;
  /** Lines the triage points at within the hunk. */
  flagged?: boolean;
}

/** One hunk of the diff (or a whole small file). */
export interface TriageHunk {
  id: string;
  file: string;
  /** e.g. "@@ -40,9 +40,14 @@ def extend(self, values):" */
  header: string;
  added: number;
  removed: number;
  diff: DiffLine[];
}

export interface ReviewReason {
  code: ReviewReasonCode;
  /** The concrete reason for this hunk, in one or two sentences. */
  detail: string;
}

/** A measured input to the risk score, shown so the reviewer can see why. */
export interface RiskSignal {
  name: string;
  value: string;
  /** 0..1, how strongly this signal pushes the hunk toward review. */
  weight: number;
}

export interface ReviewItem extends TriageHunk {
  tier: "review";
  /** 0..1, calibrated chance that this hunk hides a problem a human would want to catch. */
  riskScore: number;
  priority: Priority;
  reasons: ReviewReason[];
  signals: RiskSignal[];
  /** True when a rule (not the score) put it here, e.g. a sensitive path. */
  forcedByRule: boolean;
}

export interface SkippedItem extends TriageHunk {
  tier: "skip";
  category: SkipCategory;
  /** Why this specific hunk is safe to skip. */
  reason: string;
  riskScore: number;
}

/** The stated bound on what the skipped tier may still contain (functional bugs only). */
export interface SkipGuarantee {
  /** e.g. 0.2: if the PR has a bug, the skipped part holds it at most 20% of the time... */
  missBound: number;
  /** ...with this confidence, e.g. 0.9. */
  confidence: number;
  /** What the bound was calibrated on, e.g. "73 labelled bug-fix changes, 8 repositories". */
  calibratedOn: string;
}

export interface PrAuthor {
  name: string;
  kind: "ai_agent" | "human";
  /** e.g. "Muse Code" when an agent wrote the change. */
  agent?: string;
}

/** Where the real bug was, for PRs from the evaluation set (real commits that introduced a known bug). */
export interface TriageGroundTruth {
  /** Review or skipped item ids that hold the bug. */
  bugItemIds: string[];
  /** True when a bug item is in the review list. */
  caughtByTriage: boolean;
  /** The later commits that fixed it; evidence "deleted" = traced from changed lines, "adjacent" = from an insertion point. */
  fixes: { sha: string; subject: string; evidence: "deleted" | "adjacent" }[];
}

export interface PrTriage {
  id: string;
  /** PR number when there is one; evaluation PRs are commits and have none. */
  number: number | null;
  title: string;
  repo: string;
  branch: string;
  author: PrAuthor;
  openedAt: string;
  /** What the task asked for (used for the intent check). */
  taskSummary: string;
  /** Models that reviewed and scored it, e.g. ["spark", "glimmer"]. */
  panel: string[];
  toReview: ReviewItem[];
  skipped: SkippedItem[];
  guarantee: SkipGuarantee | null;
  /** "sample": built-in demo data; "eval": real commit with a known bug; "live": a PR triaged on request. */
  source: "sample" | "eval" | "live";
  groundTruth?: TriageGroundTruth;
  /** Each scored hunk's full diff, so files can be shown whole; items point into them (id prefix, flagged lines). */
  hunks?: { id: string; file: string; header: string; diff: DiffLine[] }[];
  /** Link to the PR on GitHub (live PRs). */
  url?: string;
  /** Branch the PR merges into (live PRs). */
  base?: string;
}

/** One row of the PR list (GET /api/triage/prs). */
export interface PrTriageSummary {
  id: string;
  /** Name of the triage set it came from ("eval", "live", ...). */
  set: string;
  number: number | null;
  title: string;
  repo: string;
  branch: string;
  openedAt: string;
  source: PrTriage["source"];
  reviewCount: number;
  skipCount: number;
  readLines: number;
  totalLines: number;
  /** null when the real bug is not known. */
  caughtByTriage: boolean | null;
}

/** How well triage did on an evaluation set (scripts write it; the Evaluation tab shows it). */
export interface TriageEvaluation {
  /** Lines read vs PRs whose bug was skipped, one point per threshold. */
  sweep: { threshold: number; missed: number; read_share: number; bound: number }[];
  by_repo: { repo: string; prs: number; missed: number; read_share: number; lines: number }[];
  /** Share of PRs whose bug is in what you read, reading the riskiest parts first up to 1/4, 1/3, 1/2 of lines. */
  gate: { quarter: number; third: number; half: number };
  auc: { combined: number; model: number };
  pr_lines: { min: number; median: number; p75: number; max: number };
  languages: Record<string, number>;
  evidence: { deleted: number; adjacent: number };
  alpha: number;
  confidence: number;
}

export interface TriageSetSummary {
  prs: number;
  repos: number;
  missed: number;
  read_share: number;
  held_out_missed: number;
  held_out_read_share: number;
}

/** About one imported triage set. */
export interface TriageSetInfo {
  name: string;
  generatedAt: string;
  model: string;
  threshold: number;
  alpha: number;
  summary: TriageSetSummary;
  evaluation: TriageEvaluation | null;
}

export interface TriageList {
  sets: TriageSetInfo[];
  prs: PrTriageSummary[];
}

// ---- validation of imported files (prlens export / prlens triage-pr)

const diffLine = z.object({
  kind: z.enum(["add", "del", "ctx"]),
  oldNo: z.number().int().nullable(),
  newNo: z.number().int().nullable(),
  text: z.string(),
  flagged: z.boolean().optional(),
});
const hunk = {
  id: z.string(),
  file: z.string(),
  header: z.string(),
  added: z.number().int(),
  removed: z.number().int(),
  diff: z.array(diffLine),
};
const reviewItem = z.object({
  ...hunk,
  tier: z.literal("review"),
  riskScore: z.number(),
  priority: z.enum(["P0", "P1", "P2"]),
  reasons: z.array(z.object({ code: z.enum(Object.keys(REVIEW_REASONS) as [ReviewReasonCode, ...ReviewReasonCode[]]), detail: z.string() })),
  signals: z.array(z.object({ name: z.string(), value: z.string(), weight: z.number() })),
  forcedByRule: z.boolean(),
});
const skippedItem = z.object({
  ...hunk,
  tier: z.literal("skip"),
  category: z.enum(Object.keys(SKIP_CATEGORIES) as [SkipCategory, ...SkipCategory[]]),
  reason: z.string(),
  riskScore: z.number(),
});
export const prTriageSchema: z.ZodType<PrTriage> = z.object({
  id: z.string(),
  number: z.number().int().nullable(),
  title: z.string(),
  repo: z.string(),
  branch: z.string(),
  author: z.object({ name: z.string(), kind: z.enum(["ai_agent", "human"]), agent: z.string().optional() }),
  openedAt: z.string(),
  taskSummary: z.string(),
  panel: z.array(z.string()),
  toReview: z.array(reviewItem),
  skipped: z.array(skippedItem),
  guarantee: z.object({ missBound: z.number(), confidence: z.number(), calibratedOn: z.string() }).nullable(),
  source: z.enum(["sample", "eval", "live"]),
  hunks: z.array(z.object({ id: z.string(), file: z.string(), header: z.string(), diff: z.array(diffLine) })).optional(),
  url: z.string().url().optional(),
  base: z.string().optional(),
  groundTruth: z
    .object({
      bugItemIds: z.array(z.string()),
      caughtByTriage: z.boolean(),
      fixes: z.array(z.object({ sha: z.string(), subject: z.string(), evidence: z.enum(["deleted", "adjacent"]) })),
    })
    .optional(),
});

export const triageFile = z.object({
  kind: z.literal("triage"),
  name: z.string().min(1),
  generated_at: z.string(),
  model: z.string(),
  threshold: z.number(),
  alpha: z.number(),
  summary: z.object({
    prs: z.number(),
    repos: z.number(),
    missed: z.number(),
    read_share: z.number(),
    held_out_missed: z.number(),
    held_out_read_share: z.number(),
  }),
  evaluation: z
    .object({
      sweep: z.array(z.object({ threshold: z.number(), missed: z.number(), read_share: z.number(), bound: z.number() })),
      by_repo: z.array(z.object({ repo: z.string(), prs: z.number(), missed: z.number(), read_share: z.number(), lines: z.number() })),
      gate: z.object({ quarter: z.number(), third: z.number(), half: z.number() }),
      auc: z.object({ combined: z.number(), model: z.number() }),
      pr_lines: z.object({ min: z.number(), median: z.number(), p75: z.number(), max: z.number() }),
      languages: z.record(z.string(), z.number()),
      evidence: z.object({ deleted: z.number(), adjacent: z.number() }),
      alpha: z.number(),
      confidence: z.number(),
    })
    .optional(),
  prs: z.array(prTriageSchema),
});
export type TriageFile = z.infer<typeof triageFile>;

/** Lines a reviewer must read vs the whole PR (added + removed lines). */
export function triageLoad(pr: PrTriage): { readLines: number; totalLines: number } {
  const size = (h: TriageHunk) => h.added + h.removed;
  const readLines = pr.toReview.reduce((n, h) => n + size(h), 0);
  return { readLines, totalLines: readLines + pr.skipped.reduce((n, h) => n + size(h), 0) };
}

const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };

/** Action-required order: priority first, then risk score, highest first. */
export function sortForReview(items: ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.riskScore - a.riskScore);
}
