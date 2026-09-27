"""Bias audit of EdgeDesk and of the market (brief section 75;
docs/cfb-market/METHODS.md).

    python3 -m v2.market_intel.bias

For each group (favourites, underdogs, home, road, P4 in P4-vs-G5 games,
conferences in non-conference games, pre-registered national brands, huge
spreads, totals) it reports, from the GROUP'S side, with n and bootstrap CIs:

  * market: cover rate at the close and at the opener (pushes excluded), and
    the mean residual (margin - line) — is the market biased against the group?
  * EdgeDesk: its mean error (margin - pure) — does EdgeDesk underrate the group?
  * the market engine's LEAN: how often EdgeDesk's side against the opener is
    the group's side, and the against-the-spread record of those picks against
    EdgeDesk's other picks. A lean is only acceptable if the record supports it.

DEV 2016-2023 only. A group is a finding only when its CI excludes the null
(and with 30+ groups some will by chance: see the multiplicity note).
"""
import argparse

import numpy as np
import pandas as pd

from . import data as D


def population(X, seasons):
    Q = X[X.fbs_fbs & X.final & X.season.isin(seasons) & X.open_ok & X.close_margin.notna() & X.ens_pred.notna()
          & ~X.eval_open_close_jump.fillna(False).astype(bool)].copy()
    Q['gap_open'] = Q.ens_pred - Q.open_margin
    return Q.reset_index(drop=True)


def side_table(Q, grp_home, valid, label):
    """grp_home: True when the group's side is the home team (valid rows only)."""
    Z = Q[valid].reset_index(drop=True)
    s = np.where(grp_home[valid], 1.0, -1.0)
    if len(Z) < 30:
        return {'group': label, 'n': int(len(Z))}
    bt = D.Boot(len(Z))
    rc = (Z.margin - Z.close_margin).values * s
    ro = (Z.margin - Z.open_margin).values * s
    cov_c = np.where(rc > 0, 1.0, np.where(rc < 0, 0.0, np.nan))
    cov_o = np.where(ro > 0, 1.0, np.where(ro < 0, 0.0, np.nan))
    err = (Z.margin - Z.ens_pred).values * s                    # + = EdgeDesk underrated the group
    pick_grp = (Z.gap_open.values * s) > 0                      # EdgeDesk's side vs the opener is the group's
    ed_side = np.sign(Z.gap_open.values)
    r_ed = (Z.margin - Z.open_margin).values * ed_side
    ed_win = np.where(r_ed > 0, 1.0, np.where(r_ed < 0, 0.0, np.nan))
    ok = np.isfinite(ed_win) & (Z.gap_open.values != 0)
    return {'group': label, 'n': int(len(Z)),
            'market_cover_rate_close': D.cell(bt.mean(cov_c), 3),
            'market_cover_rate_open': D.cell(bt.mean(cov_o), 3),
            'market_residual_close_pts': D.cell(bt.mean(rc), 3),
            'edgedesk_error_pts (+ = underrates the group)': D.cell(bt.mean(err), 3),
            'edgedesk_picks_group_share': D.cell(bt.mean(pick_grp.astype(float)), 3),
            'edgedesk_ats_open_when_picking_group': D.cell(bt.mean(ed_win, mask=ok & pick_grp), 3),
            'edgedesk_ats_open_when_picking_other': D.cell(bt.mean(ed_win, mask=ok & ~pick_grp), 3)}


def groups(Q):
    fav_home_c = Q.close_margin.values > 0
    notpk = Q.close_margin.values != 0
    nn = ~Q.neutral_site.fillna(False).astype(bool).values
    cross = (Q.home_p4.values != Q.away_p4.values)
    out = [side_table(Q, fav_home_c, notpk, 'favourite (closing line)'),
           side_table(Q, ~fav_home_c, notpk, 'underdog (closing line)'),
           side_table(Q, np.ones(len(Q), bool), nn, 'home team (non-neutral)'),
           side_table(Q, np.zeros(len(Q), bool), nn, 'road team (non-neutral)'),
           side_table(Q, Q.home_p4.values, cross, 'P4 side in P4 vs G5'),
           side_table(Q, ~Q.home_p4.values, cross, 'G5 side in P4 vs G5')]
    fl = Q.close_margin.abs().values
    for lo, hi, lab in ((0.5, 7, 'favourite laying 0.5-7'), (7.5, 14, 'favourite laying 7.5-14'),
                        (14.5, 21, 'favourite laying 14.5-21'), (21.5, 99, 'favourite laying 21.5+ (huge spreads)')):
        m = notpk & (fl >= lo) & (fl <= hi)
        out.append(side_table(Q, fav_home_c, m, lab))
    hp = Q.home_team.isin(D.POPULAR).values
    ap = Q.away_team.isin(D.POPULAR).values
    out.append(side_table(Q, hp, hp != ap, 'national brand side (pre-registered list) vs a non-brand'))
    confs = {}
    hc, ac = Q.home_conference.fillna('').values, Q.away_conference.fillna('').values
    for c in sorted(set(hc) | set(ac)):
        if not c:
            continue
        m = (hc == c) != (ac == c)
        if m.sum() >= 100:
            confs[c] = side_table(Q, hc == c, m, 'conference: ' + c + ' side in non-conference games')
    return out, list(confs.values())


def totals(Q):
    Z = Q[Q.total_close.notna() & Q.total_open.notna() & Q.pred_total.notna()].reset_index(drop=True)
    bt = D.Boot(len(Z))
    oc = np.where(Z.total_pts > Z.total_close, 1.0, np.where(Z.total_pts < Z.total_close, 0.0, np.nan))
    oo = np.where(Z.total_pts > Z.total_open, 1.0, np.where(Z.total_pts < Z.total_open, 0.0, np.nan))
    err = (Z.total_pts - Z.pred_total).values
    ed_over = (Z.pred_total - Z.total_open).values > 0
    r_ed = (Z.total_pts - Z.total_open).values * np.where(ed_over, 1, -1)
    w = np.where(r_ed > 0, 1.0, np.where(r_ed < 0, 0.0, np.nan))
    mv = (Z.total_close - Z.total_open).values * np.where(ed_over, 1, -1)
    return {'n': int(len(Z)), 'over_rate_close': D.cell(bt.mean(oc), 3), 'over_rate_open': D.cell(bt.mean(oo), 3),
            'market_residual_close_pts': D.cell(bt.mean((Z.total_pts - Z.total_close).values), 3),
            'edgedesk_total_error_pts (+ = EdgeDesk too low)': D.cell(bt.mean(err), 3),
            'edgedesk_leans_over_share': D.cell(bt.mean(ed_over.astype(float)), 3),
            'edgedesk_total_side_hit_rate_open': D.cell(bt.mean(w), 3),
            'edgedesk_total_side_hit_rate_open_when_over': D.cell(bt.mean(w, mask=ed_over), 3),
            'edgedesk_total_side_hit_rate_open_when_under': D.cell(bt.mean(w, mask=~ed_over), 3),
            'total_close_moved_toward_edgedesk_pts': D.cell(bt.mean(mv), 3),
            'note': 'EdgeDesk publishes no totals product; its pred_total is the pure layer\'s total and is audited here only as a bias check'}


def flag(rows):
    """a group is a candidate bias when a CI excludes its null."""
    out = []
    for r_ in rows:
        if 'market_cover_rate_close' not in r_:
            continue
        f = []
        if D.ci_excludes(r_['market_cover_rate_close'], 0.5):
            f.append('market cover rate at the close')
        if D.ci_excludes(r_['edgedesk_error_pts (+ = underrates the group)'], 0.0):
            f.append('EdgeDesk error')
        pg, po = r_['edgedesk_ats_open_when_picking_group'], r_['edgedesk_ats_open_when_picking_other']
        if D.ci_excludes(r_['edgedesk_picks_group_share'], 0.5):
            f.append('EdgeDesk lean (%.1f%% of its picks)' % (100 * r_['edgedesk_picks_group_share']['est']))
        if f:
            out.append({'group': r_['group'], 'n': r_['n'], 'ci_excludes_null': f,
                        'lean_supported_by_ats': (pg['est'] is not None and po['est'] is not None and pg['ci'][0] is not None and pg['ci'][0] > 0.5)})
    return out


def run():
    X = D.frame()
    Q = population(X, D.DEV)
    main, conf = groups(Q)
    res = {'n': int(len(Q)), 'groups': main, 'conferences': conf, 'totals': totals(Q),
           'flags': flag(main + conf),
           'multiplicity': '%d group rows x several statistics: at 95%% about 1 in 20 null statistics excludes its null by chance' % (len(main) + len(conf))}
    D.write_json('bias.json', res)
    return res


if __name__ == '__main__':
    argparse.ArgumentParser().parse_args()
    r = run()
    print('bias: %d games, %d flagged' % (r['n'], len(r['flags'])))
