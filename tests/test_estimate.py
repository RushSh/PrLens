import numpy as np
import pytest

from bugcensus.estimate import Prior, census, fit_prior


def test_more_missed_decoys_means_more_hidden():
    low = census(found=2, decoys=10, decoys_missed=0)
    high = census(found=2, decoys=10, decoys_missed=6)
    assert high.expected_hidden > low.expected_hidden
    assert high.p_clean < low.p_clean


def test_more_found_bugs_raise_estimate_for_same_blind_rate():
    a = census(found=0, decoys=10, decoys_missed=3)
    b = census(found=5, decoys=10, decoys_missed=3)
    assert b.expected_hidden > a.expected_hidden


def test_p_clean_matches_monte_carlo():
    prior = Prior(alpha=2.0, beta=1.5)
    res = census(found=1, decoys=12, decoys_missed=3, size=1.0, prior=prior, n_q=20000, seed=1)
    # brute-force: sample (lambda, q) from the prior, keep draws consistent with the data, look at R
    rng = np.random.default_rng(2)
    n = 2_000_000
    lam = rng.gamma(prior.alpha, 1 / prior.beta, n)
    q = rng.beta(1, 1, n)
    m = rng.binomial(12, q)
    N = rng.poisson(lam)
    S = rng.binomial(N, 1 - q)
    keep = (m == 3) & (S == 1)
    R = (N - S)[keep]
    assert abs(res.p_clean - np.mean(R == 0)) < 0.02
    assert abs(res.expected_hidden - R.mean()) < 0.05


def test_status_thresholds():
    assert census(found=0, decoys=40, decoys_missed=0, prior=Prior(0.5, 5.0)).status == "CLEAR"
    assert census(found=6, decoys=10, decoys_missed=8).status == "NEEDS REVIEW"


def test_invalid_counts():
    with pytest.raises(ValueError):
        census(found=1, decoys=3, decoys_missed=4)


def test_fit_prior_recovers_mean_rate():
    rng = np.random.default_rng(0)
    hist = []
    for _ in range(400):
        lam = rng.gamma(2.0, 1 / 1.0)          # mean 2 bugs per unit
        q = 0.2
        N = rng.poisson(lam)
        S = rng.binomial(N, 1 - q)
        m = rng.binomial(12, q)
        hist.append((int(S), 12, int(m), 1.0))
    p = fit_prior(hist)
    assert 1.5 < p.alpha / p.beta < 2.6
