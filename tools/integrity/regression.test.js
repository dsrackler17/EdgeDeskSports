#!/usr/bin/env node
/* ===========================================================================
   THE SYSTEM-INTEGRITY REGRESSION SUITE (docs/system-integrity/REPORT.md §11)

   The seventeen failures the October 8 audit named, each pinned by a test
   that drives the production code path — the canonical calculation layer,
   the schedule truth, the integrity engine, the market screen, the
   availability classes, the content engine and its database — plus one
   integration test from the committed research to a publishable,
   reconciled, approved article.

      1  Ole Miss -1.0 vs -9.5 reconciles to 8.5
      2  every displayed comparison reconciles at full precision
      3  a placeholder kickoff never becomes verified
      4  timezone conversion preserves the instant (DST included)
      5  no future-week game leaks into current-week research
      6  research status and betting status stay separate
      7  a stale market is never labelled current
      8  an alternate line is never compared with main-line consensus
      9  a faulted quote cannot bypass the decision gate
     10  a missing QB announcement does not create false uncertainty
     11  projected scores reconcile with the total and the margin
     12  exports preserve the approved snapshot's values
     13  a major data change revokes readiness              (PostgreSQL)
     14  duplicate generation cannot create duplicate charges (PostgreSQL)
     15  concurrent jobs cannot pass the monthly cap          (PostgreSQL)
     16  referral attribution survives registration and payment (PostgreSQL)
     17  an unauthorized user cannot modify production data  (PostgreSQL)
      I  integration: committed research → publishable, approved article

   Cases 13–17 and the database half of I need a local PostgreSQL (the same
   harness every SQL suite uses, tools/personal/_pg.js). Without one they are
   reported as NOT RUN and the suite fails when INTEGRITY_PG_REQUIRED=1, so a
   CI run can never count a skipped case as a pass.

   Run: node tools/integrity/regression.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const lib = (f) => require(path.join(ROOT, 'lib', f));
const CALC = lib('edgedesk_calc.js');
const SCHED = lib('edgedesk_schedule.js');
const AVAIL = lib('edgedesk_availability.js');
const INTEG = lib('edgedesk_integrity.js');
const CE = lib('content_engine.js');
const LAB = require(path.join(ROOT, 'football', 'cfb_lab', 'integrity.js'));
const V = lib('cfb_research_view.js');
global.EDCfbP4Params = require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const ENGINE = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const ART = require(path.join(ROOT, 'tools', 'content', 'artifacts.js'));

let pass = 0, fail = 0, notRun = 0;
const failures = [];
let current = '';
function section(t) { current = t; console.log('\n' + t); }
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { detail = String(e && e.stack || e).slice(0, 500); cond = false; } }
  if (cond) { pass++; return; }
  fail++; failures.push(current.split(' ')[0] + ' ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 500)));
}

const NOW = Date.parse('2026-10-08T17:30:00Z');
const H = 3600e3;
const FL = 'Florida', OM = 'Ole Miss';
const names = { home: FL, away: OM };

/* a research record as the boards build it (EDIntegrity.record), with sane
   defaults a test overrides one field at a time */
function rec(o) {
  o = o || {};
  const base = {
    game: Object.assign({ game_id: 'G1', season: 2026, week: 6, home: FL, away: OM, home_id: '57', away_id: '145', venue: 'Ben Hill Griffin Stadium', neutral_site: false,
      kickoff: '2026-10-10T19:30:00Z', start_time_tbd: false }, o.game || {}),
    model: Object.assign({ available: true, version: 'cfb_p4_v3', snapshot_id: 'm@1', projected_at: '2026-10-08T16:00:00Z', home_margin: -0.2, total: 58.1,
      home_win_prob: 0.495, away_win_prob: 0.505, confidence: 62, reliability: 72 }, o.model || {}),
    market: Object.assign({ available: true, snapshot_id: 'k@1', captured_at: '2026-10-08T17:00:00Z', market_type: 'spread', is_main_line: true, home_margin: -9.5,
      book: 'consensus', method: 'MEDIAN', stale: false, mapping_ok: true, orientation_ok: true }, o.market || {}),
    research: o.research === undefined ? { key: 'INVESTIGATE', label: 'Investigate' } : o.research,
    decision: o.decision === undefined ? null : o.decision,
    ev: o.ev || null,
    displayed: o.displayed || null
  };
  return INTEG.record(base);
}
const ev = (r, b, ctx) => INTEG.evaluate(r, b, Object.assign({ now: NOW }, ctx || {}));
const ruleStatus = (res, id) => { const c = res.checks.find((x) => x.rule_id === id); return c ? c.status : 'ABSENT'; };

/* ===================================================================== 1 */
section('1  Ole Miss -1.0 vs -9.5 reconciles to 8.5');
{
  const c = CALC.compareLines({ team: OM, line: -1.0 }, { team: OM, line: -9.5 }, names);
  chk('the two displayed lines are 8.5 points apart', c.gap === 8.5, c);
  chk('… toward Florida (EdgeDesk likes Ole Miss far less than the market)', c.toward_team === FL, c.toward_team);
  chk('… and the formula on the record is the two displayed numbers', c.reconcile.formula === '|-1.0 − -9.5| = 8.5', c.reconcile.formula);
  /* the board's own failure: the engine's near-pick'em floor printed as
     "Ole Miss -1.0" beside a 9.3 gap measured from the raw -0.18 */
  const bad = rec({ displayed: { fair_text: OM + ' -1.0', market_text: OM + ' -9.5', gap: 9.3 } });
  const r1 = ev(bad, 'PUBLIC_BRIEF');
  chk('a surface printing the -1.0 floor beside a 9.3 gap is BLOCKED (CALC.GAP_RECONCILES)', r1.status === 'BLOCKED' && ruleStatus(r1, 'CALC.GAP_RECONCILES') === 'BLOCKED', r1.blocking_reasons);
  const good = rec({ displayed: { fair_text: OM + ' -0.2', market_text: OM + ' -9.5', gap: 9.3 } });
  chk('the canonical rendering (Ole Miss -0.2, 9.3) passes the same rule', ruleStatus(ev(good, 'PUBLIC_BRIEF'), 'CALC.GAP_RECONCILES') === 'PASS');
  /* the research view the board renders from: the floor is never the printed or compared number */
  const fl = ENGINE.fairLine.normalize(-0.18, {});
  const view = V.build({ game: { game_id: 'G1', home: FL, away: OM }, market: { spread_line: -9.5, book: 'consensus' }, projection: {
    status: 'PREDICTED', game: { home: FL, away: OM },
    model: { fair_spread: -0.18, fair_total: 58.1, home_win_prob: 0.495, display_fair_spread: fl.display_fair_spread, display_side: fl.display_side, is_near_pickem: fl.is_near_pickem, display_basis: fl.basis },
    scores: { confidence: 62 }, market: { spread_line: -9.5, spread_gap: -0.18 + 9.5 }, contributions: [], explanation: { primary_drivers: [], counterarguments: [], data_quality: [] }, layers: {}, data_quality: { status: 'OK', warnings: [] } } });
  chk('the research view compares Ole Miss -0.2, never the -1.0 floor', view.fair.comparison_line_text === OM + ' -0.2' && view.market_gap.points === 9.3 && view.market_gap.reconcile.formula === '|-0.2 − -9.5| = 9.3', { fair: view.fair.comparison_line_text, gap: view.market_gap.points });
  chk('the model projection itself is untouched (raw -0.18 kept beside the display)', view.market_gap.points_exact != null && Math.abs(view.market_gap.points_exact - 9.32) < 1e-9, view.market_gap.points_exact);
}

/* ===================================================================== 2 */
section('2  every displayed comparison reconciles at full precision');
{
  chk('half away from zero, with a binary-float guard', CALC.round(9.45, 1) === 9.5 && CALC.round(-9.45, 1) === -9.5 && CALC.round(0.05, 1) === 0.1 && CALC.round(1.005, 2) === 1.01 && CALC.round(2.675, 2) === 2.68 && CALC.round(-0.04, 1) === 0);
  /* parse the number a line's TEXT shows back into a home margin */
  const marginOfText = (t) => { if (/Pick/.test(t)) return 0; const m = /^(.*) ([+-]\d+\.\d)$/.exec(t); if (!m) return NaN; const line = +m[2]; return m[1] === FL ? -line : line; };
  const off = []; let n = 0;
  for (let i = -1200; i <= 1200; i += 7) {
    const model = i / 100 + 0.004;
    for (const k of [-14, -9.5, -7, -3.5, -2.5, -1, 0, 0.5, 1.5, 3, 6.5, 10, 13.5, -4.25, 2.75, -9.45]) {
      const c = CALC.spreadComparison({ home: FL, away: OM, model_home_margin: model, market_home_margin: k });
      n++;
      const shownModel = marginOfText(c.model.text), shownMarket = marginOfText(c.market.text);
      const want = Math.abs(Math.round(shownModel * 10) - Math.round(shownMarket * 10)) / 10;
      if (c.gap !== want || Math.abs(c.gap - c.gap_exact) > 0.1 + 1e-9) off.push({ model, k, model_text: c.model.text, market_text: c.market.text, gap: c.gap });
    }
  }
  chk('every gap equals the difference of the two lines as PRINTED (' + n + ' cases), and stays within 0.1 of the full-precision gap', !off.length, off.slice(0, 4));
  const t = CALC.totalComparison({ model_total: 51.25, market_total: 49.5 });
  chk('totals: the same rule (51.3 vs 49.5 is 1.8 above)', t.gap === 1.8 && t.model === 51.3 && t.direction === 'over', t);
  chk('the policy is named on every comparison', CALC.spreadComparison({ home: FL, away: OM, model_home_margin: 1, market_home_margin: 2 }).policy === 'display_rounding_v1');
}

/* ===================================================================== 3 */
section('3  a placeholder kickoff never becomes verified');
{
  const PH = '2026-10-17T04:00:00Z';                  /* midnight Eastern: the feed's placeholder */
  const tba = SCHED.kickoffOf({ kickoff: PH, start_time_tbd: true });
  chk('the source flag TBA → not verified', tba.state === 'TBA' && tba.verified === false, tba);
  const noflag = SCHED.kickoffOf({ kickoff: PH });
  chk('the placeholder instant with no flag → SUSPECT_PLACEHOLDER, not verified', noflag.state === 'SUSPECT_PLACEHOLDER' && noflag.verified === false, noflag);
  chk('… and it is shown as "time TBA", never as a clock time', SCHED.display({ kickoff: PH }, 'America/New_York').text === 'Sat, Oct 17 · time TBA', SCHED.display({ kickoff: PH }, 'America/New_York').text);
  const carried = SCHED.kickoffOf({ kickoff: PH, start_time_tbd: true, kickoff_state: 'CONFIRMED', kickoff_basis: 'an old build' });
  chk('a stale carried CONFIRMED cannot confirm a time the source marks TBA', carried.state === 'TBA' && carried.verified === false, carried);
  const carried2 = SCHED.kickoffOf({ kickoff: PH, kickoff_state: 'CONFIRMED', kickoff_basis: 'the source gives a time (no TBA flag supplied; not a placeholder instant)' });
  chk('… nor a carried CONFIRMED on the placeholder instant with no source flag behind it', carried2.verified === false && carried2.state === 'SUSPECT_PLACEHOLDER', carried2);
  const hawaii = SCHED.kickoffOf({ kickoff: '2026-10-11T04:00:00Z', start_time_tbd: false });
  chk('a real 04:00Z kickoff the source marks as set (Sacramento State at Hawai‘i) stays confirmed', hawaii.state === 'CONFIRMED' && hawaii.verified === true);
  const r = ev(rec({ game: { kickoff: PH, start_time_tbd: true, week: 6 } }), 'PUBLIC_BRIEF');
  chk('the integrity engine blocks a TBA kickoff from publication (SCHED.KICKOFF_VERIFIED)', ruleStatus(r, 'SCHED.KICKOFF_VERIFIED') === 'BLOCKED' && r.status === 'BLOCKED', r.blocking_reasons);
  chk('… and keeps it on the research dashboard with a warning', ruleStatus(ev(rec({ game: { kickoff: PH, start_time_tbd: true } }), 'RESEARCH_DASHBOARD'), 'SCHED.KICKOFF_VERIFIED') === 'WARNING');
  const pub = SCHED.publishable({ kickoff: PH, start_time_tbd: true, season: 2026, week: 6 }, NOW, null);
  chk('the publication check names the reason', !pub.ok && pub.reasons.some((x) => x.code === 'KICKOFF_TBA'), pub.reasons);
}

/* ===================================================================== 4 */
section('4  timezone conversion preserves the instant (DST included)');
{
  /* local wall clock → UTC, by search: the inverse the display must satisfy */
  const back = (loc, zone) => {
    const guess = Date.UTC(loc.y, loc.mo - 1, loc.d, loc.h, loc.mi);
    for (let off = -14 * 60; off <= 14 * 60; off += 15) {
      const t = guess + off * 60e3, p = SCHED.wallClock(t, zone);
      if (p.y === loc.y && p.mo === loc.mo && p.d === loc.d && p.h === loc.h && p.mi === loc.mi) return t;
    }
    return null;
  };
  const instants = ['2026-10-10T19:30:00Z', '2026-10-11T03:30:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z',
    '2026-03-08T07:30:00Z', '2026-03-08T10:30:00Z', '2026-12-31T23:59:00Z', '2027-01-01T05:00:00Z', '2026-10-11T04:00:00Z'];
  const zones = SCHED.ZONES.map((z) => z.zone || z.id || z).filter((z) => typeof z === 'string');
  const off = [];
  instants.forEach((iso) => zones.forEach((zone) => {
    const d = SCHED.display({ kickoff: iso, start_time_tbd: false }, zone);
    const t = back(d.local, zone);
    /* in the repeated hour of a fall-back, two instants share a wall clock: the abbreviation tells them apart */
    if (t !== Date.parse(iso)) off.push({ iso, zone, text: d.text, back: t && new Date(t).toISOString() });
  }));
  /* the repeated hour of a fall-back: two instants share a wall clock, and the
     zone abbreviation (EDT / EST) is what tells them apart — so a read-back to
     the other instant is a failure only if the two print identically */
  const realOff = off.filter((o) => !(o.back && SCHED.display({ kickoff: o.back, start_time_tbd: false }, o.zone).text !== o.text));
  chk('every display, read back in its own zone, is the same instant (' + instants.length * zones.length + ' cases, ' + zones.length + ' zones)', zones.length >= 4 && realOff.length === 0, realOff.slice(0, 4));
  const a = SCHED.display({ kickoff: '2026-11-01T05:30:00Z', start_time_tbd: false }, 'America/New_York');
  const b = SCHED.display({ kickoff: '2026-11-01T06:30:00Z', start_time_tbd: false }, 'America/New_York');
  chk('the fall-back hour: 1:30 AM EDT and 1:30 AM EST are told apart', /1:30 AM EDT/.test(a.text) && /1:30 AM EST/.test(b.text), [a.text, b.text]);
  chk('spring forward: 2:30 AM never appears in New York on Mar 8', !/2:30 AM/.test(SCHED.display({ kickoff: '2026-03-08T07:30:00Z', start_time_tbd: false }, 'America/New_York').text));
  const late = SCHED.display({ kickoff: '2026-10-11T03:30:00Z', start_time_tbd: false }, 'America/Los_Angeles');
  chk('a Saturday-night West Coast kickoff stays Saturday in Pacific time though it is Sunday in UTC', /^Sat, Oct 10 · 8:30 PM PDT$/.test(late.text), late.text);
  chk('a naive timestamp (no zone) is refused, never guessed', SCHED.parse('2026-10-10 15:30').ms == null);
  chk('an unknown zone falls back to the documented default, not to the browser’s', SCHED.display({ kickoff: '2026-10-10T19:30:00Z', start_time_tbd: false }, 'Mars/Olympus').zone === SCHED.CONFIG.default_zone);
}

/* ===================================================================== 5 */
section('5  no future-week game leaks into current-week research');
{
  const slate = [
    { season: 2026, week: 6, kickoff: '2026-10-10T16:00:00Z', start_time_tbd: false, home: 'A', away: 'B' },
    { season: 2026, week: 6, kickoff: '2026-10-11T00:00:00Z', start_time_tbd: false, home: 'C', away: 'D' },
    { season: 2026, week: 7, kickoff: '2026-10-17T04:00:00Z', start_time_tbd: true, home: 'Texas', away: 'Florida' },
    { season: 2026, week: 5, kickoff: '2026-10-03T19:30:00Z', start_time_tbd: false, home: 'E', away: 'F', status: 'final' }
  ];
  const cur = SCHED.currentWeek(slate, NOW);
  chk('the current week is the week whose games are still to be played (week 6), not a rolling window', cur && cur.week === 6, cur);
  chk('week 7 is FUTURE_WEEK', SCHED.scope(slate[2], cur) === 'FUTURE_WEEK' && SCHED.scope(slate[3], cur) === 'PAST_WEEK');
  chk('a future-week game is not publishable this week', SCHED.publishable(slate[2], NOW, cur).reasons.some((x) => x.code === 'FUTURE_WEEK'));
  const wk = (g) => ({ game: Object.assign({ season: 2026, week: g.week, kickoff: g.kickoff, start_time_tbd: g.start_time_tbd }, {}) });
  const r = ev(rec(wk(slate[2])), 'PUBLIC_BRIEF', { target_week: { season: 2026, week: 6, key: SCHED.weekKey({ season: 2026, week: 6 }) } });
  chk('the integrity engine blocks it from the public brief (SCHED.WEEK_SCOPE)', ruleStatus(r, 'SCHED.WEEK_SCOPE') === 'BLOCKED', r.checks.find((c) => c.rule_id === 'SCHED.WEEK_SCOPE'));
  /* the content engine on the committed research */
  const art = ART.load();
  const snap = CE.research.fromArtifacts(art, { now: NOW });
  const opps = CE.discover(snap, { now: NOW, publisher: CE.PUBLISHER_TEMPLATES['stadium-rant'] });
  const leaked = [];
  opps.forEach((o) => ((o.research && o.research.games) || []).forEach((p) => { if (p.week_scope === 'FUTURE_WEEK' || (o.week != null && p.week != null && p.week !== o.week)) leaked.push(o.key + ': ' + p.away + ' at ' + p.home + ' (week ' + p.week + ')'); }));
  chk('no article opportunity built from the committed research carries a game from another week', opps.length > 0 && !leaked.length, leaked.slice(0, 4));
  /* the committed terminal research mixes weeks, as the October 8 board did
     (117 games then, 62 of them week 7 look-ahead). It is rebuilt hourly, so
     the test holds the SHAPE, never the day's counts: more than one week in
     the file, and the content research keeps exactly the chosen week's games */
  const all = Object.values(art.cfbGames.games);
  const weeks = all.map((g) => g.week).filter((w, i, a) => a.indexOf(w) === i);
  const chosen = all.filter((g) => g.week === snap.cfb.week).length, other = all.length - chosen;
  chk('the committed research mixes weeks (as the October 8 board did): ' + all.length + ' games across weeks ' + weeks.sort().join(', '), weeks.length >= 2 && other > 0, { all: all.length, weeks });
  chk('… and the content research keeps only the current week: every one of its ' + chosen + ' games, no game from another week', snap.cfb.games.length === chosen && chosen > 0 && snap.cfb.games.every((p) => p.week === snap.cfb.week), { week: snap.cfb.week, n: snap.cfb.games.length, chosen });
}

/* ===================================================================== 6 */
section('6  research status and betting status stay separate');
{
  const r = rec({ research: { key: 'WORTH_RESEARCHING', label: 'Worth researching' }, decision: { key: 'PASS', reason: 'calibrated EV below zero at this price', bettor: { decision: 'PASS', label: 'Pass' } } });
  const x = INTEG.explainStatuses(r, { now: NOW, bet_enabled: false });
  chk('two classifications, each with its own rules', x.research.status === 'WORTH_RESEARCHING' && x.decision.status === 'PASS' && x.research.rules.length >= 3 && x.decision.rules.length >= 2);
  chk('… and one sentence on why they differ', /research interest is not a profitable bet/.test(x.why_differ), x.why_differ);
  chk('research says what it is not: never a bet signal', /never a bet signal/.test(x.research.means));
  const noDec = INTEG.explainStatuses(rec({ research: { key: 'INVESTIGATE' }, decision: null }), { now: NOW });
  chk('a research status without a decision reads NO DECISION, never a bet', noDec.decision.status === 'NO_DECISION');
  const fake = ev(rec({ decision: { key: 'BET' } }), 'BETTING_DECISION');
  chk('a BET that did not come from the decision engine is BLOCKED (DEC.RESEARCH_IS_NOT_DECISION)', ruleStatus(fake, 'DEC.RESEARCH_IS_NOT_DECISION') === 'BLOCKED');
  /* the October 8 board, row for row: 20 Worth Researching, 29 Investigate, 23 Market Aligned, 1 Market Fault,
     44 No Market (117), 73 of them quoted — which the old header summed into "49 research-grade" */
  const rows = [].concat(
    Array(20).fill({ research_key: 'WORTH_RESEARCHING', market_state: 'FRESH', scope: 'CURRENT_WEEK' }),
    Array(29).fill({ research_key: 'INVESTIGATE', market_state: 'FRESH', scope: 'CURRENT_WEEK' }),
    Array(23).fill({ research_key: 'MARKET_ALIGNED', market_state: 'FRESH', scope: 'CURRENT_WEEK' }),
    Array(1).fill({ research_key: 'MARKET_FAULT', market_state: 'FAULT', scope: 'CURRENT_WEEK' }),
    Array(44).fill({ research_key: 'NO_MARKET', market_state: 'NONE', scope: 'FUTURE_WEEK' }));
  const c = INTEG.countBoard(rows);
  chk('the October 8 counts reconcile three ways (by market, by week, by research class)', c.displayed === 117 && c.reconciles.by_market && c.reconciles.by_week && c.reconciles.by_research, c.reconciles);
  chk('… and "research-grade" counts only the 20 that cleared every gate, never the 29 Investigate', c.research_grade === 20 && c.investigate === 29 && c.aligned === 23 && c.market_fault === 1 && c.no_market === 44 && c.market_usable === 72, c);
  chk('… with a written definition for every number the header prints', ['displayed', 'research_grade', 'investigate', 'market_usable', 'future_week'].every((k) => typeof c.definitions[k] === 'string' && c.definitions[k].length > 10));
}

/* ===================================================================== 7 */
section('7  a stale market is never labelled current');
{
  const old = rec({ market: { captured_at: new Date(NOW - 5 * H).toISOString(), stale: true }, displayed: { market_claim: 'current' } });
  ['RESEARCH_DASHBOARD', 'BETTING_DECISION', 'PUBLIC_BRIEF', 'AI_CONTEXT', 'EDITORIAL_APPROVAL', 'READY_TO_SEND', 'PUBLISHER_EXPORT'].forEach((b) => {
    chk('"current" on a 5-hour-old line is BLOCKED at ' + b, ruleStatus(ev(old, b), 'MKT.CURRENT_CLAIM') === 'BLOCKED');
  });
  const unlabelled = rec({ market: { captured_at: new Date(NOW - 5 * H).toISOString(), stale: true } });
  chk('an old line may be shown labelled as old (WARNING in the brief) but never priced (BLOCKED at the decision)', ruleStatus(ev(unlabelled, 'PUBLIC_BRIEF'), 'MKT.FRESH') === 'WARNING' && ruleStatus(ev(unlabelled, 'BETTING_DECISION'), 'MKT.FRESH') === 'BLOCKED');
  const fresh = rec({ market: { captured_at: new Date(NOW - 20 * 60e3).toISOString(), stale: false }, displayed: { market_claim: 'current' } });
  chk('a 20-minute-old line may be called current', ruleStatus(ev(fresh, 'PUBLIC_BRIEF'), 'MKT.CURRENT_CLAIM') === 'PASS');
  const ref = rec({ market: { captured_at: null, stale: true, book: null, method: 'REFERENCE', source: 'ESPN', reference: true } });
  const rr = ev(ref, 'PUBLIC_BRIEF');
  chk('a reference line (source, no price, no capture time) is labelled a reference, not faulted and not current', ruleStatus(rr, 'MKT.TIMESTAMP') === 'PASS' && ruleStatus(rr, 'MKT.FRESH') === 'WARNING'
    && /reference line/.test(rr.checks.find((c) => c.rule_id === 'MKT.FRESH').explanation) && ruleStatus(ev(ref, 'BETTING_DECISION'), 'MKT.FRESH') === 'BLOCKED', rr.blocking_reasons);
  const noTime = rec({ market: { captured_at: null, stale: true } });
  chk('a priced line with no capture time is BLOCKED (its age cannot be known)', ruleStatus(ev(noTime, 'PUBLIC_BRIEF'), 'MKT.TIMESTAMP') === 'BLOCKED');
}

/* ===================================================================== 8 */
section('8  an alternate line is never compared with main-line consensus');
{
  const Q = (o) => Object.assign({ market_type: 'spread', period: 'game', source: 'odds', observed_at: '2026-10-08T17:00:00Z', home_team: FL, away_team: OM }, o);
  const quotes = [
    Q({ quote_id: 'a', book: 'dk', home_line: 9.5, price_home: -110, price_away: -110 }),
    Q({ quote_id: 'b', book: 'fd', home_line: 9.5, price_home: -108, price_away: -112 }),
    Q({ quote_id: 'c', book: 'mgm', home_line: 10, price_home: -105, price_away: -115 }),
    Q({ quote_id: 'd', book: 'czr', home_line: 2.5, price_home: 360, price_away: -500 }),        /* an alternate rung filed as main */
    Q({ quote_id: 'e', book: 'br', home_line: 3.5, is_alternate: true, price_home: 250, price_away: -330 }),  /* an alternate, labelled */
    Q({ quote_id: 'f', book: 'dk', market_type: 'total', home_line: 58.5, price_home: -110, price_away: -110 })
  ];
  const s = LAB.screenSet(quotes, { game: { home: FL, away: OM } });
  const why = (id) => (s.quarantined.find((x) => x.quote.quote_id === id) || { reasons: [] }).reasons;
  chk('the labelled alternate is quarantined as a non-equivalent market', why('e').indexOf('NON_EQUIVALENT_MARKET') >= 0, s.quarantined.map((x) => [x.quote.quote_id, x.reasons]));
  chk('the alternate rung filed as main is caught (ALT_LINE_MISFILED)', why('d').indexOf('ALT_LINE_MISFILED') >= 0);
  chk('a total is never mixed into a spread consensus', why('f').indexOf('NON_EQUIVALENT_MARKET') >= 0);
  chk('only the main lines remain', s.accepted.map((q) => q.quote_id).sort().join(',') === 'a,b,c', s.accepted.map((q) => q.quote_id));
  chk('quarantined, not discarded: every quote is accounted for', s.counts.input === s.counts.accepted + s.counts.quarantined);
  const legit = LAB.screenSet([quotes[0], quotes[1], quotes[2], Q({ quote_id: 'g', book: 'pinnacle', home_line: 7.5, price_home: -110, price_away: -110 })], { game: { home: FL, away: OM } });
  chk('a legitimate outlier (a main line 2 points off consensus, priced evenly) is kept, not discarded for disagreeing', legit.accepted.some((q) => q.quote_id === 'g'), legit.quarantined.map((x) => [x.quote.quote_id, x.reasons]));
  const r = rec({ market: { is_main_line: false } });
  ['RESEARCH_DASHBOARD', 'BETTING_DECISION', 'PUBLIC_BRIEF', 'PUBLISHER_EXPORT'].forEach((b) => chk('an alternate line in the comparison is BLOCKED at ' + b, ruleStatus(ev(r, b), 'MKT.MAIN_LINE') === 'BLOCKED'));
}

/* ===================================================================== 9 */
section('9  a faulted quote cannot bypass the decision gate');
{
  const Q = (o) => Object.assign({ market_type: 'spread', period: 'game', source: 'odds', observed_at: '2026-10-08T17:00:00Z', home_team: FL, away_team: OM }, o);
  const s = LAB.screenSet([
    Q({ quote_id: 'a', book: 'dk', home_line: -9.5, price_home: -110, price_away: -110 }),
    Q({ quote_id: 'b', book: 'fd', home_line: -9.5, price_home: -112, price_away: -108 }),
    Q({ quote_id: 'p', book: 'xx', home_line: -9.5, price_home: 400, price_away: -600 }),       /* laying 9.5 priced as a big underdog */
    Q({ quote_id: 'a', book: 'dk', home_line: -9.5, price_home: -110, price_away: -110 }),       /* the same quote twice */
    Q({ quote_id: 's', book: 'mgm', home_line: -9.5, price_home: -110, price_away: -110, market_status: 'suspended' }),
    Q({ quote_id: 'u', book: 'pb', home_line: -9.5, price_home: -110, price_away: -110, home_team: 'Florida State', away_team: 'Miami' })
  ], { game: { home: FL, away: OM } });
  const reasons = s.quarantined.map((x) => x.reasons[0]).sort();
  chk('polarity, duplicate, suspended and unmapped quotes are all quarantined', ['DUPLICATE_QUOTE', 'PRICE_POLARITY', 'SUSPENDED_MARKET', 'UNMAPPED_TEAM'].every((k) => reasons.indexOf(k) >= 0), reasons);
  const bettor = { decision: 'BET', label: 'Bet' };
  const faulted = rec({ market: { fault: 'PRICE_POLARITY: a side laying points priced as the underdog' }, decision: { key: 'BET', bettor } });
  const d = ev(faulted, 'BETTING_DECISION');
  chk('a BET on a faulted market is BLOCKED, with DEC.INTEGRITY_FAULT naming the fault', d.status === 'BLOCKED' && ruleStatus(d, 'DEC.INTEGRITY_FAULT') === 'BLOCKED'
    && d.checks.find((c) => c.rule_id === 'DEC.INTEGRITY_FAULT').evidence.faults.indexOf('MKT.FAULT') >= 0, d.blocking_reasons);
  const q8 = rec({ market: { quarantined_in_consensus: ['p'] }, decision: { key: 'WATCH', bettor: { decision: 'WATCH' } } });
  chk('a quarantined quote inside the consensus blocks a decision too', ev(q8, 'BETTING_DECISION').status === 'BLOCKED' && ruleStatus(ev(q8, 'BETTING_DECISION'), 'DEC.INTEGRITY_FAULT') === 'BLOCKED');
  chk('… and never reaches a publisher as consensus', ['PUBLIC_BRIEF', 'PUBLISHER_EXPORT'].every((b) => ruleStatus(ev(faulted, b), 'MKT.FAULT') === 'BLOCKED'));
  const swapped = rec({ market: { orientation_ok: false } });
  chk('a quote whose home/away orientation disagrees with the schedule is BLOCKED everywhere', ['RESEARCH_DASHBOARD', 'BETTING_DECISION', 'PUBLIC_BRIEF'].every((b) => ruleStatus(ev(swapped, b), 'MKT.EVENT_MATCH') === 'BLOCKED'));
  const m = SCHED.eventMatch({ home_team: OM, away_team: FL, commence_time: '2026-10-10T19:30:00Z' }, { home: FL, away: OM, kickoff: '2026-10-10T19:30:00Z', start_time_tbd: false });
  chk('the event join reports a reversed orientation instead of matching it', m.code === 'ORIENTATION_REVERSED' || m.match === false, m);
}

/* ==================================================================== 10 */
section('10 a missing QB announcement does not create false uncertainty');
{
  const prev = AVAIL.classify({ team: FL, player: 'DJ Lagway', previous_start: true }, { now: NOW });
  chk('started the previous game, nothing reported → EXPECTED STARTER, no uncertainty', prev['class'] === 'EXPECTED_STARTER' && prev.may_assert_uncertainty === false && prev.uncertain === false, prev);
  const none = AVAIL.classify({ team: FL }, { now: NOW });
  chk('no player on file → UNKNOWN, which asserts nothing', none['class'] === 'UNKNOWN' && none.may_assert_uncertainty === false);
  const split = AVAIL.classify({ team: OM, player: 'A', usage: { primary: 'A', primary_share: 0.57, secondary: 'B', secondary_share: 0.38, source: 'pbp' } }, { now: NOW });
  chk('a usage split with no report is a measured fact (NOT VERIFIED), not a competition', split['class'] === 'NOT_VERIFIED' && split.measured_note === true && split.may_assert_uncertainty === false, split);
  const byTeam = { [FL]: [prev], 'DJ Lagway': [prev] };
  const bad = AVAIL.guardProse('Florida has not confirmed DJ Lagway as the starter. The model makes Florida a slight favorite.', byTeam);
  chk('prose claiming an unconfirmed starter is caught (once per name it mentions)', bad.length >= 1 && bad.every((b) => /has not confirmed/.test(b.sentence) && /no sourced report/.test(b.reason)), bad);
  chk('prose that states the expected starter plainly passes', AVAIL.guardProse('DJ Lagway started the last game for Florida.', byTeam).length === 0);
  const report = (at) => ({ team: FL, player: 'DJ Lagway', reports: [{ claim: 'questionable', source: { name: 'Florida injury report', kind: 'official', url: 'https://floridagators.com/injury' }, published_at: at }] });
  const sourced = AVAIL.classify(report('2026-10-08T12:00:00Z'), { now: NOW, kickoff: '2026-10-10T19:30:00Z' });
  chk('uncertainty may be written only from a sourced, timestamped report', sourced.may_assert_uncertainty === true && sourced.verification === 'SOURCED' && !!sourced.published_at, sourced);
  chk('… a report days before kickoff needs no revalidation', sourced.revalidate_required === false);
  const late = AVAIL.classify(report('2026-10-10T02:00:00Z'), { now: Date.parse('2026-10-10T03:00:00Z'), kickoff: '2026-10-10T19:30:00Z' });
  chk('… breaking news inside ' + AVAIL.CONFIG.revalidate_hours_before_kickoff + ' hours of kickoff must be checked again before publishing', late.revalidate_required === true, late);
  const afterApproval = AVAIL.classify(report('2026-10-08T20:00:00Z'), { now: Date.parse('2026-10-08T21:00:00Z'), kickoff: '2026-10-10T19:30:00Z', approved_at: '2026-10-08T18:00:00Z' });
  chk('… and so must a report that arrived after the article was approved', afterApproval.revalidate_required === true);
  const unsourced = AVAIL.classify({ team: FL, player: 'DJ Lagway', reports: [{ claim: 'questionable', source: { name: 'a message board' }, published_at: '2026-10-08T12:00:00Z' }] }, { now: NOW });
  chk('a claim with no verifiable source is NOT VERIFIED and asserts nothing', unsourced['class'] === 'NOT_VERIFIED' && unsourced.may_assert_uncertainty === false, unsourced);
}

/* ==================================================================== 11 */
section('11 projected scores reconcile with the total and the margin');
{
  const off = []; let n = 0;
  for (let m = -280; m <= 280; m += 3) for (let t = 380; t <= 760; t += 7) {
    const margin = m / 10 + 0.013, total = t / 10 - 0.021;
    const s = CALC.projectedScores({ home: FL, away: OM, home_margin: margin, total }); n++;
    const dp = s.decimals, P = Math.pow(10, dp);
    const sum = Math.round((s.home + s.away) * P) / P, diff = Math.round((s.home - s.away) * P) / P;
    if (sum !== CALC.round(total, 1) || diff !== CALC.round(margin, 1) || !CALC.scoresReconcile(s.home, s.away, margin, total, dp).ok) off.push({ margin, total, s: s.text });
  }
  chk('the score line adds to the displayed total and differs by the displayed margin, exactly (' + n + ' cases)', !off.length, off.slice(0, 3));
  chk('the October 8 case: Ole Miss by 0.2, total 58.1 → 29.15 – 28.95', CALC.projectedScores({ home: FL, away: OM, home_margin: -0.2, total: 58.1 }).text === 'Ole Miss 29.15 — Florida 28.95');
  const mis = CALC.scoresReconcile(29.2, 28.9, 0.2, 58.1, 1);
  chk('a score line that does not reconcile is named', mis.ok === false && /margin/.test(mis.reason), mis);
  const r = rec({ model: { home_margin: 3, total: 50, projected_score: { home: 28, away: 22 } } });
  chk('the integrity engine flags a stored score line that disagrees (PROJ.SCORES)', ruleStatus(ev(r, 'PUBLIC_BRIEF'), 'PROJ.SCORES') === 'BLOCKED' && ruleStatus(ev(r, 'RESEARCH_DASHBOARD'), 'PROJ.SCORES') === 'WARNING');
}

/* ==================================================================== 12 */
section('12 exports preserve the approved snapshot');
const ART_ALL = ART.load();
const SNAP = CE.research.fromArtifacts(ART_ALL, { now: NOW });
const SR = CE.PUBLISHER_TEMPLATES['stadium-rant'];
const OPPS = CE.discover(SNAP, { now: NOW, publisher: SR });
const PREV = OPPS.find((o) => o.league === 'cfb' && o.kind === 'weekly_preview');
const A0 = CE.draft(PREV, { publisher: SR, format: 'cfb_weekly_preview', now: NOW });
const TL = ART.teamLists(ART_ALL);
{
  const vx = CE.validate(A0, PREV, { now: NOW, teamLists: TL, publisher: SR });
  const row = Object.assign({}, A0, { id: 'x', status: 'approved', revision: 2, content_hash: 'ab'.repeat(32), approved_hash: 'ab'.repeat(32), approved_by: 'owner', approved_at: '2026-10-08T18:00:00Z',
    approved_research_hash: A0.research_hash, campaign_code: 'ce_stadiumrant_x', checks: vx });
  const ctx = { publisher: SR, campaign: 'ce_stadiumrant_x', opportunity: PREV };
  const x = CE.exportCheck(A0, row, ctx);
  chk('Markdown, HTML and Word carry the approved numbers in the same order', x.ok && x.formats.md.ok && x.formats.html.ok && x.formats.docx.ok && x.expected_numbers > 20, x.problems);
  chk('each export carries the snapshot it was made from', /edgedesk_content_hash/.test(CE.toMarkdown(A0, Object.assign({ frontMatter: true, snapshot: x.snapshot }, ctx)))
    && /edgedesk-snapshot/.test(CE.toHtml(A0, Object.assign({ standalone: true, snapshot: x.snapshot }, ctx))));
  /* a renderer that rounds a number differently is caught: the HTML writer, mutated */
  const sbx = { TextEncoder, TextDecoder, URL, console }; sbx.globalThis = sbx; vm.createContext(sbx);
  ['edgedesk_calc.js', 'edgedesk_schedule.js', 'edgedesk_availability.js', 'edgedesk_integrity.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8'), sbx));
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'content_engine.js'), 'utf8');
  const target = 'function inline(s) {\n    var t = esc(s);';
  chk('(the mutation target exists in the HTML writer)', src.indexOf(target) > 0);
  vm.runInContext(src.replace(target, 'function inline(s) {\n    var t = esc(s).replace(/(\\d+)\\.(\\d)/, function (_, a, b) { return a + "." + ((+b + 1) % 10); });'), sbx);
  const bad = sbx.EDContentEngine.exportCheck(A0, row, ctx);
  chk('an HTML renderer that alters one number is refused before export', !bad.ok && bad.formats.md.ok && !bad.formats.html.ok, bad.problems);
  chk('an export of content that is not the approved revision is refused', CE.exportCheck(A0, Object.assign({}, row, { approved_hash: 'cd'.repeat(32) }), ctx).problems.some((p) => p.id === 'EXPORT.APPROVED'));
  const edited = CE.compareCopy(CE.toMarkdown(A0, ctx).replace(/(\d+)\.(\d)/, '$1.9'), A0, ctx);
  chk('a publisher’s copy with an altered number is named against the snapshot', !edited.same && edited.not_in_approved.length >= 1, edited);
}

/* ==================================================================== DB */
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const db = PG.start('integrityreg');
if (db.skip) {
  ['13', '14', '15', '16', '17', 'I (database half)'].forEach((k) => { notRun++; console.log('  NOT RUN ' + k + ': ' + db.skip); });
  finish();
} else {
  const lit = PG.lit;
  const OWNER = '00000000-0000-0000-0000-0000000000e1', ADMIN = '00000000-0000-0000-0000-0000000000e2', USER = '00000000-0000-0000-0000-0000000000e3', READER = '00000000-0000-0000-0000-0000000000e4';
  const J = (s) => (s === '' ? null : JSON.parse(s));
  const own = (s) => J(db.as(OWNER, s));
  const svc = (s) => J(db.service(s));
  const one = (s) => db.sql(s);
  const fails = (fn) => db.mustFail(fn);
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql', 'content_engine.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
    one(`insert into auth.users (id, email, email_confirmed_at, created_at) values ('${OWNER}', 'owner@edgedesk.test', now(), now()), ('${ADMIN}', 'admin@edgedesk.test', now(), now()),
           ('${USER}', 'user@edgedesk.test', now(), now()), ('${READER}', 'reader@example.test', now(), now());
         insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
         select growth_outbound.grant_owner('owner@edgedesk.test');`);
    const pub = own('select public.content_engine_publishers();').find((p) => p.slug === 'stadium-rant');
    const withHash = (o) => Object.assign({}, o, { research_hash: CE.util.hash(JSON.stringify(o.research)) });

    /* ── I the integration test: committed research → an approved, reconciled article ── */
    section('I  integration: committed research → a publishable, approved, reconciled article');
    {
      chk('the committed research yields opportunities, and every game they carry is publishable (integrity PASS or WARNING)',
        OPPS.length > 0 && OPPS.every((o) => (o.research.games || []).every((p) => p.publishable !== false && (!p.integrity || p.integrity.public.status !== 'BLOCKED'))),
        OPPS.map((o) => o.key));
      chk('the games the integrity engine withholds are named with their rules', SNAP.cfb.withheld.every((w) => w.blocking && w.blocking.length), SNAP.cfb.withheld.slice(0, 2));
      const up = own(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(withHash(PREV)))}::jsonb, null);`);
      const v0 = CE.validate(A0, PREV, { publisher: pub, now: NOW, teamLists: TL });
      chk('the deterministic draft passes every hard check and the integrity engine', v0.ok && (v0.integrity_status === 'PASS' || v0.integrity_status === 'WARNING'), v0.failed);
      const cr = own(`select public.content_engine_article_create(${lit(up.id)}, ${lit(pub.id)}, 'cfb_weekly_preview', 'full_slate', ${lit(JSON.stringify(Object.assign({}, A0, { checks: v0 })))}::jsonb, null);`);
      own(`select public.content_engine_article_submit(${lit(cr.id)});`);
      own(`select public.content_engine_article_review(${lit(cr.id)}, '{"source_verification":true,"data_freshness":true,"model_accuracy":true,"seo_review":true,"compliance":true}'::jsonb);`);
      const h = one(`select content_hash from content_engine.articles where id = ${lit(cr.id)};`);
      const ap = own(`select public.content_engine_article_approve(${lit(cr.id)}, ${lit(h)});`);
      chk('the owner approves exactly this version', ap.ok === true, ap);
      const row = own(`select public.content_engine_article(${lit(cr.id)});`);
      const rd = CE.readiness(row, { opportunity: row.opportunity, ctx: { publisher: row.publisher_profile, campaign: row.campaign_code, opportunity: row.opportunity, landing: row.landing_url } });
      chk('the ready-to-send checklist passes on the stored row', rd.ok, rd.items.filter((i) => i.status !== 'pass'));
      const ex = CE.exportCheck({ format: row.format, title: row.title, slug: row.slug, meta_description: row.meta_description, standfirst: row.standfirst, primary_keyword: row.primary_keyword,
        secondary_keywords: row.secondary_keywords, sections: row.sections }, row, { publisher: row.publisher_profile, campaign: row.campaign_code, opportunity: row.opportunity, landing: row.landing_url });
      chk('the stored, approved article exports with the approved numbers in every format', ex.ok, ex.problems);
      const rdy = own(`select public.content_engine_article_transition(${lit(cr.id)}, 'ready_to_send', '{}'::jsonb);`);
      chk('ready to send', rdy.ok === true, rdy);

      /* ── 13 ── */
      section('13 a major data change revokes readiness');
      const changed = JSON.parse(JSON.stringify(PREV));
      changed.research.games[0].model.margin = changed.research.games[0].model.margin + 3.1;
      const up2 = own(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(withHash(changed)))}::jsonb, null);`);
      const st = one(`select status || '|' || coalesce(approved_research_hash, '') from content_engine.articles where id = ${lit(cr.id)};`);
      chk('new research for the same opportunity revokes the ready article back to review', up2.research_changed === true && up2.revoked === 1 && /^in_review\|/.test(st), { up2, st });
      chk('… logged with the old and new research', +one(`select count(*) from content_engine.events where kind = 'approval_revoked' and article_id = ${lit(cr.id)};`) === 1);
      const re = own(`select public.content_engine_article_approve(${lit(cr.id)}, ${lit(h)});`);
      chk('… and the old draft cannot be approved again on the new research', re.ok === false && re.reason === 'research_changed', re);
      chk('… nor sent (the send door refuses a stale article)', own(`select public.content_engine_send_claim(${lit(cr.id)}, 'owner@edgedesk.test', 'x', ${lit(h)}, true, null);`).ok === false);
    }

    /* ── 14 ── */
    section('14 duplicate generation cannot create duplicate charges');
    {
      const k = 'd'.repeat(40);
      const r1 = svc(`select public.content_engine_ai_reserve(${lit(k)}, 0.40, 'rewrite', null, 'claude-opus-5-5', null);`);
      const s1 = svc(`select public.content_engine_ai_settle(${lit(k)}, true, 9000, 2000, 0.076, null, null, null);`);
      const r2 = svc(`select public.content_engine_ai_reserve(${lit(k)}, 0.40, 'rewrite', null, 'claude-opus-5-5', null);`);
      chk('the same request, made and paid for, is refused the second time', r1.ok && s1.status === 'committed' && r2.ok === false && r2.reason === 'duplicate', { r1, s1, r2 });
      chk('… and charged once', one(`select count(*) || '|' || round(sum(actual_usd), 3) from content_engine.ai_spend where request_key = ${lit(k)};`) === '1|0.076');
      const art = one(`select id from content_engine.articles limit 1;`);
      const k1 = 'e'.repeat(40), k2 = 'f'.repeat(40);
      const a1 = svc(`select public.content_engine_ai_reserve(${lit(k1)}, 0.40, 'section', ${lit(art)}, 'claude-opus-5-5', null);`);
      const a2 = svc(`select public.content_engine_ai_reserve(${lit(k2)}, 0.40, 'section', ${lit(art)}, 'claude-opus-5-5', null);`);
      chk('a second rewrite of the same article while one is running is refused (one in flight per article and purpose)', a1.ok && a2.ok === false && a2.reason === 'in_flight', { a1, a2 });
      svc(`select public.content_engine_ai_settle(${lit(k1)}, false, 0, 0, null, 'test', null, null);`);
    }

    /* ── 15 ── */
    section('15 concurrent jobs cannot pass the monthly cap');
    {
      own(`select public.content_engine_budget_update('{"monthly_budget_usd": 1.00, "job_budget_usd": 1.00}'::jsonb);`);
      const used = +one(`select committed_usd + reserved_usd from content_engine.ai_months;`);
      const room = Math.max(0, 1 - used), take = (Math.round(room * 0.6 * 1e6) / 1e6).toFixed(6);
      const race = (key) => db.background(`begin; set local role service_role;
        select public.content_engine_ai_reserve('${key}', ${take}, 'other', null, 'claude-opus-5-5', null);
        select pg_sleep(1.5); commit;`);
      const ra = race('1'.repeat(40)), rb = race('2'.repeat(40));
      const oa = ra.wait(30000), ob = rb.wait(30000);
      const ok = [oa.out, ob.out].filter((o) => /"ok": true/.test(o)).length, refused = [oa.out, ob.out].filter((o) => /monthly_budget_exhausted/.test(o)).length;
      chk('two sessions racing for the last of the cap: one in, one refused', room > 0.01 && ok === 1 && refused === 1, [oa.out, ob.out]);
      chk('… and the month never passes its cap', +one(`select committed_usd + reserved_usd from content_engine.ai_months;`) <= 1.000001);
      chk('the cap defaults to $10 and cannot be raised without the owner’s explicit confirmation', own(`select public.content_engine_budget_update('{"monthly_budget_usd": 25}'::jsonb);`).reason === 'confirm_raise');
      own(`select public.content_engine_budget_update('{"monthly_budget_usd": 10, "job_budget_usd": 2}'::jsonb);`);
    }

    /* ── 16 ── */
    section('16 referral attribution survives registration and payment');
    {
      const code = one(`select campaign_code from content_engine.articles limit 1;`);
      const V1 = 'reader-visitor-token-0001';
      /* 1 the reader lands through the article's tagged link (anonymous) */
      const tv = J(db.anon(`select public.acq_track_visit(${lit(V1)}, ${lit(JSON.stringify({ utm_source: 'stadiumrant', utm_medium: 'publisher', utm_campaign: code, landing: '/today/' }))}::jsonb);`));
      /* 2 later, a direct visit (typing the address) must not overwrite the first touch */
      db.anon(`select public.acq_track_visit(${lit(V1)}, '{}'::jsonb);`);
      /* 3 the reader registers and the browser claims the visitor */
      const cl = J(db.as(READER, `select public.acq_claim(${lit(V1)});`));
      const ua = one(`select first_utm_campaign || '|' || first_utm_source from public.user_acquisition where user_id = ${lit(READER)};`);
      chk('the registration keeps the article’s campaign as its first touch', tv.ok && cl.ok && ua === code + '|stadiumrant', { tv, cl, ua });
      chk('the first touch is write-once', !!fails(() => db.sql(`update public.user_acquisition set first_utm_campaign = 'other' where user_id = ${lit(READER)};`)));
      /* 4 a trial, then a paid invoice, as the Stripe webhook records them */
      one(`insert into public.subscriptions (user_id, status, price_id, stripe_customer_id, stripe_subscription_id) values (${lit(READER)}, 'active', 'price_x', 'cus_reader', 'sub_reader')
             on conflict (user_id) do update set stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = excluded.stripe_subscription_id;
           insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, payload) values
             ('evt_r1', 'customer.subscription.created', now(), 'cus_reader', 'sub_reader', '{"data":{"object":{"id":"sub_reader","status":"trialing","trial_start":${Math.floor(Date.now() / 1000)},"customer":"cus_reader"}}}'),
             ('evt_r2', 'invoice.paid', now(), 'cus_reader', 'sub_reader', '{"data":{"object":{"id":"in_reader_1","amount_paid":2900,"customer":"cus_reader","subscription":"sub_reader"}}}');`);
      const ar = own(`select public.content_engine_acquisition_report(1);`);
      const m0 = ar.months[0];
      chk('the acquisition loop attributes the visit, the registration, the trial and the paid subscriber to the article', m0.referral_visits >= 1 && m0.registrations >= 1 && m0.trials >= 1 && m0.paid_subscribers >= 1, m0);
      chk('… with Stripe’s own invoice amount as revenue (gross, not profit)', m0.subscriber_revenue_usd >= 29 && /not profit/.test(ar.revenue), m0);
      const fp = J(one(`select content_engine.first_party(${lit(code)})::text;`));
      chk('the per-article first-party counts show the same path: visit, sign-up, trial, paid', fp && fp.visits >= 1 && fp.signups >= 1 && fp.trials >= 1 && fp.paid >= 1, fp);
      chk('targets are labelled targets, not forecasts', /not forecasts/.test(ar.targets.kind));
    }

    /* ── 17 ── */
    section('17 an unauthorized user cannot modify production data');
    {
      const art = one(`select id from content_engine.articles limit 1;`);
      const h = one(`select content_hash from content_engine.articles where id = ${lit(art)};`);
      const doors = [
        `select public.content_engine_article_approve(${lit(art)}, ${lit(h)});`,
        `select public.content_engine_article_transition(${lit(art)}, 'archived', '{}'::jsonb);`,
        `select public.content_engine_article_save(${lit(art)}, '{"title":"Hijacked headline for the test case","sections":[{"key":"intro","body":"x x x x x x x x x"}]}'::jsonb, 'x', ${lit(h)});`,
        `select public.content_engine_budget_update('{"monthly_budget_usd": 0}'::jsonb);`,
        `select public.content_engine_settings_save('{"schedule_enabled": true}'::jsonb);`,
        `select public.content_engine_ai_reserve('${'9'.repeat(40)}', 0.1, 'other', null, null, null);`
      ];
      const asUser = doors.filter((q) => !fails(() => db.as(USER, q)));
      const asAnon = doors.filter((q) => !fails(() => db.anon(q)));
      chk('a signed-in reader reaches no door that changes content, settings or spend', asUser.length === 0, asUser);
      chk('anonymous reaches none', asAnon.length === 0, asAnon);
      const asAdmin = doors.slice(0, 5).filter((q) => !fails(() => db.as(ADMIN, q)));
      chk('an affiliate admin who is not a content owner reaches none', asAdmin.length === 0, asAdmin);
      chk('the service role (the weekly job) can never approve', !!fails(() => db.service(doors[0])));
      const direct = [`update content_engine.articles set title = 'x';`, `delete from content_engine.ai_spend;`, `update content_engine.settings set monthly_budget_usd = 10;`, `insert into content_engine.ai_months (month) values ('2030-01-01');`];
      chk('no table is writable directly by a reader, anon or the service role', direct.every((q) => fails(() => db.as(USER, q)) && fails(() => db.anon(q)) && fails(() => db.service(q))));
      chk('articles are never deleted, even by the superuser path', !!fails(() => db.sql(`delete from content_engine.articles where id = ${lit(art)};`)));
    }
  } catch (e) {
    chk('the database cases reached their end — ' + String(e && e.stack || e).slice(0, 800), false);
  } finally {
    db.stop();
  }
  finish();
}

function finish() {
  failures.forEach((f) => console.log('  × ' + f));
  const required = process.env.INTEGRITY_PG_REQUIRED === '1';
  const ok = fail === 0 && !(required && notRun);
  console.log((ok ? 'PASS' : 'FAIL') + ' | system-integrity regression | ' + pass + ' passed, ' + fail + ' failed' + (notRun ? ', ' + notRun + ' NOT RUN (no PostgreSQL)' : ''));
  process.exit(ok ? 0 : 1);
}
