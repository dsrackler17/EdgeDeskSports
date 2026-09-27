"""Offense x defense interaction features per game (docs/cfb-matchup/METHODS.md section 5).

Every feature is HOME-MINUS-AWAY and oriented so that + favours the home team:

    feature = f(home offense, away defense) - f(away offense, home defense)

so swapping the two teams negates it (tests_matchup checks the antisymmetry). Inputs are the
point-in-time ratings frozen at the game's prediction_ts: V2 stage-3 ratings (the h_/a_
columns of the V2.1 snapshot row) and the style ratings (style.py), never anything later.

Standardization: z = sign x rating / scale, the metric's robust between-team SD over the three
previous seasons (V2 snapshots.metric_scales' rule), sign = -1 for metrics where a higher
offensive value is worse for the offense; so z_off > 0 is a good offense and z_def > 0 a
defense that ALLOWS more (a weak defense) on that metric.

Families (continuous first; clusters are a separate descriptive layer, backtest.py):
  pass_rush     compounding pass / rush efficiency (z_o x z_d), mix exploitation (expected
                pass share deviation x the defense's pass-vs-rush vulnerability, in points),
                relative-strength alignment
  protection    pass protection x pass rush (full product and the narrative quadrant: a
                sack-prone offense vs a strong rush), front havoc product
  qb_mobility   QB-rush share x QB-run containment, mobility x pass-rush strength
  explosive     explosive pass / rush products and the "explosive offense vs leaky defense" quadrant
  trench        line yards and stuff products (run_block_edge; pass protection is separate)
  early_down    early-down EPA (a style metric V2 does not have) edge and product
  passing_down  passing-down EPA edge, passing-down success product, behind-schedule burden
  finishing     points per scoring opportunity and opportunity-rate edges and products
  pace          possessions x strength (slow-game compression), tempo edge
  field_pos     starting field position edge and product
  fourth_down   4th-down go rate over expected, and with short-yardage conversion
  short_yardage short-yardage conversion edge and product
  play_select   opponent response: the defense's pass-rate response x the offense's pass-vs-rush
                advantage (expected play selection x expected efficiency, section 40-42)
  drive_model   V2's own possession model disagreement with the ensemble
  personnel     QB inexperience / QB change x pass rush and havoc (the only personnel dimension
                with a point-in-time history; OL and secondary health have none)
  environment   altitude, time-zone travel, home field x the visitor's tempo / sack-proneness
  v2_existing   V2's own match_* and x_* features (redundancy control: should add nothing)
Variance features (symmetric, for the variance model) and matchup-confidence inputs are
built here too.
"""
import numpy as np
import pandas as pd

from .. import snapshots as SN
from .. import config as C
from . import style as ST
from . import MATCHUP_FEATURE_VERSION

V2_NEG = C.NEGATIVE_METRICS
ST_NEG = ST.NEGATIVE

FAMILIES = {
    'pass_rush': ['xm_epa_pass', 'xm_epa_rush', 'mix_exploit', 'rel_align'],
    'protection': ['xm_sack', 'hinge_sack', 'xm_havoc'],
    'qb_mobility': ['qbr_contain', 'qbr_vs_rush', 'edge_qb_rush_epa'],
    'explosive': ['xm_expl_pass', 'xm_expl_rush', 'hinge_expl_pass'],
    'trench': ['xm_line_yds', 'xm_stuff', 'hinge_stuff'],
    'early_down': ['edge_epa_early', 'xm_epa_early'],
    'passing_down': ['edge_epa_pd', 'xm_sr_pd', 'pd_burden'],
    'finishing': ['edge_pts_per_opp_v', 'edge_so_rate_v', 'xm_pts_per_opp'],
    'pace': ['poss_x_strength', 'tempo_edge'],
    'field_pos': ['edge_start_fp_v', 'xm_start_fp'],
    'fourth_down': ['edge_go_oe', 'go_x_sy'],
    'short_yardage': ['edge_sy_conv', 'xm_sy_conv'],
    'play_select': ['resp_corr', 'proe_resp_corr'],
    'drive_model': ['drive_div'],
    'personnel': ['inexp_x_rush', 'qbchg_x_havoc', 'inexp_x_pd_burden'],
    'environment': ['alt_x_tempo', 'tz_x_tempo', 'home_x_sack', 'home_x_tempo'],
    'v2_existing': ['match_mix_edge', 'match_trench_edge', 'match_havoc_edge', 'match_sack_edge',
                    'match_explosive_edge', 'match_early_down_edge', 'match_passing_down_edge',
                    'match_finishing_edge', 'match_field_pos_edge', 'x_pass_h', 'x_pass_a', 'x_rush_h', 'x_rush_a',
                    'x_sack_h', 'x_sack_a'],
}
# narrative -> the single feature that states it (backtest tests each, section 68)
NARRATIVES = {
    'mobile QBs hurt aggressive (pass-rushing) defenses': 'qbr_vs_rush',
    'pressure destroys inexperienced QBs': 'inexp_x_rush',
    'bad OL cannot survive elite havoc (sack-prone offense vs strong rush)': 'hinge_sack',
    'explosive offenses punish weak secondaries': 'hinge_expl_pass',
    'run teams shorten games / slow games help the underdog': 'poss_x_strength',
    'teams struggle against unfamiliar schemes': 'fam_edge',
    'a backup QB against a high-havoc defense': 'qbchg_x_havoc',
    'a low-experience QB with a heavy passing-down burden underperforms': 'inexp_x_pd_burden',
    'offenses that attack the defense\'s weaker phase (pass vs run) gain beyond strength': 'mix_exploit',
    'strong finishing offense vs poor finishing defense': 'xm_pts_per_opp',
    'fast tempo teams wilt at altitude': 'alt_x_tempo',
    'crowd noise hurts sack-prone visiting offenses': 'home_x_sack',
    'the faster team wins the pace mismatch': 'tempo_edge',
}
VARIANCE_FEATURES = ['var_expl', 'var_to', 'var_pace', 'var_qbr', 'var_tempo_gap', 'var_mixed']
PUBLIC_EDGES = {'PASS EDGE': 'match_pass_edge', 'RUSH EDGE': 'match_rush_edge', 'TRENCH EDGE': 'match_trench_edge',
                'HAVOC EDGE': 'match_havoc_edge', 'EXPLOSIVE EDGE': 'match_explosive_edge'}


def _relu(x):
    return np.maximum(x, 0.0)


def attach_style(X):
    """Merge the style ratings (home h_s_*, away a_s_*) and league style means at each game's freeze."""
    parts = []
    for S, g in X.groupby('season'):
        W, Lg = ST.wide(S)
        hw = W.add_prefix('h_')
        aw = W.add_prefix('a_')
        g = g.merge(hw, left_on=['prediction_ts', 'home_id'], right_index=True, how='left')
        g = g.merge(aw, left_on=['prediction_ts', 'away_id'], right_index=True, how='left')
        g = g.merge(Lg, left_on='prediction_ts', right_index=True, how='left')
        parts.append(g)
    return pd.concat(parts).loc[X.index]


class Z:
    """Standardized, signed ratings for one season's rows."""

    def __init__(self, g, v2_scales, st_scales):
        self.g, self.sc_v2, self.sc_st = g, v2_scales, st_scales

    def v2(self, side, unit, m):
        """V2 metric m: side 'h'/'a', unit 'off'/'def'. + = good for the offense."""
        sgn = -1.0 if m in V2_NEG else 1.0
        return sgn * self.g['%s_%s__%s' % (side, m, unit)] / self.sc_v2.get(m, 1.0)

    def s(self, side, unit, m):
        sgn = -1.0 if m in ST_NEG else 1.0
        return sgn * self.g['%s_s_%s__%s' % (side, m, unit)] / self.sc_st.get(m, 1.0)


def _hma(fn):
    """home offense vs away defense  minus  away offense vs home defense."""
    return fn('h', 'a') - fn('a', 'h')


def season_features(g, S):
    """All interaction, variance and confidence features for the rows g of season S."""
    v2s = SN.metric_scales(S)
    sts = ST.metric_scales(S)
    z = Z(g, v2s, sts)
    F = pd.DataFrame(index=g.index)
    plays_half = g['exp_plays_total'] / 2.0

    def xm_v2(m):
        return _hma(lambda o, d: z.v2(o, 'off', m) * z.v2(d, 'def', m))

    def xm_st(m):
        return _hma(lambda o, d: z.s(o, 'off', m) * z.s(d, 'def', m))

    def edge_st(m):
        return _hma(lambda o, d: z.s(o, 'off', m) + z.s(d, 'def', m))

    # ---------------------------------------------------------------- pass / rush
    F['xm_epa_pass'] = xm_v2('epa_pass')
    F['xm_epa_rush'] = xm_v2('epa_rush')

    def mix(o, d):
        p_hat = g['lg_pass_rate__mu'] + g['%s_pass_rate__off' % o] + g['%s_pass_rate__def' % d]
        vul = g['%s_epa_pass__def' % d] - g['%s_epa_rush__def' % d]
        return (p_hat - g['lg_pass_rate__mu']) * vul * plays_half
    F['mix_exploit'] = _hma(mix)
    F['rel_align'] = _hma(lambda o, d: (z.v2(o, 'off', 'epa_pass') - z.v2(o, 'off', 'epa_rush'))
                          * (z.v2(d, 'def', 'epa_pass') - z.v2(d, 'def', 'epa_rush')))
    # ---------------------------------------------------------------- protection
    F['xm_sack'] = xm_v2('sack_rate')
    # narrative quadrant: sack-prone offense (z_off < 0) vs strong rush (z_def < 0) -> bad for that offense
    F['hinge_sack'] = _hma(lambda o, d: -_relu(-z.v2(o, 'off', 'sack_rate')) * _relu(-z.v2(d, 'def', 'sack_rate')))
    F['xm_havoc'] = xm_v2('havoc')
    # ---------------------------------------------------------------- QB mobility
    qbr_bar = g['slg_qb_rush_rate__mu']

    def qbr_rate(o, d):
        return g['slg_qb_rush_rate__mu'] + g['%s_s_qb_rush_rate__off' % o] + g['%s_s_qb_rush_rate__def' % d]
    F['qbr_contain'] = _hma(lambda o, d: (qbr_rate(o, d) - qbr_bar) * g['%s_s_qb_rush_epa__def' % d]
                            / sts.get('qb_rush_epa', 1.0) / max(sts.get('qb_rush_rate', 1.0), 1e-6))
    # mobile QB (z > 0) vs a STRONG rush (-z_def(sack) > 0): + ; the narrative "mobility beats an
    # aggressive rush" predicts a POSITIVE coefficient
    F['qbr_vs_rush'] = _hma(lambda o, d: z.s(o, 'off', 'qb_rush_rate') * (-z.v2(d, 'def', 'sack_rate')))
    F['edge_qb_rush_epa'] = _hma(lambda o, d: (z.s(o, 'off', 'qb_rush_epa') + z.s(d, 'def', 'qb_rush_epa'))
                                 * (qbr_rate(o, d) / qbr_bar.where(qbr_bar > 0, np.nan)))
    # ---------------------------------------------------------------- explosive
    F['xm_expl_pass'] = xm_v2('expl_pass')
    F['xm_expl_rush'] = xm_v2('expl_rush')
    F['hinge_expl_pass'] = _hma(lambda o, d: _relu(z.v2(o, 'off', 'expl_pass')) * _relu(z.v2(d, 'def', 'expl_pass')))
    # ---------------------------------------------------------------- trench
    F['xm_line_yds'] = xm_v2('line_yds')
    F['xm_stuff'] = xm_v2('stuff')
    F['hinge_stuff'] = _hma(lambda o, d: -_relu(-z.v2(o, 'off', 'stuff')) * _relu(-z.v2(d, 'def', 'stuff')))
    # ---------------------------------------------------------------- early / passing down
    F['edge_epa_early'] = edge_st('epa_early')
    F['xm_epa_early'] = xm_st('epa_early')
    F['edge_epa_pd'] = edge_st('epa_pd')
    F['xm_sr_pd'] = xm_v2('sr_pd')

    def burden(o, d):
        # how far behind schedule this offense will be vs this defense (+ = long 3rd downs), times the
        # passing-down matchup
        behind = -(z.s(o, 'off', 'third_dist') + z.s(d, 'def', 'third_dist'))
        return behind * (z.v2(o, 'off', 'sr_pd') + z.v2(d, 'def', 'sr_pd'))
    F['pd_burden'] = _hma(burden)
    # ---------------------------------------------------------------- finishing
    F['edge_pts_per_opp_v'] = g['edge_pts_per_opp']
    F['edge_so_rate_v'] = g['edge_so_rate']
    F['xm_pts_per_opp'] = xm_v2('pts_per_opp')
    # ---------------------------------------------------------------- pace
    drives = g['exp_drives_home'] + g['exp_drives_away']
    lg_drives = 2 * g['lg_drives_pg__mu']
    F['poss_x_strength'] = g['ens_pred'] * (drives - lg_drives) / lg_drives
    # tempo: + = home plays faster (fewer seconds per play) than away
    F['tempo_edge'] = -(g['h_s_tempo__off'] - g['a_s_tempo__off']) / sts.get('tempo', 1.0)
    # ---------------------------------------------------------------- field position
    F['edge_start_fp_v'] = g['edge_start_fp']
    F['xm_start_fp'] = xm_v2('start_fp')
    # ---------------------------------------------------------------- fourth down / short yardage
    F['edge_go_oe'] = (g['h_s_go_oe__off'] - g['a_s_go_oe__off']) / sts.get('go_oe', 1.0)
    F['go_x_sy'] = _hma(lambda o, d: (g['%s_s_go_oe__off' % o] / sts.get('go_oe', 1.0))
                        * (z.s(o, 'off', 'sy_conv') + z.s(d, 'def', 'sy_conv')))
    F['edge_sy_conv'] = edge_st('sy_conv')
    F['xm_sy_conv'] = xm_st('sy_conv')

    # ---------------------------------------------------------------- play selection (opponent response)
    def resp(o, d):
        adv = (g['%s_epa_pass__off' % o] + g['%s_epa_pass__def' % d]) - (g['%s_epa_rush__off' % o] + g['%s_epa_rush__def' % d])
        return g['%s_pass_rate__def' % d] * adv * plays_half
    F['resp_corr'] = _hma(resp)

    def resp_proe(o, d):
        adv = (g['%s_epa_pass__off' % o] + g['%s_epa_pass__def' % d]) - (g['%s_epa_rush__off' % o] + g['%s_epa_rush__def' % d])
        return g['%s_s_proe__def' % d] * adv * plays_half
    F['proe_resp_corr'] = _hma(resp_proe)
    # ---------------------------------------------------------------- drive model
    F['drive_div'] = g['pred_E_drive'] - g['ens_pred']
    # ---------------------------------------------------------------- personnel (QB only)
    inexp = lambda o: -(g['%s_qb_exp_db_log' % o].fillna(0.0) - 5.0) / 1.5
    F['inexp_x_rush'] = _hma(lambda o, d: -_relu(inexp(o)) * _relu(-z.v2(d, 'def', 'sack_rate')))
    F['qbchg_x_havoc'] = _hma(lambda o, d: -g['%s_qb_changed' % o].fillna(0.0) * _relu(-z.v2(d, 'def', 'havoc')))
    # QB x scheme fit (brief 26): an inexperienced QB in an offense that will often face passing downs
    # (long 3rd downs vs this defense); the narrative predicts a POSITIVE coefficient on this (<= 0) term
    F['inexp_x_pd_burden'] = _hma(lambda o, d: -_relu(inexp(o)) * _relu(-(z.s(o, 'off', 'third_dist')
                                                                          + z.s(d, 'def', 'third_dist'))))
    # ---------------------------------------------------------------- environment (no weather: no forecasts)
    away_fast = -z.s('a', 'off', 'tempo')           # + = away offense plays fast
    F['alt_x_tempo'] = g['altitude_kft'] * away_fast if 'altitude_kft' in g else (g['altitude_diff_ft'].fillna(0) / 1000.0) * away_fast
    F['tz_x_tempo'] = np.abs(g['tz_shift'].fillna(0.0)) * away_fast
    F['home_x_sack'] = g['home_field'] * (-z.v2('a', 'off', 'sack_rate'))
    F['home_x_tempo'] = g['home_field'] * away_fast
    # ---------------------------------------------------------------- v2 existing (redundancy control)
    for c in FAMILIES['v2_existing']:
        F[c] = g[c]
    # ---------------------------------------------------------------- variance features (symmetric)
    F['var_expl'] = (z.v2('h', 'off', 'expl') + z.v2('a', 'def', 'expl') + z.v2('a', 'off', 'expl') + z.v2('h', 'def', 'expl'))
    F['var_to'] = (g['h_to_rate__off'] + g['a_to_rate__def'] + g['a_to_rate__off'] + g['h_to_rate__def']) / v2s.get('to_rate', 1.0)
    F['var_pace'] = (drives - lg_drives) / lg_drives
    F['var_qbr'] = (qbr_rate('h', 'a') + qbr_rate('a', 'h') - 2 * qbr_bar) / max(sts.get('qb_rush_rate', 1.0), 1e-6)
    F['var_tempo_gap'] = np.abs(g['h_s_tempo__off'] - g['a_s_tempo__off']) / sts.get('tempo', 1.0)
    pub = np.column_stack([np.sign(g[c].fillna(0.0).values) for c in PUBLIC_EDGES.values()])
    lead = np.sign(g['ens_pred'].fillna(0.0).values)[:, None]
    F['var_mixed'] = ((pub != 0) & (pub != lead)).sum(axis=1).astype(float)
    # ---------------------------------------------------------------- confidence inputs
    n_style = np.minimum(g['h_s_proe__n_obs_off'].fillna(0), g['a_s_proe__n_obs_off'].fillna(0))
    F['conf_style_games'] = n_style
    sd_rel = []
    for m in ('proe', 'tempo', 'qb_rush_rate'):
        for sd_ in ('h', 'a'):
            v = g['%s_s_%s__off_var' % (sd_, m)]
            sd_rel.append(np.sqrt(v.clip(lower=0)) / sts.get(m, 1.0))
    F['conf_style_sd'] = pd.concat(sd_rel, axis=1).mean(axis=1)
    fam_cols = [c for fam, cols in FAMILIES.items() if fam != 'v2_existing' for c in cols if c in F]
    F['conf_completeness'] = F[fam_cols].notna().mean(axis=1)
    F['conf_qb_certain'] = 1.0 - g[['qb_missing_any', 'qb_unsettled_any']].fillna(1.0).max(axis=1)
    F['feature_version'] = MATCHUP_FEATURE_VERSION
    return F


def build(X):
    """Interaction features for every row of X (a V2.1 stage-7 / stage-5 frame with the h_/a_
    ratings, ens_pred and pred_E_drive), aligned to X.index."""
    X = X.copy()
    if {'pred_C_ridge', 'pred_D_gbm'} <= set(X.columns):
        # 2014-2015: V2.1 has no stack yet; its equal-weight C/D mean is the identical formula
        X['ens_pred'] = X.ens_pred.where(X.ens_pred.notna(), X[['pred_C_ridge', 'pred_D_gbm']].mean(axis=1))
    X = attach_style(X)
    parts = [season_features(g, S) for S, g in X.groupby('season')]
    F = pd.concat(parts).loc[X.index]
    keep = [c for c in X.columns if c.startswith(('h_s_', 'a_s_', 'slg_'))]
    return F, X[keep]


def all_feature_cols():
    return [c for cols in FAMILIES.values() for c in cols]
