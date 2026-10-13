#!/usr/bin/env node
/* ===========================================================================
   The NHL brain, offline: every rule the pipeline relies on, on synthetic
   inputs where the right answer is known, plus the committed artifacts.

     ingest      strength states, time on ice, the score BEFORE a shot, the
                 shootout credited from the official final, duplicates
     xG          features, the empty-net model, missing geometry is not 0
     ratings     a game never sees itself or anything on its own date
     distribution  mass, settlement (OT/SO win = one-goal win, SO goal in the
                 total, whole-number push), monotonicity, score effects
     calibration the pair recalibration is the identity without history
     guard       cache, revalidation, quota refusal, breaker, retries, a paid
                 provider spends nothing by default, an unknown host is refused
     sources     the NHL API schedule parser; sportsbook names → clubs
     spend       the quote job spends nothing without NHL_PRICES=on
     artifacts   the committed team-game table, walk-forward record and slate

   Run: node tools/hockey/hockey.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const G = require(path.join(ROOT, 'hockey', 'ingest', 'game.js'));
const X = require(path.join(ROOT, 'hockey', 'xg', 'model.js'));
const DIST = require(path.join(ROOT, 'hockey', 'model', 'distribution.js'));
const GLM = require(path.join(ROOT, 'hockey', 'model', 'glm.js'));
const R = require(path.join(ROOT, 'hockey', 'model', 'ratings.js'));
const V = require(path.join(ROOT, 'engine', 'validation.js'));
const ST = require(path.join(ROOT, 'engine', 'stats.js'));
const HTTP = require(path.join(ROOT, 'engine', 'http.js'));
const API = require(path.join(ROOT, 'hockey', 'sources', 'nhl_api.js'));
const Q = require(path.join(ROOT, 'hockey', 'market', 'quotes.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-6 : e);

(async function main() {
  /* ---------------- ingest ---------------- */
  const ev = (o) => Object.assign({ period: 1, period_type: 'REGULAR', home_skaters: 5, away_skaters: 5, home_goalie_in: 1, away_goalie_in: 1, empty_net: false }, o);
  const meta = { game_id: 1, season: 2027, season_type: 'R', date: '2026-10-10', home: 'AAA', away: 'BBB', final_home: 2, final_away: 1 };
  const events = [
    ev({ event_idx: 1, event_type: 'FACEOFF', game_seconds: 0, x_fixed: 0, y_fixed: 0 }),
    ev({ event_idx: 2, event_type: 'SHOT', event_team_type: 'home', game_seconds: 100, x_fixed: 70, y_fixed: 5, secondary_type: 'wrist', event_goalie_id: 9 }),
    ev({ event_idx: 3, event_type: 'GOAL', event_team_type: 'home', game_seconds: 102, x_fixed: 80, y_fixed: -2, secondary_type: 'tip-in', event_goalie_id: 9 }),
    ev({ event_idx: 4, event_type: 'PENALTY', event_team_type: 'home', game_seconds: 600, penalty_severity: 'Minor', penalty_minutes: 2 }),
    ev({ event_idx: 5, event_type: 'FACEOFF', game_seconds: 600, home_skaters: 4, away_skaters: 5 }),
    ev({ event_idx: 6, event_type: 'GOAL', event_team_type: 'away', game_seconds: 650, home_skaters: 4, away_skaters: 5, x_fixed: -75, y_fixed: 3, secondary_type: 'snap', event_goalie_id: 7 }),
    ev({ event_idx: 7, event_type: 'FACEOFF', game_seconds: 660 }),
    ev({ event_idx: 8, period: 3, event_type: 'FACEOFF', game_seconds: 3480, away_goalie_in: 0, away_skaters: 6 }),
    ev({ event_idx: 9, period: 3, event_type: 'MISSED_SHOT', event_team_type: 'home', game_seconds: 3500, away_goalie_in: 0, away_skaters: 6, x_fixed: -50, y_fixed: 0, empty_net: true }),
    ev({ event_idx: 10, period: 3, event_type: 'GAME_END', game_seconds: 3600, away_goalie_in: 0, away_skaters: 6 }),
  ];
  /* note: 1-1 after the away goal, the home team leads 2-1 officially? no: build a tie then a shootout */
  const recTie = G.processGame(Object.assign({}, meta, { final_home: 2, final_away: 1 }), events);
  chk('ingest: a regulation tie with an official 2-1 final is a shootout, the home team credited one goal', recTie.game.decided === 'SO' && recTie.game.so_winner === 'home' && recTie.game.final_home === 2 && recTie.game.final_away === 1 && recTie.game.reg_home === 1 && recTie.game.reg_away === 1, recTie.game);
  chk('ingest: the shot that scored carries the score BEFORE it (0-0)', recTie.shots.find((s) => s.goal && s.side === 'home').diff === 0);
  chk('ingest: the away goal was scored trailing by one, on the power play', (() => { const s = recTie.shots.find((x) => x.goal && x.side === 'away'); return s.diff === -1 && s.state === 'pp'; })());
  chk('ingest: a rebound is the same team shooting within 3 s', recTie.shots.find((s) => s.goal && s.side === 'home').rebound === 1);
  chk('ingest: the away goal is attacking right after the flip (X > 0)', recTie.shots.find((s) => s.side === 'away').X === 75);
  chk('ingest: power-play time is credited to the right side', recTie.teams.away.toi.pp === 60 && recTie.teams.home.toi.sh === 60, [recTie.teams.away.toi, recTie.teams.home.toi]);
  chk('ingest: a pulled goalie is "ena" for the trailing side and "enf" for the other', recTie.teams.away.toi.ena === 120 && recTie.teams.home.toi.enf === 120, [recTie.teams.away.toi, recTie.teams.home.toi]);
  chk('ingest: the empty-net attempt is flagged and not charged to a goalie', recTie.shots.find((s) => s.empty_net).goalie == null && !recTie.teams.away.goalies['null']);
  chk('ingest: the penalty is the home team\'s', recTie.teams.home.pen_minors === 1 && recTie.teams.away.pen_minors === 0);
  chk('ingest: the official final agrees, so no issue is raised', recTie.issues.length === 0, recTie.issues);
  const bad = G.processGame(Object.assign({}, meta, { final_home: 5, final_away: 1 }), events);
  chk('ingest: a play-by-play final that disagrees with the official one is flagged, not hidden', bad.issues.some((i) => /differs from official/.test(i)), bad.issues);
  const so = events.concat([ev({ event_idx: 11, period: 5, period_type: 'SHOOTOUT', event_type: 'GOAL', event_team_type: 'away', game_seconds: 3900, x_fixed: -80, y_fixed: 0 })]);
  const recSo = G.processGame(Object.assign({}, meta, { final_home: 1, final_away: 2 }), so);
  chk('ingest: shootout attempts never enter shots or rates', recSo.shots.length === recTie.shots.length && recSo.game.so_winner === 'away');

  /* ---------------- xG ---------------- */
  const shots = [];
  const rnd = ST.rng(7);
  for (let i = 0; i < 4000; i++) {
    const dist = 5 + rnd() * 60, angle = rnd() * 80;
    const p = 1 / (1 + Math.exp(-(0.5 - 0.08 * dist)));
    shots.push({ dist, angle, X: 89 - dist * Math.cos(angle * Math.PI / 180), Y: dist * Math.sin(angle * Math.PI / 180), type: 'wrist', state: 'ev5', rebound: 0, rush: 0, since_prev: 20, prev_type: 'FACEOFF', prev_same: 0, empty_net: 0, goal: rnd() < p ? 1 : 0 });
  }
  for (let i = 0; i < 300; i++) shots.push({ dist: 100 + rnd() * 80, angle: 5, type: 'wrist', state: 'enf', empty_net: 1, goal: rnd() < 0.4 ? 1 : 0 });
  const m = X.fit(shots); const pr = X.predictor(m);
  chk('xG: a closer shot is worth more', pr.predict({ dist: 10, angle: 10, type: 'wrist', state: 'ev5' }) > pr.predict({ dist: 50, angle: 10, type: 'wrist', state: 'ev5' }));
  chk('xG: the empty-net model is separate (a 150 ft empty-net shot is far likelier than a defended one)', pr.predict({ dist: 150, angle: 5, state: 'enf', empty_net: 1 }) > 5 * pr.predict({ dist: 150, angle: 5, type: 'wrist', state: 'ev5' }));
  chk('xG: missing geometry gets the league rate, not zero', near(pr.predict({ dist: null, angle: null, state: 'ev5' }), m.fallback.defended_rate) && m.fallback.defended_rate > 0);
  chk('xG: the feature vector length matches the names', X.features(shots[0]).length === X.NAMES.length);

  /* ---------------- ratings: no look-ahead ---------------- */
  {
    const rs = new R.RatingState();
    const row = (team, opp, home, date, gf, ga) => ({ team, opp, home, date, gf, ga, gf_reg: gf, ga_reg: ga, ev5_xgf_lead: 0, ev5_xgf_tie: gf, ev5_xgf_trail: 0, toi_ev5: 3000, toi_pp: 0, toi_sh: 0, pp_xgf: 0, ev5_xgf: gf, evo_xgf: 0, sh_xgf: 0, ev5_gf: gf, evo_gf: 0, pp_gf: 0, sh_gf: 0, g_start: home ? 1 : 2, g1_id: home ? 1 : 2, g1_xga: ga, g1_ga: ga, g1_fa: 30 });
    const before = rs.snapshot('AAA', 'BBB', true, '2026-10-10', null);
    rs.absorb([row('AAA', 'BBB', 1, '2026-10-10', 9, 0), row('BBB', 'AAA', 0, '2026-10-10', 0, 9)]);
    const after = rs.snapshot('AAA', 'BBB', true, '2026-10-11', null);
    chk('ratings: the snapshot taken before a game does not move when the game is absorbed later', before.ev_off === 1 && after.ev_off > 1, [before.ev_off, after.ev_off]);
    chk('ratings: a back-to-back is detected from the previous game date', after.b2b === 1 && after.rest === 1);
  }

  /* ---------------- distribution and settlement ---------------- */
  const eff = DIST.neutralEffects();
  const D = DIST.game({ lamH: 3.3, lamA: 2.7, effects: eff, ot: { k: 2.3, so_home: 0.5, format: 'R3v3' } });
  let mass = 0; for (let i = 0; i < D.final_matrix.length; i++) mass += D.final_matrix[i];
  chk('distribution: the final matrix sums to 1', near(mass, 1, 1e-9), mass);
  chk('distribution: no final score is tied (OT/SO always decide a regular-season game)', (() => { const N = D.maxg + 2; for (let h = 0; h < N; h++) if (D.final_matrix[h * N + h] > 1e-12) return false; return true; })());
  chk('distribution: home win = regulation win + its share of the ties', near(D.p_home, D.reg.home + D.reg.draw * (D.tie_split.ot_home + D.tie_split.so_home)));
  const pl = DIST.spread(D, -1.5);
  chk('settlement: −1.5 excludes every OT/SO win (a one-goal win)', near(pl.win, (() => { let s = 0; const N = D.maxg + 2; for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) if (h - a >= 2) s += D.final_matrix[h * N + a]; return s; })()) && pl.win < D.reg.home);
  chk('settlement: a half-goal line never pushes; a whole line can', DIST.total(D, 5.5).push === 0 && DIST.total(D, 6).push > 0);
  chk('settlement: the shootout winner\'s goal is in the total', DIST.expectedTotal(D) > 3.3 + 2.7);
  chk('settlement: a fair price with a push is the break-even of win vs lose', (() => { const t = DIST.total(D, 6); const a = DIST.fairAmericanWithPush(t.over, t.push); const d = a > 0 ? 1 + a / 100 : 1 + 100 / -a; return near(t.over * (d - 1) - t.under, 0, 0.01); })());
  const D2 = DIST.game({ lamH: 3.6, lamA: 2.7, effects: eff, ot: { k: 2.3, so_home: 0.5, format: 'R3v3' } });
  chk('distribution: more expected home goals means a likelier home win and over', D2.p_home > D.p_home && DIST.total(D2, 5.5).over > DIST.total(D, 5.5).over);
  chk('distribution: expected regulation goals match λ', (() => { const N = D.maxg + 1; let eh = 0; for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) eh += h * D.reg_matrix[h * N + a]; return near(eh, 3.3, 0.02); })());
  const PO = DIST.game({ lamH: 3, lamA: 3, effects: eff, ot: { format: 'PO' } });
  chk('distribution: a playoff tie between equal teams is a coin flip in sudden death', near(PO.p_home, 0.5, 1e-6) && PO.p_so === 0);
  /* score effects estimated from games where leaders always score late (empty nets) */
  const games = []; for (let i = 0; i < 2000; i++) games.push({ goals: [{ t: 1000, side: 'home' }, { t: 3570, side: 'home' }] });
  const E = DIST.estimateScoreEffects(games, { prior_goals: 1 });
  chk('score effects: a lead in the last minute is where these goals happened', E.m[6][3 + 1] > 5 && E.m[0][3] > 0.5, [E.m[6], E.m[0]]);
  const sheet = DIST.sheet(D);
  chk('sheet: the moneyline sides sum to 1 and the 3-way sums to 1', near(sheet.moneyline.home + sheet.moneyline.away, 1) && near(sheet.regulation.home + sheet.regulation.draw + sheet.regulation.away, 1));

  /* ---------------- pair recalibration ---------------- */
  chk('calibration: the identity when no earlier out-of-sample season exists', (() => { const c = GLM.fitPairCalibration([]); const o = GLM.applyPairCalibration(3, 2.5, c); return c.a === 1 && c.b === 1 && o.lh === 3 && o.la === 2.5; })());
  {
    const rows = []; const r2 = ST.rng(3);
    for (let i = 0; i < 3000; i++) { const T = 5 + (r2() - 0.5) * 2; const pi = 0.5 + (r2() - 0.5) * 0.2; const trueT = 5.6 + 0.5 * (T - 5.6); const pois = (l) => { let k = 0, p = Math.exp(-l), s = p; const u = r2(); while (u > s && k < 20) { k++; p *= l / k; s += p; } return k; }; rows.push({ lh: T * pi, la: T * (1 - pi), gh: pois(trueT * pi), ga: pois(trueT * (1 - pi)) }); }
    const c = GLM.fitPairCalibration(rows);
    chk('calibration: totals that vary twice as much as reality are shrunk (a ≈ 0.5)', c.a > 0.2 && c.a < 0.8, c);
  }

  /* ---------------- leakage audit ---------------- */
  {
    const a = V.leakageAudit([{ id: 1, predicted_at: '2026-10-10T22:00:00Z', event_start: '2026-10-10T23:00:00Z', inputs_known_at: '2026-10-10T05:00:00Z' }, { id: 2, predicted_at: '2026-10-10T22:00:00Z', event_start: '2026-10-10T23:00:00Z', inputs_known_at: '2026-10-10T22:30:00Z' }, { id: 3, predicted_at: '2026-10-10T23:00:00Z', event_start: '2026-10-10T23:00:00Z' }]);
    chk('leakage: an input known after the prediction and a prediction at the start are both caught', a.violations === 2 && a.examples.map((x) => x.id).join() === '2,3', a);
  }

  /* ---------------- the guarded client ---------------- */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
    let calls = 0, now = Date.parse('2026-10-13T00:00:00Z');
    const mk = (status, body, headers) => ({ status, headers: { get: (k) => (headers || {})[k] || null }, arrayBuffer: async () => Buffer.from(body || '') });
    let script = [];
    const fetchImpl = async (url, o) => { calls++; const s = script.shift(); if (s instanceof Error) throw s; return s(url, o); };
    const c = HTTP.createClient({ cacheDir: dir, fetchImpl, now: () => now, sleep: async () => {}, providers: { github_raw: { host: /raw\.githubusercontent\.com$/, paid: false, perRun: 3, perDay: 100, concurrency: 1 }, paidthing: { host: /paid\.example$/, paid: true } }, breakerFailures: 2 });
    script = [() => mk(200, 'hello', { etag: 'W/"1"' })];
    let r = await c.get('https://raw.githubusercontent.com/a/b.json', { ttlMs: 1000 });
    chk('guard: a fetch is cached', r.ok && r.text() === 'hello' && !r.fromCache && calls === 1);
    r = await c.get('https://raw.githubusercontent.com/a/b.json', { ttlMs: 1000 });
    chk('guard: inside the TTL the cache answers and nothing is sent', r.fromCache && calls === 1);
    now += 5000;
    script = [(u, o) => { chk('guard: revalidation sends the ETag', o.headers['if-none-match'] === 'W/"1"'); return mk(304, ''); }];
    r = await c.get('https://raw.githubusercontent.com/a/b.json', { ttlMs: 1000 });
    chk('guard: a 304 is served from the cache as revalidated', r.revalidated && r.text() === 'hello' && calls === 2);
    now += 5000;
    script = [() => mk(500, 'x'), () => mk(503, 'x'), () => mk(200, 'world')];
    r = await c.get('https://raw.githubusercontent.com/a/c.json', { ttlMs: 1000 });
    chk('guard: per-run quota stops retries and refuses past it', !r.ok && r.error.code === 'QUOTA' && calls === 3, [r.error, calls]);
    const c2 = HTTP.createClient({ cacheDir: dir, fetchImpl, now: () => now, sleep: async () => {}, providers: { github_raw: { host: /raw\.githubusercontent\.com$/, perRun: 50, perDay: 1000, concurrency: 1 } }, breakerFailures: 2, retries: 0 });
    script = [() => mk(502, ''), () => mk(502, '')];
    await c2.get('https://raw.githubusercontent.com/x/1', { ttlMs: 0 }); await c2.get('https://raw.githubusercontent.com/x/2', { ttlMs: 0 });
    const callsBefore = calls;
    r = await c2.get('https://raw.githubusercontent.com/x/3', { ttlMs: 0 });
    chk('guard: after repeated failures the breaker opens and sends nothing', !r.ok && r.error.code === 'BREAKER_OPEN' && calls === callsBefore, r.error);
    now += 20 * 60e3;
    script = [() => mk(200, 'back')];
    r = await c2.get('https://raw.githubusercontent.com/x/3', { ttlMs: 0 });
    chk('guard: the breaker half-opens after its cooldown', r.ok && r.text() === 'back');
    r = await c2.get('https://raw.githubusercontent.com/a/b.json', { ttlMs: 0 }).catch((e) => e);
    const c3 = HTTP.createClient({ cacheDir: dir, fetchImpl, now: () => now, sleep: async () => {}, providers: { paidthing: { host: /paid\.example$/, paid: true } } });
    const before = calls;
    r = await c3.get('https://paid.example/odds', { ttlMs: 0 });
    chk('guard: a paid provider spends nothing unless it is given a quota', !r.ok && r.error.code === 'QUOTA' && calls === before, r.error);
    let refused = false; try { await c3.get('https://not-registered.example/x'); } catch (e) { refused = e.code === 'UNKNOWN_PROVIDER'; }
    chk('guard: an unregistered host is refused', refused);
    chk('guard: the odds provider is not a registered host', !Object.values(HTTP.DEFAULT_PROVIDERS).some((p) => p.host.test('api.the-odds-api.com')));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---------------- sources ---------------- */
  {
    /* the shape documented for /v1/schedule/{date} (a fixture written to that shape, not a recorded response) */
    const sample = { gameWeek: [{ date: '2026-10-13', games: [
      { id: 2026020100, gameType: 2, gameDate: '2026-10-13', startTimeUTC: '2026-10-13T23:00:00Z', gameState: 'FUT', venue: { default: 'Little Caesars Arena' }, homeTeam: { abbrev: 'DET' }, awayTeam: { abbrev: 'NJD' } },
      { id: 2026010001, gameType: 1, gameDate: '2026-10-13', startTimeUTC: '2026-10-13T23:00:00Z', gameState: 'FUT', homeTeam: { abbrev: 'BOS' }, awayTeam: { abbrev: 'NYR' } },
      { id: null, gameType: 2 }] }] };
    const g = API.parseSchedule(sample);
    chk('NHL API: games parse to the shared shape; a malformed entry is skipped', g.length === 2 && g[0].home === 'DET' && g[0].game_type === 'R' && g[0].start_utc === '2026-10-13T23:00:00Z' && g[1].game_type === 'PR');
    chk('NHL API: an empty or broken body is no games, never a throw', API.parseSchedule(null).length === 0 && API.parseSchedule({}).length === 0);
    chk('quotes: sportsbook club names resolve, accents and punctuation included', Q.abbrOf('Montreal Canadiens') === 'MTL' && Q.abbrOf('Montréal Canadiens') === 'MTL' && Q.abbrOf('St Louis Blues') === 'STL' && Q.abbrOf('Utah Hockey Club') === 'UTA' && Q.abbrOf('Arizona Coyotes') === null);
    const sched = [{ game_id: 7, home: 'DET', away: 'NJD', start_utc: '2026-10-13T23:00:00Z' }];
    const n = Q.normaliseEvents([
      { id: 'e1', home_team: 'Detroit Red Wings', away_team: 'New Jersey Devils', commence_time: '2026-10-13T23:05:00Z', bookmakers: [{ key: 'pinnacle', last_update: '2026-10-13T20:00:00Z', markets: [
        { key: 'h2h', outcomes: [{ name: 'Detroit Red Wings', price: -130 }, { name: 'New Jersey Devils', price: 118 }] },
        { key: 'spreads', outcomes: [{ name: 'Detroit Red Wings', price: 175, point: -1.5 }, { name: 'New Jersey Devils', price: -205, point: 1.5 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 6.5 }, { name: 'Under', price: -110, point: 6.5 }] }] }] },
      { id: 'e2', home_team: 'Detroit Red Wings', away_team: 'New Jersey Devils', commence_time: '2026-10-20T23:00:00Z', bookmakers: [] },
      { id: 'e3', home_team: 'Springfield Ice', away_team: 'New Jersey Devils', commence_time: '2026-10-13T23:00:00Z', bookmakers: [] }], sched);
    chk('quotes: a provider event joins its game by both clubs and a start within 6 h', n.events.length === 1 && n.events[0].game_id === 7 && n.events[0].books[0].h2h.home === -130 && n.events[0].books[0].spreads[0].home_line === -1.5 && n.events[0].books[0].totals[0].line === 6.5);
    chk('quotes: anything unmatched is kept with its reason, never guessed', n.unmatched.length === 2 && n.unmatched.every((u) => u.reason));
    const nv = Q.noVig(-130, 118);
    chk('quotes: the no-vig split sums to one and removes the overround', near(nv.a + nv.b, 1) && nv.overround > 0);
  }

  /* ---------------- spend nothing by default ---------------- */
  {
    const FQ = require(path.join(ROOT, 'hockey', 'market', 'fetch_quotes.js'));
    let called = 0;
    const out = path.join(ROOT, 'hockey', 'market', 'quotes.json');
    const keep = fs.existsSync(out) ? fs.readFileSync(out) : null;
    const r = await FQ.run({ env: { EDGD_SB_URL: 'https://x.supabase.co', EDGD_SB_SERVICE: 'k' }, fetchImpl: async () => { called++; return { status: 200, text: async () => '{}' }; } });
    chk('spend: without NHL_PRICES=on the quote job asks the gateway nothing', r.status === 'DISABLED' && called === 0, r);
    const r2 = await FQ.run({ env: { NHL_PRICES: 'on' }, fetchImpl: async () => { called++; return { status: 200, text: async () => '{}' }; } });
    chk('spend: with no gateway credentials it asks nothing either', r2.status === 'UNAVAILABLE' && called === 0, r2);
    const r3 = await FQ.run({ env: { NHL_PRICES: 'on', EDGD_SB_URL: 'https://x.supabase.co', EDGD_SB_SERVICE: 'k' }, schedule: [{ game_id: 7, home: 'DET', away: 'NJD', start_utc: '2026-10-13T23:00:00Z' }],
      fetchImpl: async (url, o) => { called++; const b = JSON.parse(o.body); chk('spend: one featured request for icehockey_nhl, through the gateway', /functions\/v1\/odds_gateway$/.test(url) && b.category === 'featured' && b.sport_key === 'icehockey_nhl'); return { status: 200, text: async () => JSON.stringify({ ok: false, decision: 'denied_sport', reason: 'sport not enabled for paid retrieval: icehockey_nhl', source: 'none', data: null }) }; } });
    chk('spend: the gateway\'s refusal (sport row disabled) is reported, not retried', r3.status === 'UNAVAILABLE' && /denied_sport/.test(r3.reason) && called === 1, r3);
    if (keep) fs.writeFileSync(out, keep); else fs.unlinkSync(out);
  }

  /* ---------------- lineups ---------------- */
  {
    const LI = require(path.join(ROOT, 'hockey', 'ingest', 'lineups.js'));
    const { LineupState } = require(path.join(ROOT, 'hockey', 'model', 'lineups.js'));
    chk('lineups: TOI parses mm:ss and refuses anything else (null, never 0)', LI.toiSeconds('15:29') === 929 && LI.toiSeconds('') === null && LI.toiSeconds('n/a') === null && LI.toiSeconds(null) === null);
    const b = LI.buildLineups([
      { game_id: 1, game_date: '2026-10-01', home_away: 'home', player_id: 10, player_name: 'A. One', position: 'C', toi: '20:00' },
      { game_id: 1, game_date: '2026-10-01', home_away: 'home', player_id: 10, player_name: 'A. One', position: 'C', toi: '21:00' },
      { game_id: 1, game_date: '2026-10-01', home_away: 'home', player_id: 11, position: 'D', toi: 'bad' },
      { game_id: 1, game_date: '2026-10-01', home_away: 'away', player_id: 20, position: 'L', toi: '12:00' },
    ]);
    chk('lineups: a repeated player counts once (larger TOI), an unparsed TOI is null and counted', b.games[1].home.length === 2 && b.games[1].home[0][1] === 1260 && b.games[1].home[1][1] === null && b.stats.duplicates === 1 && b.stats.toi_unparsed === 1 && b.names[10] === 'A. One');
    chk('lineups: a team-game with an implausible skater count is flagged, not dropped', b.stats.flagged.length === 2 && b.games[1].away.length === 1);
    const ls = new LineupState(null, { NEW: 'OLD' });
    const L = (ids, star) => ids.map((id) => [id, id === star ? 1500 : 800, 'F']);
    const base = [...Array(18)].map((_, i) => 100 + i);
    chk('lineups: no history -> unknown, delta 0', ls.snapshot('OLD', base).known === false && ls.snapshot('OLD', base).proj === 0);
    for (let k = 0; k < 5; k++) ls.absorb('OLD', L(base, 100));
    const full = ls.snapshot('OLD', base), noStar = ls.snapshot('OLD', base.slice(1).concat([999]));
    chk('lineups: the usual lineup is delta 0; losing the 25-minute regular for a call-up is below 0', Math.abs(full.conf) < 1e-9 && noStar.conf < -0.02, { full, noStar });
    chk('lineups: a snapshot never sees its own game (absorb comes after)', (() => { const before = ls.snapshot('OLD', base); ls.absorb('OLD', L(base.slice(1).concat([999]), 100)); const after = ls.snapshot('OLD', base); return before.proj === 0 && after.proj < 0; })());
    const miss = ls.missingRegulars('OLD', null, 900);
    chk('lineups: an absent regular is listed with how long he has been out', miss.length === 1 && miss[0].player_id === 100 && miss[0].absent_last_games === 1, miss);
    chk('lineups: a relocated club inherits its predecessor\'s lineups', ls.snapshot('NEW', base).known === true);
    const GLM = require(path.join(ROOT, 'hockey', 'model', 'glm.js'));
    chk('lineups: an unknown lineup enters the regression as 0, never as a guess', GLM.FEATURES.lu_own_conf({}) === 0 && GLM.FEATURES.lu_own_conf({ lu_own_proj: -0.04 }) === -0.04 && GLM.FEATURES.lu_own_conf({ lu_own_conf: -0.1, lu_own_proj: 0 }) === -0.1);
  }

  /* ---------------- contracts and the second source ---------------- */
  {
    const K = require(path.join(ROOT, 'engine', 'contracts.js'));
    const good = Object.assign(K.blank('shared', 'event_context'), { record_id: 'r1', source_id: 's', retrieved_at: '2026-10-13T04:00:00Z', revision: 1, quality_status: 'RETRO', home_rest_days: 1, postseason: false });
    chk('contracts: a complete row validates', K.validate('shared', 'event_context', [good]).ok);
    const v = K.validate('shared', 'event_context', [
      Object.assign({}, good, { record_id: 'r2', home_rest_days: '1' }),
      Object.assign({}, good, { record_id: 'r3', revision: null }),
      Object.assign({}, good, { record_id: 'r4', invented: 1 }),
      Object.assign({}, good, { record_id: 'r1' }), good,
      Object.assign({}, good, { record_id: 'r5', known_at: '2027-01-01T00:00:00Z' }),
      Object.assign({}, good, { record_id: 'r6', retrieved_at: '2026-10-13' }),
    ]);
    const has = (re) => v.errors.some((e) => re.test(e));
    chk('contracts: wrong type, a null required field, an extra field, a duplicate key, known_at after retrieval and a zone-less timestamp are all errors', !v.ok && has(/home_rest_days is not number/) && has(/revision is required/) && has(/invented is not in the contract/) && has(/duplicate key r1/) && has(/known_at after retrieved_at/) && has(/retrieved_at is not timestamp/), v.errors);
    chk('contracts: missingness is reported per field', v.missing.temperature === 1 && v.missing.home_rest_days === 0);
    const CN = require(path.join(ROOT, 'hockey', 'contracts', 'canonical.js'));
    const shots = CN.shotsFromRecord({ game: { game_id: 7, season_type: 'R' }, shots: [{ period: 2, gs: 1500, state: 'pp', goal: 1, X: 80, Y: -3, dist: 9.5, angle: 17.6, type: 'wrist', rebound: 1, rush: 0, since_prev: 2, prev_type: 'SHOT', empty_net: 0, goalie: 5, shooter: 9, xg: 0.31 }] }, { retrieved_at: '2026-10-13T04:00:00Z', xg_model: 'xg_for_2026' });
    chk('contracts: a shot maps with units, state, its xG model and RETRO', K.validate('hockey', 'shots', shots).ok && shots[0].period_seconds === 300 && shots[0].strength_state === 'PP' && shots[0].shooter_team_skaters === null && shots[0].provider_xg_model_version === 'edgedesk:xg_for_2026' && /RETRO/.test(shots[0].quality_status) && shots[0].known_at === null, shots[0]);
    const nc = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'validation', 'nhl_contracts.json'), 'utf8'));
    chk('contracts: the committed mapping validates and gives a reason for every always-empty field', nc.tables.every((t) => t.ok !== false) && nc.tables.filter((t) => t.always_missing).every((t) => t.always_missing.every((f) => f.reason)) && nc.tables.some((t) => t.table === 'hockey/shots' && t.rows > 100000));
    const xc = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'validation', 'nhl_crosscheck_espn.json'), 'utf8'));
    chk('second source: every 2024-25 NHL-feed game maps to ESPN and every final agrees', xc.results.compared === xc.games.nhl_feed_games && xc.results.final_agree === xc.results.compared && !xc.games.unmatched_by_reason['no NHL-feed game with these clubs within 6 h'], xc.results);
    chk('second source: goals against per goalie agree on every sampled row', xc.goalies.goals_against_agree === xc.goalies.goalie_rows && xc.goalies.goalie_rows > 100);
    const xw = fs.readFileSync(path.join(ROOT, 'hockey', 'data', 'crosswalk', 'espn_nhl_2025.csv'), 'utf8').trim().split('\n');
    chk('second source: the id crosswalk has one row per matched game, no id twice', xw.length - 1 === xc.games.matched && new Set(xw.slice(1).map((l) => l.split(',')[0])).size === xw.length - 1 && new Set(xw.slice(1).map((l) => l.split(',')[1])).size === xw.length - 1);
  }

  /* ---------------- committed artifacts ---------------- */
  {
    const TG = require(path.join(ROOT, 'hockey', 'ingest', 'team_games.js'));
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'data', 'manifest.json'), 'utf8'));
    chk('data: the manifest names the schema and every season 2011-2027', man.schema === 'edgedesk_nhl_team_games_v2' && [...Array(17)].every((_, i) => man.seasons[2011 + i]), Object.keys(man.seasons || {}));
    const rows = TG.loadTeamGames([2026]);
    const byG = new Map(); for (const r of rows) { if (!byG.has(r.game_id)) byG.set(r.game_id, []); byG.get(r.game_id).push(r); }
    chk('data: two rows per game, each the mirror of the other', [...byG.values()].every((a) => a.length === 2 && a[0].gf === a[1].ga && a[0].toi_pp === a[1].toi_sh));
    chk('data: no duplicate game ids in a season', byG.size === rows.length / 2);
    chk('data: known_at is blank (never backdated), the availability assumption is explicit, every row is RETRO', rows.every((r) => r.known_at === '' && r.assumed_available_at && Date.parse(r.assumed_available_at) > Date.parse(r.start_utc || r.date) && r.pit === 'RETRO'));
    chk('data: every row names its source file and the xG model that scored it', rows.every((r) => r.src && /^xg_for_2026$/.test(r.xg_model)));
    chk('data: the manifest states the temporal rule', man.temporal && /never backdated/.test(man.temporal.known_at) && /RETRO/.test(man.temporal.pit));
    chk('data: xG was scored by a model fitted only on earlier seasons', (() => { const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'xg', 'models', 'xg_for_2026.json'), 'utf8')); return m.train_seasons.every((s) => s < 2026); })());
    const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'validation', 'nhl_walkforward.json'), 'utf8'));
    chk('record: zero leakage violations over every scored game', wf.leakage.violations === 0 && wf.leakage.checked > 15000, wf.leakage);
    chk('record: the market is NOT_TESTED without a closing archive', !fs.existsSync(path.join(ROOT, 'hockey', 'market', 'closing')) ? Object.values(wf.markets).every((m) => m.market_status === 'NOT_TESTED') : true);
    chk('record: the chosen model was chosen on the selection window', wf.selection && wf.selection.ll[wf.selection.chosen] <= wf.selection.ll.goals_only);
    chk('record: it says it is retrospective, with its availability assumption', wf.data.temporal && wf.data.temporal.point_in_time === 'RETROSPECTIVE' && /start \+ 4 h/.test(wf.leakage.basis));
    chk('record: lineup candidates are scored and reported, and a challenger was adopted only by the selection rule', wf.lineups && wf.lineups.available === true && wf.lineups.coverage.with_box_score === wf.lineups.coverage.scored_games && (wf.selection.chosen !== 'xg_lineup_projected' || wf.selection.ll.xg_lineup_projected <= wf.selection.ll.xg_no_goalie - 0.001) && wf.comparisons.xg_lineup_confirmed_vs_xg_no_goalie);
    const slate = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'slate.json'), 'utf8'));
    chk('slate: value claims are disabled and say why', slate.readiness.value_claims.state === 'DISABLED' && slate.readiness.value_claims.reasons.length > 0);
    chk('slate: every game has prices, goalies, evidence, uncertainty and invalidators', slate.games.every((g) => g.prices.moneyline && g.prices.puck_line && g.prices.total && g.goalies && g.evidence && g.uncertainty && g.invalidators.length));
    chk('slate: every game says what it knows about lineups, and never calls a projection confirmed', slate.games.every((g) => g.lineups && /^(PROJECTED_FROM_LAST_GAME|UNKNOWN)$/.test(g.lineups.state) && Array.isArray(g.lineups.home.regulars_absent)));
  }

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NHL brain — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
