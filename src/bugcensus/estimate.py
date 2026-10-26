"""The census math: how many real bugs are still hidden after review.

Model (see the proposal's "The mathematics" section):
  bugs in a unit           N ~ Poisson(lambda * w)      (w = size, e.g. changed lines / 100)
  per-unit bug rate        lambda ~ Gamma(alpha, beta)  (alpha, beta learned per repository)
  panel blind rate         q = P(a bug is missed by EVERY reviewer), measured with decoys
  decoys missed by all     m ~ Binomial(M, q)           -> q ~ Beta(a_q + m, b_q + M - m)
  verified bugs found      S | lambda, q ~ Poisson(lambda * w * (1 - q))
  bugs still hidden        R | lambda, q ~ Poisson(lambda * w * q), independent of S given lambda, q

Given S and m, lambda | S, q ~ Gamma(alpha + S, beta + (1 - q) w), so for each q:
  P(R = 0 | q) = (b' / (b' + q w))^a'   and   E[R | q] = a' / b' * q * w,  a' = alpha + S, b' = beta + (1-q) w.
We integrate q over its Beta posterior, reweighted by p(S | q) (S also carries information about q).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.special import gammaln


@dataclass
class Prior:
    alpha: float = 1.0     # Gamma shape for bugs per unit size
    beta: float = 1.0      # Gamma rate
    a_q: float = 1.0       # Beta prior on the panel blind rate
    b_q: float = 1.0


@dataclass
class CensusResult:
    expected_hidden: float
    p_clean: float
    interval: tuple[int, int]
    q_mean: float
    found: int
    decoys: int
    decoys_missed: int
    status: str

    def summary(self) -> str:
        lo, hi = self.interval
        return (f"Still hidden (estimate): {self.expected_hidden:.2f} bugs (90% interval {lo}-{hi}); "
                f"P(clean) {self.p_clean:.0%}; panel blind rate ~{self.q_mean:.0%} "
                f"({self.decoys_missed} of {self.decoys} decoys missed by every reviewer); status {self.status}")


def _negbin_logpmf(s: int, alpha: float, p: np.ndarray) -> np.ndarray:
    """log P(S = s) for NegBin(alpha, p): Gamma-Poisson marginal with success prob p."""
    return gammaln(s + alpha) - gammaln(alpha) - gammaln(s + 1) + alpha * np.log(p) + s * np.log1p(-p)


def census(found: int, decoys: int, decoys_missed: int, size: float = 1.0, prior: Prior | None = None,
           clear_threshold: float = 0.9, look_threshold: float = 0.5, n_q: int = 2000,
           seed: int = 0) -> CensusResult:
    """Estimate hidden bugs in one unit (a PR or a sweep module).

    found          verified real bugs found in the ORIGINAL pass (never count findings from seeded copies)
    decoys         number of decoys planted (M)
    decoys_missed  decoys missed by every reviewer (m)
    size           unit size in the same units used to fit the prior (e.g. changed lines / 100)
    """
    if decoys_missed > decoys or found < 0 or decoys < 0:
        raise ValueError("invalid counts")
    prior = prior or Prior()
    rng = np.random.default_rng(seed)
    q = rng.beta(prior.a_q + decoys_missed, prior.b_q + decoys - decoys_missed, n_q)
    q = np.clip(q, 1e-9, 1 - 1e-9)
    # weight q by the likelihood of the bugs we found: S ~ NegBin(alpha, beta / (beta + (1-q) w))
    p_succ = prior.beta / (prior.beta + (1 - q) * size)
    logw = _negbin_logpmf(found, prior.alpha, p_succ)
    w = np.exp(logw - logw.max())
    w /= w.sum()
    a2 = prior.alpha + found
    b2 = prior.beta + (1 - q) * size
    p_clean = float(np.sum(w * (b2 / (b2 + q * size)) ** a2))
    expected = float(np.sum(w * a2 / b2 * q * size))
    # interval from predictive draws
    idx = rng.choice(n_q, size=4000, p=w)
    lam = rng.gamma(a2, 1.0 / b2[idx])
    r = rng.poisson(lam * q[idx] * size)
    lo, hi = (int(v) for v in np.percentile(r, [5, 95]))
    status = "CLEAR" if p_clean >= clear_threshold else ("LOOK HERE" if p_clean >= look_threshold else "NEEDS REVIEW")
    return CensusResult(expected, p_clean, (lo, hi), float(np.sum(w * q)), found, decoys, decoys_missed, status)


def fit_prior(history: list[tuple[int, int, int, float]], min_units: int = 30) -> Prior:
    """Empirical-Bayes prior from past units: (found, decoys, decoys_missed, size).
    Method of moments for the Gamma bug rate. The blind-rate prior stays flat on purpose:
    pooling q without PR features biased hard PRs in testing (see the kickoff review)."""
    if len(history) < min_units:
        return Prior()
    S = np.array([h[0] for h in history], float)
    M = np.array([h[1] for h in history], float)
    m = np.array([h[2] for h in history], float)
    w = np.array([h[3] for h in history], float)
    qbar = (1 + m) / (2 + M)
    y = S / ((1 - qbar) * w)                       # noisy per-unit rate estimates
    mu = float(np.mean(y))
    noise = float(np.mean(y / ((1 - qbar) * w)))  # Poisson noise contribution
    var = max(float(np.var(y)) - noise, 0.05 * mu * mu, 1e-6)
    return Prior(alpha=mu * mu / var, beta=mu / var)
