#!/usr/bin/env python3
"""EdgeDesk CFB Power 4 — the market table.

This is the file that changes what the repo is allowed to claim about CFB.
`football/README.md` and `football/params.js` currently state that no public
historical CFB betting-line archive exists. One does:
`sportsdataverse/cfbfastR-data betting/csv/cfb_line_odds.csv.gz` — 1.18M rows,
2006-2025, spread + total + moneyline, OPENING and closing numbers, multiple
books including Pinnacle. Coverage of completed FBS-vs-FBS games is 96-100%
from 2015 on. A real CFB market backtest is therefore possible, and the model
is held to it.

Everything about the file's semantics below was established by execution, not
assumed:

* `game_id` joins 1:1 to the schedules' `game_id`, and the archive's
  `home_team_id`/`away_team_id` match the schedules' `home_id`/`away_id`
  exactly (checked on 2019: 100% agreement).
* `game_desc` is "Away@Home".
* For market_type='spread' and 'money_line', `abbr` names ONE SIDE and the
  row's number belongs to that side (negative spread = favourite). Verified
  on real games: USC (home) -14 / San José State +14, final 30-7.
* For market_type='total', `abbr` is 'over'/'under'.
* `abbr` is a team ABBREVIATION whose vocabulary drifts across eras, so it is
  never string-matched to a school name. Each abbr is resolved to a team_id
  by intersection: the id that appears in EVERY game the abbr appears in.
  That is purely data-derived and survives any renaming.
* `lines`/`odds` are the current (closing) numbers, `opening_lines`/
  `opening_odds` the openers. Both are kept; neither is imputed from the
  other.

EdgeDesk convention on output: `spread_line` is the number of points the HOME
team must win by. Home -14 in book terms becomes spread_line = +14.

Orientation and book-sign QA (EdgeDesk CFB audit finding F-11, fixed 2026-09-27;
rule `MARKET_ORIENTATION_RULE`). Established by execution on the full archive:

* The archive's `home_team_id`/`away_team_id` are SWAPPED relative to the
  schedule in 12 games (2020-2024, e.g. Army-Navy 2021, UTSA-Coastal 2024). Sides
  are oriented against the SCHEDULE's home_id/away_id (the archive's ids are used
  only for a game the schedule does not carry). In those games the archive's side
  LABELS also contradict each other across books: Army-Navy 2021 has Bovada (and
  its moneyline, Army -300) at Army -7 and three feeds (Caesars, consensus,
  teamrankings) at Army +7; New Mexico-San Jose State 2020 is 1 book against 5;
  UNC-South Carolina 2023 has a Bovada spread and moneyline of opposite sides. No
  rule on the lines alone recovers the true number, so a game whose archive ids
  are swapped does not use its side-labelled lines (spreads and moneylines):
  `side_resolution = archive_ids_swapped`, counted in market_qa.json; its total
  is kept. The line is left missing, never guessed.
* An abbreviation seen only against one opponent (LAF: only ever vs Army) maps
  to both teams equally often, so both of a game's sides could resolve to the
  home team and the median of +33.5 and -33.5 became a 0.0 line (Army-Lafayette
  2016/2018, Buffalo-Robert Morris 2019). Each game's abbreviations are assigned
  to its two team ids with the counts of `resolve_abbr_sides`: an abbreviation
  belongs to the team id(s) it is seen with most often over the whole archive; one
  whose most frequent id is neither of the game's teams is a stray row of another
  game and is ignored (UMass-Boston College 2014 also carries Ball State-Colgate
  rows); one tied between the game's two teams takes the side its partner does not
  hold; two abbreviations claiming the same side, or a tie with nothing to break
  it, is `side_resolution = unresolved` and those rows are not used (never guessed).
* One book's line can carry the opposite sign of the others (intertops and
  Sports Interaction 2014, JUSTBET 2008, ESPN Bet / DraftKings openers
  2023-25). Declared rule, per game and separately for the opener and the
  close, on each book's home-margin line: the books with a non-zero line vote
  by sign; a line whose sign is opposite to a STRICT majority of the voting
  books and whose size is at least `SIGN_RULE_MIN_ABS` points is DROPPED (a
  line within 2.5 of pick'em on the other side is an ordinary disagreement and
  is kept). With no strict majority and a line of that size on each side the
  field is UNRESOLVED: every line of it is dropped and the consensus is left
  missing. Dropped lines stay in market_books.csv with `sign_conflict` =
  dropped | unresolved; each game carries the counts
  (`spread_open_books_dropped`, `spread_close_books_dropped`,
  `spread_open_sign_unresolved`, `spread_close_sign_unresolved`), and
  <out>/market_qa.json the totals.

Usage: python3 build_market.py <out_dir>
Writes <out>/market.csv (one row per game), <out>/market_books.csv
(one row per game x book x market, for book-level work such as de-vig) and
<out>/market_qa.json (orientation and sign-rule counts).
"""
import os
import sys

import json

import numpy as np
import pandas as pd

import common

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'

SHARP_BOOKS = ('PINNACLE', 'Pinnacle')

MARKET_ORIENTATION_RULE = 'cfb_market_orientation_v2'   # v1: archive ids, global abbr map, no sign rule
SIGN_RULE_MIN_ABS = 3.0


def _load_raw():
    p = os.path.join(common.DATA, 'betting', 'cfb_line_odds.csv.gz')
    if not os.path.exists(p):
        raise SystemExit('missing %s — run fetch_data.sh' % p)
    L = pd.read_csv(p, low_memory=False)
    for c in ('game_id', 'season', 'week', 'lines', 'odds', 'opening_lines',
              'opening_odds', 'home_team_id', 'away_team_id'):
        L[c] = pd.to_numeric(L[c], errors='coerce')
    # The archive carries genuine duplicate rows: 1,183,529 raw collapses to
    # ~998,701 distinct. Left in, they double-weight whichever books happen to
    # be duplicated, which quietly biases every consensus median.
    before = len(L)
    L = L.drop_duplicates(subset=['game_id', 'market_type', 'abbr', 'book',
                                  'lines', 'odds', 'opening_lines', 'opening_odds'])
    print('[dedup] %d raw rows -> %d distinct (%.1f%% were duplicates)'
          % (before, len(L), 100.0 * (before - len(L)) / max(before, 1)))
    L = L[L.game_id.notna()].copy()
    L['game_id'] = L.game_id.astype('int64')
    L['abbr'] = L.abbr.astype(str)
    L['book'] = L.book.fillna('unknown').astype(str)
    return L


def resolve_abbr_sides(L):
    """abbr -> team_id, by intersection over every game the abbr appears in.

    An abbr's true team id is the single id present in {home_team_id,
    away_team_id} for ALL of its rows. Counting rather than set-intersecting
    keeps one corrupt row from destroying an otherwise unanimous mapping;
    the agreement rate is reported so a degraded mapping is visible instead
    of silent."""
    side = L[L.market_type.isin(('spread', 'money_line'))].copy()
    side = side[side.abbr.str.lower().ne('nan')]

    long = pd.concat([
        side[['abbr', 'game_id', 'home_team_id']].rename(columns={'home_team_id': 'tid'}),
        side[['abbr', 'game_id', 'away_team_id']].rename(columns={'away_team_id': 'tid'}),
    ], ignore_index=True).dropna(subset=['tid'])

    cnt = long.groupby(['abbr', 'tid']).size().rename('n').reset_index()
    # denominator counts only rows that CARRY ids — otherwise an abbr whose
    # rows simply lack team ids looks like a mapping failure when the mapping
    # was never attempted on them.
    tot = (side[side.home_team_id.notna() & side.away_team_id.notna()]
           .groupby('abbr').size().rename('rows').reset_index())
    best = cnt.sort_values('n').groupby('abbr', as_index=False).last()
    best = best.merge(tot, on='abbr', how='left')
    best['agreement'] = best.n / best.rows
    best['ided_rows'] = best.rows
    return best


def _abbr_counts(L):
    """n(abbr, team_id): rows of the abbreviation carrying that id on either side
    (orientation-free evidence; the same counts resolve_abbr_sides ranks)."""
    side = L[L.market_type.isin(('spread', 'money_line'))]
    side = side[side.abbr.str.lower().ne('nan')]
    long = pd.concat([
        side[['abbr', 'home_team_id']].rename(columns={'home_team_id': 'tid'}),
        side[['abbr', 'away_team_id']].rename(columns={'away_team_id': 'tid'}),
    ], ignore_index=True).dropna(subset=['tid'])
    return long.groupby(['abbr', 'tid']).size().to_dict()


def schedule_ids():
    """{game_id: (home_id, away_id)} from the schedules (the orientation authority)."""
    g = common.load_schedules()[['game_id', 'home_id', 'away_id']].copy()
    g['game_id'] = pd.to_numeric(g.game_id, errors='coerce')
    g = g.dropna().drop_duplicates('game_id')
    return {int(a): (int(h), int(w)) for a, h, w in zip(g.game_id, g.home_id, g.away_id)}


def orient_sides(L, sched=None):
    """Per (game, abbr): 'home' | 'away' | None, oriented against the schedule's ids.
    Returns (assignment dict, per-game frame: game_id, home_id, away_id,
    archive_ids_swapped, side_resolution)."""
    sched = schedule_ids() if sched is None else sched
    cnt = _abbr_counts(L)
    best = {}
    for (x, t), n in cnt.items():
        best[x] = max(best.get(x, 0), n)
    tops = {}
    for (x, t), n in cnt.items():             # the id(s) each abbreviation is seen with most often
        if n == best[x]:
            tops.setdefault(x, set()).add(t)
    side = L[L.market_type.isin(('spread', 'money_line'))]
    side = side[side.abbr.str.lower().ne('nan')]
    arch = side.groupby('game_id')[['home_team_id', 'away_team_id']].agg(
        lambda x: x.dropna().mode().iloc[0] if x.notna().any() else np.nan)
    abbrs = side.groupby('game_id').abbr.agg(lambda x: sorted(set(x)))
    assign, games = {}, []
    for gid, ab in abbrs.items():
        ah, aa = arch.loc[gid, 'home_team_id'], arch.loc[gid, 'away_team_id']
        if int(gid) in sched:
            h, a = sched[int(gid)]
        elif pd.notna(ah) and pd.notna(aa):
            h, a = int(ah), int(aa)
        else:
            games.append((gid, np.nan, np.nan, False, 'unresolved'))
            continue
        swapped = bool(pd.notna(ah) and pd.notna(aa) and int(ah) == a and int(aa) == h and h != a)
        if swapped:                     # the archive's own side labels are unreliable here (module doc)
            for x in ab:
                assign[(gid, x)] = None
            games.append((gid, h, a, True, 'archive_ids_swapped'))
            continue
        ind = {}
        for x in ab:
            top = tops.get(x, set())
            mine = top & {float(h), float(a)}
            if not mine:
                assign[(gid, x)] = None             # a stray abbreviation of another game: ignored
                continue
            ind[x] = None if len(mine) == 2 else ('home' if mine == {float(h)} else 'away')
        how = 'ok'
        if len(ind) == 2:
            x, y = sorted(ind)
            if ind[x] is None and ind[y] is not None:
                ind[x], how = ('away' if ind[y] == 'home' else 'home'), 'elimination'
            elif ind[y] is None and ind[x] is not None:
                ind[y], how = ('away' if ind[x] == 'home' else 'home'), 'elimination'
            elif ind[x] is None or ind[x] == ind[y]:
                ind = {x: None, y: None}
        if not ind or any(v is None for v in ind.values()):
            how = 'unresolved'
        for x, v in ind.items():
            assign[(gid, x)] = v
        games.append((gid, h, a, swapped, how))
    G = pd.DataFrame(games, columns=['game_id', 'home_id', 'away_id', 'archive_ids_swapped', 'side_resolution'])
    return assign, G


def _side_frame(L, amap, sched=None):
    """spread/moneyline rows tagged home/away, oriented by TEAM ID against the
    schedule (see the module doc: F-11). `amap` is kept for the reported mapping
    quality; the orientation itself is orient_sides'."""
    s = L[L.market_type.isin(('spread', 'money_line'))].merge(
        amap[['abbr', 'tid', 'agreement']], on='abbr', how='left')
    assign, _ = orient_sides(L, sched)
    v = [assign.get((g, x)) for g, x in zip(s.game_id, s.abbr)]
    s['is_home'] = pd.Series([None if x is None else (x == 'home') for x in v], index=s.index, dtype=object)
    return s


def sign_rule(values, min_abs=SIGN_RULE_MIN_ABS):
    """One game's lines for one field (home-margin convention), one per book.
    Returns a list of None | 'dropped' | 'unresolved', aligned with `values`."""
    x = np.asarray(values, dtype=float)
    ok = ~np.isnan(x)
    pos, neg = int((x[ok] > 0).sum()), int((x[ok] < 0).sum())
    big = ok & (np.abs(np.where(ok, x, 0)) >= min_abs)
    out = [None] * len(x)
    if pos > neg:
        maj = 1.0
    elif neg > pos:
        maj = -1.0
    else:
        if (big & (x > 0)).any() and (big & (x < 0)).any():
            return ['unresolved' if o else None for o in ok]
        return out
    for i in np.where(big & (np.sign(np.where(ok, x, 0)) == -maj))[0]:
        out[i] = 'dropped'
    return out


def apply_sign_rule(sp):
    """sp: spread rows on the home side with spread_line / spread_open. Adds
    close_conflict / open_conflict (None | dropped | unresolved) per row; the verdict
    is per BOOK (the median of that book's rows), applied to all of its rows."""
    sp = sp.copy()
    for fld, col in (('close', 'spread_line'), ('open', 'spread_open')):
        per = sp.groupby(['game_id', 'book'])[col].median().dropna().reset_index()
        verdict = {}
        for gid, d in per.groupby('game_id'):
            for b, v in zip(d.book, sign_rule(d[col].values)):
                if v:
                    verdict[(gid, b)] = v
        sp[fld + '_conflict'] = [verdict.get((g, b)) for g, b in zip(sp.game_id, sp.book)]
    return sp


def _median(x):
    x = pd.to_numeric(x, errors='coerce').dropna()
    return float(np.median(x)) if len(x) else np.nan


def build():
    L = _load_raw()
    amap = resolve_abbr_sides(L)
    weak = amap[amap.agreement < 0.99]
    print('[abbr] %d abbreviations resolved; %d below 0.99 agreement'
          % (len(amap), len(weak)))
    if len(weak):
        print(weak.sort_values('agreement').head(12).to_string(index=False))

    sched = schedule_ids()
    assign, OG = orient_sides(L, sched)
    S = _side_frame(L, amap, sched)
    unresolved = S.is_home.isna().mean()
    print('[abbr] unresolved side rows: %.4f' % unresolved)
    print('[orient] games: %d; archive ids swapped vs the schedule (side lines not used): %d; sides by '
          'elimination: %d; unresolved: %d'
          % (len(OG), int(OG.archive_ids_swapped.sum()), int(OG.side_resolution.eq('elimination').sum()),
             int(OG.side_resolution.eq('unresolved').sum())))
    S = S[S.is_home.notna()].copy()
    S['is_home'] = S.is_home.astype(bool)

    # ---- spreads: keep the HOME side, then flip into EdgeDesk convention ----
    sp = S[S.market_type.eq('spread') & S.is_home].copy()
    sp['spread_line'] = -sp['lines']              # book home -14  ->  +14
    sp['spread_open'] = -sp['opening_lines']
    # ---- book-sign rule (F-11): a line opposite to a strict majority of books is dropped
    sp = apply_sign_rule(sp)
    sp_all = sp.copy()
    sp.loc[sp.close_conflict.notna(), 'spread_line'] = np.nan
    sp.loc[sp.open_conflict.notna(), 'spread_open'] = np.nan
    drops = {}
    for fld in ('close', 'open'):
        c = sp_all[sp_all[fld + '_conflict'].notna()].drop_duplicates(['game_id', 'book'])
        drops['spread_%s_books_dropped' % fld] = c[c[fld + '_conflict'].eq('dropped')].groupby('game_id').book.nunique()
        drops['spread_%s_sign_unresolved' % fld] = c[c[fld + '_conflict'].eq('unresolved')].groupby('game_id').size() > 0

    # ---- totals ----
    to = L[L.market_type.eq('total')].copy()
    to = to[to.abbr.str.lower().isin(('over', 'under', 'nan'))
            | to.abbr.isna() | True]              # abbr is over/under; number is the same either way
    to = to.drop_duplicates(subset=['game_id', 'book', 'lines', 'opening_lines'])

    # ---- moneylines ----
    ml = S[S.market_type.eq('money_line')].copy()

    per_book = []
    for name, d, cols in (
        ('spread', sp, dict(close='spread_line', open='spread_open')),
        ('total', to, dict(close='lines', open='opening_lines')),
    ):
        t = d[['game_id', 'season', 'week', 'book', cols['close'], cols['open']]].copy()
        t.columns = ['game_id', 'season', 'week', 'book', 'close', 'open']
        t['market'] = name
        if name == 'spread':           # the book lines as oriented, with the sign-rule verdict
            t['close'] = -sp_all.loc[t.index, 'lines']
            t['open'] = -sp_all.loc[t.index, 'opening_lines']
            t['close_conflict'] = sp_all.loc[t.index, 'close_conflict']
            t['open_conflict'] = sp_all.loc[t.index, 'open_conflict']
        per_book.append(t)
    mlh = ml[ml.is_home][['game_id', 'season', 'week', 'book', 'odds', 'opening_odds']].copy()
    mlh.columns = ['game_id', 'season', 'week', 'book', 'close', 'open']
    mlh['market'] = 'ml_home'
    mla = ml[~ml.is_home][['game_id', 'season', 'week', 'book', 'odds', 'opening_odds']].copy()
    mla.columns = ['game_id', 'season', 'week', 'book', 'close', 'open']
    mla['market'] = 'ml_away'
    per_book += [mlh, mla]
    BK = pd.concat(per_book, ignore_index=True)
    BK = BK[BK.game_id.notna()]

    def agg(market, prefix):
        d = BK[BK.market.eq(market)].copy()
        if market == 'spread':          # dropped / unresolved lines never enter a consensus
            d.loc[d.close_conflict.notna(), 'close'] = np.nan
            d.loc[d.open_conflict.notna(), 'open'] = np.nan
            d = d[d.close.notna() | d.open.notna()]
        g = d.groupby('game_id').agg(
            **{prefix + '_close': ('close', _median),
               prefix + '_open': ('open', _median),
               prefix + '_books': ('book', 'nunique'),
               prefix + '_close_sd': ('close', lambda x: float(pd.to_numeric(x, errors='coerce').std()))})
        sharp = d[d.book.isin(SHARP_BOOKS)].groupby('game_id').agg(
            **{prefix + '_close_pin': ('close', _median),
               prefix + '_open_pin': ('open', _median)})
        return g.join(sharp, how='left')

    M = agg('spread', 'spread')
    M = M.join(agg('total', 'total'), how='outer')
    M = M.join(agg('ml_home', 'mlh'), how='outer')
    M = M.join(agg('ml_away', 'mla'), how='outer')
    M = M.reset_index()
    M = M.merge(OG[['game_id', 'home_id', 'away_id', 'archive_ids_swapped', 'side_resolution']]
                .rename(columns={'home_id': 'orient_home_id', 'away_id': 'orient_away_id'}), on='game_id', how='left')
    for k, v in drops.items():
        M[k] = M.game_id.map(v)
        M[k] = M[k].fillna(0).astype(int) if k.endswith('dropped') else M[k].fillna(False).astype(bool)
    M['market_orientation_rule'] = MARKET_ORIENTATION_RULE

    g = common.load_schedules()[['game_id', 'season', 'week', 'home_team', 'away_team',
                                 'home_key', 'away_key', 'home_fbs', 'away_fbs',
                                 'neutral', 'played', 'margin', 'total_pts']]
    M = M.merge(g, on='game_id', how='inner')

    # data-quality flag: a single-book number with no opener is context, not a market
    M['mkt_quality'] = np.where(
        (M.spread_books.fillna(0) >= 3) & M.spread_close.notna(), 'consensus',
        np.where(M.spread_close.notna(), 'thin', 'none'))
    M['has_open'] = M.spread_open.notna()

    os.makedirs(OUT, exist_ok=True)
    M.to_csv(os.path.join(OUT, 'market.csv'), index=False)
    BK.to_csv(os.path.join(OUT, 'market_books.csv'), index=False)
    spb = BK[BK.market.eq('spread')]
    qa = {'rule': MARKET_ORIENTATION_RULE, 'sign_rule_min_abs': SIGN_RULE_MIN_ABS,
          'games': int(len(OG)),
          'archive_ids_swapped_games': sorted(int(x) for x in OG.game_id[OG.archive_ids_swapped]),
          'sides_by_elimination_games': int(OG.side_resolution.eq('elimination').sum()),
          'sides_unresolved_games': int(OG.side_resolution.eq('unresolved').sum()),
          'book_lines_dropped': {f: int(spb[spb[f + '_conflict'].eq('dropped')].drop_duplicates(['game_id', 'book']).shape[0])
                                 for f in ('close', 'open')},
          'games_with_a_dropped_line': int(spb[spb.close_conflict.eq('dropped') | spb.open_conflict.eq('dropped')].game_id.nunique()),
          'fields_unresolved': {f: int(spb[spb[f + '_conflict'].eq('unresolved')].game_id.nunique()) for f in ('close', 'open')},
          'dropped_by_book': spb[spb.close_conflict.notna() | spb.open_conflict.notna()]
          .drop_duplicates(['game_id', 'book']).book.value_counts().to_dict()}
    with open(os.path.join(OUT, 'market_qa.json'), 'w') as fh:
        json.dump(qa, fh, indent=1, sort_keys=True)
    print('[orient/sign QA]', {k: v for k, v in qa.items() if k != 'archive_ids_swapped_games'})

    fbs = M[M.home_fbs & M.away_fbs & M.played]
    cov = fbs.groupby('season').agg(
        games=('game_id', 'nunique'),
        with_spread=('spread_close', lambda s: int(s.notna().sum())),
        with_open=('spread_open', lambda s: int(s.notna().sum())),
        with_total=('total_close', lambda s: int(s.notna().sum())),
        with_ml=('mlh_close', lambda s: int(s.notna().sum())),
        med_books=('spread_books', 'median'))
    all_g = common.fbs_games().groupby('season').game_id.nunique().rename('sched_games')
    cov = cov.join(all_g)
    cov['pct_spread'] = (cov.with_spread / cov.sched_games * 100).round(1)
    cov['pct_open'] = (cov.with_open / cov.sched_games * 100).round(1)
    print(cov.to_string())

    # sanity: the market must predict the result it priced
    ok = fbs.dropna(subset=['spread_close', 'margin'])
    print('\n[sanity] corr(spread_close, margin) = %.3f  (must be strongly POSITIVE '
          'under the EdgeDesk convention)' % ok.spread_close.corr(ok.margin))
    print('[sanity] mean(margin - spread_close) = %.3f  (must be ~0)'
          % float((ok.margin - ok.spread_close).mean()))
    print('[sanity] home cover rate = %.4f' % float((ok.margin > ok.spread_close).mean()))
    tt = fbs.dropna(subset=['total_close', 'total_pts'])
    print('[sanity] corr(total_close, total_pts) = %.3f' % tt.total_close.corr(tt.total_pts))
    print('[sanity] mean(total_pts - total_close) = %.3f' % float((tt.total_pts - tt.total_close).mean()))
    return M


if __name__ == '__main__':
    build()
