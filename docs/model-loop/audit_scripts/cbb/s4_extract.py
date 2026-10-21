import json, os, sys
D = sys.argv[1]; OUT = sys.argv[2]
out = {}; bad = []
def f(x):
    try: return float(str(x).replace('+', '').replace('o', '').replace('u', ''))
    except Exception: return None
for fn in os.listdir(D):
    gid = fn[:-5]
    try:
        j = json.load(open(os.path.join(D, fn)))
    except Exception as e:
        bad.append(gid); continue
    pcs = j.get('pickcenter') or []
    rec = {'n_providers': len(pcs)}
    comp = (j.get('header') or {}).get('competitions') or [{}]
    c0 = comp[0]
    teams = {x.get('homeAway'): str((x.get('team') or {}).get('id')) for x in (c0.get('competitors') or [])}
    rec['home_id'] = teams.get('home'); rec['away_id'] = teams.get('away')
    rec['neutral'] = c0.get('neutralSite')
    gi = j.get('gameInfo') or {}
    v = gi.get('venue') or {}
    rec['venue'] = v.get('fullName'); rec['city'] = (v.get('address') or {}).get('city'); rec['state'] = (v.get('address') or {}).get('state')
    # injuries block, if any
    rec['has_injuries_block'] = 'injuries' in j
    for p in pcs:
        prov = (p.get('provider') or {}).get('name')
        ps = p.get('pointSpread') or {}
        hc = ((ps.get('home') or {}).get('close') or {}); ho = ((ps.get('home') or {}).get('open') or {})
        tt = p.get('total') or {}
        ml = p.get('moneyline') or {}
        rec.setdefault('providers', []).append({
            'provider': prov, 'details': p.get('details'), 'spread_field': p.get('spread'), 'ou': p.get('overUnder'),
            'home_close_line': f(hc.get('line')), 'home_close_odds': f(hc.get('odds')), 'home_open_line': f(ho.get('line')),
            'away_close_odds': f(((ps.get('away') or {}).get('close') or {}).get('odds')),
            'total_close': f(((tt.get('over') or {}).get('close') or {}).get('line')), 'total_open': f(((tt.get('over') or {}).get('open') or {}).get('line')),
            'ml_home_close': f(((ml.get('home') or {}).get('close') or {}).get('odds')), 'ml_away_close': f(((ml.get('away') or {}).get('close') or {}).get('odds')),
            'home_fav': (p.get('homeTeamOdds') or {}).get('favorite'),
        })
    out[gid] = rec
json.dump({'games': out, 'unreadable': bad}, open(OUT, 'w'))
print('extracted', len(out), 'unreadable', len(bad), 'with pickcenter', sum(1 for r in out.values() if r['n_providers']))
