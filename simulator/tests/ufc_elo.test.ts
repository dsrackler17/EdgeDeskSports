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
   - the 2026-10 parameters (walkExtended): off they change nothing; the prior from the pre-UFC record and the
     age curve by hand; against model.py at full precision for the served configuration and for one with every
     parameter on; 1.1.0 stays runnable whatever is served
     node simulator/tests/ufc_elo.test.ts */
import { execFileSync } from 'node:child_process';
import { kit } from './_kit.ts';
import { walk, rating, expectA, parseBoutsCsv, emptyState, attachChampions, loadServedBouts, servedVersion, checkReproduction, loadCurrent, round4, REPO, ELO_DEFAULTS, priorOf, agePoints, eliteRecord, extendedConfig,
  factorsFor, computeFactors, loadFighterFacts, versionConfig, COMPARE_VERSION, type EloConfig } from '../src/sports/ufc/elo.ts';

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

/* ---- the 2026-10 parameters ---- */
{
  const P: EloConfig = { ...ELO_DEFAULTS, debut_offset: 25, prior_rec: 150, prior_exp: -25 };
  K.near('the prior: a 10-2 record is the centre (1500 + 25)', priorOf(P, 10, 2), 1525, 1e-9);
  K.near('the prior: no record on file is the centre too', priorOf(P, null, null), 1525, 1e-9);
  K.near('the prior: 15-0 by hand (150 x (log(17/2) - log 3) - 25 x (log 16 - log 13))', priorOf(P, 15, 0), 1525 + 150 * (Math.log(17 / 2) - Math.log(3)) - 25 * (Math.log(16) - Math.log(13)), 1e-9);
  const A: EloConfig = { ...ELO_DEFAULTS, age_slope: -15, age_knee: 32 };
  K.eq('the age curve: nothing to 32, -15 a year after, nothing without a date of birth', [agePoints(A, 30), agePoints(A, 38), agePoints(A, null)], [0, -90, 0]);
  const AD: EloConfig = { ...A, age_div: { Heavyweight: [31, -20] }, age_elite_slope: -10 };
  K.eq('the age curve by division: its own knee and slope (-20 x 7), the shared curve elsewhere, -10 a year more for an elite record',
    [agePoints(AD, 38, 'Heavyweight'), agePoints(AD, 38, 'Lightweight'), agePoints(AD, 38), agePoints(AD, 38, 'Heavyweight', true), agePoints(AD, 38, 'Lightweight', true)], [-140, -90, -90, -210, -150]);
  K.eq('an elite record: 6+ UFC wins at 70%+', [eliteRecord(AD, 6, 2), eliteRecord(AD, 5, 0), eliteRecord(AD, 6, 3), eliteRecord(AD, null, null)], [true, false, false, false]);
  K.chk('a configuration with only a curve by division is extended', extendedConfig({ ...ELO_DEFAULTS, ...cfg, age_div: { Heavyweight: [31, -15] } }));
  K.chk('1.1.0\'s configuration is not extended; one with an age slope is', !extendedConfig({ ...ELO_DEFAULTS, ...cfg }) && extendedConfig({ ...ELO_DEFAULTS, ...cfg, age_slope: -15 }));
  const facts = new Map([['A', { dob: Date.parse('1988-01-01T00:00:00Z'), pre_w: 15, pre_l: 0, pre_source: 'history' }], ['B', { dob: Date.parse('1996-01-01T00:00:00Z'), pre_w: 4, pre_l: 3, pre_source: 'history' }]]);
  const one = parseBoutsCsv(head + row('1', '2026-01-01T00:00Z', 'A', 'B', 'True', 'False') + '\n');
  const E: EloConfig = { ...cfg, debut_offset: 25, prior_rec: 150, prior_exp: -25, age_slope: -15, age_knee: 32 };
  const fx = computeFactors(one, facts);
  const ra = priorOf(E, 15, 0), rb = priorOf(E, 4, 3), adj = agePoints(E, fx[0].age_a) - agePoints(E, fx[0].age_b);
  K.near('a first bout: both priors from the records, the age points on the price', walk(one, E, emptyState(), fx).rows[0].p, 1 / (1 + 10 ** (-(ra - rb + adj) / 400)), 1e-15);
  K.chk('an extended configuration refuses to walk without the bouts\' facts', (() => { try { walk(one, E); return false; } catch (_) { return true; } })());
  const off = walk(bouts, cfg), offExt = walk(bouts, { ...cfg, layoff_mode: 'step' }, emptyState(), computeFactors(bouts, new Map()));
  K.eq('with every 2026-10 parameter off, the walk is 1.1.0\'s to the last digit', offExt.rows.map((r) => r.p), off.rows.map((r) => r.p));
}

/* ---- the committed data against the published file ---- */
const sv = servedVersion();
const v11 = versionConfig(COMPARE_VERSION);
K.eq('1.1.0 stays runnable: k 64, new-fighter step x1.5, layoff 365 days / 25%, no calibration', v11 && [v11.config.k, v11.config.k_new_mult, v11.config.layoff_days, v11.config.layoff_regress, v11.config.calibration], [64, 1.5, 365, 0.25, 'none']);
K.chk('the served version is the one versions.json names, served (' + sv.version + ', ' + sv.status + ')', /^SERVED/.test(sv.status));
const { bouts: all } = loadServedBouts();
const FF = loadFighterFacts(REPO);
const W = walk(all, sv.config, emptyState(), factorsFor(all, sv.config, FF.map));
const chk = checkReproduction(W.rows, loadCurrent().doc, sv);
K.chk('every published p_a is reproduced to its four decimals (' + chk.reproduced + ' of ' + chk.published + ')', chk.published > 0 && chk.reproduced === chk.published && !chk.mismatches.length, chk.mismatches);
K.chk('no scheduled bout in the published 14-day window is missing from the file, none extra', !chk.window_missing.length && !chk.window_extra.length, chk);
K.chk('the largest difference from a published value is rounding only (< 0.00005)', chk.max_abs_diff < 0.00005, chk.max_abs_diff);
K.eq('round4 is Python round(x, 4), which rounds the exact binary value (0.40035 is just below the half)', [round4(0.56244999), round4(0.40035), round4(0.12345), round4(0.98765)], [0.5624, 0.4003, 0.1235, 0.9877]);

/* ---- the Python walk itself, when it can be run: served, and with the champion term on ---- */
const code = 'import json,sys\nfrom model_loop.adapters.ufc import model as U\nd=U.load("model_loop/data/ufc/bouts.csv")\ncfg=json.load(open("docs/model-loop/ufc/versions.json"))\ncur=[v for v in cfg["versions"] if v["version"]==cfg["current"]][0]["config"]\nif len(sys.argv)>1: cur=dict(cur,**json.loads(sys.argv[1]))\nrows,st=U.walk(d,cur)\njson.dump({"p":{r.bout_id:[float(r.p_raw),int(r.a_bouts),int(r.b_bouts)] for r in rows.itertuples()},"ratings":st["ratings"]},sys.stdout)';
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
  const pyOn = pyWalk([JSON.stringify({ champ_bonus: 100 })]);
  const Won = walk(all, { ...sv.config, champ_bonus: 100 }, emptyState(), factorsFor(all, { ...sv.config, champ_bonus: 100 }, FF.map));
  const moved = Won.rows.filter((r, i) => r.p !== W.rows[i].p).length;
  K.chk('the champion term moves the prices of the title fights and of the champions\' later bouts (' + moved + ' bouts)', moved > 150, moved);
  if (pyOn) compare('model.py walk() with champ_bonus 100', pyOn, Won);
  /* every 2026-10 parameter on at once (the smooth layoff, shrinkage, recency, the division terms, head to head):
     the port's arithmetic in the Python's order, on the committed bouts and fighter facts */
  const EXT: Partial<EloConfig> = { debut_offset: 25, prior_rec: 150, prior_exp: -25, age_slope: -15, age_knee: 32, age_slope2: -10, young_slope: 5, shrink_bouts: 2, layoff_mode: 'smooth', layoff_days: 270,
    layoff_span: 180, layoff_regress: 0.4, layoff_k_mult: 1.5, half_life_days: 1460, div_regress: 0.25, div_up: -40, div_down: 20, h2h: 100, h2h_decay: 0.5, champ_bonus: 50,
    age_div: { Heavyweight: [30, -20], Bantamweight: [28, -10], 'Light Heavyweight': [38, -25] }, age_elite_slope: -15 };
  const pyExt = pyWalk([JSON.stringify(EXT)]);
  const cx = { ...sv.config, ...EXT } as EloConfig;
  if (pyExt) compare('model.py walk() with every 2026-10 parameter on', pyExt, walk(all, cx, emptyState(), factorsFor(all, cx, FF.map)));
}
process.exit(K.done(py ? 'model.py walk() compared at full precision' : 'python3 with pandas not available: the full-precision comparison with model.py was skipped (the published file was checked)'));
