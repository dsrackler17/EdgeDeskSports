"""The margin distribution: a discretised normal reweighted by learned
key-number multipliers, centred exactly on the projection.

    P(M = k | mu) is proportional to  phi((k - mu') / sigma) * m_|k|

m_|k| is learned from history (|margin| = 3, 7, 10 carry far more mass
than a smooth curve gives them) and mu' is solved so that E[M] = mu: the
distribution's mean IS the projection. Every probability the card prints
(win, cover, push, the outcome range) comes from this one table, so they
cannot disagree with each other or with the fair line.

The outcome range is the symmetric interval [mu - h, mu + h] holding the
requested mass (each whole margin spread evenly over its unit bin), so it is
centred on the projection by construction.
"""
import math

import numpy as np

KMAX = 70


class KeyNumberMargin:
    def __init__(self, sigma=13.5, mult=None, kmax=KMAX):
        self.sigma = float(sigma)
        self.kmax = int(kmax)
        self.k = np.arange(-self.kmax, self.kmax + 1)
        m = np.ones(self.kmax + 1) if mult is None else np.asarray(mult, dtype=float)
        if len(m) < self.kmax + 1:
            m = np.concatenate([m, np.ones(self.kmax + 1 - len(m))])
        self.mult = m[: self.kmax + 1]

    # ---------------------------------------------------------------- core
    def _raw(self, mu):
        mu = np.atleast_1d(np.asarray(mu, dtype=float))
        z = (self.k[None, :] - mu[:, None]) / self.sigma
        p = np.exp(-0.5 * z * z) * self.mult[np.abs(self.k)][None, :]
        return p / p.sum(axis=1, keepdims=True)

    def _centre(self, mu):
        """mu' such that the reweighted distribution's mean equals mu."""
        mu = np.atleast_1d(np.asarray(mu, dtype=float))
        shift = mu.copy()
        # Newton on the location: for this family d mean / d shift = Var / sigma^2
        # (1 in the middle of the support, below 1 where a 45-point college
        # favourite's tail is cut at +/- kmax), so it converges in a few steps
        # everywhere; iterate to a fixed tolerance
        s2 = self.sigma * self.sigma
        for _ in range(50):
            p = self._raw(shift)
            mean = (p * self.k[None, :]).sum(axis=1)
            var = (p * (self.k[None, :] - mean[:, None]) ** 2).sum(axis=1)
            err = mu - mean
            shift = shift + err * s2 / np.maximum(var, 1e-6 * s2)
            if np.max(np.abs(err)) < 1e-10:
                break
        return shift

    def pmf(self, mu):
        return self._raw(self._centre(mu))

    # ------------------------------------------------------------- outputs
    def win_tie_loss(self, mu):
        p = self.pmf(mu)
        win = p[:, self.k > 0].sum(axis=1)
        tie = p[:, self.k == 0].sum(axis=1)
        return win, tie, 1.0 - win - tie

    def win_prob(self, mu):
        """P(home wins | no tie): what a moneyline settles on."""
        w, t, l = self.win_tie_loss(mu)
        return w / np.maximum(w + l, 1e-12)

    def cover(self, mu, line_margin):
        """P(home margin > line), P(= line), P(< line) for a home line
        expressed as a margin (home -3 is line_margin = 3)."""
        p = self.pmf(mu)
        lm = np.atleast_1d(np.asarray(line_margin, dtype=float))
        above = (self.k[None, :] > lm[:, None] + 1e-9)
        at = (np.abs(self.k[None, :] - lm[:, None]) < 1e-9)
        return (p * above).sum(axis=1), (p * at).sum(axis=1), (p * ~(above | at)).sum(axis=1)

    def central_halfwidth(self, mu, mass=0.80):
        """Smallest h with P(|M - mu| <= h) >= mass, whole margins spread
        evenly over [k - 1/2, k + 1/2)."""
        m_ = np.atleast_1d(np.asarray(mu, dtype=float))
        P = self.pmf(m_)
        lo, hi = np.zeros(len(m_)), np.full(len(m_), float(self.kmax))
        for _ in range(50):                      # the same bisection, every row at once
            h = 0.5 * (lo + hi)
            a, b = (m_ - h)[:, None], (m_ + h)[:, None]
            cov = np.clip(np.minimum(self.k[None, :] + 0.5, b) - np.maximum(self.k[None, :] - 0.5, a), 0, 1)
            ok = (P * cov).sum(axis=1) >= mass
            hi = np.where(ok, h, hi)
            lo = np.where(ok, lo, h)
        return hi

    def loglik(self, mu, result):
        p = self.pmf(mu)
        idx = np.clip(np.round(result).astype(int) + self.kmax, 0, 2 * self.kmax)
        return np.log(np.maximum(p[np.arange(len(idx)), idx], 1e-12))

    # ----------------------------------------------------------------- fit
    @classmethod
    def fit(cls, mu, result, sigmas=None, kfit=24, iters=25, pseudo=5.0, kmax=KMAX):
        """Maximum likelihood over a sigma grid; for each sigma the
        multipliers for |k| <= kfit are fitted by iterative proportional
        fitting (observed / expected counts of |margin| = k). `kmax` widens
        the support for sports with bigger margins (college football)."""
        mu = np.asarray(mu, dtype=float)
        result = np.round(np.asarray(result, dtype=float)).astype(int)
        ok = np.isfinite(mu) & (np.abs(result) <= kmax)
        mu, result = mu[ok], result[ok]
        sigmas = np.arange(11.0, 16.01, 0.25) if sigmas is None else sigmas
        obs = np.bincount(np.abs(result), minlength=kmax + 1)[: kmax + 1].astype(float)
        best = None
        for s in sigmas:
            d = cls(sigma=s, kmax=kmax)
            z = (d.k[None, :] - mu[:, None]) / d.sigma
            phi = np.exp(-0.5 * z * z)                           # fixed for this sigma: only mult moves
            absk = np.abs(d.k)
            for _ in range(iters):
                p = phi * d.mult[absk][None, :]                  # = d._raw(mu); centring is a no-op on the fit
                p = p / p.sum(axis=1, keepdims=True)
                exp_abs = np.zeros(kmax + 1)
                np.add.at(exp_abs, np.abs(d.k), p.sum(axis=0))
                r = (obs[: kfit + 1] + pseudo) / (exp_abs[: kfit + 1] + pseudo)
                d.mult[: kfit + 1] *= r
                d.mult /= d.mult[kfit + 1:].mean() if kfit + 1 <= kmax else 1.0
            ll = d.loglik(mu, result).sum()
            if best is None or ll > best[0]:
                best = (ll, d)
        return best[1]

    def to_json(self):
        return {"sigma": round(self.sigma, 4), "mult": [round(float(x), 5) for x in self.mult[:31]], "kmax": self.kmax}

    @classmethod
    def from_json(cls, j):
        return cls(sigma=j["sigma"], mult=j["mult"], kmax=j.get("kmax", KMAX))


def american_from_prob(p):
    p = float(p)
    if not (0 < p < 1):
        return None
    return int(round(-100 * p / (1 - p))) if p >= 0.5 else int(round(100 * (1 - p) / p))


def prob_from_american(a):
    a = float(a)
    return (-a) / (-a + 100.0) if a < 0 else 100.0 / (a + 100.0)


def no_vig_two_way(a_home, a_away):
    if a_home is None or a_away is None or not np.isfinite(a_home) or not np.isfinite(a_away):
        return None
    ph, pa = prob_from_american(a_home), prob_from_american(a_away)
    return ph / (ph + pa)


def normal_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))
