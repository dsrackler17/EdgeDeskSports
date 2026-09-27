#!/usr/bin/env node
/* ===========================================================================
   Chaos and end-to-end safety tests for the Model Lab job, each in a
   temporary ledger (nothing touches the real one). docs/cfb-production/*.md.

     capture     a +450 spread, American odds of 0, schema drift, a wrong-game
                 quote and a sign flip are quarantined (kept, with reasons) and
                 never enter the market; the job run once, twice, three times
                 writes byte-identical files (duplicate cron runs)
     lines       no opener / close before the game has a settled state; a
                 kickoff DELAY moves the close window to the real kickoff; an
                 EARLY start never lets a quote observed after the real start
                 (live odds) into the close; openers are never replaced; an
                 opener correction is a separate audited record
     schedule    postponed / canceled / suspended / in-progress games are not
                 snapshotted; a moved kickoff is used for a NEW snapshot and
                 old snapshots keep theirs; a rescheduled game (> 36 h) gets
                 ADHOC snapshots, never a second official one
     betting     BET fails closed (PASS, stake 0, reason) on a degraded or
                 stale market; stays BET only when the market is actionable
     settlement  a canceled game is VOID (never a loss); a postponed game is
                 not settled; a rescheduled game voids the snapshots of its old
                 date; overtime counts in margin, ATS and totals; an invalid
                 final (0-0, no score) is never written; settling three times
                 writes nothing new; a correction supersedes, never edits

   Run: node football/cfb_lab/chaos.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const L = require('./lab_core.js');
const G = require('./ledger.js');
const MK = require('./market.js');
const CP = require('./checkpoint.js');
const ST = require('./settle.js');
const I = require('./integrity.js');

const U = L.util;
let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cfbchaos-')); }
function so(dir) { return { root: path.join(dir, 'ledger'), govRoot: path.join(dir, 'gov') }; }
function store(dir) { return new G.Store(2026, so(dir)); }
function digest(dir) {
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
  return walk(path.join(dir, 'ledger')).sort().map((f) => path.relative(dir, f) + ':' + crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12)).join('\n');
}
const FXP = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'providers', f), 'utf8'));
const K = '2026-10-10T19:30:00.000Z';
const h = (x) => new Date(U.ms(K) + x * 3600000).toISOString();

/* a model projection shaped like models.js adapters return */
function proj(o) {
  o = o || {};
  const margin = o.margin == null ? 3.5 : o.margin;
  return {
    model_version: o.mv || 'test_model_v1', model_label: 'T', engine_id: 'test', source: 'test',
    projection_computed_at: h(-80), feature_ts: h(-80), feature_version: 'fv', calibration_version: 'cv', ensemble_version: 'ev', params_hash: 'ph',
    game: { game_id: o.game_id || 'g1', season: 2026, week: 7, season_type: 'regular', home: o.home || ('Home ' + (o.game_id || 'g1')), away: o.away || ('Away ' + (o.game_id || 'g1')), home_id: null, away_id: null, neutral_site: false, kickoff: o.kickoff || K },
    pure: { margin, total: 50, p_home: 0.6, sigma: 15, t_df: 100, intervals: { 50: [margin - 10, margin + 10], 80: [margin - 19, margin + 19], 95: [margin - 29, margin + 29] },
      home_pts: (50 + margin) / 2, away_pts: (50 - margin) / 2, confidence_raw: 80, ens_sd: 1.2 },
    components: null, state: { data_completeness: 0.9, pbp_completeness: 1 }, explain: {}, slateGame: null, inputs: {},
    decide: o.decide || ((market) => {
      const gap = market && U.isNum(market.current_spread) ? margin - L.conv.bookToMargin(market.current_spread) : null;
      const d = L.v1Decision(gap);
      return { status: d.status, side: d.side, decision_source: 'test', reason: d.reason, cover_probability: 0.53, break_even_probability: 0.5238, estimated_ev: 0.01, edge_quality: 30, betting_reliability: 80, threshold_distance: null, bet_enabled: false };
    }),
  };
}
const model = (projs, mv) => ({ model_version: mv || 'test_model_v1', label: 'T', projections: new Map(projs.map((p) => [p.game.game_id, p])) });
const q = (o) => MK.baseQuote(Object.assign({ game_id: 'g1', season: 2026, week: 7, source: 'odds_api', book: 'dk', market_type: 'spread', home_line: -3, price_home: -110, price_away: -110,
  observed_at: h(-30), kickoff_ts: K, retrieved_at: h(-30) }, o));

(async () => {
  /* ═══ 1. capture: impossible values, drift, duplicate runs ═══════════ */
  {
    const d = tmp();
    const pre = FXP('espn_scoreboard_pregame.json');
    const bad = JSON.parse(JSON.stringify(pre));
    bad.events[0].competitions[0].odds[0].details = 'TEX -450'; bad.events[0].competitions[0].odds[0].spread = -450;          /* a -450 spread */
    bad.events[0].competitions[0].odds[0].pointSpread.home.close.line = '-450';
    bad.events[1].competitions[0].odds[0].homeTeamOdds.moneyLine = 0.5;                                                           /* odds 0.5 -> rounds to American ... */
    const drift = FXP('espn_scoreboard_schema_drift.json');
    const NOW = '2026-10-08T12:00:00.000Z';
    const run = () => MK.capture(2026, NOW, { espn: true, cfbd: false, espnPayloads: [bad, drift], storeOpts: so(d) });
    const r1 = await run();
    const s = store(d);
    const qz = s.quarantine();
    chk('a -450 spread never reaches the market history', !s.quotes().some((x) => Math.abs(x.home_line) > 70), s.quotes().filter((x) => Math.abs(x.home_line) > 70));
    chk('... it is kept in the quarantine with SPREAD_OUT_OF_BOUNDS', qz.some((x) => x.game_id === '401900001' && x.reasons.includes('SPREAD_OUT_OF_BOUNDS') && x.severity === 'REJECT'), qz.map((x) => [x.game_id, x.reasons]));
    chk('schema drift is logged, not silently absorbed', r1.log.espn.schema.rejected_events === 3 && /abbreviation/.test(r1.log.espn.schema.problems.join()), r1.log.espn.schema);
    chk('the integrity log counts what was refused and why', r1.log.integrity.rejected >= 1 && r1.log.integrity.reasons.SPREAD_OUT_OF_BOUNDS >= 1, r1.log.integrity);
    chk('clean games are still captured', s.quotes().some((x) => x.game_id === '401900003' && x.home_line === 0));
    chk('the quarantine is part of the verified ledger', G.verify({ roots: [path.join(d, 'ledger')], repo: d }).length === 0, G.verify({ roots: [path.join(d, 'ledger')], repo: d }));
    const d1 = digest(d);
    await run(); const d2 = digest(d); await run(); const d3 = digest(d);
    chk('the same hour run twice and three times writes byte-identical files (cron ran twice)', d1 === d2 && d2 === d3, { d1, d3 });
    const later = await MK.capture(2026, '2026-10-08T13:00:00.000Z', { espn: true, cfbd: false, espnPayloads: [bad], storeOpts: so(d) });
    chk('an unchanged quote an hour later is a duplicate, not a row (odds de-duplication)', later.written === 0 && later.dedupe.duplicates > 0, later.dedupe);
    chk('... and the same bad number an hour later is one investigation, not two', later.log.integrity.quarantine_written === 0 && later.log.integrity.quarantine_repeats_skipped >= 1, later.log.integrity);
    const hb = await MK.capture(2026, '2026-10-08T18:30:00.000Z', { espn: true, cfbd: false, espnPayloads: [bad], storeOpts: so(d) });
    chk('... but after 6 h the unchanged quote is written as a heartbeat (opening/closing reconstruction stays possible)', hb.written > 0 && store(d).quotes().some((x) => x.is_heartbeat), hb.dedupe);
  }
  {
    /* wrong game, sign flip, outlier: the screen with a known index */
    const idx = { g1: { home: 'Texas', away: 'Oklahoma', kickoff: K } };
    const stored = [q({ book: 'a', home_line: -7, home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners' }), q({ book: 'b', home_line: -7, home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners' }),
      q({ book: 'c', home_line: -6.5, home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners' })];
    const cands = [
      q({ book: 'd', home_line: -7, observed_at: h(-29), home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners' }),
      q({ book: 'e', home_line: -7, observed_at: h(-29), home_team: 'Oklahoma Sooners', away_team: 'Texas Longhorns' }),
      q({ book: 'f', home_line: -7, observed_at: h(-29), home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners', kickoff_ts: h(96) }),
      q({ book: 'a', home_line: 7, observed_at: h(-28), home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners' }),
      q({ book: 'g', home_line: -21, observed_at: h(-28), home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners' })];
    const r = MK.screenCandidates(stored, cands, { index: idx, now: h(-27), sameTeam: require('./identity.js').sameTeamFn() });
    const why = Object.fromEntries(r.quarantined.map((x) => [x.book, x.reasons.join()]));
    chk('wrong-game orientation (the book swapped home and away) is refused', /WRONG_GAME_ORIENTATION/.test(why.e || ''), why);
    chk('a quote for the same teams 4 days later (another week) is refused', /WRONG_GAME_KICKOFF/.test(why.f || ''), why);
    chk('the same book flipping -7 to +7 alone is quarantined as a sign flip', /SIGN_FLIP_SUSPECT|CROSS_BOOK_OUTLIER/.test(why.a || ''), why);
    chk('a -21 against -7 / -7 / -6.5 / -7 is a cross-book outlier', /CROSS_BOOK_OUTLIER/.test(why.g || ''), why);
    chk('the clean quote is accepted', r.accepted.length === 1 && r.accepted[0].book === 'd');
  }

  /* ═══ 2. openers and closes: settled state, delays, early starts ════════ */
  {
    const mk = (o) => { const d = tmp(); const s = store(d);
      const p = proj({ kickoff: K });
      s.appendPredictions([CP.buildRow(p, 'T24', true, L.marketAt([], h(-20), K), p.decide(null), { status: 'GREEN', checks: [] }, { now: h(-20), role: 'champion', origin: 'LIVE' })]);
      s.appendQuotes(o.quotes); return { d, s }; };
    /* a DELAY: scheduled 19:30, played at 22:30; books kept pricing it until then */
    const delay = mk({ quotes: [q({ observed_at: h(-48), home_line: -3 }), q({ observed_at: h(-1), home_line: -3.5, kickoff_ts: K }), q({ observed_at: h(2), home_line: -6, kickoff_ts: h(3) })] });
    let r = MK.lines(2026, h(8), { storeOpts: so(delay.d) });
    chk('no opener or close before the game has a settled state (even 8 h after the kickoff)', r.written === 0 && r.waiting_for_result === 1, r);
    delay.s.append('results', [Object.assign({ game_id: 'g1', status: 'FINAL', home_points: 24, away_points: 17, final_margin: 7, final_total: 41, overtime: false,
      sources: [{ source: 'espn', status: 'FINAL', home_points: 24, away_points: 17, kickoff_ts: h(3) }], sources_agree: true, season: 2026, week: 7, supersedes: null, reason: null, recorded_at: h(7) }, { result_id: 'cfbr_' + 'd'.repeat(24) })], 'result_id');
    r = MK.lines(2026, h(5.5), { storeOpts: so(delay.d) });
    chk('a delayed game is not closed before its REAL kickoff + 3 h (22:30 + 3 h)', r.written === 0, r);
    r = MK.lines(2026, h(8), { storeOpts: so(delay.d) });
    const close = delay.s.lines().find((l) => l.kind === 'CLOSE' && l.book === 'CONSENSUS' && l.market_type === 'spread');
    chk('kickoff delay: the close is the last quote before the REAL kickoff (-6 at 21:30), not the one before the old time', close && close.home_line === -6 && close.kickoff_ts === h(3), close);
    const open = delay.s.lines().find((l) => l.kind === 'OPEN' && l.book === 'CONSENSUS' && l.market_type === 'spread');
    delay.s.appendQuotes([q({ observed_at: h(-60), home_line: -1, book: 'late' })]);
    MK.lines(2026, h(30), { storeOpts: so(delay.d) });
    const open2 = delay.s.lines().filter((l) => l.kind === 'OPEN' && l.book === 'CONSENSUS' && l.market_type === 'spread');
    chk('the opener is write-once: a late-arriving earlier quote never replaces it', open2.length === 1 && open2[0].home_line === open.home_line && open2[0].line_id === open.line_id, open2);
    /* an EARLY start: scheduled 19:30, started 16:30; a provider kept a stale 19:30 kickoff and served in-play numbers */
    const early = mk({ quotes: [q({ observed_at: h(-5), home_line: -3 }), q({ observed_at: h(-2), home_line: 4.5, kickoff_ts: K })] });
    early.s.append('results', [{ result_id: 'cfbr_' + 'e'.repeat(24), game_id: 'g1', status: 'FINAL', home_points: 10, away_points: 30, final_margin: -20, final_total: 40, overtime: false,
      sources: [{ source: 'espn', status: 'FINAL', home_points: 10, away_points: 30, kickoff_ts: h(-3) }], sources_agree: true, season: 2026, week: 7, supersedes: null, reason: null, recorded_at: h(5) }], 'result_id');
    MK.lines(2026, h(6), { storeOpts: so(early.d) });
    const ec = early.s.lines().find((l) => l.kind === 'CLOSE' && l.book === 'CONSENSUS' && l.market_type === 'spread');
    chk('early start: a number observed after the REAL kickoff (in-play, +4.5) never becomes the close', ec && ec.home_line === -3 && ec.kickoff_ts === h(-3), ec);
    /* an audited opener correction */
    const c = MK.correctLine(2026, { line_id: open.line_id, home_line: -2.5, reason: 'provider re-stated its opener after a feed outage', actor: 'ops', now: h(40) }, { storeOpts: so(delay.d) });
    chk('an opener correction is a separate audited record (version 1, original kept)', c.written === 1 && c.row.version === 1 && c.row.original.home_line === open.home_line && c.row.corrected.home_line === -2.5);
    chk('... and the derived opener itself is unchanged', delay.s.lines().find((l) => l.line_id === open.line_id).home_line === open.home_line);
    const refusedC = (o) => { try { MK.correctLine(2026, Object.assign({ line_id: open.line_id, home_line: -3, reason: 'a perfectly good reason', actor: 'ops' }, o), { storeOpts: so(delay.d) }); return false; } catch (e) { return true; } };
    chk('a correction without a reason, without an actor, or with a +450 line is refused', refusedC({ reason: 'x' }) && refusedC({ actor: '' }) && refusedC({ home_line: 450 }) && refusedC({ line_id: 'cfbl_nope' }));
  }

  /* ═══ 3. schedule authority at snapshot time ═════════════════════════ */
  {
    const d = tmp();
    const models = [model([proj({ game_id: 'g1' }), proj({ game_id: 'g2' }), proj({ game_id: 'g3' }), proj({ game_id: 'g4' })])];
    const sched = { g1: { status: 'POSTPONED', kickoff: K }, g2: { status: 'IN_PROGRESS', kickoff: h(-2) }, g3: { status: 'SCHEDULED', kickoff: h(3) }, g4: { status: 'CANCELED', kickoff: K } };
    const log = CP.run({ now: h(-20), season: 2026, models, storeOpts: so(d), schedule: sched });
    const ps = store(d).predictions();
    chk('a postponed or canceled game is not snapshotted (pending job canceled)', !ps.some((p) => p.game_id === 'g1' || p.game_id === 'g4') && log.skipped_schedule.POSTPONED === 1 && log.skipped_schedule.CANCELED === 1, log.skipped_schedule);
    chk('a game that started EARLY is never given a "pregame" snapshot', !ps.some((p) => p.game_id === 'g2') && log.skipped_schedule.STARTED_BEFORE_MODEL_KICKOFF === 1);
    const g3 = ps.find((p) => p.game_id === 'g3');
    chk('a moved kickoff (+3 h): the new snapshot uses the new kickoff and its hours_to_kickoff (23 h -> the T24 window)',
      g3 && g3.kickoff_ts === h(3) && g3.hours_to_kickoff === 23 && g3.checkpoint_type === 'T24' && g3.inputs_ref.kickoff_basis.model === K, g3 && [g3.kickoff_ts, g3.hours_to_kickoff, g3.checkpoint_type]);
    chk('and the ledger still verifies (hours agree with the timestamps)', G.verify({ roots: [path.join(d, 'ledger')], repo: d }).length === 0);
    /* a rescheduled game: T24 taken for Oct 10, the game moves a week */
    const d2 = tmp();
    CP.run({ now: h(-20), season: 2026, models: [model([proj({ game_id: 'r1' })])], storeOpts: so(d2) });
    const K2 = h(7 * 24);
    const moved = [model([proj({ game_id: 'r1', kickoff: K2 })])];
    const l2 = CP.run({ now: new Date(U.ms(K2) - 20 * 3600000).toISOString(), season: 2026, models: moved, storeOpts: so(d2) });
    const rs = store(d2).predictions().filter((p) => p.game_id === 'r1');
    const adhoc = rs.find((p) => p.checkpoint_type === 'ADHOC');
    chk('a rescheduled game gets a new snapshot for the new date, as ADHOC (never a second OFFICIAL)', l2.rescheduled_adhoc === 1 && adhoc && adhoc.inputs_ref.reschedule.window === 'T24'
      && adhoc.official_families.length === 0 && rs.filter((p) => p.official_families.includes('OFFICIAL')).length === 1, rs.map((p) => [p.checkpoint_type, p.kickoff_ts]));
    chk('... the old snapshot keeps its original kickoff context', rs.find((p) => p.checkpoint_type === 'T24').kickoff_ts === K);
    const l3 = CP.run({ now: new Date(U.ms(K2) - 19 * 3600000).toISOString(), season: 2026, models: moved, storeOpts: so(d2) });
    chk('... once per window (the next hour takes nothing)', l3.taken === 0 && l3.rescheduled_adhoc === 0);
    /* a POSTPONED result with no new date: no snapshot */
    const d3 = tmp(); const s3 = store(d3);
    s3.append('results', [{ result_id: 'cfbr_' + 'p'.repeat(24).replace(/p/g, 'a'), game_id: 'p1', status: 'POSTPONED', home_points: null, away_points: null, final_margin: null, final_total: null, overtime: null, sources: [{ source: 'espn', status: 'POSTPONED' }], sources_agree: true, season: 2026, week: 7, supersedes: null, reason: null, recorded_at: h(-30) }], 'result_id');
    const l4 = CP.run({ now: h(-20), season: 2026, models: [model([proj({ game_id: 'p1' })])], storeOpts: so(d3) });
    chk('a game whose current result is POSTPONED is not snapshotted until it has a new kickoff', l4.taken === 0 && l4.skipped_schedule.RESULT_POSTPONED === 1, l4);
  }

  /* ═══ 4. BET fails closed ═══════════════════════════════════════════ */
  {
    const betting = (market) => ({ status: 'BET', side: 'HOME', decision_source: 'test', reason: 'meets the rule', cover_probability: 0.55, break_even_probability: 0.5238, estimated_ev: 0.05, edge_quality: 60, betting_reliability: 80, threshold_distance: null, bet_enabled: true });
    const d = tmp(); const s = store(d);
    s.appendQuotes([q({ game_id: 'b1', observed_at: h(-21), home_line: -2.5 })]);
    s.appendQuotes([q({ game_id: 'b2', observed_at: h(-21), home_line: -2.5 }), q({ game_id: 'b2', book: 'fd', observed_at: h(-21), home_line: -2.5 })]);
    s.appendQuotes([q({ game_id: 'b3', observed_at: h(-21), home_line: -2.5, provider_updated_at: h(-40) }), q({ game_id: 'b3', book: 'fd', observed_at: h(-21), home_line: -2.5, provider_updated_at: h(-40) })]);
    CP.run({ now: h(-20), season: 2026, models: [model(['b1', 'b2', 'b3'].map((g) => proj({ game_id: g, margin: 5, decide: betting })))], storeOpts: so(d) });
    const ps = Object.fromEntries(store(d).predictions().map((p) => [p.game_id, p]));
    chk('one book (degraded consensus): BET -> PASS, stake 0, with the reason on the row', ps.b1.decision_class === 'PASS' && ps.b1.stake_units === 0 && /MARKET_DEGRADED/.test(ps.b1.pass_reason) && ps.b1.status === 'BET' && ps.b1.inputs_ref.bet_gate, [ps.b1.decision_class, ps.b1.pass_reason]);
    chk('two fresh agreeing books: the BET stands (stake 1)', ps.b2.decision_class === 'BET' && ps.b2.stake_units === 1 && ps.b2.inputs_ref.market_integrity.actionable_status === 'ACTIONABLE', [ps.b2.decision_class, ps.b2.inputs_ref.market_integrity]);
    chk('a provider that last updated 19 h before: MARKET_STALE, BET -> PASS', ps.b3.decision_class === 'PASS' && /MARKET_STALE/.test(ps.b3.pass_reason), [ps.b3.decision_class, ps.b3.pass_reason]);
    chk('the football numbers are untouched by the gate', ps.b1.pure_home_margin === 5 && ps.b1.fair_spread_home_line === -5 && ps.b2.pure_home_margin === 5);
  }

  /* ═══ 5. settlement: canceled, postponed/rescheduled, overtime, invalid ═ */
  {
    const d = tmp(); const s = store(d);
    const row = (gid, kick, now, ct, extra) => { const p = proj(Object.assign({ game_id: gid, kickoff: kick, margin: 3 }, extra)); return CP.buildRow(p, ct || 'T24', true, L.marketAt([q({ game_id: gid, observed_at: new Date(U.ms(now) - 3600000).toISOString(), kickoff_ts: kick, home_line: -2 })], now, kick), p.decide(L.marketAt([q({ game_id: gid, observed_at: new Date(U.ms(now) - 3600000).toISOString(), kickoff_ts: kick, home_line: -2 })], now, kick)), { status: 'GREEN', checks: [] }, { now, role: 'champion', origin: 'LIVE' }); };
    const K2 = h(7 * 24);
    s.appendPredictions([row('c1', K, h(-20)), row('ot', K, h(-20)), row('r1', K, h(-20)), row('bad', K, h(-20))]);
    s.appendPredictions([CP.buildRow(proj({ game_id: 'r1', kickoff: K2, margin: 3 }), 'FINAL', false, null, proj({}).decide(null), { status: 'GREEN', checks: [] }, { now: new Date(U.ms(K2) - 1800000).toISOString(), role: 'champion', origin: 'LIVE' })]);
    const readings = [{ c1: { source: 'espn', status: 'CANCELED', kickoff_ts: K },
      ot: { source: 'espn', status: 'FINAL', home_points: 45, away_points: 38, overtime: true, kickoff_ts: K },
      r1: { source: 'espn', status: 'FINAL', home_points: 20, away_points: 10, overtime: false, kickoff_ts: K2 },
      bad: { source: 'espn', status: 'FINAL', home_points: 0, away_points: 0, overtime: false, kickoff_ts: K } },
      { ot: { source: 'cfbfastR', status: 'FINAL', home_points: 45, away_points: 38, overtime: null } }];
    const at = new Date(U.ms(K2) + 6 * 3600000).toISOString();
    const log = await ST.run({ now: at, season: 2026, offline: true, useRecord: false, storeOpts: so(d), readings });
    const ev = store(d).evaluations(), res = store(d).results();
    chk('an invalid final (0-0) is never written; the game waits', !res.some((r) => r.game_id === 'bad') && log.result_disagreements.some((x) => x.game_id === 'bad' && /tied/.test((x.invalid_final || []).join())), log.result_disagreements);
    const c1 = ev.filter((e) => e.game_id === 'c1');
    chk('a canceled game is VOID for every snapshot: never a loss, no units, no error', c1.length && c1.every((e) => e.void && e.ats_result === 'VOID' && !e.units && e.margin_error === undefined)
      && L.betting(c1).losses === 0 && L.errorSummary(c1).n === 0, c1.map((e) => [e.ats_result, e.units]));
    const ot = ev.find((e) => e.game_id === 'ot');
    chk('overtime: the final margin (+7), the total (83), ATS and the error include overtime', ot && ot.final_margin === 7 && ot.final_total === 83 && ot.overtime === true && ot.margin_error === 4 && ot.total_error === 33 && ot.ats_result === 'WIN', ot && [ot.final_margin, ot.final_total, ot.overtime, ot.ats_result]);
    const r1 = ev.filter((e) => e.game_id === 'r1');
    chk('rescheduled a week: the snapshot of the OLD date is VOID (POSTPONED), never graded against the new game',
      r1.some((e) => e.checkpoint_type === 'T24' && e.void && e.result_status === 'POSTPONED' && e.ats_result === 'VOID'), r1.map((e) => [e.checkpoint_type, e.void, e.result_status]));
    chk('... and the snapshot of the NEW date is graded normally', r1.some((e) => e.checkpoint_type === 'FINAL' && !e.void && e.final_margin === 10));
    const before = digest(d);
    await ST.run({ now: at, season: 2026, offline: true, useRecord: false, storeOpts: so(d), readings });
    await ST.run({ now: new Date(U.ms(at) + 3600000).toISOString(), season: 2026, offline: true, useRecord: false, storeOpts: so(d), readings });
    chk('settling twice and three times writes nothing new (idempotent; never graded twice)', digest(d) === before);
    const ids = store(d).evaluations().map((e) => e.evaluation_id);
    chk('one evaluation per (snapshot, result, close): no duplicate grading', new Set(ids).size === ids.length);
    const corr = [{ ot: { source: 'espn', status: 'FINAL', home_points: 45, away_points: 41, overtime: true, kickoff_ts: K } }, { ot: { source: 'cfbfastR', status: 'FINAL', home_points: 45, away_points: 41 } }];
    await ST.run({ now: new Date(U.ms(at) + 7200000).toISOString(), season: 2026, offline: true, useRecord: false, storeOpts: so(d), readings: corr });
    const otRes = store(d).results().filter((r) => r.game_id === 'ot');
    chk('a score correction supersedes the old result (both kept), and re-grades as new rows', otRes.length === 2 && otRes[1].supersedes === otRes[0].result_id
      && store(d).evaluations().filter((e) => e.game_id === 'ot').length === 2, otRes.map((r) => [r.home_points, r.away_points, r.supersedes]));
    chk('the frozen snapshots were never touched by settlement', G.verify({ roots: [path.join(d, 'ledger')], repo: d }).length === 0);
    const postponed = await ST.run({ now: at, season: 2026, offline: true, useRecord: false, storeOpts: so(tmp()), readings: [{ x: { source: 'espn', status: 'POSTPONED' } }] });
    chk('a postponed game with no prediction is not settled here (only predicted games are)', postponed.results === 0);
  }

  /* ═══ 6. the report flags an absurd BET count and quarantined quotes ═══ */
  {
    const RP = require('./report.js');
    const GOV = require('./governance.js');
    const d = tmp(); const s = store(d); GOV.seed(s);
    const bet = () => ({ status: 'BET', side: 'HOME', decision_source: 'test', reason: 'r', cover_probability: 0.55, break_even_probability: 0.5238, estimated_ev: 0.05, edge_quality: 60, betting_reliability: 80, threshold_distance: null, bet_enabled: true });
    const ok = { rule: 'r', status: 'OK', actionable_status: 'ACTIONABLE', reasons: [], n_books: 3, newest_true_age_h: 0.5 };
    const rows = [];
    [[3, 2], [4, 3], [5, 2], [6, 25]].forEach(([wk, n]) => { for (let i = 0; i < n; i++) {
      const kick = new Date(U.ms(K) + (wk - 6) * 7 * 86400000 + i * 60000).toISOString();
      const p = proj({ game_id: 'w' + wk + 'g' + i, kickoff: kick, margin: 5 }); p.game.week = wk;
      rows.push(CP.buildRow(p, 'T24', true, null, bet(), { status: 'GREEN', checks: [] }, { now: new Date(U.ms(kick) - 20 * 3600000).toISOString(), role: 'champion', origin: 'LIVE', integrity: ok }));
    } });
    s.appendPredictions(rows);
    s.append('quarantine', MK.screenCandidates([], [q({ game_id: 'w6g0', home_line: 450, observed_at: h(-30) })], { now: h(-29) }).quarantined, 'quarantine_id');
    const B = RP.build(s, h(-25));
    const bv = B.alerts.find((a) => a.kind === 'bet_volume_anomaly');
    chk('report: 25 official BETs in a week against 2 / 3 / 2 before is flagged for review (never cancelled)', bv && /25 BET decisions/.test(bv.message) && /nothing is cancelled/.test(bv.message) && s.predictions().filter((p) => p.decision_class === 'BET').length === 32, B.alerts.map((a) => a.kind));
    const qa = B.alerts.find((a) => a.kind === 'market_quotes_quarantined');
    chk('report: quarantined quotes of the last 72 h raise one alert with their reasons', qa && qa.detail.count === 1 && qa.detail.reasons.SPREAD_OUT_OF_BOUNDS === 1, qa);
  }

  fails.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
