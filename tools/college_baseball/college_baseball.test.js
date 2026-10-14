#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the engine, offline.

   Proves, on synthetic inputs first and then on the committed artifacts:
     - innings pitched are never decimals ("5.1" is 16 outs; "5.3" is invalid);
     - schedule perspectives reconcile, disagree loudly, and a mirror copy is a
       home dispute, not a score conflict;
     - a seven-inning game, a run-rule game and an extra-inning game are told
       apart from their lines; the home side does not bat when already winning;
     - every distribution sums to one; NB is wider than Poisson; P(home) is
       monotone in the rating gap; the lookup table matches the exact value;
     - the team model recovers a planted league's ranking, credits no home edge
       at a neutral site, and its conference uncertainty cancels in a
       conference game;
     - the simulator never ends a seven-inning game before seven unless a run
       rule applies, reproduces a seed exactly, and calibrates its means;
     - prices are coherent, whole-number lines push, conditional fair odds
       exclude the push, and no expected value is computed without a verified
       settlement profile and a fresh quote;
     - readiness states are independent (a price without a market; a blocked
       quarantined game);
     - the experiment registry detects an edited record;
     - the committed warehouse, walk-forward, board, audit and gates are
       internally consistent and leak-free.

   Run: node tools/college_baseball/college_baseball.test.js
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = (p) => require(path.join(ROOT, p));
let pass = 0; let fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);

const K = R('college_baseball/ingest/common.js');
const SCH = R('college_baseball/ingest/schedules.js');
const RULES = R('college_baseball/lib/rules.js');
const D = R('college_baseball/lib/distribution.js');
const TQ = R('college_baseball/lib/team_quality.js');
const SIM = R('college_baseball/lib/simulator.js');
const PR = R('college_baseball/lib/pricing.js');
const RD = R('college_baseball/lib/readiness.js');
const REG = R('college_baseball/lib/registry.js');
const PI = R('college_baseball/lib/pitchers.js');
const C = R('college_baseball/config.js');

/* 1. ingestion helpers */
ok('5.1 IP is 16 outs', K.outsFromIp('5.1') === 16);
ok('0.2 IP is 2 outs', K.outsFromIp('0.2') === 2);
ok('5.3 IP is invalid, never rounded', typeof K.outsFromIp('5.3') === 'object' && K.outsFromIp('5.3').invalid);
ok('blank IP is null, not zero', K.outsFromIp('') === null);
ok('num("") is null', K.num('') === null && K.num('NA') === null && K.num('0') === 0);
ok('date with doubleheader suffix', JSON.stringify(K.parseDate('02/14/2026(2)')) === JSON.stringify({ date: '2026-02-14', dh: 2, time: null }));
ok('date with TBA time drops the time', K.parseDate('02/16/2024 TBA').time === null);
ok('date with a clock time keeps it as text', K.parseDate('03/01/2025 01:00 PM').time === '01:00 PM');
ok('results available the next day at 06:00 UTC', K.availableAt('2026-03-31') === '2026-04-01T06:00:00Z');
ok('prediction at 14:00 UTC, before the earliest start', K.predictAt('2026-03-31') === '2026-03-31T14:00:00Z' && C.TIME.predict_hour_utc < C.TIME.earliest_start_hour_utc);
ok('person key: "Last, F" and "F Last" agree', K.personKey('Caufield, Casey') === K.personKey('Casey Caufield'));
ok('seed prefix stripped', SCH.stripSeed('#3 UMES') === 'UMES');

/* 2. schedule perspectives */
ok('opponent "@ X" is a road game', SCH.parseOpponent('@ Southeast Mo. St.').role === 'AWAY');
ok('opponent "X @Site" is neutral', (() => { const o = SCH.parseOpponent('Saint Louis @Port Charlotte, FL'); return o.role === 'NEUTRAL' && o.name === 'Saint Louis' && o.site === 'Port Charlotte, FL'; })());
ok('result with extra innings', JSON.stringify(SCH.parseResult('L 4-5 (11)')) === JSON.stringify({ status: 'FINAL', outcome: 'L', team: 4, opp: 5, innings: 11 }));
ok('postponed and canceled', SCH.parseResult('Ppd').status === 'POSTPONED' && SCH.parseResult('Canceled').status === 'CANCELED');
{
  const idx = { seasonTeam: (id) => ({ A: { team_id: '1', name: 'Alpha', division: 1 }, B: { team_id: '2', name: 'Beta', division: 1 } })[id] || null };
  const rows = [
    { team_id: 'A', team_name: 'Alpha', date: '03/01/2025', opponent_id: 'B', opponent: 'Beta', result: 'W 5-3', contest_id: '9' },
    { team_id: 'B', team_name: 'Beta', date: '03/01/2025', opponent_id: 'A', opponent: '@ Alpha', result: 'L 3-5', contest_id: '9' },
  ];
  const [c] = SCH.fromTeamRows(rows, 2025, idx, []);
  const rec = SCH.reconcileTeamContest(c, null);
  ok('two agreeing perspectives verify the score and home side', rec.quality === 'VERIFIED' && rec.home_runs === 5 && rec.away_runs === 3 && c.home_id === '1');
  const bad = [Object.assign({}, rows[0]), Object.assign({}, rows[1], { result: 'L 2-5' })];
  const [c2] = SCH.fromTeamRows(bad, 2025, idx, []);
  const rec2 = SCH.reconcileTeamContest(c2, null);
  ok('two disagreeing perspectives with no tie-break are a CONFLICT', rec2.quality === 'CONFLICT', rec2);
  const [c3] = SCH.fromTeamRows(bad, 2025, idx, []);
  const rec3 = SCH.reconcileTeamContest(c3, { src: 'linescore', home_key: '1', home_runs: 5, away_runs: 3 });
  ok('an independent linescore resolves a 1-1 disagreement by majority', rec3.status === 'FINAL' && rec3.home_runs === 5 && rec3.away_runs === 3 && rec3.quality === 'RESOLVED_MAJORITY', rec3);
  const both = [Object.assign({}, rows[0], { opponent: 'Beta' }), Object.assign({}, rows[1], { opponent: 'Alpha' })];
  const [c4] = SCH.fromTeamRows(both, 2025, idx, []);
  ok('both perspectives claiming home is a conflict', SCH.reconcileTeamContest(c4, null).quality === 'CONFLICT');
  const [c5] = SCH.fromTeamRows(rows, 2025, idx, []);
  const rec5 = SCH.reconcileTeamContest(c5, { src: 'linescore', home_key: '2', home_runs: 3, away_runs: 5 });
  ok('a linescore batting the road side last is a candidate, not an automatic swap', rec5.batsLastCandidate && rec5.batsLastCandidate.side === 'A' && c5.home_id === '1' && rec5.home_runs === 5);
}
{
  const g1 = SCH.fromGameRows([{ date: '05/19/2022', home_team: '#3 UMES', home_team_id: '393', away_team: 'Coppin St.', away_team_id: '165', home_team_score: '8', away_team_score: '9', contest_id: '7' }, { date: '05/19/2022', home_team: '#2 Coppin St.', home_team_id: '165', away_team: 'UMES', away_team_id: '393', home_team_score: '9', away_team_score: '8', contest_id: '7' }], 2022, 'season_file');
  const rec = SCH.reconcileGameRows(g1);
  ok('mirror copies: a home dispute, scores verified, treated as neutral', rec.quality === 'VERIFIED_MIRROR' && rec.g.neutral === 1 && rec.g.home_runs === 8 && rec.g.away_runs === 9, rec);
}

/* 3. rules */
ok('nine innings', RULES.inferScheduled({ away_line: '0 0 0 1 0 0 2 0 0', home_line: '1 0 0 0 0 0 0 1 x' }).scheduled === 9);
ok('tied after nine -> extra innings of a nine-inning game', RULES.inferScheduled({ away_line: '0 0 0 1 0 0 2 0 0 1', home_line: '1 0 0 0 0 2 0 0 0 0' }).basis === 'EXTRA_AFTER_9');
ok('seven innings, margin under ten -> scheduled seven', RULES.inferScheduled({ away_line: '0 0 1 0 0 2 0', home_line: '1 0 0 0 0 0 1', dh: 1 }).scheduled === 7);
ok('a ten-run lead after seven in a single game -> run rule of a nine', (() => { const x = RULES.inferScheduled({ away_line: '0 0 0 0 0 0 0', home_line: '3 4 0 2 1 0 x' }); return x.scheduled === 9 && x.run_rule === 1; })());
ok('tied after seven, decided in the eighth -> a seven-inning game in extras', RULES.inferScheduled({ away_line: '0 0 1 0 0 0 0 1', home_line: '0 0 0 0 0 1 0 0' }).basis === 'EXTRA_AFTER_7');
ok('run rule is a measured probability, not universal', RULES.runRuleProbability({ conf_game: 1 }, { run_rule: { conf: { eligible: 100, stopped: 30 } } }).p === 0.3 && RULES.runRuleProbability({}, {}).p === 0);
{
  const ev = RULES.measure([{ away_line: '0 0 0 0 0 0 0 0 1', home_line: '0 0 0 0 0 0 0 0 0 ', dh: null, season: 2025 }, { away_line: '1 0 0 0 0 0 0 0 0', home_line: '2 0 0 0 0 0 0 0 x', season: 2025 }]);
  ok('R02 measured: home led after the top of the ninth and did not bat', ev.home_not_batting_when_leading.recorded_x === 1 && ev.home_not_batting_when_leading.runs_scored_violation === 0, ev.home_not_batting_when_leading);
}

/* 4. distributions */
const constants = JSON.parse(fs.readFileSync(path.join(ROOT, 'college_baseball/params/constants.json'), 'utf8'));
for (const spec of [{ family: 'poisson' }, { family: 'nb', r: 5 }, { family: 'nb_frailty', r: 8, k: 16 }]) {
  const o = D.outcomes(6.2, 5.4, spec, constants);
  const st = o.total_pmf.reduce((a, b) => a + b, 0); const sm = o.margin_pmf.reduce((a, b) => a + b, 0);
  ok(spec.family + ': total and margin pmfs sum to one', near(st, 1, 1e-9) && near(sm, 1, 1e-9), { st, sm });
  ok(spec.family + ': no tie survives in the margin', o.margin_pmf[o.margin_offset] < 1e-12);
  ok(spec.family + ': the better side is favoured', o.p_home > 0.5);
}
{
  const p = D.poissonPmf(6); const n = D.nbPmf(6, 4);
  const v = (x) => { let m = 0; let s = 0; for (let i = 0; i < x.length; i++) { m += i * x[i]; s += i * i * x[i]; } return s - m * m; };
  ok('NB(6, r=4) variance = 6 + 36/4', near(v(n), 15, 0.05), v(n));
  ok('Poisson variance = mean', near(v(p), 6, 0.01));
  let mono = true; let last = 0; for (let la = 9; la >= 3; la -= 0.5) { const ph = D.outcomes(6, la, { family: 'nb', r: 5 }, constants).p_home; if (ph < last) mono = false; last = ph; }
  ok('P(home) rises as the road side scores less', mono);
  const f = D.pHomeTable({ family: 'nb', r: 5 }, constants); let mx = 0; for (const [a, b] of [[3, 9], [6, 6], [11, 4.5], [7.3, 6.1]]) mx = Math.max(mx, Math.abs(f(a, b) - D.outcomes(a, b, { family: 'nb', r: 5 }, constants).p_home));
  ok('the P(home) table matches the exact computation', mx < 2e-4, mx);
  ok('equal sides in extra innings split evenly; the better side is favoured', near(D.extraInningsHomeWin(1, 1, constants), 0.5, 1e-9) && D.extraInningsHomeWin(1.1, 1, constants) > 0.5);
}

/* 5. team model on a planted league */
{
  const rand = R('engine/stats.js').rng(7);
  const strength = {}; const conf = {};
  for (let t = 0; t < 40; t++) { const c = t < 20 ? 'East' : 'West'; conf[t] = c; strength[t] = (c === 'East' ? 0.15 : -0.15) + (t % 20 - 10) * 0.02; }
  const meta = { conf: (s, id) => conf[id], div: () => 1 };
  const tq = new TQ.TeamQuality({ sigma_team: 0.2, sigma_conf: 0.2, phi: 1.5, parks: false }, meta);
  tq.startSeason(2030);
  const pois = (l) => { let k = 0; let p = Math.exp(-l); let s = p; const u = rand(); while (u > s) { k++; p *= l / k; s += p; } return k; };
  const games = []; let day = 0;
  for (let rep = 0; rep < 14; rep++) for (let t = 0; t < 40; t++) {
    const o = rand() < 0.7 ? (conf[t] === 'East' ? Math.floor(rand() * 20) : 20 + Math.floor(rand() * 20)) : Math.floor(rand() * 40);
    if (o === t) continue;
    const lh = Math.exp(Math.log(6) + strength[t] / 2 - strength[o] / 2 + 0.04); const la = Math.exp(Math.log(6) + strength[o] / 2 - strength[t] / 2 - 0.04);
    games.push({ game_id: 'g' + games.length, date: '2030-03-' + String(1 + (day++ % 28)).padStart(2, '0'), home_id: String(t), away_id: String(o), neutral: 0, home_runs: pois(lh), away_runs: pois(la), park_key: null });
  }
  tq.addGames(games.map((g) => Object.assign({}, g, { home_id: g.home_id, away_id: g.away_id })));
  tq.fit(Date.parse('2030-04-01') / 864e5);
  const est = []; for (let t = 0; t < 40; t++) est.push([strength[t], tq.rating(String(t)).net]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length; const mx = mean(est.map((e) => e[0])); const my = mean(est.map((e) => e[1]));
  let cov = 0; let vx = 0; let vy = 0; for (const [x, y] of est) { cov += (x - mx) * (y - my); vx += (x - mx) ** 2; vy += (y - my) ** 2; }
  ok('the team model recovers a planted league (correlation > 0.8)', cov / Math.sqrt(vx * vy) > 0.8, cov / Math.sqrt(vx * vy));
  ok('the stronger conference is rated stronger', tq.rating('5').conf_net > tq.rating('25').conf_net);
  const pn = tq.predict({ home_id: '3', away_id: '4', neutral: 1 }); const ph = tq.predict({ home_id: '3', away_id: '4', neutral: 0 });
  ok('no home edge at a neutral site', pn.home_adv === 0 && ph.home_adv > 0);
  const inConf = tq.predict({ home_id: '1', away_id: '2', neutral: 1 }); const cross = tq.predict({ home_id: '1', away_id: '22', neutral: 1 });
  ok('conference uncertainty cancels inside a conference', inConf.sd_delta < cross.sd_delta, { inConf: inConf.sd_delta, cross: cross.sd_delta });
  ok('integration over uncertainty pulls toward a coin flip', (() => { const f = (a, b) => D.outcomes(a, b, { family: 'nb', r: 5 }, constants).p_home; return TQ.integrate(8, 4, 0.4, f) < f(8, 4); })());
}

/* 6. simulator */
{
  const g = { lh: 6.5, la: 5.5, p7: 0, run_rule_p: 0.3, frailty: { team_k: 10, shared_k: 30 } };
  const a = SIM.simulate(g, constants, { n: 3000, seed: 5 }); const b = SIM.simulate(g, constants, { n: 3000, seed: 5 });
  ok('the simulator is deterministic for a seed', a.p_home === b.p_home && a.mean_home === b.mean_home);
  ok('simulated means calibrated to the run model (within 4%)', Math.abs(a.mean_home / 6.5 - 1) < 0.04 && Math.abs(a.mean_away / 5.5 - 1) < 0.04, [a.mean_home, a.mean_away]);
  ok('no game ends before the seventh without a run rule', a.innings.slice(0, 7).reduce((x, y) => x + y, 0) === 0);
  ok('joint pmf sums to one', near(a.joint.reduce((x, y) => x + y[2], 0), 1, 1e-9));
  ok('no simulated game ends tied', a.joint.every(([h, aw]) => h !== aw));
  const seven = SIM.simulate(Object.assign({}, g, { p7: 1, run_rule_p: 0 }), constants, { n: 2000, seed: 9 });
  ok('a scheduled seven is never priced as a nine: it ends after seven unless tied (extra innings)', seven.innings[7] > 0.85 && seven.innings.slice(8).reduce((x, y) => x + y, 0) < 0.15 && seven.innings[6] === 0, seven.innings.slice(6, 11));
  ok('a seven-inning game scores fewer runs', seven.mean_home < a.mean_home);
  const noRR = SIM.simulate(Object.assign({}, g, { lh: 12, la: 3, run_rule_p: 0 }), constants, { n: 2000, seed: 3 });
  ok('with no run rule in force none is applied', noRR.run_rule_share === 0);
  ok('walk-offs exist and are a minority', a.walkoff_share > 0.03 && a.walkoff_share < 0.2, a.walkoff_share);
}

/* 7. pricing */
{
  const s = SIM.simulate({ lh: 6.5, la: 5.5, p7: 0, run_rule_p: 0.3 }, constants, { n: 4000, seed: 2 });
  const p = PR.price(PR.fromJoint(s.joint), { f5: s.f5_joint });
  ok('prices are coherent', PR.coherence(p).ok, PR.coherence(p).errors);
  const rl1 = p.run_lines.find((x) => x.home_line === -1);
  ok('a whole-number run line can push', rl1.push > 0);
  ok('the conditional fair price excludes the push', rl1.fair_home === PR.american(rl1.home_cover / (rl1.home_cover + rl1.away_cover)));
  ok('american odds: 0.6 -> -150, 0.4 -> +150', PR.american(0.6) === -150 && PR.american(0.4) === 150);
  ok('first five three-way sums to one', near(p.first_five.three_way.home + p.first_five.three_way.tie + p.first_five.three_way.away, 1, 2e-4));
  ok('no EV without a quote', PR.expectedValue(0.6, null, 'action_full_game', Date.now()).status === 'MARKET_UNAVAILABLE');
  ok('no EV under an unverified settlement profile', PR.expectedValue(0.6, { american: 120, captured_at: new Date().toISOString() }, 'action_full_game', Date.now()).status === 'SETTLEMENT_UNVERIFIED');
  ok('every settlement profile is an unverified template today', Object.values(PR.SETTLEMENT_PROFILES).every((x) => x.status !== 'VERIFIED'));
}

/* 8. readiness */
{
  const priced = RD.assess({ home_id: '1', away_id: '2', quality: 'VERIFIED', status: 'FINAL' }, { model_ok: true, price: { ok: 1 }, coherence: { ok: true }, model_status: 'PROVISIONAL', starters: { home: 'PROJECTED', away: 'UNKNOWN' } });
  ok('a game can be priced with no market', priced.states.PRICE_GENERATED === true && priced.states.MARKET_VERIFIED === false && priced.states.VALUE_EVALUATED === false);
  ok('unconfirmed starters make a price provisional', priced.states.PROVISIONAL === true && priced.reasons.PROVISIONAL.some((x) => /starting pitchers/.test(x)));
  const q = RD.assess({ home_id: '1', away_id: '2', quality: 'CONFLICT', status: 'FINAL' }, { model_ok: true });
  ok('a quarantined game is research-blocked and unpriced', q.states.RESEARCH_BLOCKED === true && q.states.PRICE_GENERATED === false);
  const mk = RD.assess({ home_id: '1', away_id: '', quality: 'VERIFIED', status: 'FINAL' }, { quote: { authorised: true } });
  ok('a market does not make an unidentified game model-eligible', mk.states.MARKET_VERIFIED === true && mk.states.MODEL_ELIGIBLE === false);
}

/* 9. registry */
{
  const f = path.join(os.tmpdir(), 'cbase_reg_' + process.pid + '.jsonl'); try { fs.unlinkSync(f); } catch (_) {}
  const rec = { id: 'T1', title: 't', hypothesis: 'h', dataset: {}, windows: {}, features: [], algorithm: {}, seeds: [1], metrics: { a: 1 }, decision: 'REJECT', justification: 'j' };
  ok('registry appends', REG.register(rec, { file: f, now: '2026-01-01', code: { commit: 'x' } }).action === 'appended');
  ok('registry: identical re-run is a no-op', REG.register(rec, { file: f, now: '2026-01-02', code: { commit: 'y' } }).action === 'unchanged');
  ok('registry: a changed result is a revision', REG.register(Object.assign({}, rec, { metrics: { a: 2 } }), { file: f, now: '2026-01-03', code: { commit: 'z' } }).action === 'revised');
  ok('registry chain verifies', REG.verify({ file: f }).ok);
  const lines = fs.readFileSync(f, 'utf8').split('\n'); lines[0] = lines[0].replace('"REJECT"', '"ACCEPT"'); fs.writeFileSync(f, lines.join('\n'));
  ok('an edited record breaks the chain', !REG.verify({ file: f }).ok);
  let threw = false; try { REG.register({ id: 'bad' }, { file: f }); } catch (_) { threw = true; } ok('an incomplete record is refused', threw);
  fs.unlinkSync(f);
}

/* 10. pitchers */
{
  const st = new PI.PitchingState();
  st.queue = [{ person_id: 'p1', team_id: 't', date: '2025-03-01', season: 2025, game_id: 'g1', seq: 1, starter: 1, bf: 25, so: 9, bb: 1, hb: 0, hr_a: 0, h: 4, r: 1, er: 1, outs: 18 },
    { person_id: 'p2', team_id: 't', date: '2025-03-02', season: 2025, game_id: 'g2', seq: 2, starter: 0, bf: 12, so: 2, bb: 2, hb: 0, hr_a: 1, h: 3, r: 3, er: 3, outs: 6 }];
  st.lw = { per_bf: 0.16, so: -0.2, bb_hbp: 0.3, hr: 1.2, h_non_hr: 0.5 };
  st.advance('2025-03-03');
  const t1 = st.talent('p1', 2025);
  ok('a strikeout rate is shrunk toward the league, not taken raw', t1.rate.so < 9 / 25 && t1.rate.so > st.popRate('so'));
  const wl = st.workload('p2');
  ok('workload: yesterday\'s batters faced and an estimated pitch count with its spread', wl.bf1 === 12 && wl.pitches3_est === Math.round(12 * PI.PITCHES_PER_BF) && wl.pitches3_sd > 0);
  const pj = st.projectStarter('t', 2025, '2025-03-08', {});
  ok('starter projection probabilities sum to one', near(pj.candidates.reduce((a, c) => a + c.p, 0) + pj.p_unseen, 1, 1e-9));
  ok('a starter projection is never CONFIRMED', pj.status === 'PROJECTED' || pj.status === 'UNKNOWN');
}

/* 11. committed artifacts */
const V = (p) => path.join(ROOT, 'college_baseball', p);
const W = R('college_baseball/lib/warehouse.js');
{
  let rows = 0; let badKnown = 0; let ids = new Set(); let dups = 0;
  for (let s = C.SEASONS.first; s <= C.SEASONS.last; s++) for (const g of W.games(s)) { rows++; if (g.known_at != null || g.pit !== 'RETRO') badKnown++; if (ids.has(g.game_id)) dups++; ids.add(g.game_id); }
  ok('the warehouse has every season', rows > 100000, rows);
  ok('no warehouse row backdates known_at', badKnown === 0, badKnown);
  ok('game ids are unique across seasons', dups === 0, dups);
  const q = W.games(2024).filter((g) => g.quality === 'CONFLICT').map((g) => g.game_id);
  const quar = fs.readFileSync(V('data/quarantine/2024.csv'), 'utf8');
  ok('every conflict is in the quarantine file', q.every((id) => quar.includes(id)));
}
if (fs.existsSync(V('validation/walkforward.json'))) {
  const wf = JSON.parse(fs.readFileSync(V('validation/walkforward.json'), 'utf8'));
  ok('walk-forward is leak-free', wf.leakage.ok && wf.leakage.violations === 0);
  ok('walk-forward is labelled RETROSPECTIVE', wf.data.point_in_time === 'RETROSPECTIVE');
  ok('walk-forward claims no market test', wf.market.market_status === 'NOT_TESTED');
  const WFM = R('college_baseball/walkforward.js');
  const sel = wf.selection.log_loss;
  ok('the chosen model follows the selection rule', R('engine/lab/protocol.js').choose(sel, WFM.selectionOrder(sel)) === wf.selection.chosen);
  if (wf.pricing) ok('the ensemble prices only if it beat the chosen model on VALIDATION', wf.pricing.model === (wf.comparisons.VALIDATION.ens_vs_chosen.a_better ? 'ens' : wf.selection.chosen));
  ok('the HOLDOUT is either withheld or carries a status', wf.windows_report.HOLDOUT.withheld === true || !!(wf.status && wf.status.moneyline && wf.status.moneyline.status));
}
{
  /* the weekly refit (no --holdout) restates this version's holdout look; any other change withholds it */
  const WFM = R('college_baseball/walkforward.js');
  const prev = { model_version: 'v1', pricing: { model: 'ens' }, windows_report: { HOLDOUT: { n: 10, seasons: [2025], models: {} } }, comparisons: { HOLDOUT: { x: 1 } }, status: { moneyline: { status: 'PROVISIONAL', failed: [] } }, generated_at: 'T0', markets: { moneyline: { status: 'PROVISIONAL' } } };
  const fresh = () => ({ model_version: 'v1', pricing: { model: 'ens' }, windows_report: { HOLDOUT: { withheld: true } }, comparisons: {}, markets: { moneyline: { status: 'PROVISIONAL', failed: ['not evaluated'] } } });
  const a = fresh(); WFM.carryHoldout(a, prev);
  ok('holdout: carried forward for the same version and pricing model, labelled', a.windows_report.HOLDOUT.carried_from === 'T0' && a.status.moneyline.status === 'PROVISIONAL' && a.holdout_evaluated_at === 'T0');
  const b = fresh(); b.model_version = 'v2'; WFM.carryHoldout(b, prev);
  ok('holdout: a new model version is not credited with the old look', b.windows_report.HOLDOUT.withheld === true && !b.status);
  const c = fresh(); c.pricing.model = 'hier_cal'; WFM.carryHoldout(c, prev);
  ok('holdout: a different pricing model is not credited with the old look', c.windows_report.HOLDOUT.withheld === true && !c.status);
  const d = fresh(); WFM.carryHoldout(d, null);
  ok('holdout: nothing to carry on a first run', d.windows_report.HOLDOUT.withheld === true);
}
if (fs.existsSync(V('board/index.json'))) {
  const idx = JSON.parse(fs.readFileSync(V('board/index.json'), 'utf8'));
  ok('board: value claims disabled', idx.value_claims === 'DISABLED');
  ok('board: replay labelled retrospective', idx.mode === 'LIVE' || idx.point_in_time === 'RETROSPECTIVE');
  ok('board: no failed inference left unreported', Array.isArray(idx.failures));
  const dd = idx.dates[Math.floor(idx.dates.length / 2)].date;
  const day = JSON.parse(fs.readFileSync(V(`board/${idx.season}/${dd}.json`), 'utf8'));
  const det = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(V(`board/${idx.season}/detail/${dd}.json.gz`))).toString('utf8'));
  ok('board: the summary and the detail list the same games', day.games.length === det.games.length && day.games.every((g, i) => g.game_id === det.games[i].game_id));
  ok('board: every game has a readiness assessment', day.games.every((g) => g.readiness && g.readiness.states) && det.games.every((g) => g.readiness && g.readiness.states));
  ok('board: no game shows an EV', det.games.every((g) => !g.market || g.market.ev == null));
  const priced = det.games.filter((g) => g.prices);
  ok('board: the detail carries prices, and every priced game is coherent', priced.length > 0 && priced.every((g) => PR.coherence(g.prices).ok), priced.length);
  ok('board: the summary moneyline is the detail moneyline', day.games.every((g, i) => !g.ml || g.ml.fair_home === det.games[i].prices.moneyline.fair_home));
  ok('board: no game is VALUE_EVALUATED', day.games.every((g) => !g.readiness.states.VALUE_EVALUATED));
}
if (fs.existsSync(V('validation/release_gates.json'))) {
  const gt = JSON.parse(fs.readFileSync(V('validation/release_gates.json'), 'utf8'));
  ok('gates: sixteen explicit gates', gt.gates.length === 16 && gt.gates.every((g) => g.status === 'PASS' || g.status === 'FAIL'));
  ok('gates: source authorisation fails without an owner sign-off', !fs.existsSync(V('research/authorizations.json')) ? gt.gates.find((g) => g.id === 'G1').status === 'FAIL' : true);
  ok('gates: market settlement cannot pass without a verified book', gt.gates.find((g) => g.id === 'G12').status === 'FAIL');
}
ok('registry chain intact', REG.verify().ok, REG.verify().errors.slice(0, 3));
{
  /* the delivery report is generated from the evidence: no hole, no claim the evidence does not make */
  const md = R('college_baseball/report.js').build();
  ok('report: no undefined or NaN anywhere', !/undefined|NaN/.test(md), (md.match(/.{0,60}(undefined|NaN).{0,40}/) || [])[0]);
  ok('report: research, not picks', /Research, not picks/.test(md) && /Market:\*\* NOT_TESTED/.test(md));
  ok('report: never claims a market edge', !/\b(edge|value bet|lock|best bet)\b/i.test(md.replace(/grid edges?|no betting opportunity|value claims/gi, '')));
}

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
