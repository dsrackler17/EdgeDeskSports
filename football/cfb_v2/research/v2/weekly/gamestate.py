"""Play context classes (rule `cfb_gamestate_v1`).

`classify(plays)` labels every play COMPETITIVE | LOW_LEVERAGE | GARBAGE | CLOCK_KILL |
DESPERATION from the quarter, the clock, the score margin at the start of the play
(from the possession team's side), possession and the play type only. It never reads
win probability (the provider's WP model reads the pregame spread).

GARBAGE is V2's production rule, reproduced exactly: `common.garbage_mask` on
`period` (NaN -> 1) and `start.pos_score_diff` (NaN -> 0), the fill plays.build_season
uses. It is the only class with a production weight (0); every other class is
descriptive and weighs 1, as in V2. Definitions and evidence:
docs/cfb-weekly/METHODS_GAMES.md section 2.
"""
import numpy as np
import pandas as pd

from .. import common
from .. import config as C

RULE_VERSION = 'cfb_gamestate_v1'
CLASSES = ('COMPETITIVE', 'LOW_LEVERAGE', 'GARBAGE', 'CLOCK_KILL', 'DESPERATION')
PRODUCTION_WEIGHT = {'COMPETITIVE': 1.0, 'LOW_LEVERAGE': 1.0, 'GARBAGE': C.GARBAGE_WEIGHT,
                     'CLOCK_KILL': 1.0, 'DESPERATION': 1.0}

LOW_LEVERAGE_MARGIN = 17        # a three-score game: |margin| >= 17 (two TDs + two 2-pt = 16)
CLOCK_KILL_SECS = 240           # Q4, <= 4:00 left: a leading offense's runs are clock plays
DESPERATION_SECS = 120          # Q4, <= 2:00 left and trailing by any amount
DESPERATION_LONG_SECS = 300     # Q4, <= 5:00 left and trailing by more than one score
DESPERATION_LONG_DEFICIT = 9    # "more than one score" = trailing by 9+

INPUT_COLUMNS = ('period', 'start.TimeSecsRem', 'start.pos_score_diff', 'pos_team_id',
                 'rush', 'pass', 'kneel_down')


def _flag(df, col):
    if col not in df:
        return np.zeros(len(df), dtype=bool)
    return df[col].fillna(False).astype(bool).to_numpy()


def classify(plays):
    """Series of classes, index aligned with `plays`. Precedence: GARBAGE >
    CLOCK_KILL > DESPERATION > LOW_LEVERAGE > COMPETITIVE."""
    n = len(plays)
    per_raw = pd.to_numeric(plays['period'], errors='coerce') if 'period' in plays else pd.Series(np.nan, index=plays.index)
    diff_raw = pd.to_numeric(plays['start.pos_score_diff'], errors='coerce')
    # V2's exact inputs for the production garbage rule
    garbage = common.garbage_mask(per_raw.fillna(1).astype(int).to_numpy(), diff_raw.fillna(0).to_numpy())
    per = per_raw.to_numpy(dtype=float)
    diff = diff_raw.to_numpy(dtype=float)
    secs = pd.to_numeric(plays['start.TimeSecsRem'], errors='coerce').to_numpy(dtype=float) \
        if 'start.TimeSecsRem' in plays else np.full(n, np.nan)
    has_pos = pd.to_numeric(plays['pos_team_id'], errors='coerce').notna().to_numpy() \
        if 'pos_team_id' in plays else np.ones(n, dtype=bool)
    rush, pas, kneel = _flag(plays, 'rush'), _flag(plays, 'pass'), _flag(plays, 'kneel_down')
    q4 = per == 4
    known = has_pos & ~np.isnan(diff)
    with np.errstate(invalid='ignore'):
        clock_kill = kneel | (q4 & known & (secs <= CLOCK_KILL_SECS) & (diff >= 1) & rush & ~pas)
        desperation = q4 & known & (diff <= -1) & (
            (secs <= DESPERATION_SECS) |
            ((secs <= DESPERATION_LONG_SECS) & (diff <= -DESPERATION_LONG_DEFICIT)))
        low_lev = (per >= 1) & (per <= 4) & (np.abs(diff) >= LOW_LEVERAGE_MARGIN)
    out = np.full(n, 'COMPETITIVE', dtype=object)
    out[low_lev] = 'LOW_LEVERAGE'
    out[desperation] = 'DESPERATION'
    out[clock_kill] = 'CLOCK_KILL'
    out[garbage] = 'GARBAGE'
    return pd.Series(out, index=plays.index, name='gamestate')


def production_weight(classes):
    return classes.map(PRODUCTION_WEIGHT).astype(float)


# ------------------------------------------------------------ evidence (docs)
def class_report(seasons):
    """Class shares of scrimmage plays by season and EPA / success by class (pooled),
    the evidence behind the definitions (METHODS_GAMES.md 2.3)."""
    from ..plays import load_pbp
    shares, pooled = {}, []
    for S in seasons:
        d = load_pbp(S)
        extra = pd.read_parquet(common.data_path('pbp', 'play_by_play_%d.parquet' % S),
                                columns=['start.TimeSecsRem', 'kneel_down'])
        d = pd.concat([d.reset_index(drop=True), extra.reset_index(drop=True)], axis=1)
        d = d[d.pos_team_id.notna() & d.def_pos_team_id.notna()]
        d = d[~d.text_dupe.fillna(False).astype(bool)]
        d['cls'] = classify(d).values
        scrim = (d.rush.fillna(False).astype(bool) | d['pass'].fillna(False).astype(bool)) & \
            ~d.penalty_no_play.fillna(False).astype(bool) & d.EPA.notna()
        s = d[scrim]
        shares[S] = {k: round(float((s.cls == k).mean()), 4) for k in CLASSES}
        shares[S]['n'] = int(len(s))
        pooled.append(s[['cls', 'EPA', 'EPA_success', 'pass', 'start.pos_score_diff']].assign(season=S))
    P = pd.concat(pooled, ignore_index=True)
    P['succ'] = P.EPA_success.fillna(False).astype(bool).astype(float)
    P['is_pass'] = P['pass'].fillna(False).astype(bool).astype(float)
    sd = P['start.pos_score_diff']
    P['side'] = np.where(sd > 0, 'leading', np.where(sd < 0, 'trailing', 'tied'))
    agg = dict(n=('EPA', 'size'), epa=('EPA', 'mean'), success=('succ', 'mean'), pass_rate=('is_pass', 'mean'))

    def tidy(frame):
        return {c: (int(v) if c == 'n' else round(float(v), 4)) for c, v in frame.items()}
    by = P.groupby('cls').agg(**agg)
    by_side = P.groupby(['cls', 'side']).agg(**agg)
    return (shares, {k: tidy(by.loc[k]) for k in CLASSES if k in by.index},
            {'%s/%s' % k: tidy(by_side.loc[k]) for k in by_side.index})
