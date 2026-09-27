"""Weekly integration, explanations and Model Lab monitoring (docs/cfb-matchup/METHODS.md section 9).

The weekly engine calls, at its freeze T (after PROJECT, i.e. with V2.1's pure projections):

    out = matchup_week(season, T, X_T, projections=P_T)

  X_T          the V2.1 stage-5 snapshot rows of the games frozen at T (the engine's ctx['X'])
  projections  optional frame with game_id, ens_pred, sigma (the engine's projections at T);
               default: ens_pred / sigma of the V2.1 stage-7 rows for these games
It returns plain records (JSON-ready, deterministic ids) for the append-only tables of
supabase/cfb_matchup.sql:
  team_week_style    one row per team x season x week x style_version (style_mean + style_sd,
                     scheme continuity, active style-change events)
  game_matchup       one row per game x prediction_ts x feature_version: GENERAL FAIR SPREAD,
                     MATCHUP ADJUSTMENT, MATCHUP-AWARE FAIR SPREAD, MATCHUP CONFIDENCE, PRIMARY /
                     SECONDARY EDGE, PRIMARY RISK, EXPECTED POSSESSIONS, EXPECTED PASS/RUSH BEHAVIOR,
                     MATCHUP VARIANCE EFFECT, the public edges, the shadow (challenger) correction
  similar_matchups   top comparisons per side (similarity, distance, differences, residual,
                     eligible_pre_prediction)
  style_change_events  events detected at or before T
Nothing is retrained weekly: the frozen artifact (residual.load_artifact) is applied as is; style
ratings are recomputed point in time. With a NO_ADJUSTMENT artifact the matchup-aware spread equals
the general spread exactly and the explanation says so.
"""
import json

import numpy as np
import pandas as pd

from .. import common
from .. import config as C
from ..weekly import ids
from . import interactions as IX
from . import similar as SM
from . import style as ST
from . import residual as RS
from . import changes as CH
from . import (STYLE_VERSION, MATCHUP_FEATURE_VERSION, SIMILARITY_VERSION, RESIDUAL_MODEL_VERSION,
               PLAYSEL_VERSION, BASE_MODEL_VERSION)

EVEN = 0.25            # |standardized edge| below this reads "even"
MIXED = 0.5            # edges of both signs at least this large -> MIXED signals

# public label -> (V2 column, what it measures, units)
PUBLIC = {'PASS EDGE': ('match_pass_edge', 'pass offense vs pass defense, adjusted EPA per dropback'),
          'RUSH EDGE': ('match_rush_edge', 'rush offense vs rush defense, adjusted EPA per rush'),
          'TRENCH EDGE': ('match_trench_edge', 'line yards, stuff rate and 5+ yard runs, offense vs defense'),
          'HAVOC EDGE': ('match_havoc_edge', 'sacks and run TFLs suffered vs forced'),
          'EXPLOSIVE EDGE': ('match_explosive_edge', 'explosive-play rate, offense vs defense')}
# unit matchups the explanation can cite: label -> (metric, source 'v2'|'style', human unit)
UNITS = {'PASS': ('epa_pass', 'v2', 'EPA/dropback'), 'RUSH': ('epa_rush', 'v2', 'EPA/rush'),
         'EXPLOSIVE PASS': ('expl_pass', 'v2', 'explosive rate/dropback'),
         'EXPLOSIVE RUSH': ('expl_rush', 'v2', 'explosive rate/rush'),
         'PROTECTION vs PASS RUSH': ('sack_rate', 'v2', 'sacks/dropback'),
         'TRENCH': ('line_yds', 'v2', 'line yards/rush'), 'EARLY DOWN': ('epa_early', 'style', 'EPA/play on 1st-2nd down'),
         'PASSING DOWN': ('sr_pd', 'v2', 'success rate on passing downs'),
         'FINISHING DRIVES': ('pts_per_opp', 'v2', 'points per scoring opportunity'),
         'QB RUN': ('qb_rush_epa', 'style', 'EPA per QB rush')}


def _num(x, k=4):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if not np.isfinite(v) else round(v, k)


# ============================================================== team style
def team_week_style(season, T, week=None, CT=None, events=None):
    """cfb_team_week_style rows at the freeze T (style ratings solved from games before T)."""
    Rt = ST.ratings(season)
    T = pd.Timestamp(T)
    r = Rt[Rt.prediction_ts.eq(T)]
    if r.empty:
        raise ValueError('no style ratings at %s (run v2.matchup.style for season %s)' % (T, season))
    Lg = ST.league(season)
    lg = Lg[Lg.prediction_ts.eq(T)].set_index('metric').mu
    CT = CH.continuity_table() if CT is None else CT
    ct = CT[CT.season.eq(season)].set_index('team_id')
    rows = []
    for tid, g in r.groupby('team_id'):
        g = g.set_index('metric')
        style = {}
        for m in ST.METRIC_NAMES:
            if m not in g.index:
                continue
            x = g.loc[m]
            style[m] = {'off_mean': _num(x['off'], 5), 'off_sd': _num(np.sqrt(max(x.off_var, 0)), 5),
                        'def_mean': _num(x['def'], 5), 'def_sd': _num(np.sqrt(max(x.def_var, 0)), 5),
                        'prior_off': _num(x.prior_off, 5), 'prior_def': _num(x.prior_def, 5),
                        'league_mean': _num(lg.get(m), 5), 'kind': 'behavior' if m in ST.BEHAVIOR else 'efficiency'}
        n = float(g.loc['proe', 'n_obs_off']) if 'proe' in g.index else 0.0
        # scheme drift: chi-square of (current - prior) / prior SD over the behavior metrics (offense)
        z2 = [((g.loc[m, 'off'] - g.loc[m, 'prior_off']) ** 2) / max(g.loc[m, 'prior_off_var'], 1e-12)
              for m in ('proe', 'ed_proe', 'pd_proe', 'tempo', 'qb_rush_rate') if m in g.index and n > 0]
        from scipy import stats
        drift_p = float(stats.chi2.sf(sum(z2), len(z2))) if z2 else None
        c = ct.loc[tid] if tid in ct.index else None
        ev = []
        if events is not None and len(events):
            e = events[(events.team_id == tid) & (events.season == season)]
            e = e[pd.to_datetime(e.detected_at, utc=True) <= T]
            ev = [{'event_type': a.event_type, 'metric': a.metric, 'z': _num(a.z, 3), 'detected_at': ids.ts(a.detected_at)}
                  for a in e.itertuples()]
        rec = {'team_id': str(int(tid)), 'season': int(season), 'week': week, 'as_of': ids.ts(T),
               'feature_version': STYLE_VERSION, 'style_games': n,
               'offensive_scheme_continuity': None if c is None or pd.isna(c.oc_cont) else float(c.oc_cont),
               'defensive_scheme_continuity': None if c is None or pd.isna(c.dc_cont) else float(c.dc_cont),
               'head_coach_new': None if c is None or pd.isna(c.hc_tenure) else bool(c.hc_tenure == 0),
               'style_drift_p': _num(drift_p, 4), 'style': style, 'events': ev}
        rec['style_id'] = 'cfbms_' + ids.h(rec['team_id'], season, rec['week'], STYLE_VERSION, rec['as_of'])
        rows.append(rec)
    return rows


# ============================================================== explanation
def _unit_matchup(g, o, d, label, v2s, sts):
    m, src, unit = UNITS[label]
    if src == 'v2':
        sgn = -1.0 if m in C.NEGATIVE_METRICS else 1.0
        off, dfn = g.get('%s_%s__off' % (o, m)), g.get('%s_%s__def' % (d, m))
        sc = v2s.get(m, 1.0)
        lgm = g.get('lg_%s__mu' % m)
    else:
        sgn = -1.0 if m in ST.NEGATIVE else 1.0
        off, dfn = g.get('%s_s_%s__off' % (o, m)), g.get('%s_s_%s__def' % (d, m))
        sc = sts.get(m, 1.0)
        lgm = g.get('slg_%s__mu' % m)
    if off is None or dfn is None or not np.isfinite(off) or not np.isfinite(dfn):
        return None
    return {'matchup': label, 'offense_rating': _num(off), 'defense_allows': _num(dfn), 'league_mean': _num(lgm),
            'expected_vs_league': _num(off + dfn), 'unit': unit, 'z': _num(sgn * (off + dfn) / sc, 3)}


def explain(g, home, away, v2s, sts, adj, conf, art_status, shadow):
    """Structured, number-only explanation of one game (brief 48-51). g: a feature row (dict-like)."""
    units = []
    for o, d, off_team, def_team, sgn in (('h', 'a', home, away, 1.0), ('a', 'h', away, home, -1.0)):
        for label in UNITS:
            u = _unit_matchup(g, o, d, label, v2s, sts)
            if u is None:
                continue
            u.update(offense=off_team, defense=def_team, favors=(off_team if u['z'] > 0 else def_team),
                     home_signed_z=_num(sgn * u['z'], 3))
            units.append(u)
    ranked = sorted(units, key=lambda u: -abs(u['z'] or 0))
    lean = home if (g.get('ens_pred') or 0) >= 0 else away
    primary = ranked[0] if ranked else None
    secondary = next((u for u in ranked[1:] if primary is None or u['matchup'] != primary['matchup']
                      or u['offense'] != primary['offense']), None)
    risk = next((u for u in ranked if u['favors'] != lean and abs(u['z'] or 0) >= EVEN), None)
    public = {}
    for label, (col, what) in PUBLIC.items():
        v = g.get(col)
        v = None if v is None or not np.isfinite(v) else float(v)
        public[label] = {'value_sd': _num(v, 3), 'favors': None if v is None else
                         ('even' if abs(v) < EVEN else (home if v > 0 else away)), 'measures': what}
    pos = [k for k, v in public.items() if v['value_sd'] is not None and v['value_sd'] >= MIXED]
    neg = [k for k, v in public.items() if v['value_sd'] is not None and v['value_sd'] <= -MIXED]
    contradictions = {'favor_home': pos, 'favor_away': neg, 'mixed': bool(pos and neg)}
    note = ('The matchup model is frozen as NO_ADJUSTMENT: no matchup family improved out-of-sample accuracy over '
            'V2.1 (docs/cfb-matchup/BACKTEST.md), so the fair line is the general line. The edges below are '
            'measured descriptions, not a correction.') if art_status != 'ADJUST' else \
        'Matchup correction %+.1f points (confidence %.2f).' % (adj, conf)
    return {'primary_matchup_edge': primary, 'secondary_matchup_edge': secondary, 'primary_matchup_risk': risk,
            'public_edges': public, 'contradictory_signals': contradictions, 'note': note,
            'shadow_challenger_adjustment': _num(shadow, 3),
            'rule': 'every number is a point-in-time rating at the freeze; no narrative text is generated'}


# ============================================================== confidence
def matchup_confidence(F):
    """[0, 1] per game from style sample size, data completeness, similar-opponent coverage, scheme
    continuity (preseason coordinator flags; fades as games accumulate) and QB certainty. It is a
    DATA-QUALITY statement about the matchup layer, not football confidence and not an edge."""
    n = F['conf_style_games'].fillna(0.0)
    sample = np.minimum(n / 6.0, 1.0)
    complete = F['conf_completeness'].fillna(0.0)
    cover = np.minimum(np.minimum(F.get('home_eff_sim', 0.0).fillna(0.0), F.get('away_eff_sim', 0.0).fillna(0.0)) / 3.0, 1.0)
    cont = F.get('conf_continuity', pd.Series(1.0, index=F.index)).fillna(0.75)
    cont = cont + (1 - cont) * np.minimum(n / 6.0, 1.0)
    qb = F['conf_qb_certain'].fillna(0.5)
    return (0.30 * sample + 0.15 * complete + 0.20 * cover + 0.15 * cont + 0.20 * qb).clip(0, 1)


# ============================================================== the hook
def matchup_week(season, T, X_T, projections=None, art=None, history=None, want_similar=True, week=None):
    """Everything the weekly engine records for the games frozen at T (see module docstring)."""
    T = pd.Timestamp(T)
    art = art or RS.load_artifact()
    X = X_T.copy()
    assert (pd.to_datetime(X.prediction_ts, utc=True) == T).all(), 'every row must be frozen at T'
    if projections is not None:
        P = projections.set_index('game_id')
        X['ens_pred'] = X.game_id.map(P.ens_pred)
        X['sigma'] = X.game_id.map(P.sigma) if 'sigma' in P else np.nan
    M = pd.read_parquet(common.out_path('stage7', 'backtest_predictions.parquet')) if history is None else history
    if 'ens_pred' not in X or X.ens_pred.isna().all():
        X = X.merge(M[['game_id', 'ens_pred', 'sigma', 'pred_E_drive']], on='game_id', how='left', suffixes=('_x', ''))
    if 'pred_E_drive' not in X:
        X = X.merge(M[['game_id', 'pred_E_drive']], on='game_id', how='left')
    from .. import models as MD
    X = MD.add_derived(X)
    Xs = IX.attach_style(X)
    F = IX.season_features(Xs, season)
    CT = CH.continuity_table()
    ct = CT[CT.season.eq(season)].set_index('team_id')
    oc = lambda t: ct.oc_cont.get(t, np.nan)
    F['conf_continuity'] = [np.nanmean([oc(h), oc(a)]) if not (np.isnan(oc(h)) and np.isnan(oc(a))) else np.nan
                            for h, a in zip(X.home_id, X.away_id)]
    sim_pairs = pd.DataFrame()
    if want_similar:
        Mh = pd.concat([M[M.kickoff_ts < T], X.assign(status='SCHEDULED')], ignore_index=True)
        cfg = art['spec'].get('similarity') or dict(SM.DEFAULT)
        # history: this season before T and all of last season (half weight), exactly as in the backtest
        SF, sim_pairs = SM.build(Mh[Mh.season.between(season - 1, season) | Mh.game_id.isin(X.game_id)],
                                 metric=cfg['metric'], h=cfg['h'], want_pairs=True, seasons=[season])
        SF = SF[SF.game_id.isin(X.game_id)].set_index('game_id')
        for c in ('sim_resid_edge', 'sim_margin_edge', 'fam_edge', 'home_eff_sim', 'away_eff_sim', 'home_max_sim',
                  'away_max_sim'):
            F[c] = X.game_id.map(SF[c]).values
        sim_pairs = sim_pairs[sim_pairs.target_game_id.isin(X.game_id)]
    D = pd.concat([X.reset_index(drop=True), F.reset_index(drop=True).drop(columns=[c for c in F.columns if c in X.columns])],
                  axis=1)
    adj = RS.apply(art, D)
    ch = art['models'].get('challenger_all_ridge')
    shadow = np.zeros(len(D))
    if ch:
        m = RS.RidgeResid.from_json(ch)
        shadow = np.clip(ch.get('lambda', 0.0) * m.predict(D), -RS.CAP, RS.CAP)
    conf = matchup_confidence(D)
    v2s = __import__('v2.snapshots', fromlist=['metric_scales']).metric_scales(season)
    sts = ST.metric_scales(season)
    games = []
    for i, g in D.iterrows():
        gd = g.to_dict()
        general = float(g.ens_pred)
        a = float(adj[i])
        exp_poss = _num(g.get('exp_drives_home', np.nan) + g.get('exp_drives_away', np.nan), 2)

        def exp_pass(o, d, sg):
            v = g.get('slg_neu_pass__mu', np.nan) + g.get('%s_s_neu_pass__off' % o, np.nan) \
                + g.get('%s_s_neu_pass__def' % d, np.nan) + sg * (g.get('slg_neu_pass__h', 0.0) if not g.get('neutral_site') else 0.0)
            return _num(v, 3)

        def exp_tempo(o, d):
            return _num(g.get('slg_tempo__mu', np.nan) + g.get('%s_s_tempo__off' % o, np.nan)
                        + g.get('%s_s_tempo__def' % d, np.nan), 2)
        rec = {'game_id': str(int(g.game_id)), 'season': int(season), 'week': week if week is not None else _num(g.get('week'), 0),
               'prediction_ts': ids.ts(T), 'kickoff_ts': ids.ts(g.kickoff_ts), 'home_team': g.get('home_team'),
               'away_team': g.get('away_team'), 'home_id': str(int(g.home_id)), 'away_id': str(int(g.away_id)),
               'base_model_version': BASE_MODEL_VERSION, 'feature_version': MATCHUP_FEATURE_VERSION,
               'style_version': STYLE_VERSION, 'similarity_version': SIMILARITY_VERSION,
               'matchup_model_version': art['artifact'], 'matchup_model_status': art['status'],
               'playsel_version': PLAYSEL_VERSION,
               'general_fair_margin': _num(general, 3), 'general_fair_spread_home': _num(-general, 3),
               'matchup_adjustment_points': _num(a, 3), 'matchup_aware_margin': _num(general + a, 3),
               'matchup_aware_spread_home': _num(-(general + a), 3), 'matchup_confidence': _num(conf[i], 3),
               'shadow_adjustment_points': _num(shadow[i], 3),
               'expected_possessions': exp_poss,
               'expected_neutral_pass_rate': {'home': exp_pass('h', 'a', 1.0), 'away': exp_pass('a', 'h', -1.0)},
               'expected_tempo_sec_per_play': {'home': exp_tempo('h', 'a'), 'away': exp_tempo('a', 'h')},
               'matchup_variance_effect': 1.0,
               'variance_note': 'variance model REJECTED on dev (docs/cfb-matchup/BACKTEST.md): V2.1 sigma unchanged',
               'features': {c: _num(g.get(c), 4) for c in IX.all_feature_cols() + list(SM.FAMILY['similar_opp'])
                            + IX.VARIANCE_FEATURES if c in D},
               'explanation': explain(gd, g.get('home_team'), g.get('away_team'), v2s, sts, a, float(conf[i]),
                                      art['status'], shadow[i])}
        rec['input_hash'] = ids.h(ids.canonical(rec['features']), art['sha256'])
        rec['matchup_id'] = 'cfbmg_' + ids.h(rec['game_id'], rec['prediction_ts'], MATCHUP_FEATURE_VERSION,
                                             art['artifact'], rec['input_hash'])
        games.append(rec)
    sims = []
    for p in sim_pairs.to_dict('records'):
        p = {k: (ids.ts(v) if isinstance(v, pd.Timestamp) else v) for k, v in p.items()}
        p['similar_id'] = 'cfbmx_' + ids.h(p['target_game_id'], p['team_side'], p['comparison_game_id'], p['prediction_ts'],
                                            SIMILARITY_VERSION)
        p['display_allowed'] = False       # no validated display threshold (BACKTEST.md): description only
        sims.append(p)
    ev = pd.read_parquet(common.out_path('matchup', 'style_change_events.parquet')) \
        if __import__('os').path.exists(common.out_path('matchup', 'style_change_events.parquet')) else pd.DataFrame()
    styles = team_week_style(season, T, week=week, CT=CT, events=ev)
    teams = set(X.home_id.astype(int)) | set(X.away_id.astype(int))
    styles = [s for s in styles if int(s['team_id']) in teams]
    evs = []
    if len(ev):
        e = ev[(ev.season == season) & (pd.to_datetime(ev.detected_at, utc=True) <= T)]
        for a in e.itertuples():
            r = {'team_id': str(a.team_id), 'season': int(a.season), 'event_type': a.event_type, 'metric': a.metric,
                 'trigger_game_id': str(a.trigger_game_id), 'detected_at': ids.ts(a.detected_at), 'z': _num(a.z, 3),
                 'threshold': _num(a.threshold, 3), 'shift': _num(a.shift, 4), 'rule_version': a.rule_version}
            r['event_id'] = 'cfbme_' + ids.h(r['team_id'], r['season'], r['metric'], r['trigger_game_id'], r['rule_version'])
            evs.append(r)
    return {'team_week_style': styles, 'game_matchup': games, 'similar_matchups': sims, 'style_change_events': evs}


# ======================================================== Model Lab monitor
def lab_monitor(records, results):
    """Prospective matchup monitoring (brief 65): join matchup records with final margins.
    records: game_matchup records; results: {game_id: final home margin}. Returns aggregate and
    per-category numbers for both the production correction and the shadow challenger."""
    rows = []
    for r in records:
        y = results.get(str(r['game_id']))
        if y is None or r.get('general_fair_margin') is None:
            continue
        gm = r['general_fair_margin']
        prim = (r.get('explanation') or {}).get('primary_matchup_edge') or {}
        rows.append({'game_id': r['game_id'], 'y': float(y), 'general': gm, 'adj': r.get('matchup_adjustment_points') or 0.0,
                     'shadow': r.get('shadow_adjustment_points') or 0.0, 'conf': r.get('matchup_confidence'),
                     'category': prim.get('matchup', 'NONE')})
    if not rows:
        return {'n': 0}
    d = pd.DataFrame(rows)
    d['resid'] = d.y - d.general

    def block(x):
        out = {'n': int(len(x)), 'mae_general': float((x.general - x.y).abs().mean())}
        for k in ('adj', 'shadow'):
            new = x.general + x[k]
            out['mae_' + k] = float((new - x.y).abs().mean())
            out['delta_' + k] = out['mae_' + k] - out['mae_general']
            big = x[k].abs() >= 0.5
            out['direction_agreement_' + k] = float((np.sign(x[k][big]) == np.sign(x.resid[big])).mean()) if big.any() else None
        return out
    res = {'overall': block(d), 'by_primary_matchup': {k: block(g) for k, g in d.groupby('category') if len(g) >= 5}}
    d['cb'] = pd.cut(d.conf.astype(float), [0, 0.4, 0.6, 0.8, 1.01], labels=['<0.4', '0.4-0.6', '0.6-0.8', '0.8+'])
    res['by_confidence'] = {str(k): block(g) for k, g in d.groupby('cb', observed=True) if len(g) >= 5}
    res['rule'] = 'monitoring only: production never changes after one week (champion/challenger governance)'
    return res


def weekly_report(records, results, n=8):
    """Largest corrections of the week and whether they were directionally right (brief 66-67)."""
    rows = []
    for r in records:
        y = results.get(str(r['game_id']))
        for k in ('matchup_adjustment_points', 'shadow_adjustment_points'):
            a = r.get(k) or 0.0
            if a == 0 or y is None:
                continue
            resid = float(y) - r['general_fair_margin']
            rows.append({'game_id': r['game_id'], 'kind': 'production' if k.startswith('matchup') else 'shadow',
                         'matchup': '%s at %s' % (r.get('away_team'), r.get('home_team')), 'adjustment': a,
                         'residual': round(resid, 2), 'direction_correct': bool(np.sign(a) == np.sign(resid)),
                         'primary_edge': ((r.get('explanation') or {}).get('primary_matchup_edge') or {}).get('matchup')})
    d = pd.DataFrame(rows)
    if d.empty:
        return {'largest': [], 'note': 'no non-zero matchup correction this week (NO_ADJUSTMENT artifact; shadow zero)'}
    d = d.reindex(d.adjustment.abs().sort_values(ascending=False).index)
    return {'largest': d.head(n).to_dict('records'),
            'direction_correct_share': {k: float(g.direction_correct.mean()) for k, g in d.groupby('kind')},
            'by_primary_edge': {k: {'n': int(len(g)), 'direction_correct': float(g.direction_correct.mean())}
                                for k, g in d.groupby('primary_edge')},
            'rule': 'do not change production after one week'}


# ======================================================== Postgres rows
def _clean(rec):
    return json.loads(ids.canonical(rec))


def table_rows(out):
    """hook.matchup_week output -> {table: [rows]} with the typed columns of supabase/cfb_matchup.sql and
    `payload` = the complete record (what an insert-only mirror would send through PostgREST)."""
    T = {'cfb_team_week_style': [], 'cfb_game_matchup_features': [], 'cfb_similar_matchups': [],
         'cfb_style_change_events': []}
    for r in out['team_week_style']:
        T['cfb_team_week_style'].append({
            'style_id': r['style_id'], 'team_id': r['team_id'], 'season': r['season'], 'week': r['week'],
            'as_of': r['as_of'], 'feature_version': r['feature_version'], 'style_games': r['style_games'],
            'offensive_scheme_continuity': r['offensive_scheme_continuity'],
            'defensive_scheme_continuity': r['defensive_scheme_continuity'], 'head_coach_new': r['head_coach_new'],
            'style_drift_p': r['style_drift_p'], 'state_version': 1, 'supersedes': None, 'payload': _clean(r)})
    cols = ['matchup_id', 'game_id', 'season', 'week', 'prediction_ts', 'kickoff_ts', 'base_model_version',
            'feature_version', 'style_version', 'similarity_version', 'matchup_model_version', 'matchup_model_status',
            'general_fair_margin', 'matchup_adjustment_points', 'matchup_aware_margin', 'matchup_confidence',
            'shadow_adjustment_points', 'expected_possessions', 'input_hash']
    for r in out['game_matchup']:
        row = {c: r.get(c) for c in cols}
        row['week'] = None if row['week'] is None else int(row['week'])
        row['payload'] = _clean(r)
        T['cfb_game_matchup_features'].append(row)
    for r in out['similar_matchups']:
        T['cfb_similar_matchups'].append({
            'similar_id': r['similar_id'], 'target_game_id': str(r['target_game_id']),
            'comparison_game_id': str(r['comparison_game_id']), 'team_side': r['team_side'], 'team_id': str(r['team_id']),
            'prediction_ts': ids.ts(r['prediction_ts']), 'comparison_kickoff_ts': ids.ts(r['comparison_kickoff_ts']),
            'similarity_score': r['similarity_score'], 'feature_distance': r['feature_distance'],
            'eligible_pre_prediction': r['eligible_pre_prediction'], 'display_allowed': r['display_allowed'],
            'similarity_version': r['similarity_version'], 'payload': _clean(r)})
    for r in out['style_change_events']:
        T['cfb_style_change_events'].append({k: r.get(k) for k in ('event_id', 'team_id', 'season', 'event_type', 'metric',
                                                                  'trigger_game_id', 'detected_at', 'z', 'threshold',
                                                                  'rule_version')} | {'payload': _clean(r)})
    return T


def version_rows(art, decided_at):
    """cfb_matchup_model_versions rows from the frozen artifact and the dev decisions (no CHAMPION:
    promotion is a person's decision with evidence)."""
    comps = [('residual', art['artifact'], art['status'], art['sha256']),
             ('style', STYLE_VERSION, 'CHALLENGER', None), ('similarity', SIMILARITY_VERSION, 'CHALLENGER', None),
             ('play_selection', PLAYSEL_VERSION, 'CHALLENGER', None), ('variance', 'cfb_matchup_variance_v1', 'REJECTED', None),
             ('clustering', 'cfb_style_cluster_v1', 'REJECTED', None), ('change_points', 'cfb_style_change_v1', 'CHALLENGER', None)]
    rows = []
    for comp, ver, status, sha in comps:
        r = {'component': comp, 'version': ver, 'status': status, 'base_model_version': BASE_MODEL_VERSION,
             'artifact_sha256': sha, 'decided_at': ids.ts(decided_at), 'decided_by': None,
             'evidence': 'docs/cfb-matchup/BACKTEST.md'}
        r['version_row_id'] = 'cfbmv_' + ids.h(comp, ver, status, r['decided_at'])
        r['payload'] = _clean(dict(r, note=art.get('evidence', {}).get('validated_families')))
        rows.append(r)
    return rows


def write_fixture(path, season=None, n_games=4):
    """A real hook run at the latest freeze of the live season, trimmed, for football/cfb_matchup/sql.test.js."""
    season = season or C.LIVE_SEASON
    X = pd.read_parquet(common.out_path('stage5', 'cfb_model_training_snapshots.parquet'))
    X = X[X.season.eq(season)]
    now = pd.Timestamp.now(tz='UTC')
    ahead = sorted(t for t in X.prediction_ts.unique() if t > now)
    T = ahead[0] if ahead else X.prediction_ts.max()      # the next freeze of the live season
    XT = X[X.prediction_ts.eq(T) & ~X.fcs_game.astype(bool)].head(n_games)
    art = RS.load_artifact()
    out = matchup_week(season, T, XT, art=art)
    rows = table_rows(out)
    rows['cfb_similar_matchups'] = rows['cfb_similar_matchups'][:12]
    rows['cfb_style_change_events'] = rows['cfb_style_change_events'][:12]
    rows['cfb_matchup_model_versions'] = version_rows(art, pd.Timestamp('2026-09-27T00:00:00Z'))
    common.write_json(path, {'generated_from': {'season': int(season), 'prediction_ts': ids.ts(T),
                                                'artifact': art['artifact'], 'status': art['status']}, 'rows': rows})
    return rows


if __name__ == '__main__':
    import sys
    write_fixture(sys.argv[1] if len(sys.argv) > 1 else 'hook_rows.json')
