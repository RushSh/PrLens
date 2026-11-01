/**
 * The adaptive skip threshold (same math as src/prlens/adaptive.py; keep the two in step).
 *
 * After each PR in which a bug surfaced, the threshold moves in log-odds space: theta <- theta - eta * (err - alpha),
 * where err = 1 if the bug was in code the PR skipped and 0 if it was in code sent to review. Updates are
 * bug-conditional: a PR where no bug surfaced is recorded but does not move the threshold (it could not have missed),
 * and each PR counts at most once. At or under `floor` nothing is skipped on score. For every sequence of
 * PRs, drifting or adversarial, the miss rate after n PRs is at most
 *     alpha + (theta_1 - logit(floor) + eta * (1 - alpha)) / (eta * n).
 */

export const ADAPTIVE_DEFAULTS = { alpha: 0.2, eta: 0.5, floor: 0.005 } as const;

export interface AdaptiveParams {
  alpha: number;
  eta: number;
  floor: number;
}

/** What a reviewer reported for one PR. Only the first two move the threshold. */
export type FeedbackOutcome = "bug_skipped" | "bug_reviewed" | "no_bug";
export const FEEDBACK_OUTCOMES = ["bug_skipped", "bug_reviewed", "no_bug"] as const;

/** err for the update: 1, 0, or null for no update. */
export const outcomeErr = (o: FeedbackOutcome): 1 | 0 | null => (o === "bug_skipped" ? 1 : o === "bug_reviewed" ? 0 : null);

export interface AdaptiveFeedback {
  prId: string;
  outcome: FeedbackOutcome;
  /** When the outcome was recorded (ISO); outcomes apply in this order. */
  at: string;
}

export interface AdaptiveState extends AdaptiveParams {
  /** e.g. "owner/repo" */
  scope: string;
  /** Where the threshold started (the evaluation set's calibrated threshold). */
  threshold0: number;
  /** The threshold the next PR in this scope gets; 0 means nothing is skipped on score. */
  threshold: number;
  /** PRs where a bug surfaced (the updates). */
  n: number;
  misses: number;
  /** PRs reported with no bug: recorded, no update. */
  noBug: number;
  missRate: number | null;
  /** The guaranteed ceiling on missRate after n PRs (1 before any). */
  bound: number;
  /** The updates, oldest first, with the threshold each PR was triaged at. */
  history: { prId: string; missed: boolean; at: string; threshold: number }[];
}

export const logit = (p: number) => {
  const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  return Math.log(q / (1 - q));
};
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function adaptiveBound(n: number, threshold0: number, p: AdaptiveParams = ADAPTIVE_DEFAULTS): number {
  if (n <= 0) return 1;
  const lo = logit(p.floor);
  return Math.min(1, p.alpha + (Math.max(logit(threshold0), lo) - lo + p.eta * (1 - p.alpha)) / (p.eta * n));
}

/** Replay a scope's recorded outcomes, oldest first, and return where its threshold stands now. */
export function adaptiveState(
  scope: string,
  threshold0: number,
  feedback: AdaptiveFeedback[],
  p: AdaptiveParams = ADAPTIVE_DEFAULTS,
): AdaptiveState {
  let theta = logit(threshold0);
  const current = () => {
    const t = sigmoid(theta);
    return t <= p.floor ? 0 : t;
  };
  const history: AdaptiveState["history"] = [];
  let misses = 0;
  let noBug = 0;
  const seen = new Set<string>();
  for (const f of [...feedback].sort((a, b) => a.at.localeCompare(b.at))) {
    const err = outcomeErr(f.outcome);
    if (err === null) {
      noBug += 1;
      continue;
    }
    if (seen.has(f.prId)) continue; // at most once per PR (the scope is the repository)
    seen.add(f.prId);
    history.push({ prId: f.prId, missed: err === 1, at: f.at, threshold: current() });
    theta -= p.eta * (err - p.alpha);
    misses += err;
  }
  const n = history.length;
  return {
    scope,
    ...p,
    threshold0,
    threshold: current(),
    n,
    misses,
    noBug,
    missRate: n ? misses / n : null,
    bound: adaptiveBound(n, threshold0, p),
    history,
  };
}

/** How many PRs with a surfaced bug it takes for the guaranteed ceiling to reach `target` (e.g. 0.3). */
export function prsForBound(target: number, threshold0: number, p: AdaptiveParams = ADAPTIVE_DEFAULTS): number {
  if (target <= p.alpha) return Infinity;
  const lo = logit(p.floor);
  const c = (Math.max(logit(threshold0), lo) - lo + p.eta * (1 - p.alpha)) / p.eta;
  return Math.ceil(c / (target - p.alpha));
}

/** The adaptive ceiling in words: the current one once it means something, else when it will. It covers bugs that get
 * reported; skipped-code bugs that are never found are outside it. */
export function guaranteeText(s: Pick<AdaptiveState, "n" | "bound" | "threshold0" | "alpha" | "eta" | "floor">): string {
  const pctOf = (x: number) => `${Math.round(x * 100)}%`;
  if (s.n > 0 && s.bound <= 0.5)
    return `share of reported bugs in skipped code ≤ ${pctOf(s.bound)} (a proven ceiling), falling toward ${pctOf(s.alpha)}`;
  const n30 = prsForBound(0.3, s.threshold0, s);
  return `the ceiling tightens as bugs are reported: share of reported bugs in skipped code ≤ 30% once ${n30} PRs with a bug are reported, approaching ${pctOf(s.alpha)}`;
}
