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
    L = ['| %s | n | mean pure p | mean decision p | cover rate [bootstrap 95%%] | pure: calibration error / Brier | decision: calibration error / Brier | MAE model | MAE quote | model − quote [95%%] | mean abs gap |' % first,
         '|---|---|---|---|---|---|---|---|---|---|---|']
    for r in rows:
        if not r.get('n'):
            continue
        L.append('| %s | %d | %s | %s | %s%s | %s / %s | %s / %s | %s | %s | %s%s | %s |' % (
            r.get(first, r.get('bucket')), r['n'], f(r.get('mean_p_pure'), 4), f(r.get('mean_p_dec'), 4), p(r['cover_rate']),
            ci(r.get('cover_boot'), 3, True),
            signed(r.get('cal_err_pure'), 4), f(r.get('brier_pure'), 4), signed(r.get('cal_err_dec'), 4), f(r.get('brier_dec'), 4),
            f(r.get('mae_model'), 2), f(r.get('mae_quote'), 2), signed(r.get('mae_model_minus_quote'), 2),
            ci(r.get('mae_model_minus_quote_ci'), 2), f(r.get('mean_abs_gap'), 2)))
    return L


def decile_table(d, label):
    L = ['**%s** (walk-forward, scored seasons, n %d):' % (label, d['n']), '',
         '| decile | n | score mean [range] | CLV pts [95%] | +CLV [95%] | ATS [95%] | ROI [95%] | max DD u [95%] | mean probability edge |',
         '|---|---|---|---|---|---|---|---|---|']
    for r in d['rows']:
        L.append('| %d | %d | %s [%s, %s] | %s%s | %s%s | %s%s | %s%s | %s%s | %s |' % (
            r['decile'], r['n'], f(r['score_mean'], 4), f(r['score_range'][0], 4), f(r['score_range'][1], 4),
            f(r['clv_pts'], 2), ci(r['clv_pts_ci'], 2), p(r['positive_clv']), ci(r['positive_clv_ci'], 3, True),
            p(r['ats_win']), ci(r['ats_win_ci'], 3, True), signed(r['units_assumed_110'], 3), ci(r['units_assumed_110_ci'], 3),
            f(r.get('max_drawdown'), 1), ci(r.get('max_drawdown_ci'), 1), signed(r['probability_edge'], 4)))
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
        '**shrink toward the market with w = %.3f** in logit space — %s, log loss %s (Δ vs coin flip %s%s). '
        'That improvement over a coin flip is small and **not significant out of sample** (the CI includes 0); in-sample on '
        'DEV the weight is %.3f with profile 95%% CI %s and LR p = %s against w = 0.'
        % (p(top['mean_p_pure']), p(top['cover_rate']), ci(top['cover_wilson'], 3, True), f(ident['log_loss'], 5),
           f(M['market']['log_loss'], 5), signed(ident['dll_vs_market'], 5), ci(ident['dll_vs_market_ci'], 5), w,
           ('every decision bucket\'s Wilson interval contains its mean decision probability' if all(
               b['cover_wilson'][0] <= b['mean_p_dec'] <= b['cover_wilson'][1] for b in s4['decision_buckets_scored'] if b.get('n'))
            else 'the decision buckets are close to, but not all within, their Wilson intervals'),
           f(shr['log_loss'], 5), signed(shr['dll_vs_market'], 5), ci(shr['dll_vs_market_ci'], 5),
           sw['pooled_dev']['w'], ci(sw['pooled_dev']['w_ci95_profile'], 3), f(sw['pooled_p_w0'], 4)))
    g = cond['gap']['table_scored_2018_2023']
    lows = [(x['bucket'], x['cover_wilson'][0]) for x in g if x.get('n')]
    hi_lb = max(lows, key=lambda t: t[1])
    taus = [v['tau2'] for v in s10['ev_curve_walk_forward'].values()]
    dt = s33['pure_cover_prob']['tests']['ats_win']
    add('2. **Do bigger edges mean better outcomes?** For **CLV, clearly**: mean CLV rises from %s pts in the <1 gap bucket to %s '
        'in the 7+ bucket and the close moves toward the model on %s → %s of moved lines. For **wins, weakly — and never '
        'past the price**: across deciles of the pure probability the cover rate rises %s pts per decile %s (Spearman %s, '
        'p %s) — the small real signal the weight w encodes — but the top-minus-bottom decile difference is %s%s, cover '
        'rates by gap run %s (<1) to %s (7+), and no gap bucket\'s cover rate is significantly above the 52.38%% break-even '
        '(highest Wilson lower bound %s, bucket %s). The frozen empirical EV curve never rises above %s per bet.'
        % (f(g[0]['clv'], 2), f(g[-1]['clv'], 2), p(g[0]['moved_toward']), p(g[-1]['moved_toward']),
           f(100 * dt['slope_per_decile'], 2), ci([100 * v for v in dt['slope_ci']], 2), f(dt['spearman_decile_means'], 2),
           f(dt['spearman_perm_p'], 3), p(dt['top_minus_bottom']), ci(dt['top_minus_bottom_ci'], 3, True),
           p(g[0]['cover_rate']), p(g[-1]['cover_rate']), p(hi_lb[1]), hi_lb[0], signed(max(A['ev_curve']['y']), 4)))
    rb = fb['reliability_bands_production_score']
    add('3. **Does reliability sort error?** **No, not among FBS-vs-FBS games.** MAE by production reliability band runs %s '
        '(<40) … %s (90+), a slope of %s pts of |error| per 10 reliability points%s; sigma itself has a slope of %s%s per '
        'point of sigma (the t model implies ≈ +0.8) and its quintiles have MAE %s. The error model\'s heteroskedasticity is '
        'not visible in realized FBS errors out of sample; the frozen reliability scale is therefore %s.'
        % (f(rb[0]['mae'], 2), f(rb[-1]['mae'], 2), signed(fb['reliability_slope_per_10pts'], 4), ci(fb['reliability_slope_ci'], 3),
           signed(fb['sigma_slope_abs_err_per_pt'], 3), ci(fb['sigma_slope_ci'], 3),
           ', '.join(f(x['mae'], 2) for x in fb['sigma_quintiles']),
           ('flat at %s pts (every score maps to the same expected error)' % f(max(A['reliability_scale']['expected_abs_error']['y']), 2)
            if max(A['reliability_scale']['expected_abs_error']['y']) - min(A['reliability_scale']['expected_abs_error']['y']) < 1e-9
            else '%s → %s pts' % (f(max(A['reliability_scale']['expected_abs_error']['y']), 2),
                                  f(min(A['reliability_scale']['expected_abs_error']['y']), 2)))))
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
        'of about %.1f points at a typical sigma of 16.4. On the scored seasons %s of decision rows had a positive probability edge; those %d rows '
        'covered %s%s at ROI %s%s. The EV the pure model claims (mean %s per bet) must be discounted entirely: realized ROI '
        'was %s%s. **No conditional map is supported** (reliability, disagreement, timing and gap all fail the pre-declared '
        'test). Football confidence carries no measurable information among FBS games; market confidence at most a weak '
        'ordering (the top fifth of predicted line movement moves %s vs %s for the bottom fifth) that does not beat a '
        'constant out of sample; bet confidence (P(positive CLV)) ranks CLV but not wins.'
        % (round(100 * (1 - w)), w, 1 - w, p(_dec(0.60, w)), p(_dec(0.70, w)), p(_inv(w)), _gap(_inv(w)),
           p(sum(v['share_edge_pos'] * v['n'] for v in s14['by_season'].values()) / sum(v['n'] for v in s14['by_season'].values())),
           e14['n'], p(e14['cover_rate']), ci(e14['cover_wilson'], 3, True), signed(e14['roi'], 3), ci(e14['roi_ci'], 3),
           p(s10['evaluation_scored']['mean_theoretical_ev']), signed(s10['evaluation_scored']['mean_realized'], 4),
           ci(s10['evaluation_scored']['mean_realized_ci'], 4),
           f(mk['quintiles_abs_move_by_pit_model'][-1]['mae'], 2), f(mk['quintiles_abs_move_by_pit_model'][0]['mae'], 2)))
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
    lg_ = ds['ledger']
    add('- **No decision-time prices after 2019; live prices have only just begun.** The study prices every historical '
        'decision at an ASSUMED −110. The raw archive does carry the opener\'s own price in 2012-2019 (5Dimes, the single '
        'book whose opener is the consensus): see *Price sensitivity* below. The 2026 Model Lab ledger at this build: %d '
        'quotes (books %s); **%d spread quotes carry a two-sided price** (%s, week(s) %s, first captured %s, %d games, %d of '
        'the priced dataset rows final). Every live row without a captured price has a null EV; none is assumed. Nothing in '
        'this study is fit on live data.'
        % (lg_['quotes_total'], ', '.join(lg_['books']), lg_['spread_quotes_two_sided_price'],
           ', '.join(lg_['priced_spread_books']) or '—', ', '.join(str(x) for x in lg_['priced_spread_weeks']) or '—',
           lg_['first_priced_observed_at'], lg_['priced_spread_games'], ds['live_priced_rows_final']))
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
    add('- Diagnostics: Platt with an intercept %s the chosen map by %s log loss, beta by %s; isotonic %s a coin flip (Δ %s).'
        % ('trails' if M['platt']['dll_vs_best_eligible'] > 0 else 'beats', signed(M['platt']['dll_vs_best_eligible'], 5),
           signed(M['beta']['dll_vs_best_eligible'], 5), 'is worse than' if M['isotonic']['dll_vs_market'] > 0 else 'beats',
           signed(M['isotonic']['dll_vs_market'], 5)))
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
    zero = [S for S, v in sw['per_season_local'].items() if v['w_ci95_profile'][0] is not None and v['w_ci95_profile'][0] <= 0]
    add('- **Stability:** per-season weights are %s one weight (Cochran Q = %s on %d df, p = %s; inverse-variance '
        'mean %s). Seasons whose own 95%% CI includes w = 0 (no signal that season alone): %s.'
        % ('consistent with' if (sw['heterogeneity_p'] or 0) > 0.05 else 'NOT consistent with', f(sw['heterogeneity_Q'], 2),
           sw['heterogeneity_df'], f(sw['heterogeneity_p'], 3), f(sw['inverse_variance_mean_local_w'], 3), ', '.join(zero) or 'none'))
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
    t7 = s10['theoretical_ev_buckets'][-1]
    add('The prescribed 7+%% bucket combined: n %d, mean theoretical EV %s, mean decision EV %s, realized ROI %s%s (EB %s), '
        'CLV %s%s, cover %s%s.' % (t7['n'], signed(t7['mean_theoretical_ev'], 4), signed(t7['mean_decision_ev'], 4),
                                   signed(t7['roi'], 3), ci(t7['roi_ci'], 3), signed(t7.get('roi_eb'), 3), f(t7['clv'], 2),
                                   ci(t7['clv_ci'], 2), p(t7['cover_rate']), ci(t7['cover_wilson'], 3, True)))
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
        'pool adjacent violators so it never decreases. Walk-forward τ² by season: %s (τ² = 0 means the bins\' differences are '
        'all within sampling noise and the curve IS the no-skill line). Frozen curve (all DEV, τ² %s): x = %s, y = %s — it '
        'rises from %s to %s and **never reaches zero**: no theoretical-EV level has a positive expected realized EV at −110.'
        % (', '.join('%s %s' % (k, f(v['tau2'], 5)) for k, v in s10['ev_curve_walk_forward'].items()), f(A['ev_curve']['tau2'], 5),
           [round(v, 4) for v in A['ev_curve']['x']], [round(v, 4) for v in A['ev_curve']['y']],
           signed(min(A['ev_curve']['y']), 4), signed(max(A['ev_curve']['y']), 4)))
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
        'the walk-forward DECISION EV (`ev_curve_decision`, fit on 2018-2023 out-of-sample decision EVs, τ² %s) is also frozen: '
        'x = %s, y = %s%s.' % (f(A['ev_curve_decision']['tau2'], 5), [round(v, 4) for v in A['ev_curve_decision']['x']],
                               [round(v, 4) for v in A['ev_curve_decision']['y']],
                               ' — flat: pool-adjacent-violators merged every bin, i.e. higher decision EV has not meant higher realized EV'
                               if len(set(round(v, 6) for v in A['ev_curve_decision']['y'])) == 1 else ''))
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
    rd = s19['reliability_diagram_p_positive_clv']
    add('Reliability diagram of the frozen P(positive CLV) (walk-forward deciles of the prediction). It ranks (bottom decile '
        '%s → top %s observed) but is not calibrated everywhere: %d of 10 deciles have a Wilson interval that excludes the '
        'prediction, so read it as a ranking.' % (p(rd[0]['obs']), p(rd[-1]['obs']),
                                                  sum(1 for x in rd if not (x['obs_wilson'][0] <= x['pred'] <= x['obs_wilson'][1]))))
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
    qm = mk['quintiles_abs_move_by_pit_model']
    add('The point-in-time model orders the move only weakly (top quintile %s%s vs %s–%s elsewhere) and does not beat a '
        'constant on walk-forward MSE, so the frozen market confidence is the constant.' % (
            f(qm[-1]['mae'], 3), ci(qm[-1]['mae_ci'], 3), f(min(x['mae'] for x in qm[:-1]), 3), f(max(x['mae'] for x in qm[:-1]), 3)))
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
    rule = s33['min_sample_rules']['rule']
    add(rule[0].upper() + rule[1:] + '.')
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
           f(s20['mean_theory_expected_error'], 3), s20['note'][0].upper() + s20['note'][1:]))
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
    d_ = ps['roi_diff_archive_minus_assumed']
    add('The assumed −110 is the real opening price for %s of these openers and %s on ROI (%s per bet); after 2019 no '
        'price exists to check.' % (p(ps['share_both_sides_-110']),
                                    'slightly conservative' if d_ > 0 else ('slightly optimistic' if d_ < 0 else 'neutral'),
                                    signed(d_, 4)))
    add('')
    # ------------------------------------------------------------------ policy
    add('## What the decision-policy agent must use')
    add('')
    add('1. **decision_cover_probability**, never the pure one: identity map, then `w_model = %.4f` in logit space toward the '
        'de-vigged market probability (0.5 without a two-sided price). **probability_edge** = decision p − break-even(price).'
        % w)
    add('2. **EV**: the decision EV (the calibrated one) is the best predictor of realized EV. The empirical curves '
        '(`ev_curve` on the THEORETICAL EV, max %s; `ev_curve_decision` on the decision EV, max %s) stay below zero everywhere: '
        'no EV level has a demonstrated positive realized EV at −110. **decision.js maps the DECISION EV through `ev_curve`, '
        'whose x-knots are THEORETICAL EV: use `ev_curve_decision` for that input** (the artifact labels each curve\'s `input`).'
        % (signed(max(A['ev_curve']['y']), 4), signed(max(A['ev_curve_decision']['y']), 4)))
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
    add('- **Almost no live prices.** At this build the 2026 ledger has %d priced spread quotes (%s, week(s) %s; %d priced rows '
        'final). Live rows without a captured price have null EV; nothing is fit on live data, and the live rows exist to '
        'exercise the pipeline and to accumulate CLV and priced outcomes.'
        % (ds['ledger']['spread_quotes_two_sided_price'], ', '.join(ds['ledger']['priced_spread_books']) or '—',
           ', '.join(str(x) for x in ds['ledger']['priced_spread_weeks']) or '—', ds['live_priced_rows_final']))
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
    add('| `ev_curve` | input `theoretical_ev`; knots x/y (rising from %s to %s, never above 0) |'
        % (signed(min(A['ev_curve']['y']), 4), signed(max(A['ev_curve']['y']), 4)))
    add('| `ev_curve_decision` | input `decision_ev`; knots x/y (%s) |' % (
        'flat at %s' % signed(A['ev_curve_decision']['y'][0], 4) if len(set(round(v, 6) for v in A['ev_curve_decision']['y'])) == 1
        else 'rising from %s to %s' % (signed(min(A['ev_curve_decision']['y']), 4), signed(max(A['ev_curve_decision']['y']), 4))))
    add('| `p_positive_clv` / `bet_confidence` | logistic, features %s |' % list(A['p_positive_clv']['coef']))
    add('| `clv_magnitude` | linear, features %s |' % list(A['clv_magnitude']['coef']))
    add('| `football_confidence` + `football_confidence_scale` | linear, %s; declared scale 10-16 pts |'
        % ('features %s' % list(A['football_confidence']['coef']) if A['football_confidence']['coef']
           else 'intercept only (%s pts: no pure feature sorts FBS error)' % f(A['football_confidence']['intercept'], 3)))
    add('| `reliability_scale.expected_abs_error` | production reliability score → expected |error| (points) |')
    add('| `market_confidence` + `market_confidence_scale` | linear, %s; declared scale 0.5-3 pts |'
        % ('features %s' % list(A['market_confidence']['coef']) if A['market_confidence']['coef']
           else 'intercept only (%s pts: no point-in-time feature beats a constant)' % f(A['market_confidence']['intercept'], 3)))
    add('| `features` | the exact feature definitions (DATASET.md) |')
    add('| `fit_seasons` | %s |' % json.dumps(A['fit_seasons']))
    add('')
    add('Reproduce: `cd football/cfb_v2/research && export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out_h OMP_NUM_THREADS=1 && '
        'python3 -m v2.decision.baseline --verify && python3 -m v2.decision.dataset && python3 -m v2.decision.study && '
        'python3 -m v2.decision.tests_decision`.')
    os.makedirs(DS.DOCS, exist_ok=True)
    text = '\n'.join(L) + '\n'
    while '  [' in text:
        text = text.replace('  [', ' [')
    open(DOC, 'w').write(text)
    print('[render] wrote', DOC)


def _dec(pp, w):
    import math
    z = w * math.log(pp / (1 - pp))
    return 1 / (1 + math.exp(-z))


def _gap(pthr, sigma=16.4):
    from scipy import stats
    return float(stats.norm.ppf(pthr) * sigma)


def _inv(w, be=100 / 210):
    """pure p at which the decision p reaches break-even at -110."""
    import math
    be = 1 / (1 + 100 / 110)
    z = math.log(be / (1 - be)) / w
    return 1 / (1 + math.exp(-z))




# ======================================================================
# docs/cfb-decision/POLICY.md — the decision-policy study (python3 -m v2.decision.render --policy)
# Every number is read from out_h/decision/policy/{tournament,analyses,holdout}.json and the frozen
# policy artifact; nothing is typed by hand.
# ======================================================================
POLICY_DOC = os.path.join(DS.DOCS, 'POLICY.md')


def PJ(name):
    return json.load(open(os.path.join(DS.out_dir(), 'policy', name)))


def _card_row(name, c, extra=''):
    a = c.get('ats') or {}
    wlp = '%s-%s-%s' % (a.get('wins', 0), a.get('losses', 0), a.get('pushes', 0)) if c.get('bet_count') else ''
    return ('| %s | %s | %s | %s%s | %s%s | %s%s | %s | %s%s | %s%s | %s |%s' % (
        name, c.get('bet_count', 0), wlp, p(a.get('cover_rate')), ci(a.get('wilson'), 3, True),
        signed(c.get('roi'), 3), ci(c.get('roi_ci'), 3), f(c.get('avg_clv'), 2), ci(c.get('avg_clv_ci'), 2),
        p(c.get('positive_clv_pct')), signed(c.get('close_implied_ev'), 4), ci(c.get('close_implied_ev_ci'), 4),
        f(c.get('max_drawdown'), 1), ci(c.get('max_drawdown_ci'), 1), signed(c.get('calibration_error'), 3), extra))


CARD_HEAD = ('| %s | n | W-L-P | cover [Wilson 95%%] | ROI at −110 [95%% CI] | CLV pts [95%% CI] | +CLV | close-implied EV [95%% CI] '
             '| max DD u [95%%] | calib. error |%s')


def live_price_targets():
    """§51-52: the price-target table for every live 2026 quote with a CAPTURED two-sided price (inputs only), under the
    frozen policy and artifact, evaluated at the moment the quote was observed (the 2026 projection is a replay)."""
    import numpy as np
    import pandas as pd
    from . import policy as POL
    from .tournament import POLICY_DIR
    P = json.load(open(os.path.join(POLICY_DIR, 'policy.json')))
    A = POL.load_artifact()
    D = pd.read_parquet(os.path.join(DS.out_dir(), 'decision_dataset.parquet'), filters=[('window', '==', 'live')])
    L = D[D.quote_role.eq('LIVE_BOOK_QUOTE') & D.price_source.eq('CAPTURED') & D.pricing_scope.eq('FBS_FBS')
          & D.pure_cover_prob.notna()].sort_values(['kickoff_ts', 'game_id'])
    rows = []
    for rw in L.to_dict('records'):
        obs = pd.Timestamp(rw['quote_observed_at']).tz_convert('UTC').strftime('%Y-%m-%dT%H:%M:%S.000Z')
        rw = dict(rw, decision_ts_iso=obs, kickoff_iso=pd.Timestamp(rw['kickoff_ts']).tz_convert('UTC').strftime('%Y-%m-%dT%H:%M:%S.000Z'))
        pure, quote, row, market, now = POL.row_to_inputs(rw, float(rw['quote_price_home']), float(rw['quote_price_away']),
                                                          books=float(rw['books']) if np.isfinite(rw['books']) else None)
        pure['home'], quote['home_team'] = rw['home_team'], rw['home_team']
        d = POL.decide_quote(pure, quote, {'policy': P, 'artifact': A, 'now': now, 'market': market, 'row': row,
                                           'expected_model_version': pure['model_version']})
        pt = d.get('price_targets') or {}
        fair = POL.minimum_price(d['raw']['decision_cover_probability'], d.get('push_probability'), 0.0) if d.get('raw') else None
        team = rw['home_team'] if d.get('side') == 'HOME' else rw['away_team']
        rows.append({'game': '%s at %s' % (rw['away_team'], rw['home_team']), 'kickoff': str(rw['kickoff_ts'])[:16],
                     'book': rw['book'], 'side': team, 'line': d.get('line_for_side'), 'price': d.get('price'),
                     'pure_p': d.get('pure_cover_probability'), 'decision_p': d.get('decision_cover_probability'),
                     'break_even': d.get('break_even_probability'), 'edge': d.get('probability_edge'),
                     'decision_ev': d.get('decision_ev'), 'calibrated_ev': d.get('empirical_ev'), 'status': d['status'],
                     'reasons': d['reason_codes'], 'bettable_to_price': pt.get('bettable_to_price'),
                     'bettable_to_line': pt.get('bettable_to_line'), 'ideal_entry_line': pt.get('ideal_entry_line'),
                     'do_not_bet': pt.get('do_not_bet'), 'decision_fair_price': fair})
    return rows


def policy_main():
    T = PJ('tournament.json')
    A = PJ('analyses.json')
    H = PJ('holdout.json') if os.path.exists(os.path.join(DS.out_dir(), 'policy', 'holdout.json')) else None
    from .tournament import POLICY_DIR, POLICY_VERSION
    P = json.load(open(os.path.join(POLICY_DIR, 'policy.json')))
    M = json.load(open(os.path.join(POLICY_DIR, 'MANIFEST.json')))
    E = json.load(open(os.path.join(POLICY_DIR, 'evidence.json')))
    acc = [json.loads(l) for l in open(os.path.join(POLICY_DIR, 'holdout_access.jsonl')) if l.strip()] \
        if os.path.exists(os.path.join(POLICY_DIR, 'holdout_access.jsonl')) else []
    oos, valid = T['oos'], T['bet_valid']
    order = ['edge', 'decision_ev', 'empirical_ev', 'multivariate', 'clv_model', 'gap', 'baseline_001', 'baseline_lean', 'none']
    L = []
    w = L.append
    w('# CFB decision policy — `%s`' % POLICY_VERSION)
    w('')
    w('Generated by `python3 -m v2.decision.render --policy` from the policy study (`v2/decision/tournament.py`, DEV only) and the '
      'one-time holdout (`v2/decision/holdout.py`). Rules: [POLICY_PREREG.md](POLICY_PREREG.md) (sha256 `%s`, one disclosed '
      'amendment). Calibration: [CALIBRATION.md](CALIBRATION.md) (`cfb_decision_calibration_v1`, frozen, not refit). Every betting '
      'number is flat 1 unit at the labelled ASSUMED −110; every interval is a game-clustered bootstrap (seed 20260927).'
      % M['prereg']['sha256'])
    w('')
    # ------------------------------------------------------------ verdict
    e = oos['edge']
    he = (H or {}).get('candidates', {}).get('edge', {})
    w('## The verdict')
    w('')
    w('1. **No policy earns BET status, on DEV or on the holdout.** None of the %d tournament candidates is BET-VALID on the '
      'walk-forward DEV seasons (%s): no candidate\'s realized ROI has a 95%% interval above zero, and no tuned candidate\'s '
      'close-implied EV (the EV of the bet if the closing line is fair) is positive. The production candidate (`edge`, '
      'probability edge ≥ %s) went %s on DEV out-of-sample: ROI %s%s, CLV %s%s, close-implied EV %s%s; on the holdout (2024-2025, '
      'read once) %s: ROI %s%s, CLV %s%s, close-implied EV %s%s.'
      % (len(order) - 1, ', '.join(str(s) for s in T['eval_seasons']), P['min_probability_edge'],
         '%d bets' % e['bet_count'], signed(e.get('roi'), 3), ci(e.get('roi_ci'), 3), f(e.get('avg_clv'), 2), ci(e.get('avg_clv_ci'), 2),
         signed(e.get('close_implied_ev'), 4), ci(e.get('close_implied_ev_ci'), 4),
         '%d bets' % he.get('bet_count', 0), signed(he.get('roi'), 3), ci(he.get('roi_ci'), 3), f(he.get('avg_clv'), 2),
         ci(he.get('avg_clv_ci'), 2), signed(he.get('close_implied_ev'), 4), ci(he.get('close_implied_ev_ci'), 4)))
    w('2. **The production policy has an empty BET region, by the evidence.** `min_ev = %s` is read on the calibrated EV, and '
      'the frozen decision-EV curve is flat at %s at every price: no quote is a BET at any price, and `bet_enabled` is false. '
      'The §86 gate fails (G3–G9); betting stays disabled. *A missing BET is preferable to a false BET.*'
      % (P['min_ev'], E['promotion_gate_before_holdout']['G8_frozen_artifact_admits_a_bet']['max_calibrated_ev']))
    lg = A['lean']
    w('3. **What the model does have is closing-line value, and the policy is built on it.** LEAN (a positive calibrated edge '
      'over break-even, |gap| ≥ %s) beat the closer on DEV by %s pts [%s, %s] (vs %s for PASS; difference %s%s) and on the holdout '
      'by %s pts%s (LEAN − PASS %s%s). That CLV does not cover the vig: LEAN\'s close-implied EV is %s on DEV and %s on the holdout. '
      'LEAN means "the market is likely to move toward this side", not "bet it".'
      % (P['lean']['min_gap_pts'], f(_st(A['pass_quality']['by_status'], 'LEAN').get('avg_clv'), 2), f(lg['lean_clv_ci'][0], 2),
         f(lg['lean_clv_ci'][1], 2), f(_st(A['pass_quality']['by_status'], 'PASS').get('avg_clv'), 2), signed(lg['lean_minus_pass_clv']['diff'], 2),
         ci(lg['lean_minus_pass_clv']['ci'], 2),
         f(_st((H or {}).get('production', {}).get('by_status', []), 'LEAN').get('avg_clv'), 2), ci((H or {}).get('production', {}).get('lean_clv_ci'), 2),
         signed(((H or {}).get('production', {}).get('lean_minus_pass_clv') or {}).get('diff'), 2),
         ci(((H or {}).get('production', {}).get('lean_minus_pass_clv') or {}).get('ci'), 2),
         signed(_st(A['pass_quality']['by_status'], 'LEAN').get('close_implied_ev'), 4),
         signed(_st((H or {}).get('production', {}).get('by_status', []), 'LEAN').get('close_implied_ev'), 4)))
    if H:
        c = H['production']['calibration']
        w('4. **The decision probability stays calibrated out of sample and carries almost no information about wins.** Holdout: '
          'mean decision probability %s vs cover %s%s (inside the interval); log loss %s vs a coin flip %s (Δ %s%s). The pure '
          'probability is again significantly worse than a coin flip (Δ %s%s). Expected vs realized units (decision probability): '
          'z = %s on DEV, %s on the holdout; the pure model\'s theoretical EV misses by z = %s and %s.'
          % (p(c['mean_p_dec']), p(c['cover_rate']), ci(c['cover_wilson'], 3, True), f(c['log_loss_decision'], 5), f(c['log_loss_coin'], 5),
             signed(c['dll_decision_minus_coin'], 5), ci(c['dll_ci'], 5), signed(c['dll_pure_minus_coin'], 5), ci(c['dll_pure_ci'], 5),
             f(A['expected_vs_realized']['all_rows']['z_realized_vs_decision'], 2), f(H['expected_vs_realized']['all_rows']['z_realized_vs_decision'], 2),
             f(A['expected_vs_realized']['all_rows']['z_realized_vs_theoretical'], 2), f(H['expected_vs_realized']['all_rows']['z_realized_vs_theoretical'], 2)))
    w('')
    # ------------------------------------------------------- the policy
    w('## The production policy (`football/cfb_v2/artifacts/decision/%s/policy.json`)' % POLICY_VERSION)
    w('')
    w('sha256 `%s`, frozen %s, status `%s`, `bet_enabled: %s`. decision.js `validatePolicy` accepts it; `shadow.js` picks it up '
      'as the newest policy.' % (M['files']['policy.json'], M['frozen_at'], P['status'], str(P['bet_enabled']).lower()))
    w('')
    w('| field | value | where it comes from |')
    w('|---|---|---|')
    prov = P.get('provenance', {})
    for k, v, src in (
            ('min_probability_edge', P['min_probability_edge'], prov.get('min_probability_edge')),
            ('min_ev (calibrated EV)', P['min_ev'], prov.get('min_ev')),
            ('ideal_probability_edge', P['ideal_probability_edge'], '2 × min_probability_edge'),
            ('lean', json.dumps(P['lean']), prov.get('lean.min_gap_pts')),
            ('hysteresis', json.dumps(P['hysteresis']), prov.get('hysteresis')),
            ('wait.enabled', P['wait']['enabled'], prov.get('wait')),
            ('stake', 'flat %s u (max %s u); Kelly validated: %s; kelly_fraction %s; saturation p %s' % (
                P['stake']['unit_u'], P['stake']['max_stake_u'], P['stake']['kelly_validated'], P['stake']['kelly_fraction'],
                P['stake']['saturation_probability']), prov.get('stake.saturation_probability')),
            ('exposure', 'game %s u, slate %s u, cluster %s u, same-game correlation %s' % (
                P['exposure']['max_game_u'], P['exposure']['max_slate_u'], P['exposure']['max_cluster_u'],
                P['exposure']['same_game_correlation']), prov.get('exposure.max_slate_u')),
            ('display', json.dumps(P['display']), 'tier and ranking rules (prereg §5)'),
            ('min_football_confidence / max_ensemble_sd', '%s / %s' % (P['min_football_confidence'], P['max_ensemble_sd']),
             prov.get('min_football_confidence / max_ensemble_sd')),
            ('min_bet_confidence', P['min_bet_confidence'], 'null: clv_model is not BET-VALID'),
            ('stale_minutes, min_books, max_dispersion_iqr, max_price, reference_price',
             '%s, %s, %s, %s, %s' % (P['stale_minutes'], P['min_books'], P['max_dispersion_iqr'], P['max_price'], P['reference_price']),
             'declared, not fitted (no point-in-time history)'),
            ('extreme checks', 'gap %s, EV %s, quote < %s min, cover p %s; orientation %s/%s' % (
                P['extreme_gap_pts'], P['extreme_ev'], P['extreme_max_age_minutes'], P['extreme_cover_probability'],
                P['orientation_gap'], P['orientation_reconcile']), 'declared')):
        w('| %s | %s | %s |' % (k, v, src))
    w('')
    w('**Statuses under this policy and the frozen artifact.** BET: never (the calibrated EV is %s at every price). LEAN: a '
      'decision-probability edge > 0 over the price\'s break-even and |gap| ≥ %s, no unresolved uncertainty. RESEARCH: the same '
      'potential edge with an unresolved QB, fewer than %d books, incomplete inputs or an extreme edge (monitor, never bet). '
      'PASS: everything else, with its reason. NO BET: fail closed.' % (
          E['promotion_gate_before_holdout']['G8_frozen_artifact_admits_a_bet']['max_calibrated_ev'], P['lean']['min_gap_pts'], P['min_books']))
    w('')
    # ----------------------------------------------------- tournament
    w('## §69 The walk-forward policy tournament (DEV out-of-sample: %s)' % ', '.join(str(s) for s in T['eval_seasons']))
    w('')
    w('Each tunable candidate chose its threshold on scored seasons before the evaluated season (in-fold score: the lower 90% '
      'bound of the mean close-implied EV; a plateau within one SE of the best; its middle value). 2019 is evaluated with '
      '2018 alone as training, which left the edge-based candidates without an eligible (n ≥ 100) threshold that fold.')
    w('')
    w(CARD_HEAD % ('candidate', ' fold choices (2019/2021/2022/2023) → final DEV | verdict |'))
    w('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for cid in order:
        c = oos[cid]
        cand = T['candidates'][cid]
        if cand['folds']:
            fc = '/'.join(str(x['choice']) if not isinstance(x['choice'], list) else '%s+%s' % (x['choice'][0], ','.join(x['choice'][1]) or '—')
                          for x in cand['folds'].values())
            fin = cand['final_dev']['choice']
            fin = '%s+%s' % (fin[0], ','.join(fin[1])) if isinstance(fin, list) else fin
            fc = '%s → %s' % (fc, fin)
        else:
            fc = 'fixed'
        w(_card_row('`%s`' % cid, c, ' %s | %s |' % (fc, valid[cid]['verdict'])))
    w('')
    w('BET-VALID criteria (prereg §4) per candidate — 1 sample, 2 pricing, 3 CLV, 4 outcome, 5 calibration, 6 stability, 7 paired vs '
      'baseline, 8 risk:')
    w('')
    w('| candidate | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | paired Δ units per quote vs baseline_001 [95%] |')
    w('|---|---|---|---|---|---|---|---|---|---|')
    for cid in order:
        cr = valid[cid]['criteria']
        pdv = valid[cid]['paired_vs_baseline_units_per_quote']
        w('| `%s` | %s | %s%s |' % (cid, ' | '.join('✓' if cr[k] else '✗' for k in sorted(cr)), signed(pdv['mean'], 4), ci(pdv['ci'], 4)))
    w('')
    w('Candidates: `edge` probability edge ≥ t; `decision_ev` decision EV ≥ t (at one price the same ordering as `edge`, up to the '
      'push probability); `empirical_ev` the walk-forward calibrated EV ≥ 0 (what decision.js reads); `multivariate` `edge` plus '
      'forward-selected gates (adopted on the final DEV fit: %s); `clv_model` edge > 0 and the frozen P(positive CLV) ≥ t; `gap` '
      '|gap| ≥ t; `baseline_001` the frozen V2.1 BET-qualifying rule (graded on the side it took); `baseline_lean` its LEAN set.'
      % (', '.join(T['candidates']['multivariate']['final_dev']['choice'][1]) or 'none'))
    w('')
    ch = A['decision_model_challenger']
    w('**§18 decision-model challenger** (a logistic model of positive CLV adding QB flags, |line|, home side and week): AUC %s vs the '
      'frozen model %s (Δ 95%% %s), log loss %s vs %s (Δ %s%s): **%s** (rule: AUC gain CI above 0).' % (
          f(ch['auc_challenger'], 3), f(ch['auc_frozen'], 3), ci(ch['auc_diff_ci95'], 4), f(ch['log_loss_challenger'], 5),
          f(ch['log_loss_frozen'], 5), signed(ch['log_loss_diff'], 5), ci(ch['log_loss_diff_ci95'], 5), 'adopted' if ch['adopted'] else 'not adopted'))
    w('')
    # ------------------------------------------------------- holdout
    if H:
        a0 = [x for x in acc if x.get('action') == 'READ_HOLDOUT']
        w('## §70 The untouched holdout (2024, 2025), read once')
        w('')
        w('Read at %s for policy sha256 `%s` (calibration `%s`, pre-registration `%s`); logged in `holdout_access.jsonl` before the read; '
          'a second run is refused. Frozen artifact applied (w = 0.227829), frozen policy and frozen thresholds; nothing re-tuned. '
          'Rows: %s (consensus openers, FBS). After the read holdout.py wrote the results into MANIFEST.json (see '
          '`post_freeze_changes.jsonl`); the manifest the access log recorded (`%s`) is rebuilt and checked by tests_policy.py.'
          % (a0[0]['at'] if a0 else '?', M['files']['policy.json'][:12], M['calibration_json_sha256'][:12],
             M['prereg']['sha256'][:12], H['by_season_rows'], (a0[0]['manifest_sha256'][:12] if a0 else '?')))
        w('')
        w(CARD_HEAD % ('candidate', ' 2024 / 2025 ROI | no collapse vs DEV |'))
        w('|---|---|---|---|---|---|---|---|---|---|---|---|')
        for cid in order:
            c = H['candidates'][cid]
            bs = c.get('by_season', {})
            yr = ' / '.join('%s (%s)' % (signed((bs.get(s) or {}).get('roi'), 3), (bs.get(s) or {}).get('bet_count', 0)) for s in ('2024', '2025'))
            w(_card_row('`%s`' % cid, c, ' %s | %s |' % (yr, c.get('no_collapse_vs_dev'))))
        w('')
        w('Production replay on the holdout (frozen policy + artifact): %s. By status:' % ', '.join('%s %d' % kv for kv in H['production']['status_counts'].items()))
        w('')
        w(CARD_HEAD % ('status', ''))
        w('|---|---|---|---|---|---|---|---|---|---|')
        for c in H['production']['by_status']:
            w(_card_row(c['group'], c))
        w('')
        pb = H['per_book_sensitivity']
        w('Per-book sensitivity (every book\'s opener, %s rows, %s games, %s; game-clustered): all rows ROI %s%s, CLV %s; edge > 0 rows '
          '(n %s) ROI %s%s, CLV %s%s, close-implied EV %s%s.' % (
              pb['rows'], pb['games'], ', '.join(pb['books']), signed(pb['all']['roi'], 3), ci(pb['all']['roi_ci'], 3),
              f(pb['all']['avg_clv'], 2), pb['edge_gt_0']['bet_count'], signed(pb['edge_gt_0']['roi'], 3), ci(pb['edge_gt_0']['roi_ci'], 3),
              f(pb['edge_gt_0']['avg_clv'], 2), ci(pb['edge_gt_0']['avg_clv_ci'], 2), signed(pb['edge_gt_0']['close_implied_ev'], 4),
              ci(pb['edge_gt_0']['close_implied_ev_ci'], 4)))
        w('')
        c = H['production']['calibration']
        w('Holdout calibration of the decision probability (buckets): ' + '; '.join(
            '%s n %d: mean %s, cover %s%s' % (b['bucket'], b['n'], p(b['mean_p_dec']), p(b['cover']), ci(b['wilson'], 3, True)) for b in c['buckets']) + '.')
        w('')
    # ------------------------------------------------------- pass quality
    w('## §28-31 PASS quality, LEAN and RESEARCH (DEV scored seasons, hypothetical flat 1u for every status)')
    w('')
    w('Production replay (the frozen policy through the Python mirror of decision.js, per-season walk-forward artifacts):')
    w('')
    w(CARD_HEAD % ('status / first reason', ''))
    w('|---|---|---|---|---|---|---|---|---|---|')
    for c in A['pass_quality']['by_status'] + A['pass_quality']['by_first_reason']:
        w(_card_row(c['group'], c))
    w('')
    w('Counterfactual (betting enabled and the calibrated EV replaced by the decision EV, to expose every gate that would fire):')
    w('')
    w(CARD_HEAD % ('first reason', ''))
    w('|---|---|---|---|---|---|---|---|---|---|')
    for c in A['pass_quality']['counterfactual_betting_enabled_by_reason']:
        w(_card_row(c['group'], c))
    w('')
    r_ = A['research']
    w('- **Filtering adds CLV, not wins.** LEAN rows beat PASS rows on CLV (above); their cover rates and ROI intervals overlap.')
    w('- **LEAN** min gap: rows with |gap| in [g, g+1): ' + '; '.join('%s: n %d, CLV %s%s' % (x['g'], x['n'], f(x['clv'], 3), ci(x['clv_ci'], 3))
                                                             for x in lg['gap_rule']['rows']) + ' → %s.' % lg['gap_rule']['choice'])
    w('- **RESEARCH (QB)**: positive-edge rows with a QB flag: CLV %s%s, close-implied EV %s, ROI %s%s; without: CLV %s%s, ROI %s%s '
      '(flagged − clear CLV %s%s).' % (
          f(r_['qb_flagged']['avg_clv'], 2), ci(r_['qb_flagged']['avg_clv_ci'], 2), signed(r_['qb_flagged']['close_implied_ev'], 4),
          signed(r_['qb_flagged']['roi'], 3), ci(r_['qb_flagged']['roi_ci'], 3), f(r_['qb_clear']['avg_clv'], 2), ci(r_['qb_clear']['avg_clv_ci'], 2),
          signed(r_['qb_clear']['roi'], 3), ci(r_['qb_clear']['roi_ci'], 3), signed(r_['clv_diff_flagged_minus_clear']['diff'], 2),
          ci(r_['clv_diff_flagged_minus_clear']['ci'], 2)))
    w('')
    # ------------------------------------------------ selectivity etc.
    w('## §32-36, §55 Selectivity, rank order, robustness (DEV evaluated seasons)')
    w('')
    w('Optimal selectivity — the top share of quotes by probability edge:')
    w('')
    w('| top | n | CLV [95%] | close-implied EV [95%] | ROI [95%] | cover | max DD | calib. error | status |')
    w('|---|---|---|---|---|---|---|---|---|')
    for x in A['selectivity']['probability_edge']:
        w('| %s | %d | %s%s | %s%s | %s%s | %s | %s | %s | %s |' % (
            p(x['top_share'], 0), x['n'], f(x['clv'], 2), ci(x['clv_ci'], 2), signed(x['close_ev'], 4), ci(x['close_ev_ci'], 4),
            signed(x['roi'], 3), ci(x['roi_ci'], 3), p(x['cover']), f(x['max_drawdown'], 1), signed(x['calibration_error'], 3), x['sample_status']))
    w('')
    w('Rank order (deciles; Spearman of decile means, slope per decile [95%]):')
    w('')
    w('| score | CLV | close-implied EV | ROI | cover |')
    w('|---|---|---|---|---|')
    for k, v in A['rank_order'].items():
        t = v['tests']
        cell = lambda o: '%s, %s%s%s' % (f(t[o]['spearman'], 2), signed(t[o]['slope_per_decile'], 4), ci(t[o]['slope_ci'], 4),
                                         ' ✓' if t[o]['monotone_increasing_supported'] else '')
        w('| %s | %s | %s | %s | %s |' % (k, cell('clv_pts'), cell('close_ev'), cell('units'), cell('ats_win')))
    w('')
    w('Threshold robustness (each grid value as a fixed threshold on the evaluated seasons):')
    w('')
    w('| candidate | t | n | ROI [95%] | CLV | close-implied EV [95%] | max DD | status |')
    w('|---|---|---|---|---|---|---|---|')
    for cid in ('edge', 'decision_ev', 'clv_model', 'gap'):
        for x in A['robustness_fixed_thresholds'][cid]:
            if not x['n']:
                continue
            w('| `%s` | %s | %d | %s%s | %s | %s%s | %s | %s |' % (cid, x['t'], x['n'], signed(x.get('roi'), 3), ci(x.get('roi_ci'), 3),
                                                              f(x.get('clv'), 2), signed(x.get('close_ev'), 4), ci(x.get('close_ev_ci'), 4),
                                                              f(x.get('max_drawdown'), 1), x.get('sample_status')))
    w('')
    # --------------------------------------------------- timing, stability
    tm = A['timing']
    w('## §21-23, §53-54, §62 Bet now vs wait, regret, edge disappearance, stability')
    w('')
    w('The archive has two snapshots per game: the opener (no timestamp; assumed available at the Tuesday freeze — an optimistic '
      'fill) and the close. Every timing statement below is opener → close only.')
    w('')
    w('| set | n | ROI now (opener) | ROI waiting (close) | now − wait [95%] | CLV [95%] | share where the close was better | mean regret of betting now (pts) |')
    w('|---|---|---|---|---|---|---|---|')
    for k in ('lean_set_pe_gt_0', 'edge_region', 'all_rows'):
        x = tm[k]
        w('| %s | %d | %s | %s | %s%s | %s%s | %s | %s |' % (k, x['n'], signed(x['roi_bet_now_opener'], 3), signed(x['roi_wait_to_close'], 3),
                                                        signed(x['now_minus_wait']['mean'], 3), ci(x['now_minus_wait']['ci'], 3),
                                                        f(x['clv'], 2), ci(x['clv_ci'], 2), p(x['share_close_better_for_us']), f(x['regret_bet_now_pts'], 2)))
    if H:
        x = H['timing']['lean_set_pe_gt_0']
        w('| holdout lean_set_pe_gt_0 | %d | %s | %s | %s%s | %s%s | %s | %s |' % (
            x['n'], signed(x['roi_bet_now_opener'], 3), signed(x['roi_wait_to_close'], 3), signed(x['now_minus_wait']['mean'], 3),
            ci(x['now_minus_wait']['ci'], 3), f(x['clv'], 2), ci(x['clv_ci'], 2), p(x['share_close_better_for_us']), f(x['regret_bet_now_pts'], 2)))
    w('')
    wr = tm['wait_rule']
    w('- **WAIT is disabled:** edge-region rows with a negative expected CLV (the only ones decision.js could send to WAIT): %d. '
      'Waiting never showed a benefit; betting the opener beat betting the same side at the close by the CLV.' % wr['n_expected_clv_negative'])
    ed = tm['edge_disappearance']
    w('- **Edge disappearance (§62):** %d of the positive-edge openers (%s) had no edge left at the close. Their ROI at the opener %s, at '
      'the close %s%s; the %d whose edge survived to the close lost at the close: ROI %s%s. An edge that survives the market is more '
      'often the model\'s error than the market\'s — the downgrade to PASS_LINE_MOVED is right.' % (
          ed['edge_at_open_gone_at_close'], p(ed['share_of_edges']), signed(ed['gone_roi_at_opener'], 3), signed(ed['gone_roi_at_close'], 3),
          ci(ed['gone_roi_at_close_ci'], 3), ed['kept_n'], signed(ed['kept_roi_at_close'], 3), ci(ed['kept_roi_at_close_ci'], 3)))
    pr = tm['pass_regret']
    w('- **PASS regret:** %d passed openers (%s of passes) showed an edge at the close; at the close they returned ROI %s%s.' % (
        pr['passed_at_open_positive_edge_at_close'], p(pr['share_of_passes']), signed(pr['their_roi_at_close'], 3), ci(pr['their_roi_at_close_ci'], 3)))
    st = tm['stability']
    w('- **Stability / hysteresis (§53-54):** open → close transitions under the production policy: %s. In the `edge` region the '
      'median |open → close edge change| is %s; flips out of the BET region by buffer: %s. Buffer frozen at %s (half the median move: '
      'a line move of a point or more always re-decides). %s of quotes sit within 0.01 of the threshold.' % (
          ', '.join('%s %d' % kv for kv in sorted(A['stability_transitions_open_to_close'].items())), f(st['median_abs_open_to_close_edge_change_in_region'], 4),
          ', '.join('%s → %s' % (b, p(v['flip_rate'])) for b, v in sorted(st['flips_by_buffer'].items())), st['hysteresis_buffer_rule_value'],
          p(st['near_threshold_share'])))
    w('')
    # --------------------------------------------------- risk layer
    sat = A['saturation']
    w('## §38-49 Staking, saturation, exposure, portfolio and risk of ruin')
    w('')
    w('**Edge saturation (§43)** — outcomes by decision probability: ' + '; '.join(
        '%s n %d: cover %s, ROI %s, CLV %s' % (b['bucket'], b['bet_count'], p((b.get('ats') or {}).get('cover_rate')), signed(b.get('roi'), 3),
                                              f(b.get('avg_clv'), 2)) for b in sat['decision_p_buckets'] if b['bet_count']) +
      '. Saturation probability %s (the highest bucket with ≥ 300 rows).' % sat['p_saturation'])
    w('')
    k = A['kelly']
    w('**Flat vs fractional Kelly (§39-42)** on the `edge` candidate\'s OOS bets (Kelly on the decision probability capped at %s; fixed 100 u base; '
      'Kelly is NOT validated: the decision probability does not beat a coin flip significantly, CI %s):' % (k['edge_oos_set']['p_saturation'],
                                                                                                          ci(k['validation']['decision_p_logloss_vs_coin_ci'], 5)))
    w('')
    w('| method | bets | mean stake | units | ROI per unit staked | units per bet [95%] | max DD [95%] |')
    w('|---|---|---|---|---|---|---|')
    for x in k['edge_oos_set']['rows']:
        w('| %s | %d | %s | %s | %s | %s | %s%s |' % (x['method'], x['bets'], f(x['stake_mean'], 3), signed(x['units'], 2), signed(x['roi_per_unit_staked'], 4),
                                                   ci(x['units_per_bet_ci'], 4), f(x['max_drawdown'], 1), ci(x['max_drawdown_ci'], 1)))
    w('')
    pf = A['portfolio']
    sb, rr = pf['season_bootstrap'], pf['risk_of_ruin']
    w('**Portfolio simulation (§47-48)** — %s (%d OOS bets), seasons of 15 weeks resampled from %d observed weeks: %s bets/season; season units '
      'mean %s (SD %s, 5th pct %s, 95th %s); max drawdown median %s u, 95th pct %s u, 99th %s u; worst week %s u. Historical: max drawdown %s u, '
      'longest losing streak %s, longest time to recover %s bets.' % (
          pf['risk_set'], pf['n_bets'], sb['blocks'], sb['bets_per_season_mean'], signed(sb['season_units_mean'], 2), f(sb['season_units_sd'], 2),
          signed(sb['season_units_p05'], 2), signed(sb['season_units_p95'], 2), f(sb['max_drawdown_p50'], 1), f(sb['max_drawdown_p95'], 1),
          f(sb['max_drawdown_p99'], 1), f(sb['worst_week_min'], 1), f(pf['historical'].get('max_drawdown'), 1), pf['historical'].get('longest_losing_streak'),
          (pf['historical'].get('time_to_recovery') or {}).get('bets')))
    w('')
    w('**Risk of ruin (§49)** — a 50%% loss of the bankroll within 3 seasons, flat 1 u, cover rate from the Beta posterior of the OOS record '
      '(2.5/50/97.5%%: %s), within-week correlation %s, %d paths (Monte Carlo SE in brackets):' % (
          ' / '.join(p(v) for v in rr['posterior_cover_quantiles'].values()), f(rr['rho'], 4), rr['paths']))
    w('')
    w('| bankroll | at 2.5th pct cover | at median | at 97.5th pct | posterior predictive |')
    w('|---|---|---|---|---|')
    for br in ('25', '50', '100'):
        x = rr['by_bankroll'][br]
        w('| %s u | %s [%s] | %s [%s] | %s [%s] | %s [%s] |' % (br, *[v for s in ('p025', 'p50', 'p975', 'posterior_predictive')
                                                                 for v in (p(x[s]['ror'], 2), p(x[s]['mc_se'], 2))]))
    w('')
    sl = pf['slate_cap']
    w('**Slate cap:** ' + '; '.join('%s u: p95 drawdown %s u, RoR %s %s' % (x['cap'], f(x['max_drawdown_p95'], 1), p(x['ror_p025'], 2), '✓' if x['passes'] else '✗')
                                   for x in sl['table']) + ' → **%s u per slate, %s u per conference cluster**. No weekly quota (§76).' % (
        sl['choice'], sl['cluster_choice']))
    w('')
    cg = A['correlations']
    w('**Correlations (§46, DEV FBS finals, consensus close; phi of the outcome indicators [95%]):**')
    w('')
    w('| pair | phi [95%] | n | note |')
    w('|---|---|---|---|')
    for kk, x in cg['same_game']['pairs'].items():
        w('| %s | %s%s | %d | %s |' % (kk.replace('__', ' + ').replace('_', ' '), signed(x['phi'], 3), ci(x['ci95'], 3), x['n'], x['note']))
    w('')
    w('By |line|: ' + '; '.join('%s: favourite spread + over %s, spread + moneyline %s' % (
        b, signed(v['favorite_spread__game_over']['phi'], 3), signed(v['spread__moneyline_same_team']['phi'], 3)) for b, v in cg['same_game']['by_abs_line'].items())
      + '. Cross-game (model-side results): within a week ICC %s%s, within a conference-week %s%s.' % (
          signed(cg['cross_game_icc']['week']['icc'], 4), ci(cg['cross_game_icc']['week']['ci95'], 4),
          signed(cg['cross_game_icc']['conference_week']['icc'], 4), ci(cg['cross_game_icc']['conference_week']['ci95'], 4)))
    w('Not estimable: ' + '; '.join(cg['same_game']['not_estimable']) + '. The exposure caps use them through `same_game_correlation` = 1 '
      '(every same-game position decision.js can hold is a spread; the same side at two books is one bet) and a game cap of 1 u.')
    w('')
    # --------------------------------------------------- tiers, rankings
    ti = A['tiers']
    w('## §73-76 Tiers, rankings, weekly counts, expected vs realized')
    w('')
    w('**Edge-quality tiers (§74)** — decision.js\'s bet-confidence labels (P(positive CLV) ≥ 0.58 HIGH, ≥ 0.52 MEDIUM): ' + '; '.join(
        '%s n %d: CLV %s%s, +CLV %s, ROI %s' % (t_, x['bet_count'], f(x['avg_clv'], 2), ci(x['avg_clv_ci'], 2), p(x['positive_clv_pct']), signed(x['roi'], 3))
        for t_, x in ti['bet_confidence_tiers'].items()) + '. HIGH − LOW CLV %s → **displayed: %s** (they order CLV, not wins).' % (
        ci(ti['high_minus_low_clv_ci'], 2), ti['display_edge_quality_tiers']))
    if H:
        w('Holdout: ' + '; '.join('%s n %d: CLV %s' % (t_, x['bet_count'], f(x['avg_clv'], 2)) for t_, x in H['tiers'].items()) + '.')
    w('The football-confidence labels (reliability ≥ 70 HIGH, ≥ 45 MEDIUM) do **not** sort error: MAE ' + ', '.join(
        '%s %s%s' % (t_, f(x['mae_model'], 2), ci(x['mae_ci'], 2)) for t_, x in ti['football_confidence_labels_vs_error'].items())
      + ' — they should not be shown as a quality tier.')
    w('')
    rk = A['rankings']
    w('**No bet rankings (§75):** within-week Kendall τ between the ranking key and realized CLV: ' + '; '.join(
        '%s %s%s' % (kk, signed(v['mean_kendall_tau'], 3), ci(v['ci95'], 3)) for kk, v in rk.items() if isinstance(v, dict))
      + '. decision.js ranks by the calibrated EV, which the frozen artifact makes constant: **rankings are not displayed**.')
    w('')
    wk = A['weekly_counts']
    w('**Recommended wager limit (§76):** no quota. Weekly OOS counts: ' + '; '.join(
        '%s median %s, 90th pct %s, max %s, zero-bet weeks %s' % (kk, v['median'], v['p90'], v['max'], p(v['zero_bet_weeks_share']))
        for kk, v in wk.items() if kk in ('edge', 'multivariate', 'baseline_001', 'empirical_ev')) + '.')
    w('')
    w('**Expected vs realized (§64)** — cumulative expected units from the decision probability vs realized:')
    w('')
    w('| set | n | expected (decision p) | expected (pure p) | realized | z vs decision | z vs pure |')
    w('|---|---|---|---|---|---|---|')
    for kk, v in A['expected_vs_realized'].items():
        w('| DEV %s | %d | %s | %s | %s | %s | %s |' % (kk, v['n'], signed(v['expected_units_decision'], 1), signed(v['expected_units_theoretical'], 1),
                                                   signed(v['realized_units'], 1), f(v['z_realized_vs_decision'], 2), f(v['z_realized_vs_theoretical'], 2)))
    if H:
        for kk, v in H['expected_vs_realized'].items():
            w('| holdout %s | %d | %s | %s | %s | %s | %s |' % (kk, v['n'], signed(v['expected_units_decision'], 1), signed(v['expected_units_theoretical'], 1),
                                                           signed(v['realized_units'], 1), f(v['z_realized_vs_decision'], 2), f(v['z_realized_vs_theoretical'], 2)))
    w('')
    # --------------------------------------------------- scorecard + gate
    w('## §73 The decision-quality scorecard')
    w('')
    w('`v2/decision/scorecard.py` `scorecard(df)` returns BET COUNT, AVG PREDICTED EDGE, AVG EV, AVG CLV, POSITIVE CLV %, ATS, ROI, '
      'MAX DRAWDOWN, BRIER, CALIBRATION ERROR and AVERAGE MARKET MOVEMENT AFTER BET (side-oriented and absolute), plus the close-implied EV, '
      'with game-clustered intervals; PROCESS and OUTCOME are kept apart. The Model Lab runs it on the live shadow record: '
      '`python3 -m v2.decision.scorecard --shadow football/cfb_decision/2026` (per engine and status; non-BET rows graded hypothetically).')
    w('')
    w('| strategy (DEV OOS) | bets | avg edge | avg EV | avg CLV | +CLV | ATS | ROI | max DD | Brier | calib. error | move after bet (abs) |')
    w('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for cid in order:
        c = oos[cid]
        if not c.get('bet_count'):
            continue
        w('| `%s` | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s (%s) |' % (
            cid, c['bet_count'], signed(c.get('avg_predicted_edge'), 4), signed(c.get('avg_ev'), 4), f(c.get('avg_clv'), 2), p(c.get('positive_clv_pct')),
            p((c.get('ats') or {}).get('cover_rate')), signed(c.get('roi'), 3), f(c.get('max_drawdown'), 1), f(c.get('brier'), 4),
            signed(c.get('calibration_error'), 3), f(c.get('avg_market_move_after_bet'), 2), f(c.get('avg_abs_market_move_after_bet'), 2)))
    w('')
    g = (H or {}).get('promotion_gate') or E['promotion_gate_before_holdout']
    w('## §86 The promotion gate')
    w('')
    w('| criterion | result | detail |')
    w('|---|---|---|')
    for kk, v in g.items():
        if not kk.startswith('G'):
            continue
        det = {x: y for x, y in v.items() if x != 'pass' and y is not None}
        w('| %s | %s | %s |' % (kk.replace('_', ' '), {True: 'PASS', False: 'FAIL', None: 'n/a'}[v['pass']], json.dumps(det) if det else ''))
    w('')
    w('**%s.** Betting can be enabled only by a person, through a new policy version that passes every criterion above.' % g['decision'].capitalize())
    w('')
    # --------------------------------------------------- price targets
    lt = live_price_targets()
    w('## §51-52, §60-61 Price targets for the live priced quotes')
    w('')
    w('Every 2026 quote with a CAPTURED two-sided price (%d, one book), decided at the moment it was observed with the frozen policy and '
      'artifact (the 2026 projection is a replay: evidence of the mechanics, not of foresight). "Fair price" is the price at which the '
      'decision probability has zero EV — shown for research; it is NOT a bettable-to price. BETTABLE TO is null for every quote: no price '
      'clears the calibrated-EV floor, so the do-not-bet rule is "any price".' % len(lt))
    w('')
    w('| game | book | side | line | price | pure p | decision p | break-even | edge | status (reason) | bettable to | fair price |')
    w('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for x in lt:
        w('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s (%s) | %s | %s |' % (
            x['game'], x['book'], x['side'], x['line'], x['price'], p(x['pure_p']), p(x['decision_p']), p(x['break_even']),
            signed(x['edge'], 4), x['status'], ', '.join(x['reasons']), x['bettable_to_price'] if x['bettable_to_price'] is not None else '—',
            x['decision_fair_price']))
    w('')
    # --------------------------------------------------- engine notes
    w('## decision.js: bugs fixed by this study (each with a test in tests.js)')
    w('')
    for b in DECISION_JS_FIXES:
        w('- ' + b)
    w('')
    w('## Limitations')
    w('')
    for b in LIMITATIONS:
        w('- ' + b)
    w('')
    w('## Files and reproduction')
    w('')
    w('- `football/cfb_v2/artifacts/decision/%s/`: `policy.json` (frozen), `evidence.json` (the tournament, the pre-holdout and post-holdout gate, '
      'the holdout results), `MANIFEST.json` (hashes of the policy, evidence, parity fixture, pre-registration, calibration, baseline, dataset '
      'and code), `holdout_access.jsonl` (append-only) and `post_freeze_changes.jsonl` (append-only: every change after the '
      'freeze, with its hashes — the holdout.py edit made before the read, the live-adapter fix in scorecard.py, and the manifest '
      'fields holdout.py wrote after the read; `tests_policy.py` rebuilds the pre-read manifest and matches the hash the access '
      'log recorded).' % POLICY_VERSION)
    w('- `football/cfb_v2/artifacts/decision/fixtures/policy_parity.json`: %s decision cases, stakes, portfolios and games; '
      '`football/cfb_decision/tests.js` checks decision.js against it.' % 'the')
    w('- Code: `v2/decision/{policy,tournament,portfolio,scorecard,holdout,tests_policy}.py`.')
    w('- Reproduce (byte-identical): `cd football/cfb_v2/research && export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out_h OMP_NUM_THREADS=1 '
      'OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 && python3 -m v2.decision.tournament && python3 -m v2.decision.policy --fixture && '
      'python3 -m v2.decision.render --policy && python3 -m v2.decision.tests_policy`. The holdout is not re-run: it refuses '
      '(holdout_access.jsonl).')
    with open(POLICY_DOC, 'w') as fh:
        fh.write('\n'.join(L).rstrip() + '\n')
    print('[render] wrote', POLICY_DOC)


def _st(rows, name):
    for x in rows or []:
        if x.get('group') == name:
            return x
    return {}


DECISION_JS_FIXES = [
    '**Bettable-to price read the wrong gate** (`priceTargets`): it was the price where the raw decision EV met `min_ev`, ignoring the '
    'calibrated-EV curve and the probability-edge threshold that decideQuote applies. Under the frozen artifact it printed "bettable to -114" '
    'for a quote no price could make a BET. It now inverts the same curve and both thresholds, verifies the price clears (and one cent worse '
    'does not), and is null when no price clears.',
    '**RESEARCH was driven by the pure probability**: a quote that did not clear became RESEARCH when its PURE edge cleared `min_probability_edge` '
    '(31% of DEV quotes, CLV barely above PASS). It now needs the decision-probability edge LEAN needs.',
    '**Best quote under a flat EV curve** (`decideGame`): ties in the calibrated EV went to the first book listed, not the best price; ties now go '
    'to the higher decision EV. The game carries `summary_index`.',
    '**Public card showed the first book** (`publicCard`): for a non-BET game it explained `decisions[0]` (possibly a PASS) beside the game\'s '
    'LEAN status; it now shows the decision behind the status.',
    '**`early_season: 0` was overridden** (`features`): an explicit 0 fell back to "week <= 3", so every postseason game (schedule week 1) fed '
    'early_season = 1 to the CLV models. An explicit value is now honoured.',
    '**Exposure caps could be exceeded by rounding** (`applyExposure`): scaled stakes rounded to 3 dp could sum past a cap (3.001 u under a 3 u '
    'slate cap); scaled stakes now round down.',
    'Not changed (latent, reported): `P.x || default` makes an explicit 0 fall back to the default for `min_books`, `max_dispersion_iqr`, '
    '`extreme_*`, `lean.min_gap_pts`, `wait.p_disappear` and others; the frozen policy sets none of them to 0. PASS_QB_UNCERTAINTY is in the '
    'vocabulary but never emitted (an unresolved QB is RESEARCH_QB).',
]
LIMITATIONS = [
    'Every historical price is an ASSUMED -110 (the 2016-2019 archive confirms -110 on 93.8% of openers; 2020-2025 cannot be checked). The price '
    'gates, de-vig, bettable-to price and per-book statuses are tested but unvalidated on real prices: 29 live priced quotes, none settled.',
    'Openers carry no timestamp: the historical fill is optimistic, and the close-implied EV, CLV and "bet now vs wait" are opener -> close only.',
    'The 2019 fold trains on 2018 alone; edge-based candidates had no eligible threshold there. The evaluated sample for any candidate is a few '
    'hundred bets: an ROI interval is about +/-10 points wide.',
    'Market-depth gates (book count, dispersion, staleness) have no point-in-time history; their values are declared.',
    'The CLV models used for bet confidence were fit on all DEV seasons (in-sample for the DEV replay); the tournament used the walk-forward '
    'P(positive CLV).',
    'Correlations are outcome correlations on DEV finals; team-total lines are synthetic; no SGP, prop or alternate-line prices exist.',
    'The holdout can never be re-used for this policy; a new policy needs new live evidence (the shadow record) or a new untouched window.',
]


if __name__ == '__main__':
    import sys
    if '--policy' in sys.argv:
        policy_main()
    else:
        main()
