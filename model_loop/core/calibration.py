"""Probability calibration fitted on out-of-sample history only.

Platt: p' = sigmoid(a + b * logit(p)), fitted by Newton on log loss with a
weak pull toward the identity (a=0, b=1). Isotonic: pool-adjacent-violators
on (p, outcome), interpolated. Either is fitted on seasons BEFORE the season
it is applied to; the walk-forward harness enforces that.
"""
import numpy as np


def _logit(p):
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


class Platt:
    def __init__(self, a=0.0, b=1.0):
        self.a, self.b = float(a), float(b)

    @classmethod
    def fit(cls, p, y, prior=1.0, iters=50):
        x = _logit(p)
        y = np.asarray(y, dtype=float)
        theta = np.array([0.0, 1.0])
        ref = np.array([0.0, 1.0])
        for _ in range(iters):
            q = _sigmoid(theta[0] + theta[1] * x)
            g = np.array([np.sum(q - y), np.sum((q - y) * x)]) + prior * (theta - ref)
            wq = q * (1 - q)
            H = np.array([[wq.sum(), (wq * x).sum()], [(wq * x).sum(), (wq * x * x).sum()]]) + prior * np.eye(2)
            step = np.linalg.solve(H, g)
            theta = theta - step
            if np.max(np.abs(step)) < 1e-10:
                break
        return cls(theta[0], theta[1])

    def __call__(self, p):
        return _sigmoid(self.a + self.b * _logit(p))

    def to_json(self):
        return {"kind": "platt", "a": round(self.a, 6), "b": round(self.b, 6)}


class Isotonic:
    def __init__(self, x=None, y=None):
        self.x = np.array([0.0, 1.0]) if x is None else np.asarray(x)
        self.y = np.array([0.0, 1.0]) if y is None else np.asarray(y)

    @classmethod
    def fit(cls, p, y):
        o = np.argsort(p)
        xs, ys = np.asarray(p, dtype=float)[o], np.asarray(y, dtype=float)[o]
        blocks = [[xs[i], ys[i], 1.0] for i in range(len(xs))]
        out = []
        for b in blocks:
            out.append(b)
            while len(out) > 1 and out[-2][1] / out[-2][2] > out[-1][1] / out[-1][2]:
                x2, y2, n2 = out.pop()
                out[-1][0] = (out[-1][0] * out[-1][2] + x2 * n2) / (out[-1][2] + n2)
                out[-1][1] += y2
                out[-1][2] += n2
        return cls(np.array([b[0] for b in out]), np.array([b[1] / b[2] for b in out]))

    def __call__(self, p):
        return np.clip(np.interp(np.asarray(p, dtype=float), self.x, self.y), 1e-4, 1 - 1e-4)

    def to_json(self):
        return {"kind": "isotonic", "knots": len(self.x)}
