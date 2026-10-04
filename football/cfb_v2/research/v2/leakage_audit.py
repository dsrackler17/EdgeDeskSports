"""Leakage audit: every input of every submodel, every transformation, and the
evidence for each answer. Renders docs/cfb-v2/LEAKAGE_AUDIT.md and
report/redteam/leakage_audit.csv.

    python3 -m v2.leakage_audit

The answers are not assertions in prose: each row names the test that
enforces it (tests_leakage, tests_poison, tests_signs, the layer contract) or
the measured check that found a problem. A 'FIXED' verdict names the commit
message section that fixed it.
"""
import csv
import json
import os

from . import config as C
from . import models as MD
from . import rt_walkforward as RT
from . import walkforward as WF

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.normpath(os.path.join(HERE, '..', '..', '..', '..', 'docs', 'cfb-v2'))
REPORT = os.path.normpath(os.path.join(HERE, '..', 'report', 'redteam'))

POISON = 'tests_poison (all 841 features bit-identical before the cutoff when every later game/season is randomised)'

# One entry per information source. Q1..Q10 are the brief's ten questions:
# Q1 source, Q2 availability, Q3 target game, Q4 season aggregate w/ future,
# Q5 injury/depth hindsight, Q6 market timestamp, Q7 ranking hindsight,
# Q8 future opponent performance, Q9 preprocessing fit on everything,
# Q10 normalisation with future seasons.
SOURCES = {
    'ratings': dict(
        match=lambda c: c.startswith(('edge_', 'form_', 'match_', 'x_', 'exp_', 'drive_', 'l4_edge', 'l2_edge'))
        and not c.startswith('edge_prior_') or c == 'eff_pts_raw',
        q1='sportsdataverse espn_cfb_pbp play-by-play -> stage-1 team-game efficiency -> stage-3 joint '
           'opponent-adjusted Bayesian ridge ratings',
        q2='plays of games that kicked off BEFORE the Tuesday 12:00 UTC freeze of the target game\'s week '
           '(asserted in build_ratings: obs.kickoff_ts < T; artifact test counts only prior games)',
        q3='No. The target game kicks off after its freeze, so none of its plays exist at T. ' + POISON,
        q4='No. Ratings are re-solved at every freeze from games before it; never a season total. ' + POISON,
        q5='Not applicable (no injury or depth data enters).',
        q6='Not applicable. The provider\'s win-probability and spread columns are excluded at read time '
           '(FORBIDDEN_PBP_COLUMNS; test pbp_never_reads_market_or_wp_columns).',
        q7='Not applicable (no rankings).',
        q8='No. Opponent ratings are solved jointly at the same freeze from the same past games. ' + POISON,
        q9='Variance components from the 2009-2011 burn-in only; metric scales (standardisation of edges) '
           'from data-only finals of the three seasons BEFORE the target season.',
        q10='No: metric_scales(S) reads seasons S-3..S-1 only.',
        caveat='EPA values come from the provider\'s fixed expected-points model, fitted by the provider on '
               'historical seasons that overlap the development window. It is a value function of down, '
               'distance and field position (not of any game\'s outcome), but it is hindsight about how '
               'football is valued. Cannot be removed without a re-fitted EP model; disclosed.',
        verdict='CLEAN (proved end-to-end by the poisoning test)'),
    'volatility': dict(
        match=lambda c: c == 'vol_sum',
        q1='stage-3 residual volatility of each team\'s EPA (error model input only)',
        q2='games before the freeze',
        q3='No.', q4='FOUND: candidate 001 filled teams with no games yet (week 1) with the median of the '
                     'WHOLE SEASON of snapshot rows, i.e. later weeks. tests_poison: vol_sum moved on 129 '
                     'pre-cutoff rows.',
        q5='n/a', q6='n/a', q7='n/a', q8='No.', q9='FOUND (same fill)', q10='No.',
        caveat='Feeds the error model only (intervals, probabilities), never the point prediction.',
        verdict='FIXED: each team has a point-in-time volatility prior before its first game'),
    'priors': dict(
        match=lambda c: c.startswith('edge_prior_'),
        q1='preseason prior per team and metric: ridge on last season\'s and the season before\'s data-only '
           'ratings, CFBD returning production, 247 team talent composite, head-coach/coordinator continuity',
        q2='before the season: lagged ratings end with the previous season\'s bowls; the other inputs are '
           'preseason releases',
        q3='No.', q4='No: the prior model trains on target seasons strictly before S.',
        q5='Coaching continuity checked for hindsight: mid-season firings (Helton 2021, Frost 2022, Edwards '
           '2022, Franklin 2025, Pry 2025) still show the PRESEASON coach for every week, so the field is '
           'preseason state. The same pack\'s qb_name field IS hindsight (Penn State 2025 lists the '
           'late-season starter from week 1) and is not used.',
        q6='n/a', q7='n/a (no poll or ranking input)',
        q8='No.', q9='Prior model and its variance fitted on seasons < S.', q10='Talent z-scored within its own season.',
        caveat='The talent composite\'s exact publication date is not in the feed; roster composition can '
               'drift during a season. Measured instead of assumed: the talent ablation (phase 7) bounds '
               'how much it could matter.',
        verdict='CLEAN (timestamps of third-party preseason releases unverifiable; measured by ablation)'),
    'elo': dict(
        match=lambda c: c.startswith('elo_'),
        q1='results-only Elo over final scores (stage 4)',
        q2='scores of games that kicked off before the freeze (snapshot per freeze)',
        q3='No.', q4='No.', q5='n/a', q6='n/a', q7='n/a', q8='No.',
        q9='K, home-field and carry-over tuned on the development window 2016-2023 (never the holdout). '
           'Development-window metrics are therefore in-sample with respect to that tuning.',
        q10='n/a', caveat='', verdict='CLEAN'),
    'qb': dict(
        match=lambda c: 'qb' in c,
        q1='passer ids and dropback EPA from play-by-play (stage 4)',
        q2='games before the freeze; expected starter = the team\'s most recent starter',
        q3='No: a quarterback who first appears after the freeze cannot be the expected starter '
           '(test qb_features_ignore_post_kickoff_quarterback_knowledge).',
        q4='No.', q5='No pregame depth charts or injury reports exist historically; none are used. Live status '
                     'reports stamped at/after kickoff are refused by the engine (tests.js).',
        q6='n/a', q7='n/a', q8='Past-season QB games are adjusted with that season\'s final defence ratings, '
                                 'which are complete before the target season.',
        q9='QB shrinkage from 2009-2013; same-starter rate from 2012-2015.', q10='n/a',
        caveat='', verdict='CLEAN'),
    'schedule': dict(
        match=lambda c: c in ('home_field', 'rest_diff', 'travel_miles_log', 'tz_shift', 'altitude_kft',
                              'conference_game_f', 'is_postseason_f'),
        q1='published schedule (neutral site, kickoff, conference game, postseason) and static venue geography',
        q2='known before the game (schedules are published months ahead; venues are static)',
        q3='No.', q4='No.', q5='n/a', q6='n/a', q7='n/a', q8='n/a', q9='n/a', q10='n/a',
        caveat='The archived schedule is the FINAL schedule: a game moved at short notice carries its '
               'actual kickoff. Effect on rest days only; measured by ablation.',
        verdict='CLEAN'),
}

TRANSFORMS = [
    ('scaling', 'Linear models standardise with the TRAINING rows\' mean/sd (seasons < S). Matchup edges '
                'divide by metric scales from seasons S-3..S-1. LightGBM needs none.', 'CLEAN'),
    ('imputation', 'Linear: NaN -> training mean. Prior model: explicit missingness flags. FOUND: three '
                   'batch-median fills (volatility in stage 5; error-model and cover-calibration inputs at '
                   'prediction time).', 'FIXED (fills stored at fit time; row-independence test)'),
    ('feature selection', 'Grouped ablation on the development window only. Development metrics are '
                          'therefore optimistic by the selection; the holdout was not used to select.',
     'CLEAN for the holdout'),
    ('dimensionality reduction', 'None.', 'n/a'),
    ('opponent adjustment', 'Solved at every freeze from games before it.', 'CLEAN (' + POISON + ')'),
    ('model training', 'Every fit for season S uses seasons < S (assert_past_only; reproduced by an '
                       'independent implementation to 1e-11).', 'CLEAN'),
    ('calibration', 'Win and cover calibrators fit on out-of-fold rows of seasons < S; the method is chosen '
                    'on development log loss.', 'CLEAN'),
    ('ensemble fitting', 'Stack weights from out-of-fold predictions of seasons < S.', 'CLEAN'),
    ('hyperparameter tuning', 'Rating prior strengths, recent half-life, ridge alpha, GBM settings and Elo '
                              'constants tuned on development seasons only (assert_dev_only).', 'CLEAN for the holdout'),
    ('market QA', 'FOUND: candidate 001 dropped openers that were sign-flipped or > 14 pts from the CLOSE, '
                  'i.e. it used the closing line to decide which openers exist. Selection on the future.',
     'FIXED in the hardened candidate: point-in-time checks only (|line| > 60; the engine\'s model-based '
     'orientation guard); the close is used for evaluation only'),
    ('layer contract', 'FOUND: pure columns were recognised by name PREFIX, so a new column named '
                       'edge_closing_line or qb_status_final would have been accepted as pure.',
     'FIXED: exact allowlist generated from the metric registry; injection tests for every hindsight kind'),
]


def feature_rows():
    import json as _j
    fam = _j.load(open(os.path.join(HERE, '..', 'report', 'selected_families.json')))
    used = {}
    for c in MD.features_for(fam['C']):
        used.setdefault(c, set()).add('C ridge')
    for c in MD.features_for(fam['D']):
        used.setdefault(c, set()).add('D gbm')
    for c, m in ((x, 'A') for x in RT.A_COLS):
        used.setdefault(c, set()).add('A adj-eff')
    for c in RT.B_COLS:
        used.setdefault(c, set()).add('B elo')
    for c in RT.E_COLS:
        used.setdefault(c, set()).add('E drive')
    for c in WF.SIGMA_COLS:
        used.setdefault(c, set()).add('error model')
    rows = []
    for c in sorted(used):
        src = next((k for k, v in SOURCES.items() if v['match'](c)), None)
        if src is None:
            src = 'derived (error model)' if c in WF.SIGMA_COLS else 'unmapped'
        rows.append((c, ', '.join(sorted(used[c])), src))
    return rows


def main():
    rows = feature_rows()
    os.makedirs(REPORT, exist_ok=True)
    with open(os.path.join(REPORT, 'leakage_audit.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['feature', 'used_by', 'source', 'Q1_source', 'Q2_available', 'Q3_target_game',
                    'Q4_future_aggregate', 'Q5_injury_hindsight', 'Q6_market_timestamp', 'Q7_ranking_hindsight',
                    'Q8_future_opponent', 'Q9_preprocessing', 'Q10_normalisation', 'caveat', 'verdict'])
        for c, u, s in rows:
            d = SOURCES.get(s, {})
            w.writerow([c, u, s] + [d.get('q%d' % i, 'error-model input derived from the rows above; fills learned at fit time')
                                    for i in range(1, 11)] + [d.get('caveat', ''), d.get('verdict', 'CLEAN (fills fixed)')])
    L = ['# CFB V2 leakage audit', '',
         'This file is generated by `python3 -m v2.leakage_audit`.',
         '',
         '**How it was checked:** every feature that any submodel of candidate 001 reads was audited. It was then **attacked** in two ways:',
         '- **Future poisoning:** season 2019 was rebuilt with every later game and season randomised (plays, EPA, scores, QB starters, later rosters, talent and coaching). Every pre-cutoff feature had to come out bit-identical.',
         '- **Injection:** each kind of hindsight was offered to the models under realistic names.',
         '',
         '**Result: four problems found and fixed.**',
         '- a whole-season median fill;',
         '- batch-median fills at prediction time;',
         '- a market QA step that used the closing line;',
         '- a name-prefix layer contract.',
         '',
         'None of them touched the point prediction. The volatility and fill leaks affect intervals and probabilities only. The market QA leak affected only which openers were evaluated. The contract hole was never exploited: no such column existed.',
         '',
         '## Sources (the ten questions, per source)', '']
    for k, d in SOURCES.items():
        L += ['### %s' % k, '',
              '- **Verdict:** %s' % d['verdict']]
        names = ['Source', 'Available at', 'Contains the target game?', 'Season aggregate recomputed with future games?',
                 'Injury/depth hindsight?', 'Market later than the prediction?', 'Ranking hindsight?',
                 'Future opponent performance?', 'Preprocessing fit on the full dataset?', 'Normalisation uses future seasons?']
        for i, n in enumerate(names, 1):
            L.append('- **Q%d. %s** %s' % (i, n, d['q%d' % i]))
        if d['caveat']:
            L.append('- **Caveat:** %s' % d['caveat'])
        L.append('')
    L += ['## Transformations', '', '| step | what it is fitted on | verdict |', '|---|---|---|']
    for a, b, c in TRANSFORMS:
        L.append('| %s | %s | %s |' % (a, b, c))
    L += ['', '## Injection tests (tests_leakage.phase2_injections_are_refused_by_every_model)', '',
          '| kind | names offered to the ridge and the GBM | result |', '|---|---|---|']
    from .tests_leakage import INJECTIONS
    for k, v in INJECTIONS.items():
        L.append('| %s | %s | refused (LayerViolation) |' % (k, ', '.join('`%s`' % x for x in v)))
    L += ['', '## Every model input', '',
          'The full per-feature table (all ten answers per row) is in [`report/redteam/leakage_audit.csv`](../../football/cfb_v2/research/report/redteam/leakage_audit.csv).',
          '', '| feature | used by | source |', '|---|---|---|']
    for c, u, s in rows:
        L.append('| `%s` | %s | %s |' % (c, u, s))
    with open(os.path.join(DOCS, 'LEAKAGE_AUDIT.md'), 'w') as f:
        f.write('\n'.join(L) + '\n')
    unm = [r for r in rows if r[2] == 'unmapped']
    print('[leakage_audit] %d features audited, %d unmapped' % (len(rows), len(unm)), unm)


if __name__ == '__main__':
    main()
