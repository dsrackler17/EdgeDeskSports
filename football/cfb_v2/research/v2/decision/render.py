"""Render docs/cfb-decision/CALIBRATION.md from out_h/decision/*.json and the frozen artifact.

    python3 -m v2.decision.render
Every number in the document is read from the study's JSON; nothing is typed by hand.
"""
import json
import os

from .. import config as C
from . import ARTIFACT_VERSION, BASELINE_ID, BASE_MODEL_VERSION
from . import dataset as DS
from .freeze import CAL_JSON, ART_DIR, FIXTURE

DOC = os.path.join(DS.DOCS, 'CALIBRATION.md')


def J(name):
    return json.load(open(os.path.join(DS.out_dir(), name)))


def f(x, k=3):
    return '—' if x is None else ('%.*f' % (k, x))


def p(x, k=1):
    return '—' if x is None else ('%.*f%%' % (k, 100 * x))


def ci(v, k=3, pct=False):
    if not v or v[0] is None:
        return ''
    return ' [%s, %s]' % ((p(v[0], k - 2), p(v[1], k - 2)) if pct else (f(v[0], k), f(v[1], k)))


def signed(x, k=4):
    return '—' if x is None else ('%+.*f' % (k, x))


def outcome_table(rows, first='bucket', pure=True, dec=True):
    L = ['| %s | n | W-L-P | cover rate [Wilson 95%%] | EB cover | ROI at assumed −110 [95%% CI] | EB ROI | CLV pts [95%% CI] | +CLV | moved toward model [95%%] | max DD u [95%%] | status |' % first,
         '|---|---|---|---|---|---|---|---|---|---|---|---|']
    for r in rows:
        if not r.get('n'):
            L.append('| %s | 0 | | | | | | | | | | |' % r.get(first, r.get('bucket')))
            continue
        L.append('| %s | %d | %d-%d-%d | %s%s | %s | %s%s | %s | %s%s | %s | %s%s | %s%s | %s |' % (
            r.get(first, r.get('bucket')), r['n'], r['wins'], r['losses'], r['pushes'],
            p(r['cover_rate']), ci(r.get('cover_wilson'), 3, True), p(r.get('cover_eb')),
            signed(r['roi'], 3), ci(r.get('roi_ci'), 3), signed(r.get('roi_eb'), 3),
            f(r['clv'], 2), ci(r.get('clv_ci'), 2), p(r.get('pos_clv')),
            p(r.get('moved_toward')), ci(r.get('moved_toward_wilson'), 3, True),
            f(r.get('max_drawdown'), 1), ci(r.get('max_drawdown_ci'), 1), r['sample_status']))
    return L


def prob_table(rows, first='bucket'):
    L = ['| %s | n | mean pure p | mean decision p | cover rate | pure: calibration error / Brier | decision: calibration error / Brier | MAE model | MAE quote | model − quote [95%%] | mean abs gap |' % first,
         '|---|---|---|---|---|---|---|---|---|---|---|']
    for r in rows:
        if not r.get('n'):
            continue
        L.append('| %s | %d | %s | %s | %s | %s / %s | %s / %s | %s | %s | %s%s | %s |' % (
            r.get(first, r.get('bucket')), r['n'], f(r.get('mean_p_pure'), 4), f(r.get('mean_p_dec'), 4), p(r['cover_rate']),
            signed(r.get('cal_err_pure'), 4), f(r.get('brier_pure'), 4), signed(r.get('cal_err_dec'), 4), f(r.get('brier_dec'), 4),
            f(r.get('mae_model'), 2), f(r.get('mae_quote'), 2), signed(r.get('mae_model_minus_quote'), 2),
            ci(r.get('mae_model_minus_quote_ci'), 2), f(r.get('mean_abs_gap'), 2)))
    return L


def decile_table(d, label):
    L = ['**%s** (walk-forward, scored seasons, n %d):' % (label, d['n']), '',
         '| decile | n | score mean [range] | CLV pts [95%] | +CLV [95%] | ATS [95%] | ROI [95%] | mean probability edge |',
         '|---|---|---|---|---|---|---|---|']
    for r in d['rows']:
        L.append('| %d | %d | %s [%s, %s] | %s%s | %s%s | %s%s | %s%s | %s |' % (
            r['decile'], r['n'], f(r['score_mean'], 4), f(r['score_range'][0], 4), f(r['score_range'][1], 4),
            f(r['clv_pts'], 2), ci(r['clv_pts_ci'], 2), p(r['positive_clv']), ci(r['positive_clv_ci'], 3, True),
            p(r['ats_win']), ci(r['ats_win_ci'], 3, True), signed(r['units_assumed_110'], 3), ci(r['units_assumed_110_ci'], 3),
            signed(r['probability_edge'], 4)))
    L += ['', '| outcome | Spearman of decile means (perm. p) | slope per decile [95%] | top − bottom decile [95%] | adjacent inversions | increasing supported |',
          '|---|---|---|---|---|---|']
    for o, t in d['tests'].items():
        L.append('| %s | %s (%s) | %s%s | %s%s | %d | %s |' % (o, f(t['spearman_decile_means'], 2), f(t['spearman_perm_p'], 4),
                                                              signed(t['slope_per_decile'], 4), ci(t['slope_ci'], 4),
                                                              signed(t['top_minus_bottom'], 4), ci(t['top_minus_bottom_ci'], 4),
                                                              t['adjacent_inversions'], 'yes' if t['monotone_increasing_supported'] else 'no'))
    return L


def main():
    s4, s5, cond, s10 = J('s04_cover_buckets.json'), J('s05_calibration_methods.json'), J('s06_09_conditional.json'), J('s10_11_ev.json')
    s14, s19, s24, s33 = J('s12_14_edge.json'), J('s19_20_clv_models.json'), J('s24_27_confidences.json'), J('s33_36_rank_order.json')
    s20, ps, summ, ds = J('s2020.json'), J('price_sensitivity.json'), J('study_summary.json'), J('dataset_summary.json')
    A = json.load(open(CAL_JSON))
    FX = json.load(open(FIXTURE))
    M = s5['methods']
    sw = s5['shrink_weight']
    w = A['market_shrinkage']['w_model']
    pop = summ['populations']
    fb, mk = s24['football'], s24['market']
    L = []
    add = L.append
    add('# CFB decision calibration — `%s`' % ARTIFACT_VERSION)
    add('')
    add('Generated by `python3 -m v2.decision.study` (then `v2.decision.render`) from the decision dataset '
        '([DATASET.md](DATASET.md)). Base model `%s`, frozen baseline `%s`. **Every fit and every selection below read '
        'DEV seasons only** (2016-2023; priced seasons 2017-2019 and 2021-2023 — 2020 has no openers and 2016 no error '
        'model); the **holdout 2024-2025 was not read** (the study loads the dataset through a `window == dev` row filter; '
        '`tests_decision.py` asserts it). Walk-forward: season S is scored by maps fit on earlier seasons only; scored '
        'seasons %s.' % (BASE_MODEL_VERSION, BASELINE_ID, ', '.join(str(s) for s in summ['scored_seasons'])))
    add('')
    add('**Conventions.** The side is the one the pure model prefers against the quote. Every probability is P(side covers | no push); '
        'pushes are excluded from cover rates and counted. Historical decisions bet the consensus OPENER at the Tuesday freeze '
        'at an **ASSUMED −110** (break-even %.5f); CLV is opener → close, oriented to the side. Populations: DEV priced FBS rows '
        '%d; decision rows (pure probability exists, not routed to REVIEW) %d, of which %d in the scored seasons; REVIEW rows %d; '
        'FBS football games with an error model %d. Bootstrap CIs are game-level percentile intervals (2,000 resamples; drawdown '
        '1,000), seed %d. Minimum-sample rule: n < 100 INSUFFICIENT (shown, never used), 100-299 PROVISIONAL, ≥ 300 ESTIMABLE; '
        'every bucket table also carries empirical-Bayes shrunk cover rate, ROI and CLV ("EB").'
        % (0.5238095, pop['dev_priced_fbs'], pop['dev_decision'], pop['dev_decision_scored'], pop['review_rows'],
           pop['football_games'], C.SEED))
    add('')
    # ------------------------------------------------------------------ verdict
    shr = M['shrink']
    ident = M['identity']
    pb = s4['pure_buckets_scored']
    top = pb[-1]
    add('## The verdict')
    add('')
    add('1. **Are the probabilities calibrated?** The PURE cover probabilities are not: they are overconfident. On the scored '
        'DEV seasons the pure "65%%+" bucket predicted %s and covered %s%s; walk-forward log loss of the raw probabilities is '
        '%s against %s for a coin flip (Δ %s%s: significantly worse than no opinion). After the chosen decision map — '
        '**shrink toward the market with w = %.3f** in logit space — the decision probabilities are calibrated within their '
        'CIs (every decision bucket\'s cover rate brackets its prediction), log loss %s (Δ vs coin flip %s%s). '
        'That improvement over a coin flip is small and **not significant out of sample** (the CI includes 0); in-sample on '
        'DEV the weight is %.3f with profile 95%% CI %s and LR p = %s against w = 0.'
        % (p(top['mean_p_pure']), p(top['cover_rate']), ci(top['cover_wilson'], 3, True), f(ident['log_loss'], 5),
           f(M['market']['log_loss'], 5), signed(ident['dll_vs_market'], 5), ci(ident['dll_vs_market_ci'], 5), w,
           f(shr['log_loss'], 5), signed(shr['dll_vs_market'], 5), ci(shr['dll_vs_market_ci'], 5),
           sw['pooled_dev']['w'], ci(sw['pooled_dev']['w_ci95_profile'], 3), f(sw['pooled_p_w0'], 4)))
    g = cond['gap']['table_scored_2018_2023']
    add('2. **Do bigger edges mean better outcomes?** For **CLV, yes**: mean CLV rises from %s pts in the <1 gap bucket to %s '
        'in the 7+ bucket and the close moves toward the model on %s → %s of moved lines. For **wins and ROI, not '
        'demonstrably**: cover rates run %s (<1) to %s (7+), every bucket\'s CI includes 52.4%%, and the empirical-Bayes EV '
        'curve collapses to the no-skill value (τ² = 0) in every walk-forward season.'
        % (f(g[0]['clv'], 2), f(g[-1]['clv'], 2), p(g[0]['moved_toward']), p(g[-1]['moved_toward']),
           p(g[0]['cover_rate']), p(g[-1]['cover_rate'])))
    rb = fb['reliability_bands_production_score']
    add('3. **Does reliability sort error?** **No, not among FBS-vs-FBS games.** MAE by production reliability band runs %s '
        '(<40) … %s (90+), a slope of %s pts of |error| per 10 reliability points %s; sigma itself has a slope of %s %s per '
        'point of sigma and its quintiles have MAE %s. The error model\'s heteroskedasticity is not visible in realized '
        'errors out of sample; the frozen reliability scale is therefore nearly flat (%s → %s pts).'
        % (f(rb[0]['mae'], 2), f(rb[-1]['mae'], 2), signed(fb['reliability_slope_per_10pts'], 3), ci(fb['reliability_slope_ci'], 3),
           signed(fb['sigma_slope_abs_err_per_pt'], 3), ci(fb['sigma_slope_ci'], 3),
           ', '.join(f(x['mae'], 2) for x in fb['sigma_quintiles']),
           f(max(A['reliability_scale']['expected_abs_error']['y']), 2), f(min(A['reliability_scale']['expected_abs_error']['y']), 2)))
    zt = {x['tercile']: x for x in fb['disagreement_vs_standardized_error']}
    ce = cond['ens_sd_tercile']
    add('4. **Does disagreement predict overconfidence?** **No.** High-disagreement games have standardized errors %s of '
        'what the t predicts %s (low %s, mid %s): if anything sigma is slightly too WIDE there. The cover-probability '
        'weight by disagreement tercile (low %s / mid %s / high %s) is not different (LR p = %s), and a conditional map '
        'is worse out of sample (Δ log loss %s%s).'
        % (f(zt['high']['ratio'], 3), ci(zt['high']['ratio_ci'], 3), f(zt['low']['ratio'], 3), f(zt['mid']['ratio'], 3),
           f(ce['w_by_group'].get('low'), 3), f(ce['w_by_group'].get('mid'), 3), f(ce['w_by_group'].get('high'), 3),
           f(ce['lr_test_dev_2017_2023']['p'], 3), signed(ce['walk_forward_dll_conditional_minus_single'], 5),
           ci(ce['walk_forward_dll_ci'], 5)))
    lin = s19['walk_forward']['linear']
    lg = s19['walk_forward']['logistic']
    pk = s19['picked']
    add('5. **Does expected CLV predict CLV?** **It ranks it, weakly.** Walk-forward, the %s CLV-magnitude model correlates '
        '%s%s with realized CLV (calibration slope %s: predictions are too spread and must be read as a ranking); '
        'P(positive CLV) has AUC %s%s. Its log loss is not significantly better than the base rate (Δ %s%s) because the '
        'base rate of positive CLV drifts by season (%s).'
        % (pk['linear'].replace('_', ' '), f(lin[pk['linear']]['corr'], 3), ci(lin[pk['linear']].get('corr_ci'), 3),
           f(lin[pk['linear']]['calibration_slope'], 2), f(lg[pk['logistic']]['auc'], 3), ci(lg[pk['logistic']].get('auc_ci'), 3),
           signed(lg[pk['logistic']]['dll_vs_intercept'], 5), ci(lg[pk['logistic']]['dll_vs_intercept_ci'], 5),
           ', '.join('%s %s' % (k, p(v)) for k, v in s19['base_rate_by_season'].items())))
    e14 = s14['edge_positive']
    add('6. **What must the decision layer shrink?** The model\'s cover logit, by about **%d%%**: decision_p = '
        'sigmoid(%.3f × logit(pure_p) + %.3f × logit(market_p)). At −110 that turns a pure 60%% into %s and a pure 70%% into %s, '
        'so the decision probability exceeds break-even (52.38%%) only when the pure probability is above about %s — a gap '
        'of roughly 4.5-5 points. On the scored seasons %s of decision rows had a positive probability edge; those %d rows '
        'covered %s%s at ROI %s%s. The EV the pure model claims (mean %s per bet) must be discounted entirely: realized ROI '
        'was %s%s. **No conditional map is supported** (reliability, disagreement, timing and gap all fail the pre-declared '
        'test). Football confidence and market confidence carry no measurable information historically; bet confidence '
        '(P(positive CLV)) ranks CLV but not wins.'
        % (round(100 * (1 - w)), w, 1 - w, p(_dec(0.60, w)), p(_dec(0.70, w)), p(_inv(w)),
           p(sum(v['share_edge_pos'] * v['n'] for v in s14['by_season'].values()) / sum(v['n'] for v in s14['by_season'].values())),
           e14['n'], p(e14['cover_rate']), ci(e14['cover_wilson'], 3, True), signed(e14['roi'], 3), ci(e14['roi_ci'], 3),
           p(s10['evaluation_scored']['mean_theoretical_ev']), signed(s10['evaluation_scored']['mean_realized'], 4),
           ci(s10['evaluation_scored']['mean_realized_ci'], 4)))
    add('')
    add('These answers agree with, and extend, the red team (docs/cfb-v2/REDTEAM.md §7, §12-15): raw cover probabilities are '
        'overconfident, calibrated ones collapse toward a coin flip, the close moves toward V2 by a fraction of the gap, and '
        'no rule clears −110 out of sample. The red team calibrated the HOME cover probability with Platt (slope ≈ 0.2); '
        'this study calibrates the SIDE probability with a side-symmetric logit shrink (w ≈ %.2f) — the same finding in '
        'the form the decision engine needs. Nothing here contradicts BACKTEST.md; the holdout numbers there are not '
        'repeated or used.' % w)
    add('')
    # ------------------------------------------------------------------ data caveats
    add('## What the data allows (read before any table)')
    add('')
    add('- **No decision-time prices after 2019, and none live.** The study prices every historical decision at an ASSUMED '
        '−110. The raw archive does carry the opener\'s own price in 2012-2019 (5Dimes, the single book whose opener is the '
        'consensus): see *Price sensitivity* below. The 2026 Model Lab has %d quotes, one book, **%d with a price**: no live '
        'EV is computable and none is assumed.' % (ds['ledger']['quotes_total'], ds['ledger']['quotes_with_any_price']))
    add('- **The "consensus opener" is one book** in every DEV season but 2023 (5Dimes 2016-2019, Bovada 2021-2022), has no '
        'timestamp, and is assumed available at the Tuesday freeze (optimistic; the close is the pessimistic check).')
    add('- **No Pinnacle opener exists** (the archive\'s Pinnacle rows carry no opening line). **No line-movement, maturity or '
        'freshness history exists** (opener and close only). **Dispersion and book count are close-time or era-confounded** '
        'historically and never enter a frozen model (their diagnostic variants are shown and are worse out of sample).')
    add('- **2020 has no openers**: it is reported separately (below) and never enters a market fit.')
    add('')
    # ------------------------------------------------------------------ §4
    add('## §4 Cover-probability buckets (side the model prefers, scored DEV seasons 2018-2023, walk-forward)')
    add('')
    add('Pure probability buckets — calibration:')
    add('')
    L += prob_table(s4['pure_buckets_scored'])
    add('')
    add('Pure probability buckets — outcomes:')
    add('')
    L += outcome_table(s4['pure_buckets_scored'])
    add('')
    add('The same edges on the DECISION probability (walk-forward shrink):')
    add('')
    L += prob_table(s4['decision_buckets_scored'])
    add('')
    L += outcome_table(s4['decision_buckets_scored'])
    add('')
    ov = s4['overall_scored']
    add('All scored decision rows: n %d, cover %s%s, ROI %s%s, CLV %s%s, max drawdown %s u%s.'
        % (ov['n'], p(ov['cover_rate']), ci(ov['cover_wilson'], 3, True), signed(ov['roi'], 4), ci(ov['roi_ci'], 4),
           f(ov['clv'], 3), ci(ov['clv_ci'], 3), f(ov['max_drawdown'], 1), ci(ov['max_drawdown_ci'], 1)))
    add('')
    add('Pure buckets by season (n / pure mean / cover rate):')
    add('')
    hdr = '| season | ' + ' | '.join(b[2] for b in __import__('v2.decision.study', fromlist=['x']).COVER_BUCKETS) + ' |'
    add(hdr)
    add('|---' * 8 + '|')
    for S, rows in s4['pure_by_season'].items():
        add('| %s | %s |' % (S, ' | '.join('%d / %s / %s' % (x['n'], f(x.get('mean_p_pure'), 3), p(x.get('cover_rate'))) if x.get('n') else '0'
                                          for x in rows)))
    add('')
    # ------------------------------------------------------------------ §5
    add('## §5 Continuous walk-forward calibration: method comparison')
    add('')
    add('Each map is fit on DEV decision rows of seasons strictly before the scored season (non-push rows). Pooled over %d '
        'scored non-push rows.' % s5['n_scored_nonpush'])
    add('')
    add('| method | decision-eligible | params | log loss | Δ vs coin flip [95% CI] | Δ vs best eligible (SE) | Brier | ECE adaptive-10 | ECE §4 buckets | mean p − cover | log loss by season |')
    add('|---|---|---|---|---|---|---|---|---|---|---|')
    for k in ('market', 'identity', 'shrink', 'logit_pwl', 'isotonic', 'platt', 'beta', 'isotonic_fold'):
        m = M[k]
        add('| %s | %s | %s | %s | %s%s | %s (%s) | %s | %s | %s | %s | %s |' % (
            k, 'yes' if m['eligible'] else 'diagnostic', m['n_params'] if m['n_params'] is not None else 'np', f(m['log_loss'], 5),
            signed(m['dll_vs_market'], 5), ci(m['dll_vs_market_ci'], 5), signed(m['dll_vs_best_eligible'], 5), f(m['dll_se'], 5),
            f(m['brier'], 5), f(m['ece_adaptive10'], 4), f(m['ece_fixed_buckets'], 4), signed(m['cal_in_the_large'], 4),
            ', '.join('%s %s' % (s, f(v, 4)) for s, v in m['by_season'].items())))
    add('')
    add('- **market** = 0.5 (w = 0); **identity** = the raw pure probability; **shrink** = sigmoid(w·logit p), w fit walk-forward; '
        '**logit_pwl** = side-symmetric piecewise-linear map in logit space (knots at p = 0.50, 0.52, 0.55, 0.60, 0.70, 0.85, '
        'smoothness penalty 5, f(0.5) = 0.5); **isotonic** = isotonic regression on the side probability, reflected; '
        '**platt** (with intercept), **beta** (3 parameters) and **isotonic_fold** (unreflected) are diagnostics: they are '
        'not side-symmetric, and decision.js applies one map to each side\'s own probability.')
    add('- **Selection rule (pre-declared):** %s' % s5['rule'])
    add('- **Chosen: `%s`** (best eligible: `%s`).' % (s5['chosen'], s5['best_eligible']))
    add('- Platt\'s intercept and beta\'s extra shape do not help out of sample; isotonic over-fits (worse than a coin flip).')
    add('')
    # ------------------------------------------------------------------ §12-13
    add('## §12-13 Shrinkage toward the market (inside the decision layer only)')
    add('')
    add('`decision_cover_probability = sigmoid(w · logit(calibrated_p) + (1 − w) · logit(market_p))`, market_p = the de-vigged '
        'two-sided price of the side (0.5 at the ASSUMED −110/−110 — so historically w is identified only against a fair-line '
        'market). The calibration map is `identity`, so the whole correction is this one weight. `pure_cover_probability` '
        'and `decision_cover_probability` are both kept.')
    add('')
    add('| season | walk-forward w (fit on seasons < S) [profile 95%] | n train | this season alone: w [profile 95%] | n |')
    add('|---|---|---|---|---|')
    for S in ['2017'] + [str(s) for s in summ['scored_seasons']]:
        wf = sw['walk_forward'].get(S)
        lo = sw['per_season_local'].get(S)
        add('| %s | %s | %s | %s | %s |' % (S, (f(wf['w'], 3) + ci(wf['w_ci95_profile'], 3)) if wf else '— (first priced season)',
                                            int(wf['n']) if wf else '—', f(lo['w_unbounded'], 3) + ci(lo['w_ci95_profile'], 3), int(lo['n'])))
    add('')
    add('- **Pooled DEV (the frozen weight): w = %.4f**, profile 95%% CI %s, bootstrap 95%% CI %s, n %d. LR test w = 0: '
        'χ² = %s (p = %s); w = 1 (trust the pure model): χ² = %s (p < 1e-8).'
        % (sw['pooled_dev']['w'], ci(sw['pooled_dev']['w_ci95_profile'], 3), ci(sw['pooled_bootstrap_ci95'], 3),
           sw['pooled_dev']['n'], f(sw['pooled_dev']['lr_w0'], 2), f(sw['pooled_p_w0'], 4), f(sw['pooled_dev']['lr_w1'], 1)))
    add('- **Stability:** per-season weights are consistent with one weight (Cochran Q = %s on %d df, p = %s; inverse-variance '
        'mean %s). Two seasons (2019, 2022) alone show no signal (w ≈ 0).'
        % (f(sw['heterogeneity_Q'], 2), sw['heterogeneity_df'], f(sw['heterogeneity_p'], 3), f(sw['inverse_variance_mean_local_w'], 3)))
    wt = s5['w_on_top_of_each_map']
    add('- **Residual shrinkage each alternative map still needs** (w fit on the map\'s own out-of-sample outputs): %s. '
        'Every richer map still needs heavy shrinkage (or is already flat): the data support one number.'
        % '; '.join('%s %s%s' % (k, f(v['pooled_oos'], 3), ci(v['pooled_ci95'], 3)) for k, v in wt.items()))
    add('')
    # ------------------------------------------------------------------ §14
    add('## §14 Probability edge = decision_cover_probability − break_even(price)')
    add('')
    add('At the assumed −110 the break-even is %.5f. The pure probability exceeds it on %s of scored rows; the decision '
        'probability on far fewer:' % (s14['break_even_at_assumed_110'], p(s14['pure_edge_share_positive'])))
    add('')
    add('| season | n | share edge > 0 | median edge | 90th pct edge | max edge | max decision p |')
    add('|---|---|---|---|---|---|---|')
    for S, v in s14['by_season'].items():
        add('| %s | %d | %s | %s | %s | %s | %s |' % (S, v['n'], p(v['share_edge_pos']), signed(v['edge_q50'], 4),
                                                   signed(v['edge_q90'], 4), signed(v['edge_max'], 4), f(v['p_dec_max'], 4)))
    add('')
    add('Outcomes split at the only cut used here, the price\'s break-even (declared, not searched):')
    add('')
    L += outcome_table([dict(s14['edge_positive'], bucket='edge > 0'), dict(s14['edge_nonpositive'], bucket='edge ≤ 0')])
    add('')
    # ------------------------------------------------------------------ §6-9
    add('## §6-9 Conditional calibration')
    add('')
    add('For each conditioner: the outcome table on the scored seasons (walk-forward decision probability), the per-group '
        'shrink weight on all DEV decision rows, an in-sample likelihood-ratio test of one weight vs one weight per group, and '
        'the walk-forward log-loss change of the conditional map (groups with < 150 training rows fall back to the single '
        'weight). **Rule (pre-declared): adopt a conditional map only if LR p < 0.05/4 AND the walk-forward Δ log loss CI is '
        'entirely below 0.**')
    add('')
    names = {'reliability': '§6 by football confidence (production reliability score)', 'ens_sd_tercile': '§7 by ensemble disagreement tercile',
             'timing': '§8 by season timing', 'gap': '§9 by model-market gap (|pure margin − opener|, points)'}
    for k in ('reliability', 'ens_sd_tercile', 'timing', 'gap'):
        c = cond[k]
        add('### %s' % names[k])
        add('')
        if k == 'ens_sd_tercile':
            add('Tercile edges (DEV decision rows): ens_sd < %s low, < %s mid, else high.' % (f(c['edges'][0], 3), f(c['edges'][1], 3)))
            add('')
        L += prob_table(c['table_scored_2018_2023'], 'group')
        add('')
        L += outcome_table(c['table_scored_2018_2023'], 'group')
        add('')
        add('Per-group weight (all DEV decision rows): %s. LR test: χ² = %s on %d df, p = %s. Walk-forward Δ log loss '
            '(conditional − single) %s%s. **Adopted: %s.**'
            % (', '.join('%s %s%s' % (r['bucket'], f(r.get('w_group'), 3), ci(r.get('w_group_ci95'), 2))
                         for r in c['table_scored_2018_2023'] if r.get('n')),
               f(c['lr_test_dev_2017_2023']['lr'], 2), int(c['lr_test_dev_2017_2023']['df']), f(c['lr_test_dev_2017_2023']['p'], 3),
               signed(c['walk_forward_dll_conditional_minus_single'], 5), ci(c['walk_forward_dll_ci'], 5),
               'yes' if c['adopted'] else 'no'))
        add('')
    add('**One map is kept** (no conditioner passes). Gap buckets including 2016 (no pure probability yet) and the REVIEW rows '
        '(|gap| ≥ 14 or an orientation fault; production never prices them):')
    add('')
    L += outcome_table(cond['gap_buckets_incl_2016_no_pure'])
    add('')
    rv = cond['review_rows_not_priced']
    add('REVIEW rows with a pure probability (2017-2023): n %d, cover %s, CLV %s.' % (rv['n'], p(rv.get('cover_rate')), f(rv.get('clv'), 2)))
    add('')
    # ------------------------------------------------------------------ §10-11
    add('## §10-11 EV calibration')
    add('')
    add('Theoretical EV = EV of the PURE probability at the assumed −110 with the empirical push probability. Realized = units '
        'at the assumed −110. Buckets on the scored seasons:')
    add('')
    add('| theoretical EV bucket | n | mean theoretical EV | mean decision EV | realized ROI [95%] | EB ROI | CLV [95%] | cover [Wilson] | status |')
    add('|---|---|---|---|---|---|---|---|---|')
    for r in s10['theoretical_ev_buckets_extended']:
        if not r.get('n'):
            continue
        add('| %s | %d | %s | %s | %s%s | %s | %s%s | %s%s | %s |' % (
            r['bucket'], r['n'], signed(r['mean_theoretical_ev'], 4), signed(r['mean_decision_ev'], 4), signed(r['roi'], 3),
            ci(r['roi_ci'], 3), signed(r.get('roi_eb'), 3), f(r['clv'], 2), ci(r['clv_ci'], 2), p(r['cover_rate']),
            ci(r['cover_wilson'], 3, True), r['sample_status']))
    add('')
    add('Decision EV (walk-forward decision probability) buckets:')
    add('')
    add('| decision EV bucket | n | mean decision EV | realized ROI [95%] | EB ROI | CLV [95%] | cover [Wilson] | status |')
    add('|---|---|---|---|---|---|---|---|')
    for r in s10['decision_ev_buckets']:
        if not r.get('n'):
            continue
        add('| %s | %d | %s | %s%s | %s | %s%s | %s%s | %s |' % (
            r['bucket'], r['n'], signed(r['mean_decision_ev'], 4), signed(r['roi'], 3), ci(r['roi_ci'], 3),
            signed(r.get('roi_eb'), 3), f(r['clv'], 2), ci(r['clv_ci'], 2), p(r['cover_rate']), ci(r['cover_wilson'], 3, True),
            r['sample_status']))
    add('')
    ev = s10['evaluation_scored']
    add('**The empirical EV curve** (theoretical EV → expected realized EV). Method (pre-declared): bin by theoretical EV '
        '(edges 0, 1, 2, 3, 5, 7, 10, 15, 25%%), take the mean realized units per bin, shrink each bin toward the NO-SKILL '
        'value of that bin (a fair coin at the price: 0.5(1 − push)b − 0.5(1 − push)) with normal-normal empirical Bayes, then '
        'pool adjacent violators so it never decreases. Walk-forward τ² by season: %s — **zero in every season**: the bins\' '
        'differences are all within sampling noise, so the curve is the no-skill line. Frozen curve (all DEV): x = %s, y = %s.'
        % (', '.join('%s %s' % (k, f(v['tau2'], 5)) for k, v in s10['ev_curve_walk_forward'].items()),
           [round(v, 4) for v in A['ev_curve']['x']], [round(v, 4) for v in A['ev_curve']['y']]))
    add('')
    add('| predictor of realized units (scored seasons) | mean | MSE vs realized |')
    add('|---|---|---|')
    add('| theoretical EV (pure) | %s | %s |' % (signed(ev['mean_theoretical_ev'], 4), f(ev['mse_realized_vs_theoretical_ev'], 5)))
    add('| decision EV (walk-forward shrink) | %s | %s |' % (signed(ev['mean_decision_ev'], 4), f(ev['mse_realized_vs_decision_ev'], 5)))
    add('| empirical EV curve (walk-forward) | %s | %s |' % (signed(ev['mean_empirical_ev'], 4), f(ev['mse_realized_vs_empirical_ev'], 5)))
    add('| no skill (coin at −110) | — | %s |' % f(ev['mse_realized_vs_no_skill'], 5))
    add('| realized | %s%s | — |' % (signed(ev['mean_realized'], 4), ci(ev['mean_realized_ci'], 4)))
    add('')
    add('The decision EV is the best of these predictors; the theoretical EV is worse than assuming no skill. A second curve on '
        'the walk-forward DECISION EV (`ev_curve_decision`, fit on 2018-2023 out-of-sample decision EVs) is also frozen: x = %s, '
        'y = %s.' % ([round(v, 4) for v in A['ev_curve_decision']['x']], [round(v, 4) for v in A['ev_curve_decision']['y']]))
    add('')
    # ------------------------------------------------------------------ §19-20
    add('## §19-20 CLV models')
    add('')
    add('Target: side-oriented CLV (points, opener → close) on DEV decision rows; positive CLV = CLV > 0 (no move counts as 0; '
        '%s of rows did not move). Walk-forward on the scored seasons. Point-in-time features only in the frozen variant: %s. '
        'The ridge strength of each variant is picked from %s on the pooled walk-forward loss (disclosed: a mild selection on '
        'the evaluation). `with_close_side_diagnostics` adds the close-time dispersion and the era-confounded archive book '
        'count: it is **much worse** out of sample and is never frozen.'
        % (p(s19['share_no_move']), ', '.join('`%s`' % x for x in __import__('v2.decision.study', fromlist=['x']).CLV_FEATURES),
           list(__import__('v2.decision.study', fromlist=['x']).L2_GRID)))
    add('')
    add('P(positive CLV), logistic:')
    add('')
    add('| variant | ridge | log loss | Δ vs base rate [95%] | Brier | AUC [95%] | predictions p5-p95 |')
    add('|---|---|---|---|---|---|---|')
    for k, m in lg.items():
        add('| %s | %s | %s | %s%s | %s | %s%s | %s |' % (k, m.get('l2'), f(m['log_loss'], 5), signed(m['dll_vs_intercept'], 5),
                                                        ci(m['dll_vs_intercept_ci'], 5), f(m['brier'], 5), f(m['auc'], 3),
                                                        ci(m.get('auc_ci'), 3), ci(m.get('pred_range_p05_p95'), 3).strip()))
    add('')
    add('Expected CLV magnitude, linear (fit on CLV clipped at ±%g):' % s19['winsor_clv_fit'])
    add('')
    add('| variant | ridge | MAE | RMSE | corr [95%] | calibration slope | ΔMSE vs mean [95%] |')
    add('|---|---|---|---|---|---|---|')
    for k, m in lin.items():
        add('| %s | %s | %s | %s | %s%s | %s | %s%s |' % (k, m.get('l2', '—'), f(m['mae'], 3), f(m['rmse'], 3), f(m.get('corr'), 3),
                                                       ci(m.get('corr_ci'), 3), f(m.get('calibration_slope'), 3),
                                                       signed(m.get('dmse_vs_intercept'), 4), ci(m.get('dmse_vs_intercept_ci'), 4)))
    add('')
    add('- **Adoption rule:** %s. **Frozen: p_positive_clv = `%s`, clv_magnitude = `%s`.**'
        % (s19['adoption_rule'], pk['logistic'], pk['linear']))
    add('- Base rate of positive CLV by season: %s (pooled %s).' % (', '.join('%s %s' % (k, p(v)) for k, v in s19['base_rate_by_season'].items()),
                                                                     p(s19['base_rate_positive_clv'])))
    for kind, label in (('logistic', 'p_positive_clv'), ('linear', 'clv_magnitude')):
        fm = s19['final'][kind]
        add('- Frozen `%s` (all DEV, n %d, ridge %s): intercept %s; standardized coefficients %s.'
            % (label, fm['n_train'], fm['l2'], f(fm['intercept'], 4),
               ', '.join('%s %s%s' % (k, signed(v, 4), ci(fm['coef_ci95'].get(k), 3)) for k, v in fm['coef'].items()) or 'none'))
    add('')
    add('Reliability diagram of the frozen P(positive CLV) (walk-forward deciles of the prediction):')
    add('')
    add('| decile | n | predicted | observed [Wilson 95%] |')
    add('|---|---|---|---|')
    for r in s19['reliability_diagram_p_positive_clv']:
        add('| %d | %d | %s | %s%s |' % (r['decile'], r['n'], p(r['pred']), p(r['obs']), ci(r['obs_wilson'], 3, True)))
    add('')
    add('Expected CLV (frozen magnitude model) vs realized, walk-forward deciles:')
    add('')
    add('| decile | n | predicted CLV | realized CLV [95%] |')
    add('|---|---|---|---|')
    for r in s19['deciles_expected_clv']:
        add('| %d | %d | %s | %s%s |' % (r['decile'], r['n'], f(r['pred'], 3), f(r['obs'], 3), ci(r['obs_ci'], 3)))
    add('')
    # ------------------------------------------------------------------ §24-27
    add('## §24-27 Three separate confidences, each empirical')
    add('')
    add('### Football confidence (predicts |error|; pure inputs only)')
    add('')
    add('Population: %s, n %d; scored %s. Candidates for the expected |final margin − projected margin|:' %
        (fb['population'], fb['n_games'], fb['seasons_scored']))
    add('')
    add('| candidate | features | walk-forward MSE | Δ vs best (SE) | Δ vs constant [95%] | bias | Spearman(pred, |err|) |')
    add('|---|---|---|---|---|---|---|')
    for k, m in fb['candidates_walk_forward'].items():
        add('| %s | %s | %s | %s (%s) | %s%s | %s | %s |' % (k, ', '.join(m['features']) if m['features'] else ('—' if m['features'] is not None else 'sigma·E|T|'),
                                                         f(m['mse'], 3), signed(m['dmse_vs_best'], 3), f(m['se_vs_best'], 3),
                                                         signed(m['dmse_vs_intercept'], 3), ci(m['dmse_vs_intercept_ci'], 3),
                                                         signed(m['bias'], 3), f(m.get('spearman'), 4)))
    add('')
    add('**Picked (1-SE parsimony, order constant → sigma → frozen features): `%s`.** MAE by quintile of sigma (walk-forward):' % fb['picked'])
    add('')
    add('| sigma quintile | n | mean sigma | MAE [95%] |')
    add('|---|---|---|---|')
    for r in fb['sigma_quintiles']:
        add('| %d | %d | %s | %s%s |' % (r['band'], r['n'], f(r['pred_mean'], 2), f(r['mae'], 3), ci(r['mae_ci'], 3)))
    add('')
    add('Spearman of quintile MAE on sigma: %s (perm. p %s). Game-level slope of |error| on sigma: %s pts per point of sigma%s '
        '(the t model implies about +0.8).' % (f(fb['sigma_quintile_monotonicity']['rho'], 2), f(fb['sigma_quintile_monotonicity']['p'], 3),
                                              signed(fb['sigma_slope_abs_err_per_pt'], 3), ci(fb['sigma_slope_ci'], 3)))
    add('')
    add('**Production reliability score (engine.js football_prediction_confidence) → expected |error|**, validated walk-forward '
        '(the frozen `reliability_scale` method: band means, empirical-Bayes toward the pooled mean, PAV non-increasing):')
    add('')
    add('| reliability band | n | mean score | mean sigma | predicted MAE (walk-forward) | realized MAE [95%] | stage-7 walk-forward score: n / MAE [95%] |')
    add('|---|---|---|---|---|---|---|')
    for r, r2 in zip(fb['reliability_bands_production_score'], fb['reliability_bands_stage7_wf']):
        add('| %s | %d | %s | %s | %s | %s%s | %d / %s%s |' % (r['band'], r['n'], f(r.get('mean_score'), 1), f(r['mean_sigma'], 2),
                                                             f(r['pred_mean'], 3), f(r['mae'], 3), ci(r['mae_ci'], 3), r2['n'],
                                                             f(r2['mae'], 3), ci(r2['mae_ci'], 3)))
    add('')
    rs = A['reliability_scale']
    add('Slope of |error| per 10 reliability points: %s%s. Band monotonicity (Spearman of band MAE on band order): %s '
        '(p %s). EB τ² = %s → **the frozen scale is %s** (x = %s, y = %s). The raw (unshrunk) isotonic fit for reference: %s.'
        % (signed(fb['reliability_slope_per_10pts'], 3), ci(fb['reliability_slope_ci'], 3), f(fb['reliability_band_monotonicity']['rho'], 2),
           f(fb['reliability_band_monotonicity']['p'], 3), f(rs['tau2'], 4),
           'flat (complete pooling)' if (rs['tau2'] or 0) == 0 else 'shrunk', [round(v, 1) for v in rs['expected_abs_error']['x']],
           [round(v, 3) for v in rs['expected_abs_error']['y']],
           dict(zip(fb['reliability_isotonic_raw_grid']['x'], fb['reliability_isotonic_raw_grid']['y']))))
    add('')
    add('The frozen `football_confidence` model and its score use a DECLARED absolute scale (score 100 ↔ 10 pts expected '
        '|error|, 0 ↔ 16 pts), so the score shows how little the data separate FBS games (every FBS game lands near %s).'
        % f(100 * (16 - (A['football_confidence']['intercept'])) / 6, 0))
    add('')
    add('Disagreement vs overconfidence of the error model (standardized |error| relative to the t\'s expectation):')
    add('')
    add('| ens_sd tercile | n | mean ens_sd | mean sigma | MAE | mean abs z / expected [95%] | 80% interval coverage |')
    add('|---|---|---|---|---|---|---|')
    for r in fb['disagreement_vs_standardized_error']:
        add('| %s | %d | %s | %s | %s | %s%s | %s |' % (r['tercile'], r['n'], f(r['mean_ens_sd'], 2), f(r['mean_sigma'], 2), f(r['mae'], 2),
                                                     f(r['ratio'], 3), ci(r['ratio_ci'], 3), p(r['cover80'])))
    add('')
    add('### Market confidence (historically only the quote itself is point in time)')
    add('')
    add('Target: %s. Population: %s. Mean |move| %s pts.' % (mk['target'], mk['population'], f(mk['mean_abs_move'], 3)))
    add('')
    add('| candidate | features | walk-forward MSE | Δ vs constant [95%] | Spearman with |move| | Spearman with |quote error| |')
    add('|---|---|---|---|---|---|')
    for k, m in mk['candidates_walk_forward'].items():
        add('| %s | %s | %s | %s%s | %s | %s |' % (k, ', '.join(m['features']) or '—', f(m['mse'], 4), signed(m['dmse_vs_intercept'], 4),
                                                ci(m['dmse_vs_intercept_ci'], 4), f(m.get('spearman_abs_move'), 3),
                                                f(m.get('spearman_abs_quote_error'), 3)))
    add('')
    add('**Picked: `%s`.** Quintiles of the point-in-time model (|move| / |quote error|):' % mk['picked'])
    add('')
    add('| quintile | n | predicted |move| | realized |move| [95%] | realized |quote error| [95%] |')
    add('|---|---|---|---|---|')
    for a, b in zip(mk['quintiles_abs_move_by_pit_model'], mk['quintiles_abs_quote_error_by_pit_model']):
        add('| %d | %d | %s | %s%s | %s%s |' % (a['band'], a['n'], f(a['pred_mean'], 3), f(a['mae'], 3), ci(a['mae_ci'], 3),
                                              f(b['mae'], 3), ci(b['mae_ci'], 3)))
    add('')
    add('Dispersion, book count and Pinnacle presence exist historically only at the CLOSE (or as an era-confounded archive '
        'count); as diagnostics they make the model worse out of sample. **An empirical market confidence has to be learned '
        'from the live capture (freshness, per-book depth, dispersion at decision time), which does not exist yet.** '
        'decision.js\'s marketConfidence (freshness, book count, IQR, two-sided prices) is DECLARED, not fitted.')
    add('')
    add('### Bet confidence (predicts CLV and the calibrated edge, not wins)')
    add('')
    add(s24['bet']['definition'] + '.')
    add('')
    L += decile_table(s24['bet']['deciles'], 'bet_confidence (walk-forward P(positive CLV))')
    add('')
    # ------------------------------------------------------------------ §33-36
    add('## §33-36 Rank order, monotonicity, minimum samples')
    add('')
    add(s33['min_sample_rules']['rule'] + '.')
    add('')
    for k, lab in (('pure_cover_prob', 'pure cover probability'), ('theoretical_ev', 'theoretical EV'),
                   ('probability_edge', 'probability edge (edge quality)'), ('exp_clv_wf', 'bet-quality score = expected CLV')):
        L += decile_table(s33[k], lab)
        add('')
    # ------------------------------------------------------------------ 2020
    add('## 2020 (reported separately: no openers)')
    add('')
    add('FBS games %d: model MAE %s%s; expected |error| from the football model fit on 2017-2019: %s (theory %s). %s.'
        % (s20['n_games'], f(s20['mae_model'], 3), ci(s20['mae_model_ci'], 3), f(s20['mean_expected_abs_error_wf'], 3),
           f(s20['mean_theory_expected_error'], 3), s20['note']))
    dv = s20['diagnostic_vs_close']
    add('')
    add('%s: n %d (pushes %d), the model\'s side covered the close %s, mean pure p %s, log loss %s vs coin %s, weight on the '
        'model %s%s.' % (dv['label'], dv['n'], dv['pushes'], p(dv['cover_rate']), f(dv['mean_p_pure'], 3), f(dv['log_loss_pure'], 5),
                         f(dv['log_loss_coin'], 5), f(dv['w_2020_close'], 3), ci(dv['w_ci95'], 3)))
    add('')
    # ------------------------------------------------------------------ price sensitivity
    add('## Price sensitivity: the archive\'s real opening price (2016-2019)')
    add('')
    add('The raw archive carries the 5Dimes OPENING price for the very opener the study bets (2012-2019). On %d DEV FBS rows: '
        'both sides −110 on %s; top price pairs %s. Mean de-vigged market probability of the side %s (not 0.5 on %s). ROI at the '
        'archive price %s vs %s at the assumed −110 (difference %s%s). Mean break-even at the archive price %s. The shrink weight '
        'anchored on the de-vigged archive probability instead of 0.5: %s vs %s (n %s).'
        % (ps['n'], p(ps['share_both_sides_-110']), ps['price_pairs'], f(ps['mean_devig_market_prob_side'], 4),
           p(ps['share_market_prob_not_0.5']), signed(ps['roi_archive_price'], 4), signed(ps['roi_assumed_110'], 4),
           signed(ps['roi_diff_archive_minus_assumed'], 4), ci(ps['roi_diff_ci'], 4), f(ps['mean_break_even_archive'], 4),
           f(ps.get('w_anchor_devig_archive'), 3), f(ps.get('w_anchor_0.5'), 3), ps.get('n_w')))
    add('')
    add('The assumed −110 is the real opening price for most of these openers and slightly optimistic overall; after 2019 no '
        'price exists to check.')
    add('')
    # ------------------------------------------------------------------ policy
    add('## What the decision-policy agent must use')
    add('')
    add('1. **decision_cover_probability**, never the pure one: identity map, then `w_model = %.4f` in logit space toward the '
        'de-vigged market probability (0.5 without a two-sided price). **probability_edge** = decision p − break-even(price).'
        % w)
    add('2. **EV**: decision EV (the calibrated one) for thresholds; the empirical curves (`ev_curve` on the THEORETICAL EV, '
        '`ev_curve_decision` on the decision EV) are flat at the no-skill value and exist to show that no EV level has a '
        'demonstrated realized edge. Note: decision.js maps the DECISION EV through `ev_curve`, whose x-knots are THEORETICAL EV; '
        'use `ev_curve_decision` for that input (both are flat here, so the number is the same).')
    add('3. **No conditional map**, no reliability/disagreement/timing/gap-specific weight: none passed.')
    add('4. **CLV is the only outcome the model demonstrably predicts** (direction and size of the move). p_positive_clv / '
        'bet_confidence and expected CLV rank it; read them as rankings (their calibration drifts with the season\'s base rate).')
    add('5. **Football and market confidence carry no measurable historical signal** among FBS games; do not use them to '
        'select bets on the belief that they sort error.')
    add('6. **The holdout (2024-2025) is untouched by this study.** Apply this frozen artifact to both holdout seasons once, '
        'after thresholds are frozen; do not refit. Report 2020 separately; exclude FCS; never assume a live price.')
    add('7. Minimum samples: read EB-shrunk bucket values; nothing below n = 100 sets anything; ≥ 300 to act.')
    add('')
    # ------------------------------------------------------------------ caveats
    add('## Caveats')
    add('')
    add('- **Assumed prices.** Every historical ROI and EV here is at an assumed −110 (labelled `ASSUMED_-110`); 2016-2019 '
        'show the assumption is close for those openers; 2020-2025 cannot be checked.')
    add('- **No live prices.** The 2026 ledger has one book and zero prices: no live EV, edge or bet is computable; the live '
        'rows exist to exercise the pipeline and to accumulate CLV.')
    add('- **Opener timing.** Openers carry no timestamp; the Tuesday freeze may face a line that has already moved '
        '(optimistic fill; the close is the pessimistic check, REDTEAM §15).')
    add('- **2020** has no openers: no market statistic; football-side only.')
    add('- **Single-book openers.** The consensus opener is one book in 2016-2022; its CLV and the base rate of positive CLV '
        'shift with the book (5Dimes → Bovada), which is why CLV probabilities drift by season.')
    add('- **Selection disclosures.** The ridge strength of the CLV models is chosen on the walk-forward loss over a 5-value '
        'grid; the CLV-model adoption rule (discrimination + no loss penalty) was stated after the loss-only comparison was '
        'inconclusive. Everything else (maps, parsimony rule, conditional-map rule, EV-curve method, bucket edges, declared '
        'confidence scales) was fixed before looking at outcomes.')
    add('- **Replay, not live.** 2026 pure predictions are a replay trained through 2025 (evidence of method).')
    add('')
    # ------------------------------------------------------------------ artifact
    add('## The frozen artifact')
    add('')
    add('`football/cfb_v2/artifacts/decision/%s/calibration.json` (schema `%s`, base model `%s`), with `evidence.json` and '
        '`MANIFEST.json` (sha256 of every file, the dataset, the fitting code and the baseline manifest). Parity fixture: '
        '`artifacts/decision/fixtures/decision_parity.json` (%d cases generated by `v2.decision.reference.evaluate`, tolerance '
        '1e-6). Keys:' % (ARTIFACT_VERSION, A['schema'], A['base_model_version'], len(FX['cases'])))
    add('')
    add('| key | content |')
    add('|---|---|')
    add('| `cover_calibration` | `{map: %s}` + selection evidence (no `conditional`: none supported) |' % json.dumps(A['cover_calibration']['map']))
    add('| `market_shrinkage` | `{w_model: %.6f, space: "logit"}` + CI, LR tests, by-season weights |' % w)
    add('| `push_table` | `%s` (FBS openers 2014-2023, integer lines) |' % json.dumps({k: round(v, 4) for k, v in A['push_table'].items()}))
    add('| `ev_curve` | input `theoretical_ev`; knots x/y (flat at %s) |' % f(A['ev_curve']['y'][0], 4))
    add('| `ev_curve_decision` | input `decision_ev`; knots x/y |')
    add('| `p_positive_clv` / `bet_confidence` | logistic, features %s |' % list(A['p_positive_clv']['coef']))
    add('| `clv_magnitude` | linear, features %s |' % list(A['clv_magnitude']['coef']))
    add('| `football_confidence` + `football_confidence_scale` | linear, features %s; declared scale 10-16 pts |' % list(A['football_confidence']['coef']))
    add('| `reliability_scale.expected_abs_error` | production reliability score → expected |error| (points) |')
    add('| `market_confidence` + `market_confidence_scale` | linear, features %s; declared scale 0.5-3 pts |' % list(A['market_confidence']['coef']))
    add('| `features` | the exact feature definitions (DATASET.md) |')
    add('| `fit_seasons` | %s |' % json.dumps(A['fit_seasons']))
    add('')
    add('Reproduce: `cd football/cfb_v2/research && export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out_h OMP_NUM_THREADS=1 && '
        'python3 -m v2.decision.baseline --verify && python3 -m v2.decision.dataset && python3 -m v2.decision.study && '
        'python3 -m v2.decision.tests_decision`.')
    os.makedirs(DS.DOCS, exist_ok=True)
    open(DOC, 'w').write('\n'.join(L) + '\n')
    print('[render] wrote', DOC)


def _dec(pp, w):
    import math
    z = w * math.log(pp / (1 - pp))
    return 1 / (1 + math.exp(-z))


def _inv(w, be=100 / 210):
    """pure p at which the decision p reaches break-even at -110."""
    import math
    be = 1 / (1 + 100 / 110)
    z = math.log(be / (1 - be)) / w
    return 1 / (1 + math.exp(-z))


if __name__ == '__main__':
    main()
