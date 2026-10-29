/**
 * The adaptive skip threshold (same math as src/prlens/adaptive.py; keep the two in step).
 *
 * After each reviewed PR the threshold moves in log-odds space: theta <- theta - eta * (err - alpha), where err = 1
 * if a bug was found in code the PR skipped. At or under `floor` nothing is skipped on score. For every sequence of
 * PRs, drifting or adversarial, the miss rate after n PRs is at most
 *     alpha + (theta_1 - logit(floor) + eta * (1 - alpha)) / (eta * n).
 */

export const ADAPTIVE_DEFAULTS = { alpha: 0.2, eta: 0.5, floor: 0.005 } as const;

export interface AdaptiveParams {
  alpha: number;
  eta: number;
  floor: number;
}

export interface AdaptiveFeedback {
  prId: string;
  missed: boolean;
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
  n: number;
  misses: number;
  missRate: number | null;
  /** The guaranteed ceiling on missRate after n PRs (1 before any). */
  bound: number;
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
  for (const f of [...feedback].sort((a, b) => a.at.localeCompare(b.at))) {
    history.push({ ...f, threshold: current() });
    theta -= p.eta * ((f.missed ? 1 : 0) - p.alpha);
    misses += f.missed ? 1 : 0;
  }
  const n = history.length;
  return {
    scope,
    ...p,
    threshold0,
    threshold: current(),
    n,
    misses,
    missRate: n ? misses / n : null,
    bound: adaptiveBound(n, threshold0, p),
    history,
  };
}

/** How many reviewed PRs it takes for the guaranteed ceiling to reach `target` (e.g. 0.3). */
export function prsForBound(target: number, threshold0: number, p: AdaptiveParams = ADAPTIVE_DEFAULTS): number {
  if (target <= p.alpha) return Infinity;
  const lo = logit(p.floor);
  const c = (Math.max(logit(threshold0), lo) - lo + p.eta * (1 - p.alpha)) / p.eta;
  return Math.ceil(c / (target - p.alpha));
}

/** The guarantee in words: the current ceiling once it means something, else when it will. */
export function guaranteeText(s: Pick<AdaptiveState, "n" | "bound" | "threshold0" | "alpha" | "eta" | "floor">): string {
  const pctOf = (x: number) => `${Math.round(x * 100)}%`;
  if (s.n > 0 && s.bound <= 0.5) return `long-run miss rate guaranteed ≤ ${pctOf(s.bound)}, falling toward ${pctOf(s.alpha)}`;
  const n30 = prsForBound(0.3, s.threshold0, s);
  return `the guarantee tightens as reviews come in: miss rate ≤ 30% once ${n30} PRs are reviewed, approaching ${pctOf(s.alpha)}`;
}
