"""Dixon-Coles-style scoreline model and expected-points picker for PronoBot.

Pure numpy/scipy, no network. Used by backtest.py today; intended to be
imported by predict.py once the backtest justifies replacing Jev.

Model: independent Poisson goals per side,
    log lambda_home = mu + home_adv + attack[home] - defence[away]
    log lambda_away = mu + attack[away] - defence[home]
fitted by time-weighted, L2-regularised maximum likelihood, plus the
Dixon-Coles low-score correction (rho) for 0-0 / 1-0 / 0-1 / 1-1.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import minimize
from scipy.stats import poisson

# Scoreline grid: actual results up to MAX_GOALS each, candidate picks up to MAX_PICK.
MAX_GOALS = 8
MAX_PICK = 5


def _points_tensor() -> np.ndarray:
    """PTS[i, j, k, l] = points for predicting i-j when the result is k-l.

    Mirrors src/domain/scoring.ts: 5 exact, 3 correct outcome + goal
    difference, 2 correct outcome only, 0 otherwise.
    """
    pts = np.zeros((MAX_PICK + 1, MAX_PICK + 1, MAX_GOALS + 1, MAX_GOALS + 1))
    for i in range(MAX_PICK + 1):
        for j in range(MAX_PICK + 1):
            for k in range(MAX_GOALS + 1):
                for l in range(MAX_GOALS + 1):
                    if (i, j) == (k, l):
                        p = 5
                    elif np.sign(i - j) != np.sign(k - l):
                        p = 0
                    elif i - j == k - l:
                        p = 3
                    else:
                        p = 2
                    pts[i, j, k, l] = p
    return pts


PTS = _points_tensor()


def score_match(pred: tuple[int, int], actual: tuple[int, int]) -> int:
    i, j = pred
    k, l = actual
    if (i, j) == (k, l):
        return 5
    if np.sign(i - j) != np.sign(k - l):
        return 0
    return 3 if i - j == k - l else 2


@dataclass
class Params:
    teams: list[str]
    mu: float
    home_adv: float
    attack: np.ndarray
    defence: np.ndarray
    rho: float

    def index(self) -> dict[str, int]:
        return {t: n for n, t in enumerate(self.teams)}


def fit(
    home: np.ndarray,
    away: np.ndarray,
    hg: np.ndarray,
    ag: np.ndarray,
    weights: np.ndarray,
    extra_teams: list[str] | None = None,
    reg: float = 1.0,
) -> Params:
    """Fit on arrays of team names / goals / per-match weights.

    `extra_teams` are teams to give (regularised, i.e. league-average)
    parameters even though they have no training matches -- promoted sides.
    """
    teams = sorted(set(home) | set(away) | set(extra_teams or []))
    idx = {t: n for n, t in enumerate(teams)}
    n = len(teams)
    hi = np.array([idx[t] for t in home])
    ai = np.array([idx[t] for t in away])
    w = weights.astype(float)

    def nll(theta: np.ndarray):
        mu, h = theta[0], theta[1]
        a, d = theta[2 : 2 + n], theta[2 + n :]
        eta_h = mu + h + a[hi] - d[ai]
        eta_a = mu + a[ai] - d[hi]
        lam_h, lam_a = np.exp(eta_h), np.exp(eta_a)
        loss = np.sum(w * (lam_h - hg * eta_h)) + np.sum(w * (lam_a - ag * eta_a))
        loss += 0.5 * reg * (np.sum(a * a) + np.sum(d * d))
        r_h = w * (lam_h - hg)
        r_a = w * (lam_a - ag)
        g = np.zeros_like(theta)
        g[0] = r_h.sum() + r_a.sum()
        g[1] = r_h.sum()
        ga = np.bincount(hi, r_h, n) + np.bincount(ai, r_a, n) + reg * a
        gd = -np.bincount(ai, r_h, n) - np.bincount(hi, r_a, n) + reg * d
        g[2 : 2 + n] = ga
        g[2 + n :] = gd
        return loss, g

    theta0 = np.zeros(2 + 2 * n)
    theta0[0] = np.log(max(np.average(np.r_[hg, ag], weights=np.r_[w, w]), 0.1))
    res = minimize(nll, theta0, jac=True, method="L-BFGS-B")
    th = res.x
    p = Params(teams, th[0], th[1], th[2 : 2 + n], th[2 + n :], 0.0)

    # rho by 1-D grid on the weighted training likelihood of the 4 low scores.
    lam_h = np.exp(p.mu + p.home_adv + p.attack[hi] - p.defence[ai])
    lam_a = np.exp(p.mu + p.attack[ai] - p.defence[hi])
    best, best_ll = 0.0, -np.inf
    for rho in np.linspace(-0.25, 0.1, 15):
        tau = _tau(hg, ag, lam_h, lam_a, rho)
        if np.any(tau <= 0):
            continue
        ll = np.sum(w * np.log(tau))
        if ll > best_ll:
            best, best_ll = rho, ll
    p.rho = float(best)
    return p


def _tau(x, y, lam, mu, rho):
    tau = np.ones_like(lam, dtype=float)
    tau = np.where((x == 0) & (y == 0), 1 - lam * mu * rho, tau)
    tau = np.where((x == 0) & (y == 1), 1 + lam * rho, tau)
    tau = np.where((x == 1) & (y == 0), 1 + mu * rho, tau)
    tau = np.where((x == 1) & (y == 1), 1 - rho, tau)
    return tau


def lambdas(p: Params, home: str, away: str) -> tuple[float, float]:
    idx = p.index()
    ah = p.attack[idx[home]] if home in idx else 0.0
    dh = p.defence[idx[home]] if home in idx else 0.0
    aa = p.attack[idx[away]] if away in idx else 0.0
    da = p.defence[idx[away]] if away in idx else 0.0
    return (
        float(np.exp(p.mu + p.home_adv + ah - da)),
        float(np.exp(p.mu + aa - dh)),
    )


def scoreline_matrix(p: Params, home: str, away: str) -> np.ndarray:
    """P[k, l] = P(home scores k, away scores l), renormalised over the grid."""
    lam, mu = lambdas(p, home, away)
    g = np.arange(MAX_GOALS + 1)
    m = np.outer(poisson.pmf(g, lam), poisson.pmf(g, mu))
    r = p.rho
    m[0, 0] *= 1 - lam * mu * r
    m[0, 1] *= 1 + lam * r
    m[1, 0] *= 1 + mu * r
    m[1, 1] *= 1 - r
    return m / m.sum()


def outcome_probs(m: np.ndarray) -> tuple[float, float, float]:
    home = float(np.tril(m, -1).sum())
    draw = float(np.trace(m))
    away = float(np.triu(m, 1).sum())
    return home, draw, away


def pick_most_likely(m: np.ndarray) -> tuple[int, int]:
    k, l = np.unravel_index(np.argmax(m[: MAX_PICK + 1, : MAX_PICK + 1]), (MAX_PICK + 1, MAX_PICK + 1))
    return int(k), int(l)


def pick_max_expected_points(m: np.ndarray) -> tuple[int, int, float]:
    ev = np.einsum("ijkl,kl->ij", PTS, m)
    i, j = np.unravel_index(np.argmax(ev), ev.shape)
    return int(i), int(j), float(ev[i, j])


def pick_round_xg(p: Params, home: str, away: str, m: np.ndarray) -> tuple[int, int]:
    """Jev-style rule (round expected goals, then force the scoreline to agree
    with the most likely outcome) -- the rule predict.py applies to Jev's
    answers, fed with this model's numbers instead of Jev's."""
    lam, mu = lambdas(p, home, away)
    hg, ag = int(round(lam)), int(round(mu))
    ph, pd, pa = outcome_probs(m)
    o = int(np.argmax([ph, pd, pa]))
    if o == 0 and hg <= ag:
        hg = ag + 1
    elif o == 2 and ag <= hg:
        ag = hg + 1
    elif o == 1 and hg != ag:
        ag = hg
    return min(hg, MAX_PICK), min(ag, MAX_PICK)
