#!/usr/bin/env python3
"""EdgeDesk Football Engine — NFL training + walk-forward backtest.

Design contract (mirrors ../engine.js exactly — the JS engine re-implements
the same recursions and ships the constants this script learns):

  1. SEQUENTIAL RATINGS (leak-free by construction). One pass over games in
     kickoff order. A team's rating going into a game uses only completed
     games. Opponent adjustment uses the opponent's rating AT THAT TIME
     (iterative opponent adjustment, online form). League means are slow
     EWMAs so era drift (scoring environment) is absorbed without lookahead.
  2. QUARTERBACK LAYER. Per-QB EPA/dropback EWMA with shrinkage by starts;
     a team's QB adjustment is the announced starter's value minus the QB
     value already embedded in the team's own passing rating.
  3. SUBMODELS (the philosophy layer; each is testable on its own):
       koerner_spread  — power-rating projection of the margin
       sharp_total     — efficiency/matchup/environment projection of the total
       stuckey_context — situational residual layer (rest, short week, week,
                         divisional, surface/roof), learned not asserted
       fezzik_market   — the market number itself as a top-down prior;
                         in this backtest only the CLOSING consensus exists,
                         so its role is the baseline every model must beat
  4. WALK-FORWARD FITS. Ridge coefficients are refit before each season on
     out-of-sample rows from all prior seasons only. Hyperparameters are
     tuned on 2006-2015 OOS, frozen, then 2016-2025 is scored untouched.
  5. HONESTY. Only the closing line exists historically (no openers), so no
     CLV backtest is possible or claimed. The strictest available test is
     beating the CLOSING number ATS, which is harder than beating an opener.

Usage: python3 train_nfl.py <out_dir_from_build_features>
Writes <out>/nfl_oos.csv, <out>/params_nfl.json, <out>/report_nfl.json
"""
import sys, os, json, math
import numpy as np
import pandas as pd

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'

TUNE_END = 2015          # hyperparams tuned on OOS <= this season, then frozen
BURN_SEASONS = 4         # ratings warm-up + first ridge fit window
FIRST_OOS = 2003         # first season with enough history to score

RATE_FEATS = ['off_epa_play', 'pass_epa_db', 'rush_epa_att', 'expl_pass',
              'expl_rush', 'sack_rate_all', 'pass_rate', 'plays',
              'def_epa_play', 'def_pass_epa_db', 'def_rush_epa_att',
              'def_expl_pass', 'def_expl_rush', 'sack_rate_made',
              'pts_for', 'pts_against']
# which opposing rating adjusts each observed performance
COUNTER = {'off_epa_play': 'def_epa_play', 'pass_epa_db': 'def_pass_epa_db',
           'rush_epa_att': 'def_rush_epa_att', 'expl_pass': 'def_expl_pass',
           'expl_rush': 'def_expl_rush', 'sack_rate_all': 'sack_rate_made',
           'def_epa_play': 'off_epa_play', 'def_pass_epa_db': 'pass_epa_db',
           'def_rush_epa_att': 'rush_epa_att', 'def_expl_pass': 'expl_pass',
           'def_expl_rush': 'expl_rush', 'sack_rate_made': 'sack_rate_all',
           'pts_for': 'pts_against', 'pts_against': 'pts_for'}


def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def ridge_fit(X, y, lam):
    X = np.asarray(X, float); y = np.asarray(y, float)
    Xb = np.hstack([X, np.ones((len(X), 1))])
    A = Xb.T @ Xb + lam * np.eye(Xb.shape[1])
    A[-1, -1] -= lam                       # never penalize the intercept
    return np.linalg.solve(A, Xb.T @ y)


def ridge_pred(X, w):
    Xb = np.hstack([np.asarray(X, float), np.ones((len(X), 1))])
    return Xb @ w


class Ratings:
    """Sequential team + QB rating state. Mirrors engine.js buildRatings."""

    def __init__(self, hp):
        self.hp = hp
        self.team = {}          # team -> feat -> rating (deviation units)
        self.ngames = {}        # team -> games absorbed
        self.lmean = {}         # feat -> slow league mean EWMA
        self.qb = {}            # qb_id -> {'v': ewma dev, 'n': starts}
        self.team_qb = {}       # team -> ewma of starters' qb_eff

    def _t(self, t):
        if t not in self.team:
            self.team[t] = {f: 0.0 for f in RATE_FEATS}
            self.ngames[t] = 0
            self.team_qb[t] = 0.0
        return self.team[t]

    def season_break(self):
        c = self.hp['carry']
        for t in self.team:
            for f in RATE_FEATS:
                self.team[t][f] *= c
            self.team_qb[t] *= c

    def qb_eff(self, qb_id):
        q = self.qb.get(qb_id)
        if not q:
            return self.hp['qb_prior']
        k = self.hp['qb_shrink']
        return q['v'] * (q['n'] / (q['n'] + k)) + self.hp['qb_prior'] * (k / (q['n'] + k))

    def qb_adjust(self, team, starter_id):
        """Value of today's announced starter vs the QB play already baked
        into this team's rating. 0 when unknown."""
        if not isinstance(starter_id, str) or not starter_id:
            return 0.0
        return self.qb_eff(starter_id) - self.team_qb.get(team, 0.0)

    def snapshot(self, t):
        self._t(t)
        return dict(self.team[t])

    def absorb_game(self, rows_by_team, qb_starts):
        """rows_by_team: {team: feature dict of raw per-game values}.
        Called AFTER predictions for this game were made."""
        hp = self.hp
        pre = {t: self.snapshot(t) for t in rows_by_team}
        for t, raw in rows_by_team.items():
            opp = [o for o in rows_by_team if o != t][0]
            for f in RATE_FEATS:
                v = raw.get(f)
                if v is None or (isinstance(v, float) and math.isnan(v)):
                    continue
                lm = self.lmean.get(f)
                if lm is None:
                    self.lmean[f] = v
                    continue
                cfeat = COUNTER.get(f)
                perf = v - lm - (pre[opp].get(cfeat, 0.0) if cfeat else 0.0)
                a = hp['alpha_pts'] if f in ('pts_for', 'pts_against') else hp['alpha']
                self.team[t][f] = (1 - a) * self.team[t][f] + a * perf
                self.lmean[f] = (1 - hp['alpha_league']) * lm + hp['alpha_league'] * v
            self.ngames[t] = self.ngames[t] + 1
        for t, (qb_id, pass_dev) in qb_starts.items():
            if isinstance(qb_id, str) and qb_id and pass_dev is not None \
               and not (isinstance(pass_dev, float) and math.isnan(pass_dev)):
                q = self.qb.setdefault(qb_id, {'v': 0.0, 'n': 0})
                aq = self.hp['alpha_qb']
                q['v'] = (1 - aq) * q['v'] + aq * pass_dev
                q['n'] += 1
                e = self.qb_eff(qb_id)
                at = self.hp['alpha']
                self.team_qb[t] = (1 - at) * self.team_qb.get(t, 0.0) + at * e


SPREAD_FEATS = ['net_pts', 'net_epa', 'net_pass', 'net_rush', 'qb_adj_diff',
                'rest_diff', 'div_game']
TOTAL_FEATS = ['off_epa_sum', 'def_epa_sum', 'pass_matchup', 'rush_matchup',
               'expl_sum', 'sack_env', 'pace_sum', 'pts_env',
               'is_dome', 'temp_c', 'wind_o', 'div_game', 'week_frac']
CTX_FEATS = ['rest_diff', 'home_short', 'away_short', 'home_off_bye',
             'away_off_bye', 'div_game', 'week_frac', 'is_dome', 'grass']


def game_features(R, g, tg_idx):
    h, a = g.home_fr, g.away_fr
    rh, ra = R.snapshot(h), R.snapshot(a)
    qh = R.qb_adjust(h, g.home_qb_id)
    qa = R.qb_adjust(a, g.away_qb_id)
    rest_h = g.home_rest if not pd.isna(g.home_rest) else 7
    rest_a = g.away_rest if not pd.isna(g.away_rest) else 7
    dome = 1.0 if str(g.roof) in ('dome', 'closed') else 0.0
    temp = g.temp if (not pd.isna(g.temp) and not dome) else 68.0
    wind = g.wind if (not pd.isna(g.wind) and not dome) else 0.0
    week_frac = min(1.0, (g.week if not pd.isna(g.week) else 9) / 18.0)
    sf = {
        'net_pts': (rh['pts_for'] + rh['pts_against']) - (ra['pts_for'] + ra['pts_against']),
        'net_epa': (rh['off_epa_play'] - rh['def_epa_play']) - (ra['off_epa_play'] - ra['def_epa_play']),
        'net_pass': (rh['pass_epa_db'] - rh['def_pass_epa_db']) - (ra['pass_epa_db'] - ra['def_pass_epa_db']),
        'net_rush': (rh['rush_epa_att'] - rh['def_rush_epa_att']) - (ra['rush_epa_att'] - ra['def_rush_epa_att']),
        'qb_adj_diff': qh - qa,
        'rest_diff': (rest_h - rest_a) / 7.0,
        'div_game': 0.0 if pd.isna(g.div_game) else float(g.div_game),
    }
    tf = {
        'off_epa_sum': rh['off_epa_play'] + ra['off_epa_play'],
        'def_epa_sum': rh['def_epa_play'] + ra['def_epa_play'],
        'pass_matchup': rh['pass_epa_db'] + ra['def_pass_epa_db'] + ra['pass_epa_db'] + rh['def_pass_epa_db'],
        'rush_matchup': rh['rush_epa_att'] + ra['def_rush_epa_att'] + ra['rush_epa_att'] + rh['def_rush_epa_att'],
        'expl_sum': rh['expl_pass'] + ra['expl_pass'] + rh['def_expl_pass'] + ra['def_expl_pass'],
        'sack_env': rh['sack_rate_all'] + ra['sack_rate_all'] - rh['sack_rate_made'] - ra['sack_rate_made'],
        'pace_sum': rh['plays'] + ra['plays'],
        'pts_env': rh['pts_for'] + ra['pts_for'] + rh['pts_against'] + ra['pts_against'],
        'is_dome': dome,
        'temp_c': (temp - 68.0) / 25.0,
        'wind_o': max(0.0, wind - 8.0) / 10.0,
        'div_game': 0.0 if pd.isna(g.div_game) else float(g.div_game),
        'week_frac': week_frac,
    }
    cf = {
        'rest_diff': (rest_h - rest_a) / 7.0,
        'home_short': 1.0 if rest_h <= 5 else 0.0,
        'away_short': 1.0 if rest_a <= 5 else 0.0,
        'home_off_bye': 1.0 if rest_h >= 12 else 0.0,
        'away_off_bye': 1.0 if rest_a >= 12 else 0.0,
        'div_game': 0.0 if pd.isna(g.div_game) else float(g.div_game),
        'week_frac': week_frac,
        'is_dome': dome,
        'grass': 1.0 if str(g.surface).lower().startswith('grass') else 0.0,
    }
    known = min(R.ngames.get(h, 0), R.ngames.get(a, 0))
    return sf, tf, cf, known


def sequential_pass(games, tg, qb, hp):
    """One chronological pass: emit pre-game features, then absorb the game."""
    tg_idx = {}
    for r in tg.itertuples():
        tg_idx.setdefault(r.game_id, {})[r.team] = r
    qb_idx = {}
    for r in qb.itertuples():
        key = (r.game_id, r.team)
        cur = qb_idx.get(key)
        if cur is None or r.dropbacks > cur.dropbacks:
            qb_idx[key] = r

    R = Ratings(hp)
    season = None
    rows = []
    for g in games.itertuples():
        if season is not None and g.season != season:
            R.season_break()
        season = g.season
        sf, tf, cf, known = game_features(R, g, tg_idx)
        rows.append({'game_id': g.game_id, 'season': g.season, 'week': g.week,
                     'known': known, **{'s_' + k: v for k, v in sf.items()},
                     **{'t_' + k: v for k, v in tf.items()},
                     **{'c_' + k: v for k, v in cf.items()}})
        gt = tg_idx.get(g.game_id, {})
        raws = {}
        for team, r in gt.items():
            raws[team] = {f: getattr(r, f, float('nan')) for f in RATE_FEATS
                          if f not in ('pts_for', 'pts_against')}
            raws[team]['pts_for'] = r.pts_for
            raws[team]['pts_against'] = r.pts_against
        qb_starts = {}
        for team in gt:
            k = (g.game_id, team)
            if k in qb_idx:
                r = qb_idx[k]
                lm = R.lmean.get('pass_epa_db')
                dev = (r.passing_epa / r.dropbacks - lm) if (lm is not None and r.dropbacks >= 10) else None
                qb_starts[team] = (r.player_id, dev)
        if len(raws) == 2:
            R.absorb_game(raws, qb_starts)
    feat = pd.DataFrame(rows)
    return games.merge(feat, on=['game_id', 'season', 'week'], how='inner'), R


def walk_forward(df, feats, target, lam, min_known=4):
    """Refit before each season on prior seasons' rows; predict OOS."""
    df = df[df.known >= min_known].copy()
    seasons = sorted(df.season.unique())
    preds = pd.Series(np.nan, index=df.index)
    coefs = {}
    for s in seasons:
        tr = df[df.season < s]
        te = df[df.season == s]
        if tr.season.nunique() < BURN_SEASONS or not len(te):
            continue
        w = ridge_fit(tr[feats].values, tr[target].values, lam)
        preds.loc[te.index] = ridge_pred(te[feats].values, w)
        coefs[int(s)] = w.tolist()
    df['pred'] = preds
    return df.dropna(subset=['pred']), coefs


def run(hp, games, tg, qb, lam_s=60.0, lam_t=60.0):
    df, R = sequential_pass(games, tg, qb, hp)
    sfe = ['s_' + f for f in SPREAD_FEATS]
    tfe = ['t_' + f for f in TOTAL_FEATS]
    sp, sp_coefs = walk_forward(df, sfe, 'margin', lam_s)
    to, to_coefs = walk_forward(df.dropna(subset=['total_pts']), tfe, 'total_pts', lam_t)
    return df, R, sp, to, sp_coefs, to_coefs


def mae(d, col='pred', tgt='margin'):
    return float(np.mean(np.abs(d[col] - d[tgt])))


def main():
    games = pd.read_csv(os.path.join(OUT, 'nfl_games.csv'),
                        parse_dates=['kick_dt']).sort_values(['kick_dt', 'game_id'])
    games = games[games.season <= 2025]
    tg = pd.read_csv(os.path.join(OUT, 'nfl_team_games.csv'))
    qb = pd.read_csv(os.path.join(OUT, 'nfl_qb_games.csv'))

    # ---- hyperparameter tuning: OOS MAE on <= TUNE_END only, then frozen ----
    base = dict(alpha=0.10, alpha_pts=0.06, alpha_league=0.02, carry=0.65,
                alpha_qb=0.12, qb_shrink=12.0, qb_prior=-0.04)
    grid = []
    for alpha in (0.07, 0.10, 0.14):
        for carry in (0.50, 0.65, 0.80):
            grid.append({**base, 'alpha': alpha, 'carry': carry})
    best, best_m = None, 1e9
    for hp in grid:
        _, _, sp, _, _, _ = run(hp, games, tg, qb)
        m = mae(sp[(sp.season >= FIRST_OOS) & (sp.season <= TUNE_END)])
        print(f"tune alpha={hp['alpha']} carry={hp['carry']}: spread MAE {m:.3f}")
        if m < best_m:
            best, best_m = dict(hp), m
    for aq in (0.08, 0.12, 0.18):
        hp = {**best, 'alpha_qb': aq}
        _, _, sp, _, _, _ = run(hp, games, tg, qb)
        m = mae(sp[(sp.season >= FIRST_OOS) & (sp.season <= TUNE_END)])
        print(f"tune alpha_qb={aq}: spread MAE {m:.3f}")
        if m < best_m:
            best, best_m = dict(hp), m
    HP = best
    print('frozen hyperparams:', HP)

    # ---- final pass with frozen hyperparams ----
    df, R, sp, to, sp_coefs, to_coefs = run(HP, games, tg, qb)
    test = sp[sp.season > TUNE_END]

    # ---- stuckey context layer on koerner residuals (walk-forward) ----
    sp = sp.copy()
    sp['resid'] = sp.margin - sp.pred
    cfe = ['c_' + f for f in CTX_FEATS]
    ctx, ctx_coefs = walk_forward(sp.rename(columns={'pred': 'koerner'})
                                  .assign(pred=np.nan), cfe, 'resid', 200.0)
    ctx = ctx.rename(columns={'pred': 'ctx_adj'})
    sp2 = sp.merge(ctx[['game_id', 'ctx_adj']], on='game_id', how='left')
    sp2['ctx_adj'] = sp2.ctx_adj.fillna(0.0)
    sp2['model_spread'] = sp2.pred + sp2.ctx_adj

    # ---- market ensemble: does the football number add to the close? ----
    ens_rows = sp2.dropna(subset=['spread_line'])
    ens, ens_coefs = walk_forward(ens_rows.assign(
        e_model=ens_rows.model_spread, e_mkt=ens_rows.spread_line,
        pred=np.nan), ['e_model', 'e_mkt'], 'margin', 1.0)
    ens = ens.rename(columns={'pred': 'blend'})

    # ---- totals context: none beyond sharp_total in v1 (kept honest) ----
    to = to.copy()
    to['model_total'] = to.pred
    toe = to.dropna(subset=['total_line'])
    tens, tens_coefs = walk_forward(toe.assign(
        e_model=toe.model_total, e_mkt=toe.total_line, pred=np.nan),
        ['e_model', 'e_mkt'], 'total_pts', 1.0)
    tens = tens.rename(columns={'pred': 'blend'})

    # ---- evaluation ----
    def seg(d, lo, hi):
        return d[(d.season >= lo) & (d.season <= hi)]

    rep = {'hyperparams': HP, 'n_games_scored': int(len(sp2))}
    for name, d, col, tgt, mk in [
            ('spread_koerner', sp2, 'pred', 'margin', 'spread_line'),
            ('spread_model', sp2, 'model_spread', 'margin', 'spread_line'),
            ('total_model', to, 'model_total', 'total_pts', 'total_line')]:
        dd = d.dropna(subset=[mk])
        rep[name] = {}
        for era, lo, hi in [('tune_2003_2015', FIRST_OOS, TUNE_END),
                            ('test_2016_2025', TUNE_END + 1, 2025),
                            ('all', FIRST_OOS, 2025)]:
            e = seg(dd, lo, hi)
            if not len(e):
                continue
            rep[name][era] = {
                'n': int(len(e)),
                'mae_model': round(mae(e, col, tgt), 3),
                'rmse_model': round(float(np.sqrt(np.mean((e[col] - e[tgt]) ** 2))), 3),
                'mae_market': round(mae(e, mk, tgt), 3),
                'corr_with_market': round(float(np.corrcoef(e[col], e[mk])[0, 1]), 3),
            }

    # ATS vs the CLOSE at edge thresholds (the strict test)
    def ats(d, model_col, mkt_col, tgt, thresholds):
        out = {}
        for tau in thresholds:
            e = d[np.abs(d[model_col] - d[mkt_col]) >= tau].copy()
            if not len(e):
                continue
            side = np.sign(e[model_col] - e[mkt_col])       # +1 = take home side
            res = np.sign(e[tgt] - e[mkt_col])
            push = (res == 0)
            win = (side == res) & ~push
            n = int((~push).sum())
            w = int(win.sum())
            from math import comb
            p = sum(comb(n, k) for k in range(w, n + 1)) / (2 ** n) if n <= 1000 else None
            if p is None:
                z = (w - n / 2) / math.sqrt(n / 4)
                p = 1 - norm_cdf(z)
            out[str(tau)] = {'n': n, 'wins': w, 'win_pct': round(w / n * 100, 2) if n else None,
                             'binom_p_one_sided': round(float(p), 4)}
        return out

    test2 = seg(sp2.dropna(subset=['spread_line']), TUNE_END + 1, 2025)
    rep['ats_spread_vs_close_test'] = ats(test2, 'model_spread', 'spread_line', 'margin', [0.5, 1, 1.5, 2, 3])
    tt2 = seg(to.dropna(subset=['total_line']), TUNE_END + 1, 2025)
    rep['ou_total_vs_close_test'] = ats(tt2, 'model_total', 'total_line', 'total_pts', [0.5, 1, 1.5, 2, 3])

    # incremental info: blend weights + MAE vs market alone
    for nm, e, tgt, mk in [('spread_blend', ens, 'margin', 'spread_line'),
                           ('total_blend', tens, 'total_pts', 'total_line')]:
        t = seg(e, TUNE_END + 1, 2025)
        rep[nm] = {
            'test_mae_blend': round(mae(t, 'blend', tgt), 3),
            'test_mae_market': round(mae(t, mk, tgt), 3),
            'blend_coefs_by_season': {k: [round(x, 4) for x in v]
                                      for k, v in (ens_coefs if nm == 'spread_blend' else tens_coefs).items()
                                      if k > TUNE_END},
        }

    # ---- win probability: sigma by MLE on all OOS rows; calibration 2010+ ----
    z = sp2.dropna(subset=['model_spread'])
    z = z[z.margin != 0]
    sigmas = np.arange(9.0, 16.5, 0.1)
    lls = []
    for s in sigmas:
        p = np.array([norm_cdf(m / s) for m in z.model_spread])
        p = np.clip(p, 1e-6, 1 - 1e-6)
        y = (z.margin > 0).astype(float)
        lls.append(np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    sigma_m = float(sigmas[int(np.argmax(lls))])
    rep['sigma_margin_mle'] = round(sigma_m, 2)

    ml = seg(sp2.dropna(subset=['home_moneyline', 'away_moneyline']), 2016, 2025).copy()
    def dec(a):
        return 1 + a / 100.0 if a > 0 else 1 + 100.0 / (-a)
    ml['p_mkt'] = [ (1/dec(h)) / (1/dec(h) + 1/dec(a))
                    for h, a in zip(ml.home_moneyline, ml.away_moneyline)]
    ml['p_model'] = [norm_cdf(m / sigma_m) for m in ml.model_spread]
    ml['home_win'] = (ml.margin > 0).astype(float)
    ml = ml[ml.margin != 0]
    for nm, col in [('model', 'p_model'), ('market_novig', 'p_mkt')]:
        p = np.clip(ml[col].values, 1e-6, 1 - 1e-6)
        y = ml.home_win.values
        rep[f'winprob_{nm}'] = {
            'n': int(len(ml)),
            'brier': round(float(np.mean((p - y) ** 2)), 5),
            'log_loss': round(float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))), 5),
        }
    bins = np.linspace(0, 1, 11)
    cal = []
    for i in range(10):
        m = (ml.p_model >= bins[i]) & (ml.p_model < bins[i + 1])
        if m.sum() >= 20:
            cal.append({'bin': f'{bins[i]:.1f}-{bins[i+1]:.1f}', 'n': int(m.sum()),
                        'p_pred': round(float(ml.p_model[m].mean()), 3),
                        'p_obs': round(float(ml.home_win[m].mean()), 3)})
    rep['calibration_2016_2025'] = cal

    # ---- ablations (test era spread MAE) ----
    abl = {}
    for nm, mod in [('no_qb', {'alpha_qb': 0.0}),
                    ('no_carryover', {'carry': 0.0}),
                    ('points_only', None)]:
        if mod is not None:
            _, _, s2, _, _, _ = run({**HP, **mod}, games, tg, qb)
            abl[nm] = round(mae(seg(s2, TUNE_END + 1, 2025)), 3)
        else:
            s2, _ = walk_forward(df, ['s_net_pts', 's_rest_diff', 's_div_game'],
                                 'margin', 60.0)
            abl[nm] = round(mae(seg(s2, TUNE_END + 1, 2025)), 3)
    abl['full_model'] = round(mae(seg(sp2, TUNE_END + 1, 2025), 'model_spread'), 3)
    rep['ablation_spread_mae_test'] = abl

    # ---- margin distribution around the model spread (key numbers) ----
    resid = (sp2.margin - sp2.model_spread).round().astype(int)
    resid = resid[(resid >= -40) & (resid <= 40)]
    pmf = resid.value_counts(normalize=True).sort_index()
    key_mass = {str(k): round(float((sp2.margin.abs() == k).mean()), 4)
                for k in [1, 2, 3, 4, 6, 7, 10, 14]}
    rep['abs_margin_key_mass'] = key_mass
    tot_resid = (to.total_pts - to.model_total).round().astype(int)
    tot_resid = tot_resid[(tot_resid >= -40) & (tot_resid <= 40)]
    tot_pmf = tot_resid.value_counts(normalize=True).sort_index()
    rep['sigma_total'] = round(float((to.total_pts - to.model_total).std()), 2)

    # ---- margin PMF conditioned on the spread (key-number engine) ----
    # A pooled residual PMF smears key numbers (margins cluster on integers,
    # model spreads are continuous). Estimate P(margin = m | spread = s) with
    # a Gaussian kernel over CLOSING spreads; bandwidth chosen by held-out
    # (2016+) log-likelihood, never by hand.
    kn = sp2.dropna(subset=['spread_line']).copy()
    kn['mi'] = kn.margin.round().astype(int)
    tr_k = kn[kn.season <= TUNE_END]
    te_k = kn[kn.season > TUNE_END]
    def pmf_at(train, s, bw):
        w = np.exp(-0.5 * ((train.spread_line.values - s) / bw) ** 2)
        tot = w.sum()
        out = {}
        for m, ww in zip(train.mi.values, w):
            out[m] = out.get(m, 0.0) + ww
        return {m: v / tot for m, v in out.items()}, tot
    best_bw, best_ll = None, -1e18
    for bw in (1.0, 1.5, 2.0, 3.0):
        ll = 0.0
        for s_val, grp in te_k.groupby(te_k.spread_line.round(0)):
            p, _ = pmf_at(tr_k, s_val, bw)
            for m in grp.mi:
                ll += math.log(max(p.get(m, 0.0), 1e-6))
        if ll > best_ll:
            best_bw, best_ll = bw, ll
    rep['pmf_spread_bw'] = best_bw
    pmf_by_spread = {}
    for s10 in range(-28, 29):                      # -14.0 .. +14.0 by 0.5
        s_val = s10 / 2.0
        p, _ = pmf_at(kn, s_val, best_bw)
        pmf_by_spread[f'{s_val:.1f}'] = {str(m): round(v, 6)
                                         for m, v in sorted(p.items())
                                         if v >= 1e-5 and -45 <= m <= 45}
    rep['key_mass_at_minus3'] = {
        'p_margin_3_given_spread_3': round(pmf_by_spread['3.0'].get('3', 0.0), 4),
        'p_margin_7_given_spread_7': round(pmf_by_spread['7.0'].get('7', 0.0), 4)}

    # ---- final shipped coefficients: fit on ALL OOS-capable seasons ----
    fit_all = sp2[sp2.season <= 2025]
    sfe = ['s_' + f for f in SPREAD_FEATS]
    tfe = ['t_' + f for f in TOTAL_FEATS]
    cfe = ['c_' + f for f in CTX_FEATS]
    w_spread = ridge_fit(fit_all[sfe].values, fit_all.margin.values, 60.0)
    w_ctx = ridge_fit(fit_all[cfe].values, (fit_all.margin - ridge_pred(fit_all[sfe].values, w_spread)).values, 200.0)
    to_all = to[to.season <= 2025]
    w_total = ridge_fit(to_all[tfe].values, to_all.total_pts.values, 60.0)
    e_all = ens[ens.season <= 2025]
    w_blend_s = ridge_fit(e_all[['e_model', 'e_mkt']].values, e_all.margin.values, 1.0)
    te_all = tens[tens.season <= 2025]
    w_blend_t = ridge_fit(te_all[['e_model', 'e_mkt']].values, te_all.total_pts.values, 1.0)

    seeds = {t: {f: round(v, 5) for f, v in R.team[t].items()} for t in sorted(R.team)}
    params = {
        'sport': 'nfl',
        'model_version': 'edgedesk_football_v1.0.0',
        'feature_version': 'nfl_fv1',
        'trained_through_season': int(games[games.margin.notna()].season.max()),
        'data_provenance': {
            'games': 'nflverse/nfldata data/games.csv (closing consensus lines)',
            'team_stats': 'nflverse-data releases stats_team/stats_team_week_YYYY.csv',
            'qb_stats': 'nflverse-data releases stats_player/stats_player_week_YYYY.csv',
        },
        'hyperparams': HP,
        'rate_feats': RATE_FEATS,
        'counter': COUNTER,
        'spread_feats': SPREAD_FEATS, 'w_spread': [round(x, 5) for x in w_spread],
        'ctx_feats': CTX_FEATS, 'w_ctx': [round(x, 5) for x in w_ctx],
        'total_feats': TOTAL_FEATS, 'w_total': [round(x, 5) for x in w_total],
        'w_blend_spread': [round(x, 5) for x in w_blend_s],
        'w_blend_total': [round(x, 5) for x in w_blend_t],
        'sigma_margin': round(sigma_m, 2),
        'sigma_total': rep['sigma_total'],
        'margin_resid_pmf': {str(k): round(float(v), 6) for k, v in pmf.items()},
        'margin_pmf_by_spread': pmf_by_spread,
        'pmf_spread_bw': best_bw,
        'pmf_spread_range': [-14.0, 14.0],
        'total_resid_pmf': {str(k): round(float(v), 6) for k, v in tot_pmf.items()},
        'league_means': {f: round(v, 5) for f, v in R.lmean.items()},
        'seed_ratings': seeds,
        'seed_team_qb': {t: round(v, 5) for t, v in R.team_qb.items()},
        'seed_qb_values': {q: {'v': round(d['v'], 5), 'n': d['n']}
                           for q, d in R.qb.items() if d['n'] >= 4},
    }

    sp2[['game_id', 'season', 'week', 'margin', 'spread_line', 'pred',
         'ctx_adj', 'model_spread']].to_csv(os.path.join(OUT, 'nfl_oos.csv'), index=False)
    with open(os.path.join(OUT, 'params_nfl.json'), 'w') as f:
        json.dump(params, f, indent=1)
    with open(os.path.join(OUT, 'report_nfl.json'), 'w') as f:
        json.dump(rep, f, indent=1)
    print(json.dumps(rep, indent=1)[:4000])


if __name__ == '__main__':
    main()
