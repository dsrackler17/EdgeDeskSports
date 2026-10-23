/* The UFC Elo port (simulator/src/sports/ufc/elo.ts) against the served Python walk:
   - SYNTHETIC bouts with hand-computed ratings: the expected score, the faster step for a fighter's first
     bouts, a draw, a bout with no result (priced, not absorbed), the layoff regression and its persistence
     (a cancelled row after a layoff regresses the stored rating), the (time, bout id) order
   - the committed data: every p_a the loop published (model_loop/published/ufc/current.json) reproduced to
     its four decimals, with the same fighters and bout counts, and no bout in the published window missing
   - when python3 with pandas is available: model.py walk() itself, every bout's full-precision price and
     every rating equal to the port's (difference at the last floating-point digit at most), served and
     with the champion term on (champ_bonus 100, the loop's weekly candidate)
   - the champion term: off (0) changes nothing; on, the champion going in gets the points on either side
     node simulator/tests/ufc_elo.test.ts */
import { execFileSync } from 'node:child_process';
import { kit } from './_kit.ts';
import { walk, rating, expectA, parseBoutsCsv, emptyState, attachChampions, loadServedBouts, servedVersion, checkReproduction, loadCurrent, round4, REPO, ELO_DEFAULTS, type EloConfig } from '../src/sports/ufc/elo.ts';

const K = kit('UFC Elo port');
const cfg: EloConfig = { ...ELO_DEFAULTS, k: 64, k_new_mult: 1.5, new_bouts: 3, layoff_days: 365, layoff_regress: 0.25 };

/* ---- SYNTHETIC ---- */
const head = 'bout_id,event_id,event_name,start_time,fighter_a_id,fighter_a,fighter_b_id,fighter_b,a_winner,b_winner,status,status_detail,round,clock,format_json,weight_class\n';
const row = (id: string, t: string, a: string, b: string, aw: string, bw: string, st = 'STATUS_FINAL') => [id, 'e1', 'SYNTHETIC', t, a, 'F' + a, b, 'F' + b, aw, bw, st, 'Final', '3', '5:00', '"{""regulation"": {""periods"": 3}}"', 'Lightweight'].join(',');
const csv = head + [
  row('10', '2020-01-01T00:00Z', 'A', 'B', 'True', 'False'),          // A beats B: both new (k 96)
  row('9', '2020-01-01T00:00Z', 'C', 'D', 'False', 'False'),          // same time, lower id: first; a draw
  row('11', '2020-02-01T00:00Z', 'A', 'C', 'False', 'False', 'STATUS_SCHEDULED'), // priced, never absorbed
  row('12', 'not a date', 'A', 'B', 'True', 'False'),                 // dropped (load)
  row('13', '2021-03-01T00:00Z', 'A', 'X', 'False', 'False', 'STATUS_CANCELED'), // A back after 425 days: regressed and STORED
  row('14', '2021-03-02T00:00Z', 'A', 'B', 'False', 'True')           // A regressed again (no absorbed bout since), B too
].join('\n') + '\n';
const bouts = parseBoutsCsv(csv);
K.eq('SYNTHETIC: an unparseable start time is dropped; order is (time, bout id as text)', bouts.map((b) => b.bout_id), ['10', '9', '11', '13', '14']);
K.eq('SYNTHETIC: ids "10" and "9" at the same time sort as text ("10" first)', bouts.slice(0, 2).map((b) => b.bout_id), ['10', '9']);
const { rows, state } = walk(bouts, cfg);
K.near('SYNTHETIC: two new fighters are priced at 50%', rows[0].p, 0.5, 1e-15);
K.near('SYNTHETIC: the loser moves by 1.5 x 64 x 0.5 = 48 in a first bout', walk(bouts.slice(0, 1), cfg).state.R.get('B') as number, 1452, 1e-9);
K.chk('SYNTHETIC: a draw between equals moves nobody', state.N.get('C') === 1 && Math.abs(1500 - (state.R.get('D') as number)) < 1e-12);
K.near('SYNTHETIC: a scheduled bout is priced from the ratings before it', rows[2].p, expectA(cfg, 1548, 1500), 1e-12);
K.eq('SYNTHETIC: ...and not absorbed (bout counts unchanged)', [state.N.get('A'), rows[2].a_bouts], [2, 1]);
/* A: 1548 after bout 10; 2021-03-01 is 425 days later: 1500 + 48 x 0.75 = 1536, stored; 2021-03-02: still no absorbed bout since,
   so regressed again: 1500 + 36 x 0.75 = 1527; B: 1452 -> 1464 at bout 14 */
K.near('SYNTHETIC: the cancelled row prices A after the layoff regression (1536 v a new fighter)', rows[3].p, expectA(cfg, 1536, 1500), 1e-12);
const eA = expectA(cfg, 1527, 1464);
K.near('SYNTHETIC: the regression is stored, so the next row regresses again (1527 v B at 1464)', rows[4].p, eA, 1e-12);
K.near('SYNTHETIC: then the result: A loses with k 96 (second absorbed bout)', state.R.get('A') as number, 1527 + 96 * (0 - eA), 1e-9);
K.near('SYNTHETIC: ...and B, regressed from 1452 to 1464, wins with k 96', state.R.get('B') as number, 1464 + 96 * eA, 1e-9);
{
  const S = emptyState(); S.R.set('Z', 1600); S.last.set('Z', Date.parse('2020-01-01T00:00Z'));
  K.near('rating(): 364 days off is not a layoff', rating(S, cfg, 'Z', Date.parse('2020-12-30T00:00Z')), 1600, 1e-12);
  K.near('rating(): 365 whole days is (and the regressed value is stored)', rating(S, cfg, 'Z', Date.parse('2020-12-31T00:00Z')), 1575, 1e-12);
  K.near('rating(): a never-seen fighter is 1500 (the debut price: an average fighter)', rating(S, cfg, 'new', 0), 1500, 0);
}

/* ---- the champion term (model.py champ_bonus) ---- */
{
  const tb = parseBoutsCsv(head + [row('1', '2020-01-01T00:00Z', 'A', 'B', 'True', 'False'), row('2', '2020-06-01T00:00Z', 'C', 'D', 'False', 'True'), row('3', '2020-07-01T00:00Z', 'E', 'F', 'True', 'False')].join('\n') + '\n');
  attachChampions(tb, new Map([['1', 'A'], ['2', 'D'], ['3', 'nobody']]));
  const on = walk(tb, { ...cfg, champ_bonus: 100 }), off = walk(tb, { ...cfg, champ_bonus: 0 }), plain = walk(parseBoutsCsv(head + [row('1', '2020-01-01T00:00Z', 'A', 'B', 'True', 'False'), row('2', '2020-06-01T00:00Z', 'C', 'D', 'False', 'True'), row('3', '2020-07-01T00:00Z', 'E', 'F', 'True', 'False')].join('\n') + '\n'), cfg);
  K.eq('champion term off (0): every price and rating as with no title flags', [off.rows.map((r) => r.p), [...off.state.R.entries()]], [plain.rows.map((r) => r.p), [...plain.state.R.entries()]]);
  K.near('champion term on: the champion as fighter a gets +100 (1600 v 1500)', on.rows[0].p, expectA(cfg, 1600, 1500), 1e-15);
  K.near('champion term on: the champion as fighter b gets it too (a priced at 1400 v 1500)', on.rows[1].p, expectA(cfg, 1400, 1500), 1e-15);
  K.near('champion term on: a flag naming neither fighter adds nothing', on.rows[2].p, 0.5, 1e-15);
  K.near('champion term on: the update uses the adjusted expectation (A wins, moves by 96 x (1 - e))', on.state.R.get('A') as number, 1500 + 96 * (1 - expectA(cfg, 1600, 1500)), 1e-9);
}

/* ---- the committed data against the published file ---- */
const sv = servedVersion();
K.eq('the served version is 1.1.0 with k 64, new-fighter step x1.5, layoff 365 days / 25%, no calibration', [sv.version, sv.config.k, sv.config.k_new_mult, sv.config.layoff_days, sv.config.layoff_regress, sv.config.calibration], ['1.1.0', 64, 1.5, 365, 0.25, 'none']);
const { bouts: all } = loadServedBouts();
const W = walk(all, sv.config);
const chk = checkReproduction(W.rows, loadCurrent().doc, sv);
K.chk('every published p_a is reproduced to its four decimals (' + chk.reproduced + ' of ' + chk.published + ')', chk.published > 0 && chk.reproduced === chk.published && !chk.mismatches.length, chk.mismatches);
K.chk('no scheduled bout in the published 14-day window is missing from the file, none extra', !chk.window_missing.length && !chk.window_extra.length, chk);
K.chk('the largest difference from a published value is rounding only (< 0.00005)', chk.max_abs_diff < 0.00005, chk.max_abs_diff);
K.eq('round4 is Python round(x, 4), which rounds the exact binary value (0.40035 is just below the half)', [round4(0.56244999), round4(0.40035), round4(0.12345), round4(0.98765)], [0.5624, 0.4003, 0.1235, 0.9877]);

/* ---- the Python walk itself, when it can be run: served, and with the champion term on ---- */
const code = 'import json,sys\nfrom model_loop.adapters.ufc import model as U\nd=U.load("model_loop/data/ufc/bouts.csv")\ncfg=json.load(open("docs/model-loop/ufc/versions.json"))\ncur=[v for v in cfg["versions"] if v["version"]==cfg["current"]][0]["config"]\nif len(sys.argv)>1: cur=dict(cur,champ_bonus=float(sys.argv[1]))\nrows,st=U.walk(d,cur)\njson.dump({"p":{r.bout_id:[float(r.p_raw),int(r.a_bouts),int(r.b_bouts)] for r in rows.itertuples()},"ratings":st["ratings"]},sys.stdout)';
const pyWalk = (args: string[]): { p: Record<string, number[]>; ratings: Record<string, number> } | null => {
  try { return JSON.parse(execFileSync('python3', ['-c', code, ...args], { cwd: REPO, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString()); } catch (_) { return null; }
};
const compare = (label: string, py: { p: Record<string, number[]>; ratings: Record<string, number> }, Wx: ReturnType<typeof walk>) => {
  let dp = 0, dc = 0, dr = 0;
  for (const r of Wx.rows) { const q = py.p[r.bout.bout_id]; if (!q) { dc++; continue; } dp = Math.max(dp, Math.abs(q[0] - r.p)); if (q[1] !== r.a_bouts || q[2] !== r.b_bouts) dc++; }
  for (const [f, v] of Object.entries(py.ratings)) dr = Math.max(dr, Math.abs((Wx.state.R.get(f) ?? NaN) - v));
  K.chk(label + ': every one of ' + Wx.rows.length + ' bouts priced the same to the last digits (max difference ' + dp + ')', dp < 1e-12 && Object.keys(py.p).length === Wx.rows.length, dp);
  K.chk(label + ': the same bout counts for every bout', dc === 0, dc);
  K.chk(label + ': every rating equal (max difference ' + dr + ')', dr < 1e-9 && Object.keys(py.ratings).length === Wx.state.R.size, dr);
};
const py = pyWalk([]);
if (py) {
  compare('model.py walk()', py, W);
  const pyOn = pyWalk(['100']);
  const Won = walk(all, { ...sv.config, champ_bonus: 100 });
  const moved = Won.rows.filter((r, i) => r.p !== W.rows[i].p).length;
  K.chk('the champion term moves the prices of the title fights and of the champions\' later bouts (' + moved + ' bouts)', moved > 150, moved);
  if (pyOn) compare('model.py walk() with champ_bonus 100', pyOn, Won);
}
process.exit(K.done(py ? 'model.py walk() compared at full precision' : 'python3 with pandas not available: the full-precision comparison with model.py was skipped (the published file was checked)'));
