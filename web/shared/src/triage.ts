/**
 * PR Reviewer triage: which parts of a pull request a human should read, and which are safe to skip.
 *
 * Every hunk of a PR lands in one of two tiers:
 *   - ReviewItem  ("Action required"): needs a human, with the specific reasons and a risk score;
 *   - SkippedItem ("Safe to skip"):     filtered out of the review queue, with its skip category.
 * Rules always win over scores: verified findings, sensitive paths and public API changes are never skipped.
 *
 * These types are the contract between the triage backend (not wired up yet) and the dashboard tab, which
 * runs on sample data until then.
 */

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

export interface PrTriage {
  id: string;
  number: number;
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
  /** "sample" until the triage backend is wired up. */
  source: "sample" | "live";
}

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
