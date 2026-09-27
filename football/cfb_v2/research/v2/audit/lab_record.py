"""Audit items 31-35 and 97-99 — Model Lab evaluations, closing lines, and the public record math.

    python3 -m v2.audit.lab_record    -> $CFB_V2_OUT/audit/lab_record.json

1. Every Model Lab evaluation (football/cfb_lab/ledger/<season>/evaluations.jsonl) recomputed from its
   prediction row, the settled result and the derived lines, independently of lab_core.js:
   margin error, beat-open/close, ATS at the graded line, CLV = (L_snap - L_close) x side, Brier.
2. Closing-line definition: every CLOSE line's quotes — timestamps vs kickoff (no post-kickoff quote),
   in-play flags, the number of books behind it, and whether a price exists.
3. Execution realism of the capture: books, prices, observation timing relative to kickoff.
4. Public records: record/football/cfb_model_lab.json (Model Lab) and record/football/cfb_2026.json +
   summary.json (the V1 football record) — every graded game re-graded longhand; denominators, pushes,
   missing games, model version.
5. Governance: ledger append-only evidence (hashes / ids), the audit log, and whether the database
   contract forbids UPDATE/DELETE on prediction rows (supabase/cfb_lab.sql).
"""
import glob
import json
import os
import re

import numpy as np
import pandas as pd

from . import _io

REPO = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', '..'))
LAB = os.path.join(REPO, 'football', 'cfb_lab', 'ledger', '2026')


def jl(p):
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []


def lab_evaluations():
    P = {}
    for f in glob.glob(os.path.join(LAB, 'predictions', '*.jsonl')):
        for r in jl(f):
            P[r['prediction_id']] = r
    E = jl(os.path.join(LAB, 'evaluations.jsonl'))
    R = {r['game_id']: r for r in jl(os.path.join(LAB, 'results.jsonl'))}
    mism = {k: 0 for k in ('final_margin', 'abs_margin_error', 'edgedesk_beat_close', 'close_abs_error',
                           'ats_result', 'clv_points', 'brier_win', 'market_move_toward_model', 'winner_correct',
                           'in_interval_80')}
    checked = {k: 0 for k in mism}
    ex = []
    for e in E:
        p = P.get(e['prediction_id'])
        r = R.get(e['game_id'])
        if p is None or r is None or e.get('void'):
            continue
        m = r['home_points'] - r['away_points']
        mu = p['pure_home_margin']
        def chk(k, mine, theirs, tol=1e-3):
            if mine is None and theirs is None:
                return
            checked[k] += 1
            bad = (mine is None) != (theirs is None) or (
                isinstance(mine, (int, float, np.floating)) and not isinstance(mine, bool) and abs(float(mine) - float(theirs)) > tol) or (
                isinstance(mine, (bool, str)) and mine != theirs)
            if bad:
                mism[k] += 1
                if len(ex) < 10:
                    ex.append({'eval': e['evaluation_id'], 'field': k, 'mine': mine, 'lab': theirs})
        chk('final_margin', m, e['final_margin'])
        chk('abs_margin_error', abs(m - mu) if mu is not None else None, e['abs_margin_error'], 0.011)
        chk('winner_correct', (mu > 0) == (m > 0) if mu is not None and mu != 0 else None, e.get('winner_correct'))
        cl = e.get('close_home_line')
        if cl is not None and mu is not None:
            cae = abs(m + cl)
            chk('close_abs_error', cae, e['close_abs_error'], 0.011)
            chk('edgedesk_beat_close', abs(m - mu) < cae - 1e-9, e['edgedesk_beat_close'])
        side = e.get('side'); gl = e.get('graded_line')
        if side and gl is not None:
            home_line = gl if side == 'HOME' else (-gl if gl != 0 else 0)
            x = m + home_line
            res = 'PUSH' if x == 0 else (('WIN' if x > 0 else 'LOSS') if side == 'HOME' else ('LOSS' if x > 0 else 'WIN'))
            chk('ats_result', res, e['ats_result'])
            if cl is not None:
                d = home_line - cl
                chk('clv_points', d if side == 'HOME' else -d, e['clv_points'])
        ph = p.get('home_win_probability')
        if ph is not None:
            chk('brier_win', (ph - (1 if m > 0 else 0)) ** 2, e['brier_win'], 1e-4)
        ol = e.get('open_home_line')
        if ol is not None and cl is not None and mu is not None and (mu + ol) != 0 and e.get('market_move_toward_model') is not None:
            mv = (-cl) - (-ol)
            chk('market_move_toward_model', bool(mv * np.sign(mu + ol) > 0), e['market_move_toward_model'])
        lo, hi = p.get('interval_80_low'), p.get('interval_80_high')
        if lo is not None and hi is not None:
            chk('in_interval_80', bool(lo <= m <= hi), e.get('in_interval_80'))
    return {'evaluations': len(E), 'predictions': len(P), 'results': len(R), 'checked': checked,
            'mismatches': mism, 'examples': ex,
            'by_origin': pd.Series([e['origin'] for e in E]).value_counts().to_dict(),
            'official_evaluations': int(sum(bool(e.get('official')) for e in E))}


def closing_lines():
    Q = {}
    for f in glob.glob(os.path.join(LAB, 'quotes', '*.jsonl')):
        for q in jl(f):
            Q[q['quote_id']] = q
    L = jl(os.path.join(LAB, 'lines.jsonl'))
    close = [l for l in L if l['kind'] == 'CLOSE' and l['market_type'] == 'spread' and l['quality'] != 'MISSING']
    after, missing_q, nb, lead = 0, 0, [], []
    inplay = 0
    for l in close:
        k = pd.Timestamp(l['kickoff_ts'])
        nb.append(l.get('n_books') or 0)
        for qid in l['quote_ids']:
            q = Q.get(qid)
            if q is None:
                missing_q += 1
                continue
            t = pd.Timestamp(q.get('observed_at') or q.get('retrieved_at'))
            lead.append((k - t).total_seconds() / 3600)
            if t >= k:
                after += 1
            if q.get('is_pregame') is False:
                inplay += 1
    qs = pd.DataFrame(list(Q.values()))
    qs['lead_h'] = (pd.to_datetime(qs.kickoff_ts) - pd.to_datetime(qs.observed_at)).dt.total_seconds() / 3600
    return {'close_spread_lines': len(close), 'quality': pd.Series([l['quality'] for l in close]).value_counts().to_dict(),
            'n_books_distribution': pd.Series(nb).value_counts().to_dict(),
            'quotes_behind_close_missing': missing_q, 'close_quotes_at_or_after_kickoff': after,
            'close_quotes_flagged_not_pregame': inplay,
            'close_quote_lead_hours': {'min': float(np.min(lead)) if lead else None, 'median': float(np.median(lead)) if lead else None,
                                       'max': float(np.max(lead)) if lead else None},
            'all_quotes': int(len(qs)), 'books': qs.book.value_counts().to_dict(),
            'quotes_with_any_price': int((qs.price_home.notna() | qs.price_away.notna()).sum()),
            'spread_quotes_with_price': int((qs.market_type.eq('spread') & (qs.price_home.notna() | qs.price_away.notna())).sum()),
            'provider_declared_close_quotes': int(qs.is_provider_close.fillna(False).astype(bool).sum()),
            'quote_lead_hours_quantiles': qs.lead_h.quantile([0, 0.1, 0.5, 0.9, 1]).round(2).to_dict()}


def public_records():
    out = {}
    lab = json.load(open(os.path.join(REPO, 'record', 'football', 'cfb_model_lab.json')))
    out['cfb_model_lab'] = {'official_predictions': lab['counts']['official_predictions'], 'graded': lab['counts']['graded'],
                            'games_listed': len(lab['games']), 'models': lab['models'], 'accuracy': lab['accuracy']}
    rec = json.load(open(os.path.join(REPO, 'record', 'football', 'cfb_2026.json')))
    G = rec['games']
    tot = {'games': len(G), 'graded': 0, 'spread_regraded': 0, 'spread_mismatch': 0, 'err_mismatch': 0, 'w': 0, 'l': 0, 'p': 0,
           'versions': {}, 'status': {}}
    ex = []
    for gid, g in G.items():
        tot['versions'][g.get('model_version')] = tot['versions'].get(g.get('model_version'), 0) + 1
        gr = g.get('grade') or {}
        tot['status'][gr.get('status')] = tot['status'].get(gr.get('status'), 0) + 1
        if gr.get('status') != 'GRADED' or not g.get('close') or not g.get('final'):
            continue
        tot['graded'] += 1
        mdl = (g.get('pick') or {}).get('home_line')
        cl = g['close'].get('home_line')
        m = g['final']['home_score'] - g['final']['away_score']
        if mdl is None or cl is None:
            continue
        side = 'home' if mdl < cl else ('away' if mdl > cl else None)
        sp = gr.get('spread') or {}
        if side is None:
            continue
        x = m + cl
        res = 'push' if x == 0 else (('win' if x > 0 else 'loss') if side == 'home' else ('loss' if x > 0 else 'win'))
        tot['spread_regraded'] += 1
        tot[{'win': 'w', 'loss': 'l', 'push': 'p'}[res]] += 1
        if sp.get('side') != side or sp.get('result') != res:
            tot['spread_mismatch'] += 1
            if len(ex) < 6:
                ex.append({'game_id': gid, 'mine': [side, res], 'record': [sp.get('side'), sp.get('result')], 'model': mdl, 'close': cl, 'margin': m})
        er = (gr.get('error') or {})
        if er.get('model_margin_err') is not None and abs(abs(m + mdl) - er['model_margin_err']) > 0.051:
            tot['err_mismatch'] += 1
    tot['ats_pct_longhand'] = round(100 * tot['w'] / max(1, tot['w'] + tot['l']), 1)
    tot['examples'] = ex
    s = json.load(open(os.path.join(REPO, 'record', 'football', 'summary.json')))
    cfb = s['sports'].get('cfb', {})
    tot['summary_cfb_counts'] = cfb.get('counts'); tot['summary_cfb_ats_all'] = (cfb.get('ats') or {}).get('all')
    tot['summary_generated_at'] = s.get('generated_at'); tot['record_updated_at'] = rec.get('updated_at')
    out['cfb_2026_v1_record'] = tot
    return out


def governance():
    sql = open(os.path.join(REPO, 'supabase', 'cfb_lab.sql')).read()
    trig = re.findall(r'create[^;]*trigger[^;]*;', sql, flags=re.I)
    revoke = re.findall(r'revoke[^;]*(?:update|delete)[^;]*;', sql, flags=re.I)
    no_del = [t[:160] for t in trig if re.search(r'delete|update', t, re.I)]
    al = jl(os.path.join(REPO, 'football', 'cfb_lab', 'governance', 'audit_log.jsonl'))
    return {'sql_triggers_on_update_or_delete': no_del[:10], 'sql_revokes': [r[:160] for r in revoke[:10]],
            'audit_log_events': pd.Series([a.get('event') or a.get('type') for a in al]).value_counts().to_dict(),
            'ledger_is_git_files': True,
            'note': 'the git ledger files can be rewritten by any commit; the database contract is the only place a '
                    'delete can be refused'}


def main():
    out = {'doc': __doc__, 'lab_evaluations': lab_evaluations(), 'closing_lines': closing_lines(),
           'public_records': public_records(), 'governance': governance()}
    _io.write('lab_record.json', out)
    print(json.dumps(out, indent=1, default=str)[:7000])


if __name__ == '__main__':
    main()
