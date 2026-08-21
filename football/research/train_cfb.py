#!/usr/bin/env python3
"""EdgeDesk Football Engine — CFB training + walk-forward backtest.

College football gets its OWN feature layer and its own learned constants —
nothing is copied from the NFL model (see the CRITICAL note in the spec:
shared architecture, sport-specific assumptions).

What the available public dataset supports (cfbfastR-data schedules):
  scores, kickoff, week, neutral site, conference game, divisions (fbs/fcs),
  conferences, and a third-party pregame Elo per game (benchmark only).
It contains NO betting lines, NO per-play data, NO rosters. Therefore:
  - ratings are learned from scores (capped-margin online rating = the
    iterative opponent-adjustment method in online form),
  - garbage-time is handled by CAPPING blowout margins (cap is learned),
  - the benchmark is the dataset's own pregame Elo mapped to margin by a
    walk-forward linear fit (never a hand-set scale), plus home-field-only,
  - NO market claim of any kind is made for CFB in this report. Market
    comparison happens live in the app against real quotes, and CFB edges
    stay UNPROVEN until graded CLV exists.
Era handling: 2002-2013 / 2014-2020 / 2021+ (portal+NIL) are reported
separately, and the shipped constants are refit on the modern era where the
walk-forward shows era drift.

Usage: python3 train_cfb.py <out_dir_from_build_features>
Writes <out>/cfb_oos.csv, <out>/params_cfb.json, <out>/report_cfb.json
"""
import sys, os, json, math
import numpy as np
import pandas as pd

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
TUNE_END = 2015
FIRST_OOS = 2006


def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


class CfbRatings:
    """Online capped-margin rating; points units, home-perspective.
    r_pre difference + HFA is the prediction; the update moves both teams
    toward the capped observed margin. FCS sides use one shared learned
    rating bucket (they appear rarely and briefly)."""

    def __init__(self, hp):
        self.hp = hp
        self.r = {}
        self.n = {}
        self.off = {}   # scoring EWMAs for totals: points for/against
        self.lmean_pts = None

    def get(self, team, fbs):
        if not fbs:
            return self.hp['fcs_rating']
        return self.r.get(team, self.hp['init_rating'])

    def games(self, team):
        return self.n.get(team, 0)

    def season_break(self):
        c = self.hp['carry']
        for t in self.r:
            self.r[t] *= c
        for t in self.off:
            self.off[t]['pf'] *= c
            self.off[t]['pa'] *= c

    def predict_margin(self, home, away, h_fbs, a_fbs, neutral):
        hfa = 0.0 if neutral else self.hp['hfa']
        return self.get(home, h_fbs) - self.get(away, a_fbs) + hfa

    def predict_total(self, home, away):
        if self.lmean_pts is None:
            return None
        oh = self.off.get(home); oa = self.off.get(away)
        if not oh or not oa:
            return None
        return 2 * self.lmean_pts + self.hp['k_total'] * (
            oh['pf'] + oh['pa'] + oa['pf'] + oa['pa'])

    def absorb(self, home, away, h_fbs, a_fbs, neutral, margin, h_pts, a_pts):
        hp = self.hp
        cap = hp['cap']
        m = max(-cap, min(cap, margin))
        err = m - self.predict_margin(home, away, h_fbs, a_fbs, neutral)
        if h_fbs:
            self.r[home] = self.get(home, True) + hp['k'] * err
            self.n[home] = self.games(home) + 1
        if a_fbs:
            self.r[away] = self.get(away, True) - hp['k'] * err
            self.n[away] = self.games(away) + 1
        # totals state (FBS teams only; per-game points vs league mean)
        if self.lmean_pts is None:
            self.lmean_pts = (h_pts + a_pts) / 2.0
        for t, pf, pa, fbs in ((home, h_pts, a_pts, h_fbs),
                               (away, a_pts, h_pts, a_fbs)):
            if not fbs:
                continue
            o = self.off.setdefault(t, {'pf': 0.0, 'pa': 0.0})
            at = hp['alpha_total']
            o['pf'] = (1 - at) * o['pf'] + at * (pf - self.lmean_pts)
            o['pa'] = (1 - at) * o['pa'] + at * (pa - self.lmean_pts)
        al = hp['alpha_league']
        self.lmean_pts = (1 - al) * self.lmean_pts + al * ((h_pts + a_pts) / 2.0)


def run(games, hp):
    R = CfbRatings(hp)
    season = None
    rows = []
    for g in games.itertuples():
        if season is not None and g.season != season:
            R.season_break()
        season = g.season
        known = min(R.games(g.home_team) if g.home_fbs else 99,
                    R.games(g.away_team) if g.away_fbs else 99)
        pm = R.predict_margin(g.home_team, g.away_team, g.home_fbs,
                              g.away_fbs, bool(g.neutral_site))
        pt = R.predict_total(g.home_team, g.away_team)
        rows.append({'game_id': g.game_id, 'season': g.season, 'week': g.week,
                     'known': known, 'pred_margin': pm, 'pred_total': pt,
                     'margin': g.margin, 'total_pts': g.total_pts,
                     'both_fbs': bool(g.home_fbs and g.away_fbs),
                     'elo_diff': (g.home_pregame_elo - g.away_pregame_elo)
                     if (not pd.isna(g.home_pregame_elo)
                         and not pd.isna(g.away_pregame_elo)) else np.nan,
                     'neutral': bool(g.neutral_site)})
        R.absorb(g.home_team, g.away_team, g.home_fbs, g.away_fbs,
                 bool(g.neutral_site), g.margin, g.home_points, g.away_points)
    return pd.DataFrame(rows), R


def mae(d, col, tgt):
    return float(np.mean(np.abs(d[col] - d[tgt])))


def main():
    games = pd.read_csv(os.path.join(OUT, 'cfb_games.csv'),
                        parse_dates=['kick_dt']).sort_values(['kick_dt', 'game_id'])
    games = games[games.season <= 2025]

    base = dict(k=0.10, cap=28.0, hfa=2.8, carry=0.60, init_rating=-8.0,
                fcs_rating=-26.0, alpha_total=0.10, alpha_league=0.01,
                k_total=0.5)
    # ---- tune on <= TUNE_END, frozen afterwards ----
    best, best_m = None, 1e9
    for k in (0.06, 0.10, 0.14):
        for cap in (21.0, 28.0, 35.0):
            for hfa in (2.0, 2.8, 3.6):
                hp = {**base, 'k': k, 'cap': cap, 'hfa': hfa}
                df, _ = run(games, hp)
                d = df[(df.season >= FIRST_OOS) & (df.season <= TUNE_END)
                       & df.both_fbs & (df.known >= 4)]
                m = mae(d, 'pred_margin', 'margin')
                if m < best_m:
                    best, best_m = dict(hp), m
    for carry in (0.45, 0.60, 0.75):
        for fcs in (-32.0, -26.0, -20.0):
            hp = {**best, 'carry': carry, 'fcs_rating': fcs}
            df, _ = run(games, hp)
            d = df[(df.season >= FIRST_OOS) & (df.season <= TUNE_END)
                   & df.both_fbs & (df.known >= 4)]
            m = mae(d, 'pred_margin', 'margin')
            if m < best_m:
                best, best_m = dict(hp), m
    HP = best
    print('frozen hyperparams:', HP, 'tune MAE', round(best_m, 3))

    df, R = run(games, HP)
    sc = df[df.both_fbs & (df.known >= 4)].copy()

    # walk-forward Elo benchmark: margin ~ a*elo_diff + b*(not neutral)
    el = sc.dropna(subset=['elo_diff']).copy()
    el['home_adv'] = (~el.neutral).astype(float)
    preds = pd.Series(np.nan, index=el.index)
    for s in sorted(el.season.unique()):
        tr = el[el.season < s]
        te = el[el.season == s]
        if tr.season.nunique() < 3 or not len(te):
            continue
        X = np.column_stack([tr.elo_diff, tr.home_adv, np.ones(len(tr))])
        w = np.linalg.lstsq(X, tr.margin, rcond=None)[0]
        Xt = np.column_stack([te.elo_diff, te.home_adv, np.ones(len(te))])
        preds.loc[te.index] = Xt @ w
    el['elo_pred'] = preds
    el = el.dropna(subset=['elo_pred'])

    rep = {'hyperparams': HP, 'n_games_scored': int(len(sc))}
    eras = [('2006_2013', 2006, 2013), ('2014_2020', 2014, 2020),
            ('2021_2025_portal', 2021, 2025),
            ('test_2016_2025', TUNE_END + 1, 2025), ('all', FIRST_OOS, 2025)]
    for era, lo, hi in eras:
        d = sc[(sc.season >= lo) & (sc.season <= hi)]
        e = el[(el.season >= lo) & (el.season <= hi)]
        dt = d.dropna(subset=['pred_total'])
        rep[era] = {
            'n': int(len(d)),
            'mae_margin_model': round(mae(d, 'pred_margin', 'margin'), 3),
            'rmse_margin_model': round(float(np.sqrt(np.mean((d.pred_margin - d.margin) ** 2))), 3),
            'mae_margin_elo_benchmark': round(mae(e, 'elo_pred', 'margin'), 3) if len(e) else None,
            'mae_margin_hfa_only': round(float(np.mean(np.abs(
                d.margin - np.where(d.neutral, 0.0, HP['hfa'])))), 3),
            'mae_total_model': round(mae(dt, 'pred_total', 'total_pts'), 3) if len(dt) else None,
            'mae_total_league_mean': round(float(np.mean(np.abs(
                dt.total_pts - dt.total_pts.expanding().mean().shift(1)))), 3) if len(dt) else None,
        }

    # win probability sigma by MLE (test era)
    z = sc[(sc.season > TUNE_END) & (sc.margin != 0)]
    sigmas = np.arange(12.0, 22.0, 0.1)
    lls = []
    for s in sigmas:
        p = np.clip([norm_cdf(m / s) for m in z.pred_margin], 1e-6, 1 - 1e-6)
        y = (z.margin > 0).astype(float).values
        lls.append(np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    sigma_m = float(sigmas[int(np.argmax(lls))])
    p = np.clip([norm_cdf(m / sigma_m) for m in z.pred_margin], 1e-6, 1 - 1e-6)
    y = (z.margin > 0).astype(float).values
    rep['sigma_margin_mle'] = round(sigma_m, 2)
    rep['winprob_model_test'] = {
        'n': int(len(z)),
        'brier': round(float(np.mean((np.array(p) - y) ** 2)), 5),
        'log_loss': round(float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))), 5)}

    # calibration table
    cal = []
    bins = np.linspace(0, 1, 11)
    pz = np.array(p)
    for i in range(10):
        m = (pz >= bins[i]) & (pz < bins[i + 1])
        if m.sum() >= 30:
            cal.append({'bin': f'{bins[i]:.1f}-{bins[i+1]:.1f}', 'n': int(m.sum()),
                        'p_pred': round(float(pz[m].mean()), 3),
                        'p_obs': round(float(y[m].mean()), 3)})
    rep['calibration_test'] = cal

    # key numbers: CFB's own margin distribution (never NFL's)
    key_mass = {str(k): round(float((sc.margin.abs() == k).mean()), 4)
                for k in [1, 2, 3, 4, 6, 7, 10, 14, 17, 21]}
    rep['abs_margin_key_mass'] = key_mass
    resid = (sc.margin - sc.pred_margin).round().astype(int)
    resid = resid[(resid >= -45) & (resid <= 45)]
    pmf = resid.value_counts(normalize=True).sort_index()
    dt = sc.dropna(subset=['pred_total'])
    rep['sigma_total'] = round(float((dt.total_pts - dt.pred_total).std()), 2)
    tot_resid = (dt.total_pts - dt.pred_total).round().astype(int)
    tot_resid = tot_resid[(tot_resid >= -45) & (tot_resid <= 45)]
    tot_pmf = tot_resid.value_counts(normalize=True).sort_index()

    # ---- margin PMF conditioned on the MODEL projection (key numbers) ----
    # CFB has no public historical line archive, so the conditioning variable
    # is the model's own projection — weaker than a market spread and labeled
    # as such. Bandwidth by held-out (2016+) log-likelihood.
    kn = sc.copy()
    kn['mi'] = kn.margin.round().astype(int)
    tr_k = kn[kn.season <= TUNE_END]
    te_k = kn[kn.season > TUNE_END]
    def pmf_at(train, s, bw):
        w = np.exp(-0.5 * ((train.pred_margin.values - s) / bw) ** 2)
        tot = w.sum()
        out = {}
        for m, ww in zip(train.mi.values, w):
            out[m] = out.get(m, 0.0) + ww
        return {m: v / tot for m, v in out.items()}
    best_bw, best_ll = None, -1e18
    for bw in (2.0, 3.0, 4.0, 6.0):
        ll = 0.0
        for s_val, grp in te_k.groupby(te_k.pred_margin.round(0)):
            p = pmf_at(tr_k, s_val, bw)
            for m in grp.mi:
                ll += math.log(max(p.get(m, 0.0), 1e-6))
        if ll > best_ll:
            best_bw, best_ll = bw, ll
    rep['pmf_spread_bw'] = best_bw
    pmf_by_spread = {}
    for s_val in range(-35, 36):
        p = pmf_at(kn, float(s_val), best_bw)
        pmf_by_spread[f'{float(s_val):.1f}'] = {str(m): round(v, 6)
                                                for m, v in sorted(p.items())
                                                if v >= 1e-5 and -60 <= m <= 60}

    params = {
        'sport': 'cfb',
        'model_version': 'edgedesk_football_v1.0.0',
        'feature_version': 'cfb_fv1',
        'trained_through_season': int(games.season.max()),
        'data_provenance': {
            'schedules': 'sportsdataverse/cfbfastR-data schedules/csv/cfb_schedules_YYYY.csv '
                         '(CollegeFootballData-sourced; no betting lines exist in this dataset)'},
        'hyperparams': HP,
        'sigma_margin': round(sigma_m, 2),
        'sigma_total': rep['sigma_total'],
        'margin_resid_pmf': {str(k): round(float(v), 6) for k, v in pmf.items()},
        'margin_pmf_by_spread': pmf_by_spread,
        'pmf_spread_bw': best_bw,
        'pmf_spread_range': [-35.0, 35.0],
        'pmf_conditioning': 'model projection (no public CFB line archive exists)',
        'total_resid_pmf': {str(k): round(float(v), 6) for k, v in tot_pmf.items()},
        'league_mean_pts': round(float(R.lmean_pts), 3),
        'seed_ratings': {t: round(v, 4) for t, v in sorted(R.r.items())},
        'seed_totals': {t: {'pf': round(o['pf'], 4), 'pa': round(o['pa'], 4)}
                        for t, o in sorted(R.off.items())},
        'seed_ngames': {t: int(n) for t, n in sorted(R.n.items())},
    }

    sc[['game_id', 'season', 'week', 'margin', 'pred_margin',
        'total_pts', 'pred_total']].to_csv(os.path.join(OUT, 'cfb_oos.csv'), index=False)
    with open(os.path.join(OUT, 'params_cfb.json'), 'w') as f:
        json.dump(params, f, indent=1)
    with open(os.path.join(OUT, 'report_cfb.json'), 'w') as f:
        json.dump(rep, f, indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == '__main__':
    main()
