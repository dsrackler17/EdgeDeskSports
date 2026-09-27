"""Audit items 26-27 — team mapping and home/away sign, end to end.

    python3 -m v2.audit.mapping      -> $CFB_V2_OUT/audit/mapping.json

1. Market archive orientation: the raw cfbfastR line archive's home/away team ids vs the schedule's
   for EVERY game_id (V1 verified only 2019); games where they are swapped would carry a
   sign-flipped line into V2.
2. Name collisions: teams whose names collide or nest (Miami FL / Miami OH, USC / South Carolina,
   UTSA / Texas, Texas / Texas A&M / Texas State / Texas Tech, the Florida schools, the "State"
   pairs) — ids must be distinct and every game's ids must match its names in every source.
3. Suspicious signs: games whose market line disagrees in sign with V2, Elo and CFBD Elo at once by a
   wide margin (a flipped row would look like this).
4. Model Lab capture: every quote's (game_id, home_team, away_team) vs the schedule for that game_id.
5. Hand-computed games: margin, book-line conversion, fair-spread display, cover result and CLV,
   recomputed longhand and compared with the stored stage-7 columns and engine.decide().
"""
import json
import os
import subprocess

import numpy as np
import pandas as pd

from . import _io

RESEARCH = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
DATA = os.environ.get('CFB_V2_DATA', os.path.join(RESEARCH, 'data'))
V2 = os.path.normpath(os.path.join(RESEARCH, '..'))
REPO = os.path.normpath(os.path.join(V2, '..', '..'))


def archive_orientation():
    L = pd.read_csv(os.path.join(DATA, 'betting', 'cfb_line_odds.csv.gz'), low_memory=False,
                    usecols=['game_id', 'season', 'home_team_id', 'away_team_id', 'market_type'])
    L['game_id'] = pd.to_numeric(L.game_id, errors='coerce')
    L = L.dropna(subset=['game_id']).drop_duplicates(['game_id', 'home_team_id', 'away_team_id'])
    G = pd.read_parquet(os.path.join(_io.out_dir(), 'stage2', 'games.parquet'),
                        columns=['game_id', 'season', 'home_id', 'away_id', 'neutral_site', 'home_team', 'away_team'])
    j = L.merge(G, on='game_id', how='inner')
    hid, aid = pd.to_numeric(j.home_team_id), pd.to_numeric(j.away_team_id)
    j['same'] = (hid == j.home_id) & (aid == j.away_id)
    j['swapped'] = (hid == j.away_id) & (aid == j.home_id)
    j['other'] = ~j.same & ~j.swapped & hid.notna()
    j['missing_ids'] = hid.isna() | aid.isna()
    per = j.groupby('season_x').agg(games=('game_id', 'nunique'), same=('same', 'sum'), swapped=('swapped', 'sum'),
                                     other=('other', 'sum'), missing_ids=('missing_ids', 'sum'))
    multi = j.groupby('game_id').size()
    sw = j[j.swapped]
    M = _io.preds()
    s = sw.merge(M[['game_id', 'margin', 'ens_pred', 'line', 'close_margin', 'status']], on='game_id', how='left')
    ok = s.close_margin.notna() & s.margin.notna()
    return {'by_season': per.reset_index().rename(columns={'season_x': 'season'}).to_dict('records'),
            'games_with_conflicting_id_rows': int((multi > 1).sum()),
            'swapped_games': int(sw.game_id.nunique()),
            'swapped_neutral_share': float(sw.neutral_site.mean()) if len(sw) else None,
            'swapped_in_v2_market_with_close': int(ok.sum()),
            'swapped_corr_close_vs_margin': float(np.corrcoef(s.close_margin[ok], s.margin[ok])[0, 1]) if ok.sum() > 5 else None,
            'swapped_corr_close_vs_v2': float(np.corrcoef(s.close_margin[ok], s.ens_pred[ok])[0, 1]) if ok.sum() > 5 else None,
            'swapped_examples': s.head(8)[['game_id', 'season_y', 'home_team', 'away_team', 'neutral_site', 'ens_pred',
                                           'close_margin', 'margin']].to_dict('records') if len(s) else []}


COLLIDE = ['Miami', 'Miami (OH)', 'USC', 'South Carolina', 'UTSA', 'Texas', 'Texas A&M', 'Texas State', 'Texas Tech',
           'UT Martin', 'UTEP', 'UT Arlington', 'Florida', 'Florida State', 'Florida Atlantic', 'Florida International',
           'FIU', 'FAU', 'Central Florida', 'UCF', 'South Florida', 'Mississippi State', 'Ole Miss', 'Mississippi',
           'Washington', 'Washington State', 'Kansas', 'Kansas State', 'Iowa', 'Iowa State', 'Oregon', 'Oregon State',
           'Arizona', 'Arizona State', 'Michigan', 'Michigan State', 'Western Michigan', 'Central Michigan',
           'Eastern Michigan', 'North Carolina', 'NC State', 'North Carolina State', 'Georgia', 'Georgia State',
           'Georgia Southern', 'Georgia Tech', 'Louisiana', 'Louisiana Tech', 'UL Monroe', 'Louisiana Monroe',
           'San José State', 'San Jose State', 'San Diego State', 'Boston College', 'Boston University',
           'Army', 'Navy', 'Air Force', 'Kent State', 'Ohio', 'Ohio State', 'Penn State', 'Pennsylvania']


def name_collisions():
    G = pd.read_parquet(os.path.join(_io.out_dir(), 'stage2', 'games.parquet'),
                        columns=['game_id', 'season', 'home_id', 'away_id', 'home_team', 'away_team'])
    L = pd.concat([G[['season', 'home_id', 'home_team']].rename(columns={'home_id': 'id', 'home_team': 'name'}),
                   G[['season', 'away_id', 'away_team']].rename(columns={'away_id': 'id', 'away_team': 'name'})])
    id_per_name = L.groupby('name').id.nunique()
    name_per_id = L.groupby('id').name.nunique()
    watch = L[L.name.isin(COLLIDE)].drop_duplicates(['name', 'id']).sort_values('name')
    return {'names_with_more_than_one_id': id_per_name[id_per_name > 1].to_dict(),
            'ids_with_more_than_one_name': {int(k): sorted(L[L.id == k].name.unique().tolist())
                                            for k in name_per_id[name_per_id > 1].index},
            'watchlist_name_to_id': watch[['name', 'id']].to_dict('records')}


def suspicious_signs():
    M = _io.preds()
    w = M[M.status.eq('FINAL') & M.close_margin.notna() & M.ens_pred.notna()].copy()
    f = w[(w.close_margin.abs() >= 7) & (np.sign(w.close_margin) != np.sign(w.ens_pred))
          & (np.sign(w.close_margin) != np.sign(w.elo_diff)) & ((w.close_margin - w.ens_pred).abs() >= 14)]
    f = f.assign(close_vs_margin_agree=np.sign(f.close_margin) == np.sign(f.margin),
                 flipped_close_error=(-f.close_margin - f.margin).abs(), close_error=(f.close_margin - f.margin).abs())
    return {'n_candidates': int(len(f)), 'n_scored_rows': int(len(w)),
            'close_sign_matched_result_share': float(f.close_vs_margin_agree.mean()) if len(f) else None,
            'flipped_close_would_be_more_accurate_share': float((f.flipped_close_error < f.close_error).mean()) if len(f) else None,
            'examples': f.head(12)[['game_id', 'season', 'home_team', 'away_team', 'neutral_site', 'ens_pred', 'elo_diff',
                                    'line', 'close_margin', 'margin']].to_dict('records')}


def lab_quotes():
    import glob
    rows = []
    for f in glob.glob(os.path.join(REPO, 'football', 'cfb_lab', 'ledger', '2026', 'quotes', '*.jsonl')):
        rows += [json.loads(l) for l in open(f)]
    Q = pd.DataFrame(rows)
    s = pd.read_parquet(os.path.join(DATA, 'sched', 'cfb_schedules_2026.parquet'),
                        columns=['game_id', 'home_team', 'away_team', 'home_id', 'away_id'])
    s['game_id'] = pd.to_numeric(s.game_id, errors='coerce')
    Q['gid'] = pd.to_numeric(Q.game_id, errors='coerce')
    j = Q.merge(s, left_on='gid', right_on='game_id', how='left', suffixes=('', '_sched'))
    return {'quotes': int(len(Q)), 'games': int(Q.gid.nunique()), 'books': Q.book.value_counts().to_dict(),
            'market_types': Q.market_type.value_counts().to_dict(),
            'with_price_home': int(Q.price_home.notna().sum()),
            'provider_event_id_equals_game_id': float((Q.provider_event_id.astype(str) == Q.game_id.astype(str)).mean()),
            'not_in_schedule': int(j.home_team_sched.isna().sum()),
            'home_name_mismatch': int((j.home_team != j.home_team_sched)[j.home_team_sched.notna()].sum()),
            'away_name_mismatch': int((j.away_team != j.away_team_sched)[j.home_team_sched.notna()].sum()),
            'home_away_swapped': int(((j.home_team == j.away_team_sched) & (j.away_team == j.home_team_sched)).sum()),
            'mismatch_examples': j[(j.home_team != j.home_team_sched) & j.home_team_sched.notna()].head(5)[
                ['game_id', 'home_team', 'away_team', 'home_team_sched', 'away_team_sched']].to_dict('records'),
            'watchlist_games': j[j.home_team.isin(COLLIDE[:9]) | j.away_team.isin(COLLIDE[:9])].drop_duplicates('game_id')[
                ['game_id', 'home_team', 'away_team', 'home_team_sched', 'away_team_sched']].head(20).to_dict('records')}


def hand_games():
    """Longhand, from first principles, for chosen historical games (home fav, road fav, neutral,
    a push, a flip)."""
    M = _io.preds()
    w = M[M.season.isin([2024, 2025]) & M.status.eq('FINAL') & M.line.notna() & M.close_margin.notna() & ~M.fcs_game]
    picks = {
        'home_favourite_covered': w[(w.line >= 7) & (w.margin > w.line)].iloc[0],
        'road_favourite_covered': w[(w.line <= -7) & (w.margin < w.line)].iloc[0],
        'neutral_site': w[w.neutral_site].iloc[0],
        'integer_line_push': w[(w.margin == w.line)].iloc[0] if (w.margin == w.line).any() else None,
        'model_takes_dog_line_moved': w[(w.side.eq('HOME')) & (w.line < -3) & (w.close_margin != w.line)].iloc[0],
    }
    out = {}
    for k, r in picks.items():
        if r is None:
            continue
        hp, ap = float(r.home_points), float(r.away_points)
        margin = hp - ap
        book_open_home = -float(r.line)        # the archive stores the home MARGIN; the book shows its negative
        book_close_home = -float(r.close_margin)
        # cover by the book rule: home covers iff home_points + book_line > away_points
        home_cover = np.sign(hp + book_open_home - ap)
        side_home = r.side == 'HOME'
        res = 0 if home_cover == 0 else (1 if (home_cover > 0) == side_home else -1)
        # CLV in points for the side taken: a home bettor wants the home line to have been more generous
        # (bet at book -3, close -5 => +2): clv = book_open_home - book_close_home for home, reversed for away
        clv = (book_open_home - book_close_home) if side_home else (book_close_home - book_open_home)
        disp_team = r.home_team if r.ens_pred > 0 else r.away_team
        out[k] = {'game_id': int(r.game_id), 'teams': '%s (home) vs %s' % (r.home_team, r.away_team),
                  'neutral': bool(r.neutral_site), 'final': [hp, ap], 'margin_longhand': margin,
                  'margin_stored': float(r.margin), 'book_open_home': book_open_home, 'book_close_home': book_close_home,
                  'v2_home_margin': round(float(r.ens_pred), 2),
                  'fair_spread_display_longhand': '%s -%.1f' % (disp_team, round(abs(r.ens_pred) * 2) / 2),
                  'side': r.side, 'bet_result_longhand': res, 'bet_result_stored': float(r.bet_result),
                  'clv_longhand': clv, 'clv_stored': float(r.clv_pts),
                  'agree': bool(margin == r.margin and res == r.bet_result and abs(clv - r.clv_pts) < 1e-9)}
    # the same games through engine.decide (display, side, gap orientation)
    js = r"""
    require('%s/params.js'); var E=require('%s/engine.js');
    var g=JSON.parse(process.argv[1]); var out={};
    Object.keys(g).forEach(function(k){ var x=g[k];
      var row={game_id:x.game_id, ens_pred:x.v2_home_margin, sigma:16, home:'HOME', away:'AWAY', kickoff:'2030-01-01T00:00:00Z'};
      var p=E.pure(row); var d=E.decide(p,{current:{home_line:x.book_open_home, ts:'2029-12-31T23:00:00Z'}, price_home:-110, price_away:-110},{row:row, now:'2029-12-31T23:30:00Z'});
      out[k]={display:p.fair_spread_display, fair_home_line:p.fair_spread_home_line, gap:d.raw_gap_pts, side:d.side,
              market_margin:d.current_market_margin}; });
    console.log(JSON.stringify(out));
    """ % (V2, V2)
    eng = json.loads(subprocess.run(['node', '-e', js, json.dumps(out)], capture_output=True, text=True, check=True).stdout)
    for k in out:
        e = eng[k]
        out[k]['engine'] = e
        out[k]['engine_gap_matches_longhand'] = abs(e['gap'] - round(out[k]['v2_home_margin'] - (-out[k]['book_open_home']), 2)) < 0.011
        out[k]['engine_fair_home_line_is_negated_margin'] = abs(e['fair_home_line'] + out[k]['v2_home_margin']) < 0.011
    return out


def main():
    out = {'doc': __doc__, 'archive_orientation': archive_orientation(), 'name_collisions': name_collisions(),
           'suspicious_signs': suspicious_signs(), 'lab_quotes': lab_quotes(), 'hand_games': hand_games()}
    _io.write('mapping.json', out)
    a = out['archive_orientation']
    print('archive orientation:', {k: v for k, v in a.items() if k not in ('by_season', 'swapped_examples')})
    print(pd.DataFrame(a['by_season']).to_string(index=False))
    for e in a['swapped_examples'][:5]:
        print('  swapped', e)
    n = out['name_collisions']
    print('names>1 id', n['names_with_more_than_one_id']); print('ids>1 name', list(n['ids_with_more_than_one_name'].items())[:12])
    print('watch', [(r['name'], r['id']) for r in n['watchlist_name_to_id']][:60])
    print('suspicious', {k: v for k, v in out['suspicious_signs'].items() if k != 'examples'})
    for e in out['suspicious_signs']['examples'][:6]:
        print('   ', e)
    print('lab', {k: v for k, v in out['lab_quotes'].items() if k != 'watchlist_games'})
    for k, v in out['hand_games'].items():
        print(k, v)


if __name__ == '__main__':
    main()
