"""The market-residual model: predict where the line goes between the open
and the close, with the opener as the prior.

    move = close - open            (points markets: points;
                                    price markets: no-vig probability of side A)
    move ~ b0 + b1 * (model - open) + b2 * x2 + ...      ridge, walk-forward

The opener is the prior: with every coefficient at zero the prediction is
"no move", i.e. the opener is right. A feature earns weight only if, in
earlier seasons, it said which way the market went. The fitted number to bet
is open + predicted move; the harness bets it against the opener exactly as
it bets any model.

Every fit uses earlier seasons only. Features are standardised on the
training seasons; the intercept is not penalised.
"""
import numpy as np
import pandas as pd


def ridge_fit(X, y, lam, w=None):
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)
    w = np.ones(len(y)) if w is None else np.asarray(w, dtype=float)
    mu = np.average(X, axis=0, weights=w)
    sd = np.sqrt(np.average((X - mu) ** 2, axis=0, weights=w))
    sd = np.where(sd > 1e-12, sd, 1.0)
    Z = (X - mu) / sd
    ybar = np.average(y, weights=w)
    A = (Z * w[:, None]).T @ Z + lam * np.eye(Z.shape[1]) * w.sum() / len(w)
    beta = np.linalg.solve(A, (Z * w[:, None]).T @ (y - ybar))
    return {"mu": mu, "sd": sd, "beta": beta, "b0": ybar, "lam": lam,
            "coef_raw": beta / sd, "intercept_raw": ybar - float((beta / sd) @ mu)}


def ridge_predict(model, X):
    Z = (np.asarray(X, dtype=float) - model["mu"]) / model["sd"]
    return model["b0"] + Z @ model["beta"]


def _rows(df, features, target):
    ok = df[target].notna()
    for f in features:
        ok &= df[f].notna()
    return ok


def choose_lambda(train, features, target, lams, min_train_seasons=2):
    """Inner walk-forward over the training seasons only: the lambda with the
    lowest out-of-sample squared error of the move."""
    seasons = sorted(train.season.unique())
    best = None
    for lam in lams:
        err, n = 0.0, 0
        for i, s in enumerate(seasons):
            if i < min_train_seasons:
                continue
            tr = train[train.season < s]
            te = train[train.season == s]
            m = ridge_fit(tr[features], tr[target], lam)
            r = te[target].to_numpy() - ridge_predict(m, te[features])
            err += float((r ** 2).sum())
            n += len(r)
        if n and (best is None or err / n < best[1]):
            best = (lam, err / n)
    return best[0] if best else lams[len(lams) // 2]


def walk_forward(df, features, target, eval_seasons, lams=(0.1, 1.0, 10.0, 100.0),
                 min_train_seasons=3, fixed_lambda=None):
    """Out-of-sample predictions of `target` for every season in
    eval_seasons, each from a fit on strictly earlier seasons (the lambda is
    itself chosen by an inner walk-forward on those earlier seasons).
    Returns (predictions aligned to df.index, per-season fit log)."""
    d = df[_rows(df, features, target)]
    pred = pd.Series(np.nan, index=df.index)
    log = []
    for s in sorted(eval_seasons):
        tr = d[d.season < s]
        if tr.season.nunique() < min_train_seasons:
            log.append({"season": int(s), "skipped": "not enough earlier seasons"})
            continue
        lam = fixed_lambda if fixed_lambda is not None else choose_lambda(tr, features, target, list(lams))
        m = ridge_fit(tr[features], tr[target], lam)
        te = df[df.season == s]
        te = te[te[features].notna().all(axis=1)]
        pred.loc[te.index] = ridge_predict(m, te[features])
        log.append({"season": int(s), "n_train": int(len(tr)), "lambda": lam,
                    "coef": {f: round(float(c), 5) for f, c in zip(features, m["coef_raw"])},
                    "intercept": round(float(m["intercept_raw"]), 5)})
    return pred, log
