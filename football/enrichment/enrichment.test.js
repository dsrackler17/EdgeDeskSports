#!/usr/bin/env node
/* ===========================================================================
   THE ENRICHMENT LAYER — the rules, pinned (football/enrichment/).

   Every "never fake coverage" rule is a check here, on fixtures, offline:

     provider failure != healthy roster      missing record != available
     no conflicting source != confirmed       one quote != consensus
     unrated player != replacement level      missing FCS rating != average
     UNKNOWN stays UNKNOWN                    a run's egress block != a
                                              provider's auth failure
   plus: the evidence cache carries last-known values with their own clocks;
   the scheduler freezes kicked-off games; the QB hierarchy never lets Tier 5
   override fresh Tier 1; the FCS bridge recovers a known truth; reliability
   read from an evidence package behaves as documented; and the evidence
   layer never touches a projection.

   Run: node football/enrichment/enrichment.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P = global.EDCfbP4Params;
const R = require(path.join(ROOT, 'lib', 'cfb_reliability.js'));
const GE = require(path.join(ROOT, 'lib', 'game_evidence.js'));
const MC = require(path.join(ROOT, 'lib', 'market_consensus.js'));
const C = require('./config.js');
const ST = require('./availability/status.js');
const AG = require('./availability/aggregator.js');
const RES = require('./qb/resolver.js');
const IMP = require('./impact/player_impact.js');
const STARTERS = require('./impact/starters.js');
const H = require('./core/health.js');
const K = require('./core/cache.js');
const SCH = require('./core/scheduler.js');
const LIN = require('./core/lineage.js');
const B = require('./fcs/bridge.js');
const ROI = require('./roi.js');
const AUDIT = require('./audit.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String((e && e.stack) || e).slice(0, 400); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function section(t) { console.log('\n' + t); }

const NOW = Date.parse('2026-10-03T15:00:00Z');
const KICK = '2026-10-03T23:30:00Z';
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();

/* ======================================================================== */
section('1 · one availability vocabulary; UNKNOWN is never AVAILABLE');
{
  eq('OUT', ST.normalize('Out').status, 'OUT');
  eq('ESPN code', ST.normalize('INJURY_STATUS_OUT').status, 'OUT');
  eq('game-time decision is doubt', ST.normalize('GAME_TIME_DECISION').status, 'QUESTIONABLE');
  eq('out for the first half is not "out"', ST.normalize('OUT_FIRST_HALF').status, 'QUESTIONABLE');
  eq('text sharpens OUT to SEASON_OUT', ST.normalize('OUT', 'will miss the rest of the season').status, 'SEASON_OUT');
  eq('suspension', ST.normalize(null, 'suspended for the opener').status, 'SUSPENDED');
  eq('portal', ST.normalize(null, 'has entered the transfer portal').status, 'TRANSFERRED');
  eq('left the program', ST.normalize(null, 'is no longer with the team').status, 'NOT_WITH_TEAM');
  eq('text never softens a designation', ST.normalize('PROBABLE', 'out for the season last year').status, 'PROBABLE');
  eq('no words, no designation: UNKNOWN', ST.normalize(null, 'ankle').status, 'UNKNOWN');
  eq('UNKNOWN has no absence probability (not 0, not 0.5)', ST.pAbsent('UNKNOWN'), null);
  chk('the ten states', C.STATUS.length === 10 && C.STATUS.indexOf('UNKNOWN') >= 0);
}

/* ======================================================================== */
section('2 · provider health: a run’s egress block is not the provider’s failure');
{
  eq('proxy denial', H.classifyCall({ status: 403, headers: { 'x-deny-reason': 'host_not_allowed' } }).outcome, 'EGRESS_BLOCKED');
  eq('provider 403', H.classifyCall({ status: 403 }).outcome, 'AUTH_FAILURE');
  eq('429', H.classifyCall({ status: 429 }).outcome, 'RATE_LIMITED');
  eq('5xx', H.classifyCall({ status: 503 }).outcome, 'SERVER_ERROR');
  const eg = H.summarize('x', { calls: [{ outcome: 'EGRESS_BLOCKED' }, { outcome: 'EGRESS_BLOCKED' }] });
  chk('all egress-blocked: DOWN, attributed to the run', eg.state === 'DOWN' && eg.attributable_to === 'run_environment', eg);
  const auth = H.summarize('x', { calls: Array(5).fill({ outcome: 'AUTH_FAILURE' }) });
  eq('every call refused by the provider: AUTH_FAILURE', auth.state, 'AUTH_FAILURE');
  const rl = H.summarize('x', { calls: [{ outcome: 'OK' }, { outcome: 'RATE_LIMITED' }, { outcome: 'RATE_LIMITED' }] });
  eq('429s dominate the failures: RATE_LIMITED', rl.state, 'RATE_LIMITED');
  const dg = H.summarize('x', { calls: [{ outcome: 'OK' }, { outcome: 'OK' }, { outcome: 'OK' }, { outcome: 'SERVER_ERROR' }] });
  chk('some calls failed: DEGRADED, certainty reduced proportionally', dg.state === 'DEGRADED' && dg.certainty === 0.75, dg);
  const st = H.summarize('x', { calls: [{ outcome: 'OK' }], content_stale_why: 'only 2020 rows' });
  eq('answered with historical rows: STALE', st.state, 'STALE');
  const mix = H.summarize('x', { calls: [{ outcome: 'OK' }, { outcome: 'OK' }, { outcome: 'EGRESS_BLOCKED' }] });
  chk('a blocked live check does not dilute what did reach the provider', mix.state === 'HEALTHY' && /network policy/.test(mix.reason), mix);
  eq('not asked and not configured', H.summarize('x', { configured: false }).state, 'NOT_CONFIGURED');
  eq('not asked this run: NOT_CHECKED, never DOWN', H.summarize('x', { checked: false }).state, 'NOT_CHECKED');
  eq('a failure group names the refusal, not the missing endpoint variants',
    H.callsFromFailureGroup({ error: 'no depth-chart endpoint answered (HTTP 404; HTTP 403; HTTP 404)', teams: 3 }, ago(1))[0].outcome, 'AUTH_FAILURE');
}

/* ======================================================================== */
section('3 · the evidence cache: last-known values, with their own clocks');
{
  const f = path.join(os.tmpdir(), 'edge_enrich_cache_' + process.pid + '.json');
  try { fs.unlinkSync(f); } catch (_) {}
  const s = K.open(f);
  K.put(s, 'a', 'injuries', { value: { out: ['X'] }, source: 'report', observed_at: NOW - 3600e3 }, NOW);
  const r0 = K.recall(s, 'a', NOW);
  chk('fresh inside its TTL', r0.found && r0.fresh && !r0.stale && !r0.carried, r0);
  K.fail(s, 'a', 'injuries', 'HTTP 403', NOW + 20 * 3600e3);
  const r1 = K.recall(s, 'a', NOW + 20 * 3600e3);
  chk('a failed refresh carries the value, marked STALE past its TTL, with the reason', r1.found && r1.stale && r1.carried && /403/.test(r1.reason), r1);
  eq('the carried value keeps its ORIGINAL observation time', r1.observed_at, new Date(NOW - 3600e3).toISOString());
  const r2 = K.recall(s, 'a', NOW + 200 * 3600e3);
  chk('past max_carry it is HISTORICAL, not evidence', !r2.found && r2.historical, r2);
  K.put(s, 'b', 'injuries', { value: 1, observed_at: NOW - 3600e3 }, NOW);
  K.put(s, 'b', 'injuries', { value: 1, observed_at: NOW }, NOW + 3600e3);
  eq('an unchanged re-read renews retrieval, never the observation', s.entries.b.current.observed_at, new Date(NOW - 3600e3).toISOString());
  K.save(s, NOW); chk('saved', fs.existsSync(f));
  try { fs.unlinkSync(f); } catch (_) {}
  const l = LIN.make('Jalen', { source: 'x', observed_at: NOW - 50 * 3600e3, kind: 'qb_status', now: NOW });
  chk('lineage marks a value past its TTL stale', l.stale && l.provenance === 'COMPLETE', l);
  chk('a value without provenance is trusted less', LIN.trust(LIN.make(1, {})) < LIN.trust(LIN.make(1, { source: 's', source_type: 'PRIMARY_STRUCTURED', observed_at: NOW, now: NOW })));
}

/* ======================================================================== */
section('4 · the scheduler: refresh windows, horizons, and the frozen pregame ledger');
{
  const d = (h, last) => SCH.due('injuries', { now: NOW, kickoff: NOW + h * 3600e3, last_retrieved_at: last == null ? null : NOW - last * 60e3 });
  eq('beyond the horizon: not called', d(24 * 20, null).due, false);
  eq('> 72h: NORMAL', d(100, 30).window, 'NORMAL');
  eq('24-72h: ELEVATED', d(50, 30).window, 'ELEVATED');
  eq('6-24h: HIGH', d(10, 30).window, 'HIGH');
  eq('< 6h: VERY_HIGH', d(3, 30).window, 'VERY_HIGH');
  eq('< 90 min: FINAL confirmation pass', d(1, 30).window, 'FINAL');
  eq('FINAL is due every 20 minutes', d(1, 30).due, true);
  const fr = d(-1, 5);
  chk('kicked off: FROZEN, never re-read', fr.window === 'FROZEN' && fr.due === false, fr);
  eq('weather is not read a week out', SCH.due('weather', { now: NOW, kickoff: NOW + 100 * 3600e3 }).due, false);
}

/* ======================================================================== */
section('5 · the availability aggregator');
const FX = { game_id: 'g1', kickoff: KICK, side: 'home', team_key: 'ohiostate', team_name: 'Ohio State', is_fbs: true };
const STARTERS5 = [{ player_id: '1', name: 'Tackle', pos: 'OL', slot: 'OL1', unit: 'offense', role: 'STARTER', starter: true },
  { player_id: '2', name: 'Corner', pos: 'CB', slot: 'SECONDARY1', unit: 'defense', role: 'STARTER', starter: true },
  { player_id: '3', name: 'Quarterback', pos: 'QB', slot: 'QB', unit: 'offense', role: 'STARTER', starter: true }];
function ev(o) {
  return Object.assign({ evidence_id: 'e' + Math.random(), provider: 'conference_reports', team_id: 'ohiostate', player_id: '1', player_name: 'Tackle',
    availability_status: 'OUT', source: 'Big Ten report', source_type: 'PRIMARY_STRUCTURED', source_timestamp: ago(5), retrieved_at: ago(4), game_id: 'g1',
    identity: { confidence: 'EXACT' } }, o || {});
}
const failedProviders = { espn_core_injuries: { provider: 'espn_core_injuries', state: 'STALE' }, espn_depth_chart: { provider: 'espn_depth_chart', state: 'AUTH_FAILURE' } };
{
  const pf = AG.aggregate({ fixture: FX, policy: { state: 'UNVERIFIED' }, evidence: [], official: null, starters: STARTERS5, providers: failedProviders, now: NOW });
  eq('every source failed: PROVIDER_FAILED', pf.summary.coverage_class, 'PROVIDER_FAILED');
  eq('coverage 0', pf.summary.coverage_score, 0);
  chk('a provider failure is never a healthy roster: no starter is AVAILABLE', pf.players.every((p) => p.availability_status !== 'AVAILABLE') && pf.summary.starters.known === 0, pf.summary.starters);
  chk('the failure is named', /failed/.test(pf.summary.coverage_reason) && /espn_depth_chart/.test(pf.summary.coverage_reason), pf.summary.coverage_reason);

  const nc = AG.aggregate({ fixture: FX, policy: { state: 'REQUIRED' }, evidence: [ev()],
    official: { ok: true, comprehensive: false, published_at: ago(5), retrieved_at: ago(4), rows_n: 1, game_id: 'g1' }, starters: STARTERS5, providers: {}, now: NOW });
  eq('an absence-only official report', nc.summary.coverage_class, 'OFFICIAL_THIS_GAME');
  eq('its silence is not availability: the unlisted starters are UNKNOWN', nc.summary.starters.unknown, 2);

  const cp = AG.aggregate({ fixture: FX, policy: { state: 'REQUIRED' }, evidence: [ev()],
    official: { ok: true, comprehensive: true, published_at: ago(5), retrieved_at: ago(4), rows_n: 1, game_id: 'g1' }, starters: STARTERS5, providers: {}, now: NOW });
  eq('a fresh comprehensive official report', cp.summary.coverage_class, 'COMPREHENSIVE_OFFICIAL');
  eq('every starter’s status is known', cp.summary.starters.known, 3);
  const qb = cp.players.find((p) => p.player_id === '3');
  chk('an unlisted starter is AVAILABLE, confirmed, by comprehensive silence', qb && qb.availability_status === 'AVAILABLE' && qb.is_confirmed && /COMPREHENSIVE_SILENCE/.test(qb.basis), qb);

  const stale = AG.aggregate({ fixture: FX, policy: { state: 'REQUIRED' }, evidence: [ev({ source_timestamp: ago(60) })],
    official: { ok: true, comprehensive: true, published_at: ago(60), retrieved_at: ago(59), rows_n: 1, game_id: 'g1' }, starters: STARTERS5, providers: {}, now: NOW });
  eq('an official report past 48h is STALE_CARRIED', stale.summary.coverage_class, 'STALE_CARRIED');
  chk('and stale silence clears nobody', stale.summary.starters.known < 3, stale.summary.starters);

  const other = AG.aggregate({ fixture: FX, policy: { state: 'NOT_DUE_YET' }, evidence: [ev({ game_id: 'g0', source_timestamp: ago(150) }),
    ev({ game_id: 'g0', player_id: '2', player_name: 'Corner', availability_status: 'SEASON_OUT', source_timestamp: ago(150) })],
    official: null, starters: STARTERS5, providers: {}, now: NOW });
  eq('last week’s report for another fixture does not grade this one', other.summary.coverage_class, 'STALE_CARRIED');
  chk('but a season-ending designation carries', other.players.some((p) => p.player_id === '2' && p.availability_status === 'SEASON_OUT'), other.players);
  chk('while an ordinary OUT from another game does not', !other.players.some((p) => p.player_id === '1'), other.players);

  const hist = AG.aggregate({ fixture: FX, policy: { state: 'NOT_REQUIRED_FOR_THIS_GAME' }, evidence: [ev({ provider: 'espn_core_injuries', source_type: 'SECONDARY_STRUCTURED', game_id: null, source_timestamp: '2020-11-21T18:31:00Z' })],
    official: null, starters: STARTERS5, providers: {}, now: NOW });
  eq('a 2020 row is refused as HISTORICAL', hist.summary.refused.HISTORICAL, 1);
  eq('and is not a current read', hist.summary.coverage_class, 'NOT_REQUIRED');

  const cf = AG.aggregate({ fixture: FX, policy: { state: 'REQUIRED' }, evidence: [ev({ availability_status: 'OUT', source: 'A' }), ev({ availability_status: 'QUESTIONABLE', source: 'B' })],
    official: null, starters: STARTERS5, providers: {}, now: NOW });
  const c1 = cf.players.find((p) => p.player_id === '1');
  chk('same tier, same time, different words: UNKNOWN and a published conflict', c1.availability_status === 'UNKNOWN' && c1.conflict && c1.conflicts.length === 1, c1);

  const later = AG.aggregate({ fixture: FX, policy: { state: 'REQUIRED' }, evidence: [ev({ availability_status: 'OUT', source_timestamp: ago(20) }), ev({ availability_status: 'PROBABLE', source_timestamp: ago(2) })],
    official: null, starters: STARTERS5, providers: {}, now: NOW });
  chk('same tier, the later filing wins, and the earlier one stays on the record', later.players[0].availability_status === 'PROBABLE' && later.players[0].conflicts.length === 1, later.players[0]);

  const op = AG.aggregate({ fixture: FX, policy: { state: 'REQUIRED' }, evidence: [ev({ availability_status: 'OUT' }),
    ev({ provider: 'operator_overrides', source_type: 'MANUAL_VERIFIED_OVERRIDE', availability_status: 'AVAILABLE', source_timestamp: ago(6), game_id: 'g1' })],
    official: null, starters: STARTERS5, providers: {}, now: NOW });
  eq('a manual verified override outranks an official report', op.players[0].availability_status, 'AVAILABLE');

  const fcs = AG.aggregate({ fixture: Object.assign({}, FX, { is_fbs: false }), policy: {}, evidence: [], official: null, starters: [], providers: {}, now: NOW });
  eq('an FCS side with no source: NO_SOURCE, coverage 0', fcs.summary.coverage_score, 0);
}

/* ======================================================================== */
section('6 · the QB resolver: hierarchy, conflicts, and labels that are not probabilities');
function usage(name, id, share, h) { return { kind: 'GAME_USAGE', player_id: id, player_name: name, source: 'plays', published_at: ago(h || 100), retrieved_at: ago(3), detail: Math.round(share * 40) + ' of 40 dropbacks in week 4', week: 4, stale: false }; }
function projn(name, id) { return { kind: 'PROJECTION', player_id: id, player_name: name, source: 'EPIR', published_at: ago(10), retrieved_at: ago(10), stale: false }; }
function recOf(ev0, o) { return Object.assign({ player_id: ev0[0].player_id, player_name: ev0[0].player_name, status: 'PREVIOUS_GAME', evidence: ev0, history: [], competition: null }, o || {}); }
const res = (o) => RES.resolve(Object.assign({ team_key: 't', team_name: 'Team', game_id: 'g1', kickoff: KICK, now: NOW, operator: [], availability: null, quality: [] }, o));
{
  const agree = res({ record: recOf([usage('A', '1', 0.95), projn('A', '1')]) });
  chk('observed start and quality ranking agree: EXPECTED, no conflict', agree.confirmation_level === 'EXPECTED' && !agree.conflict && agree.agreement === 1, agree);
  chk('no conflicting source is still not CONFIRMED', agree.confirmation_level !== 'CONFIRMED');

  const dec = res({ record: recOf([usage('A', '1', 0.95), projn('B', '2')]) });
  chk('a decisive observed start outranks EdgeDesk’s own ranking: conflict detected AND resolved',
    dec.conflict && dec.conflict_resolved && dec.resolution === 'OBSERVED_OVER_MODEL' && dec.player_name === 'A' && dec.confirmation_level === 'EXPECTED', dec);
  chk('both sides of the disagreement are published', dec.conflicting_sources.length === 1 && dec.conflicting_sources[0].player_name === 'B');
  chk('agreement is the weight that named the starter', dec.agreement > 0.5 && dec.agreement < 1, dec.agreement);

  const nd = res({ record: recOf([usage('A', '1', 0.5), projn('B', '2')]) });
  eq('a split start against the ranking cannot be settled: CONFLICTED', nd.confirmation_level, 'CONFLICTED');

  const t1 = res({ record: recOf([usage('A', '1', 0.95)]), operator: [{ kind: 'STARTER', player: 'B', player_id: '2', confirmed: true, source_name: 'Team release', published_at: ago(8), recorded_at: ago(7) }] });
  chk('fresh Tier 1 beats Tier 5, resolved by AUTHORITY, CONFIRMED', t1.player_name === 'B' && t1.resolution === 'AUTHORITY' && t1.confirmation_level === 'CONFIRMED', t1);
  eq('an announcement has no calibrated probability: null, never the label', t1.starter_probability, null);

  const t1stale = res({ record: recOf([usage('A', '1', 0.95)]), operator: [{ kind: 'STARTER', player: 'B', player_id: '2', confirmed: true, source_name: 'Team release', published_at: ago(200), recorded_at: ago(199) }] });
  eq('a STALE Tier 1 does not override a fresh observation', t1stale.player_name, 'A');

  const two = res({ record: null, operator: [{ kind: 'STARTER', player: 'A', player_id: '1', confirmed: true, source_name: 'Team', published_at: ago(30), recorded_at: ago(30) },
    { kind: 'STARTER', player: 'B', player_id: '2', confirmed: true, source_name: 'Team', published_at: ago(5), recorded_at: ago(5) }] });
  chk('two Tier-1 filings hours apart: the later one wins', two.player_name === 'B' && two.resolution === 'LATER_FILING', two);

  eq('no evidence: UNKNOWN', res({ record: null }).confirmation_level, 'UNKNOWN');
  const st = res({ record: recOf([Object.assign(usage('A', '1', 0.95, 900), { stale: true })]) });
  chk('only stale evidence: UNKNOWN, with the last known name as context', st.confirmation_level === 'UNKNOWN' && st.player_name === null && st.last_known && st.last_known.player_name === 'A', st);
  const notime = res({ record: recOf([Object.assign(usage('A', '1', 0.95), { published_at: null, stale: false })]) });
  chk('a start with no kickoff time is judged by the starter layer’s week rule, not called unknown', notime.confirmation_level === 'EXPECTED', notime);

  const out = res({ record: recOf([usage('A', '1', 0.95), usage('B', '2', 0.05)]), availability: { byId: { 1: { availability_status: 'OUT', freshness: 'FRESH', basis: 'report' } }, summary: null } });
  chk('a ruled-out starter hands the job to the next name the evidence supports', out.player_name === 'B' && out.resolution === 'INJURY' && out.handed_from.player_name === 'A', out);
  const q = res({ record: recOf([usage('A', '1', 0.95)]), availability: { byId: { 1: { availability_status: 'QUESTIONABLE', freshness: 'FRESH' } }, summary: null } });
  eq('a starter listed questionable is UNCERTAIN', q.confirmation_level, 'UNCERTAIN');

  const QBC = require(path.join(ROOT, 'football', 'matchup', 'qb_context.js'));
  const per = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'starters', 'persistence.json'), 'utf8'));
  const cal = res({ record: recOf([usage('A', '1', 0.95)], { history: [{ week: 4, starter: { player_id: '1', player_name: 'A', share: 0.95 } }] }), persistence: per, qbc: QBC });
  chk('a previous-game start carries the CALIBRATED persistence rate, and says where it came from', typeof cal.starter_probability === 'number' && /measured/.test(cal.probability_basis), cal);
}

/* ======================================================================== */
section('7 · player impact: an unrated player is not a replacement-level player');
{
  const lt = IMP.importance({ pos: 'OL', projected_starter: true, slot: 'OL1' });
  eq('a starting tackle is CRITICAL', lt.category, 'CRITICAL');
  eq('a starting running back is MEANINGFUL', IMP.importance({ pos: 'RB', projected_starter: true, slot: 'RB' }).category, 'MEANINGFUL');
  eq('a depth lineman is DEPTH', IMP.importance({ pos: 'OL', role: 'DEPTH' }).category, 'DEPTH');
  eq('no position, no placement: UNKNOWN', IMP.importance({}).category, 'UNKNOWN');
  const a = IMP.assessTeam({ players: [{ player_id: '1', player_name: 'Tackle', position: 'OL', availability_status: 'OUT' }, { player_id: '9', player_name: 'Rated WR', position: 'WR', availability_status: 'OUT' }],
    roster_roles: { 1: { pos: 'OL', slot: 'OL1', role: 'STARTER', starter: true, rating_known: false }, 9: { pos: 'WR', slot: 'WR1', role: 'STARTER', starter: true, rating_known: true } },
    personnel: { absences: [{ player_id: '9', impact_if_absent: 30 }], unrated: [{ player_id: '1', missing: ['player_quality'] }] } });
  const t = a.absences.find((x) => x.player_id === '1'), w = a.absences.find((x) => x.player_id === '9');
  chk('an unrated starting tackle’s impact is UNKNOWN, not 0', t.impact_status === 'UNKNOWN' && t.impact_if_absent === null, t);
  chk('a rated absence carries its measured impact', w.impact_status === 'KNOWN' && w.impact_if_absent === 30, w);
  eq('and the unknown one costs certainty at the starter rate', a.summary.unknown_impact_cost, 0.5);
  const tf = { key: 't', units: { groups: { QB: { projected: [{ key: 'a:1', name: 'Q', slot: 1, role: 'STARTER' }] }, OL: { projected: [{ key: 'a:2', name: 'L', slot: 1 }] } } },
    players: [{ id: '1', cn: 300, q: [0, 0, 0, 0, 0.5] }, { id: '2', cn: 0, q: [0, 0, 0, 0, 0] }] };
  const pj = STARTERS.project(tf), cv = STARTERS.coverage(pj);
  chk('an unfilled starter slot is counted as an unrated starter', cv.starters.total === 24 && pj.unfilled.length === 22, { t: cv.starters.total, u: pj.unfilled.length });
  chk('a lineman with no measured production is not rated', pj.starters.find((p) => p.player_id === '2').rating_known === false);
}

/* ======================================================================== */
section('8 · the FCS bridge recovers a known truth on EdgeDesk’s scale');
{
  /* synthetic: 30 FCS teams in 3 conferences with known ratings, 20 FBS
     anchors; FCS-vs-FCS and cross-division games with noise */
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const gauss = () => { const u = Math.max(1e-9, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const truth = {}, conf = {}, anchors = {};
  const cm = { A: -15, B: -25, C: -35 };
  for (let i = 0; i < 30; i++) { const c = ['A', 'B', 'C'][i % 3]; truth['f' + i] = cm[c] + 6 * gauss(); conf['f' + i] = c; }
  for (let j = 0; j < 20; j++) anchors['b' + j] = 10 * gauss();
  const games = [];
  for (let k = 0; k < 400; k++) {
    const a = 'f' + Math.floor(rnd() * 30), b = 'f' + Math.floor(rnd() * 30);
    if (a === b) continue;
    const m = truth[a] - truth[b] + 3.2 + 10 * gauss();
    games.push({ home: a, away: b, home_fbs: false, away_fbs: false, neutral: false, home_points: 30 + m / 2, away_points: 30 - m / 2 });
  }
  for (let k = 0; k < 150; k++) {
    const f = 'f' + (k % 30), bb = 'b' + (k % 20);
    const m = anchors[bb] - truth[f] + 3.2 + 10 * gauss();
    games.push({ home: bb, away: f, home_fbs: true, away_fbs: false, neutral: false, home_points: 40 + m / 2, away_points: 40 - m / 2 });
  }
  const fit = B.fit({ games, anchors, conference: conf, estimate: true, hyper: { sigma: 14.9, hfa: 3.2, cap: 60 } });
  const errs = Object.keys(truth).map((k) => fit.teams[k].rating - truth[k]);
  const bias = errs.reduce((s, v) => s + v, 0) / errs.length;
  const rmse = Math.sqrt(errs.reduce((s, v) => s + v * v, 0) / errs.length);
  chk('the FCS block lands on the FBS scale (no offset): |bias| < 2', Math.abs(bias) < 2, { bias });
  chk('team ratings recovered within a few points', rmse < 4.5, { rmse });
  chk('the game noise is estimated, not assumed (truth 10)', fit.hyper.sigma > 7 && fit.hyper.sigma < 13, fit.hyper);
  const few = Object.keys(fit.teams).sort((a, b) => fit.teams[a].games - fit.teams[b].games)[0];
  const many = Object.keys(fit.teams).sort((a, b) => fit.teams[b].games - fit.teams[a].games)[0];
  chk('more games, tighter rating', fit.teams[many].sd < fit.teams[few].sd, { few: fit.teams[few], many: fit.teams[many] });
  const pr = B.carryPrior(fit, 0.75, fit.hyper.tau);
  const f2 = B.fit({ games: [], conference: conf, prior: pr, hyper: fit.hyper });
  chk('a carried prior regresses toward the conference and widens', Object.keys(truth).every((k) => f2.teams[k].sd > fit.teams[k].sd), null);
}

/* ======================================================================== */
section('9 · market consensus: one quote is not a consensus');
{
  const now = NOW;
  const c = MC.consensus({ books: [-3, -3, -3.5, -3, -2.5].map((v, i) => ({ book: 'b' + i, spread: v, spread_price: -110, total: 51, ml_home: -150, ml_away: 130, timestamp: now - 4 * 60e3 })) }, now);
  eq('the modal line is the consensus', c.consensus_spread, -3);
  eq('five books, one off by a half: dispersion LOW', c.market_dispersion.level, 'LOW');
  eq('STRONG', c.market_quality_grade, 'STRONG');
  chk('the mean is published as NOT used', c.mean_spread_not_used === -3);
  const one = MC.consensus({ books: [{ book: 'x', spread: -3, timestamp: now - 120 * 60e3 }] }, now);
  chk('one quote: not a consensus, THIN', !one.is_consensus && one.market_quality_grade === 'THIN' && /not a consensus/.test(one.summary), one.summary);
  const out = MC.consensus({ books: [-3, -3, -3, -3, -7].map((v, i) => ({ book: 'b' + i, spread: v })) }, now);
  chk('an off-market book is an outlier', out.outlier_books.length === 1 && out.outlier_books[0].spread === -7, out.outlier_books);
  const pts = MC.consensus({ points: [{ side: 'home', line: -3, n_books: 4 }, { side: 'home', line: -3.5, n_books: 2 }, { side: 'away', line: 3, n_books: 4 }] }, now);
  eq('captured points: a book quoting both sides is counted once', pts.books_reporting, 6);
  eq('no quote: NO MARKET, never a zero line', MC.consensus({}, now).consensus_spread, null);
  const bh = c.best_available.home, ba = c.best_available.away;
  chk('best available per side', bh.line === -2.5 && ba.line === 3.5, c.best_available);
}

/* ======================================================================== */
section('10 · reliability read from an evidence package');
function qbInfo(who, ident, avail) {
  return { available: true, value: 0.9, confidence: 0.9, components: { who_starts: { value: who }, identity: { value: ident }, observed: { value: 1 }, available: { value: avail } } };
}
function term(key, points, confidence) { return { key, label: key, points, available: true, confidence, source: 'fixture' }; }
function projection() {
  const terms = [term('rating', 3.3, 1), term('hfa', 2.5, 0.95), term('matchup', 0.4, 0.9), term('qb', 0, 0.2)];
  terms[3].available = false;
  const m = 6.2;
  return { status: 'PREDICTED', prediction_timestamp: ago(0.5), game: { home: 'Ohio State', away: 'Penn State' },
    model: { fair_spread: m, home_win_prob: 0.66, away_win_prob: 0.34, sigma_margin: 14.9, median_margin: m, p10_margin: m - 19, p90_margin: m + 19, display_side: 'home' },
    scores: { confidence: 84 }, contributions: terms,
    layers: { qb: { information: { home: qbInfo(0.907, 1, 0), away: qbInfo(0.907, 1, 0) } }, strength: { preseason_blend: { prior_weight: 0.6, games_played: 6 } } } };
}
function row(field, side, state, o) { return Object.assign({ field, side: side || null, state, source: 'fixture', as_of: ago(2), observed_at: ago(2), detail: null }, o || {}); }
function contract() {
  const rows = [row('venue_geography', 'home', 'USABLE', { detail: 'Ohio Stadium' }), row('venue_geography', 'away', 'USABLE'), row('weather', null, 'RESEARCH_ONLY'),
    row('matchup_profile', null, 'USABLE'), row('schedule_context', 'home', 'USABLE'), row('schedule_context', 'away', 'USABLE')];
  ['home', 'away'].forEach((s) => rows.push(row('roster', s, 'USABLE'), row('availability', s, 'USABLE'), row('roster_talent', s, 'USABLE', { detail: 'at confidence 0.6' }),
    row('qb_starter', s, 'RESEARCH_ONLY', { observed_at: ago(100) }), row('qb_availability', s, 'UNAVAILABLE'), row('qb_efficiency_history', s, 'RESEARCH_ONLY'), row('team_rating', s, 'USABLE')));
  return rows;
}
function input(evidence) {
  return { now: NOW, game: { game_id: 'g1', home: 'Ohio State', away: 'Penn State', kickoff: KICK, neutral_site: false, venue: 'Ohio Stadium', home_fbs: true, away_fbs: true,
    home_team_id: 'ohiostate', away_team_id: 'pennstate', home_conference_id: 'bigten', away_conference_id: 'bigten', matchup_type: 'conference' },
    projection: projection(), contract: contract(),
    starters: { home: { status: 'PREVIOUS_GAME', player_id: '10', player_name: 'Home QB', conflicts: [], published_at: ago(100), retrieved_at: ago(3) },
      away: { status: 'PREVIOUS_GAME', player_id: '20', player_name: 'Away QB', conflicts: [], published_at: ago(100), retrieved_at: ago(3) } },
    qb_epa: { home: { identity: { kind: 'LAST_GAME_PROXY', contested: false } }, away: { identity: { kind: 'LAST_GAME_PROXY', contested: false } } },
    personnel: { home: { status: 'NO_ABSENCES_ON_FILE', coverage: { comprehensive: true, official: true } }, away: { status: 'NO_ABSENCES_ON_FILE', coverage: { comprehensive: true, official: true } } },
    team_quality: { home: { gates: [] }, away: { gates: [] } }, roster_talent: { home: { confidence: 0.6 }, away: { confidence: 0.6 } },
    venues: { home: { lat: 40, lon: -83 }, away: { lat: 40.8, lon: -77.9 } }, market: { joined: false },
    model_state: { built_at: ago(1) },
    blend: { home: { games_played: 6, prior_weight: 0.6, carried: 18.4, this_season: 17.9 }, away: { games_played: 6, prior_weight: 0.6, carried: 15, this_season: 14.6 } },
    params: P, evidence: evidence || null };
}
function qbEv(o) {
  return Object.assign({ player_id: '10', player_name: 'Home QB', status: 'AVAILABLE', status_fresh: true, status_basis: 'COMPREHENSIVE_SILENCE', starter_probability: 0.907,
    probability_basis: 'measured', confirmation_level: 'EXPECTED', contested: false, conflict: false, conflict_resolved: null, resolution: null,
    resolution_text: null, agreement: 1, sources_n: 2, reasoning_codes: [] }, o || {});
}
function avEv(cls, o) { return Object.assign({ coverage_class: cls, coverage_score: C.AVAIL_COVERAGE[cls], coverage_reason: cls + ' fixture', as_of: ago(5), official: null,
  starters: { total: 24, known: 24, unknown: 0 } }, o || {}); }
function pkg(o) {
  o = o || {};
  return { schema: GE.SCHEMA, game_id: 'g1', built_at: ago(0.5),
    quarterback: { home: qbEv(o.qh), away: qbEv(Object.assign({ player_id: '20', player_name: 'Away QB' }, o.qa || {})) },
    availability: { home: avEv(o.ah || 'COMPREHENSIVE_OFFICIAL'), away: avEv(o.aa || 'COMPREHENSIVE_OFFICIAL') },
    impact: { home: o.ih || { absences: 0, unknown_impact: 0, unknown_impact_important: 0, unknown_impact_cost: 0 }, away: o.ia || { absences: 0, unknown_impact: 0, unknown_impact_important: 0, unknown_impact_cost: 0 } },
    team_data: o.td || { home: { is_fbs: true, fcs: null }, away: { is_fbs: true, fcs: null } }, conflicts: [], missing: [], stale: [] };
}
{
  const v2 = R.score(input(null));
  chk('without a package, the v2 scorer is unchanged: a known starter nobody cleared is capped at 89', v2.capped_by.indexOf('QB_STATUS_UNCONFIRMED') >= 0 && v2.score <= 89, v2.capped_by);
  const good = R.score(input(pkg()));
  chk('a comprehensive official report that does not list the QB establishes he can play: the cap lifts',
    good.gates.every((g) => g.id !== 'QB_STATUS_UNCONFIRMED') && good.score > v2.score, { v2: v2.score, ev: good.score, gates: good.gates });
  chk('the evidence is declared on the result', good.evidence.used === true);
  chk('potential reliability is published and never below the score', good.potential && good.potential.score >= good.score, good.potential);

  const pf = R.score(input(pkg({ ah: 'PROVIDER_FAILED', qh: { status: 'UNKNOWN', status_fresh: null, status_basis: null } })));
  const nq = pf.components.roster_availability.items.find((i) => i.id === 'non_qb_home');
  chk('provider failure: the availability item earns nothing and names the failure', nq.earned === 0 && /PROVIDER_FAILED/.test(nq.reason), nq);
  chk('and QB status is not established by a failure', pf.gates.some((g) => g.id === 'QB_STATUS_UNCONFIRMED'), pf.gates);

  const unk = R.score(input(pkg({ qh: { confirmation_level: 'UNKNOWN', player_id: null, player_name: null, status: 'UNKNOWN', starter_probability: null } })));
  chk('the resolver found nobody: QB_UNKNOWN, even though the engine had a rate', unk.gates.some((g) => g.id === 'QB_UNKNOWN'), unk.gates);

  const conf = R.score(input(pkg({ qh: { confirmation_level: 'CONFLICTED', conflict: true, conflict_resolved: false, resolution: 'UNRESOLVED', resolution_text: 'A vs B', agreement: 0.5 } })));
  const cg = conf.gates.find((g) => g.id === 'QB_CONFLICTED');
  chk('an unresolved QB conflict: QB_CONFLICTED at the contested cap', cg && cg.cap === R.CONFIG.caps.qb_contested && conf.score <= R.CONFIG.caps.qb_contested, conf.gates);

  const res1 = R.score(input(pkg({ qh: { conflict: true, conflict_resolved: true, resolution: 'OBSERVED_OVER_MODEL', resolution_text: 'A over the ranking', agreement: 0.667 } })));
  chk('a resolved disagreement is not capped, and costs only the dissenting weight',
    !res1.gates.some((g) => /QB_CONF|QB_CONTESTED/.test(g.id)) && res1.components.source_integrity.score < good.components.source_integrity.score, res1.gates);

  const q = R.score(input(pkg({ qh: { status: 'QUESTIONABLE' } })));
  chk('a QB listed questionable lowers the identity item', q.components.roster_availability.score < good.components.roster_availability.score);

  const ukn = R.score(input(pkg({ ih: { absences: 2, unknown_impact: 2, unknown_impact_important: 2, unknown_impact_cost: 1.0 } })));
  chk('absences with UNKNOWN impact cost certainty, never zero', ukn.components.roster_availability.score < good.components.roster_availability.score
    && ukn.penalties.some((p) => /UNKNOWN impact/.test(p.reason)), ukn.penalties.slice(0, 3));

  /* the FCS bridge */
  function fcsIn(fx) {
    const i = input(pkg({ aa: 'NO_SOURCE', td: { home: { is_fbs: true }, away: { is_fbs: false, fcs: fx } }, qa: { player_id: '20', status: 'UNKNOWN', status_fresh: null } }));
    i.game.away_fbs = false; i.game.matchup_type = 'fbs_fcs';
    i.contract = i.contract.map((x) => x.field === 'team_rating' && x.side === 'away' ? row('team_rating', 'away', 'UNAVAILABLE', { detail: 'outside the rated FBS field' }) : x);
    i.blend.away = { basis: 'FCS bucket', value: -28, prior_weight: 1, carried: -28, this_season: -28, games_played: null };
    return i;
  }
  const thin = R.score(fcsIn(null));
  const weak = R.score(fcsIn({ team_rating: -21, rating_sd: 6.5, confidence: 'WEAK', games_sample: 10, bridge_sample: 1, floor: -28 }));
  chk('a WEAK bridged rating keeps THIN DATA, and the reason cites the evidence', weak.capped_by.indexOf('THIN_DATA') >= 0
    && weak.penalties.some((p) => /bridged rating is -21/.test(p.reason)), weak.penalties.slice(0, 2));
  const strong = R.score(fcsIn({ team_rating: -27, rating_sd: 3.5, confidence: 'STRONG', games_sample: 14, bridge_sample: 3, completeness: 0.9, floor: -28 }));
  chk('a STRONG rating that corroborates the priced floor escapes THIN DATA', strong.gates.every((g) => g.id !== 'THIN_DATA'), strong.gates);
  const far = R.score(fcsIn({ team_rating: -5, rating_sd: 3.5, confidence: 'STRONG', games_sample: 14, bridge_sample: 3, floor: -28 }));
  chk('a STRONG rating that CONTRADICTS the floor keeps THIN DATA: a measured error is not a fix', far.gates.some((g) => g.id === 'THIN_DATA'), far.gates);
  chk('the priced floor’s measured error drives the perturbation: tighter when it fits, wider when it does not',
    strong.stability.projection_stability_sd < thin.stability.projection_stability_sd && far.stability.projection_stability_sd > thin.stability.projection_stability_sd,
    { strong: strong.stability.projection_stability_sd, thin: thin.stability.projection_stability_sd, far: far.stability.projection_stability_sd });

  /* the evidence never touches the projection */
  const i0 = input(pkg()), before = JSON.stringify(i0.projection);
  R.score(i0);
  eq('scoring from evidence leaves the projection byte-identical', JSON.stringify(i0.projection), before);
  const same = Object.keys(GE.CLASS_TO_STATE).every((k) => GE.CLASS_TO_STATE[k] === R.EVIDENCE_CLASS_TO_STATE[k])
    && Object.keys(R.EVIDENCE_CLASS_TO_STATE).length === Object.keys(GE.CLASS_TO_STATE).length;
  chk('the scorer and the package read ONE class-to-state map', same);
  chk('every coverage class has a coverage score (or is not applicable)', Object.keys(GE.CLASS_TO_STATE).every((k) => k in C.AVAIL_COVERAGE));
  chk('recoverable points are published by family', good.recoverable_by_family && typeof good.recoverable_by_family === 'object');
  const v = GE.view(Object.assign(pkg(), { player_quality: { game: { offense_pct: 45, defense_pct: 36, starters_pct: 40, key_pct: 38 } } }), good, { home: 'Ohio State', away: 'Penn State' });
  chk('the DATA COVERAGE view: team data, QB, availability, player quality, environment, market, stability',
    ['team_data', 'qb', 'availability', 'player_quality', 'environment', 'market', 'stability'].every((k) => v.rows.some((r) => r.key === k)), v.rows.map((r) => r.key));
  chk('potential reliability rides along, labelled as not a probability', v.potential && GE.viewText(v).some((l) => /not a probability/.test(l)));
}

/* ======================================================================== */
section('11 · the ROI planner and the self-audit');
{
  const rows = [{ game_id: 'a', reliability: { score: 70, potential: { score: 85 }, recoverable_by_family: { availability: 10, fcs_rating: 2 },
    penalties: [{ points: 6, family: 'availability', action_key: 'availability:home' }, { points: 3, family: 'qb_status', action_key: 'availability:home' }, { points: 4, action_key: 'fcs_rating', family: null }] } },
    { game_id: 'b', reliability: { score: 80, potential: { score: 84 }, recoverable_by_family: { availability: 4 }, penalties: [{ points: 4, family: 'availability', action_key: 'availability:away' }] } }];
  const pl = ROI.plan(rows, { market: { under_two_sources: 2 } });
  const av = pl.families.find((f) => f.key === 'availability');
  chk('availability: games, points lost (both symptoms), maximum recoverable', av.games_affected === 2 && av.current_points_lost === 13 && av.maximum_recoverable_points === 14, av);
  chk('ranked by ROI = estimated / cost', av.engineering_priority === 1 && av.enrichment_roi === Math.round(100 * av.estimated_recoverable_points / av.cost) / 100, pl.families);
  chk('market depth listed, and says why it has no points in the published build', pl.families.some((f) => f.key === 'market_sources' && /not scored in the published build/.test(f.note)));
  eq('the mean potential', pl.potential.mean_potential, 84.5);
  const rel1 = { generated_at: 't1', games: { a: { game_id: 'a', home: 'H', away: 'A', matchup_type: 'conference', reliability: { score: 69, grade: 'CAUTION', penalties: [{ points: 5, family: 'qb_status' }], gates: [] } } } };
  const rel2 = { generated_at: 't2', games: { a: { game_id: 'a', home: 'H', away: 'A', matchup_type: 'conference', reliability: { score: 75, grade: 'ADEQUATE', penalties: [{ points: 0.5, family: 'qb_status' }], gates: [] } } } };
  const s1 = AUDIT.snapshot(rel1, null), s2 = AUDIT.snapshot(rel2, null);
  eq('a count only evidence can supply is NOT MEASURED without it, never 0', s1.counts.missing_qb_status, null);
  const d = AUDIT.compare(s1, s2);
  chk('WHAT IMPROVED names the grade move', d.improved.some((x) => /CAUTION → ADEQUATE/.test(x)), d.improved);
  chk('WHY names the family that moved it', d.why.some((x) => /qb_status/.test(x)), d.why);
  chk('a not-measured count is not reported as a change', d.degraded.every((x) => !/QB statuses missing/.test(x)), d.degraded);
}

/* ======================================================================== */
section('12 · the committed artifacts agree with each other');
{
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (_) { return null; } };
  const E = read('football/enrichment/current.json'), S = read('football/fbs/slate.json'), F = read('football/enrichment/fcs_ratings.json');
  if (E && S) {
    const ids = new Set(S.games.map((g) => String(g.game_id)));
    const inE = Object.keys(E.games);
    chk('every evidence package belongs to a slate game (or is a frozen pregame package)', inE.every((id) => ids.has(id)), inE.filter((id) => !ids.has(id)).slice(0, 5));
    chk('every package carries the ten sections', inE.every((id) => { const pk = GE.forGame(E, id);
      return ['team_data', 'quarterback', 'availability', 'impact', 'player_quality', 'source_health', 'conflicts', 'missing', 'stale', 'market'].every((k) => k in pk); }));
    chk('no package claims a QB is CONFIRMED without Tier-1 evidence', inE.every((id) => ['home', 'away'].every((s) => {
      const q = E.games[id].quarterback[s];
      return q.confirmation_level !== 'CONFIRMED' || (q.sources || []).some((x) => x.tier === 1 && x.agrees && x.fresh);
    })));
    chk('a PROVIDER_FAILED side never lists an AVAILABLE starter count', inE.every((id) => ['home', 'away'].every((s) => {
      const a = E.games[id].availability[s];
      return a.coverage_class !== 'PROVIDER_FAILED' || a.starters.known === 0;
    })));
    chk('provider states are from the published vocabulary', Object.values(E.providers).every((p) => C.HEALTH.indexOf(p.state) >= 0), Object.values(E.providers).map((p) => p.state));
  } else chk('the committed enrichment and slate artifacts exist', false, { E: !!E, S: !!S });
  if (F) {
    chk('the FCS artifact is shadow-only and says why it is not promoted', /SHADOW/.test(F.status) && F.promotion.state === 'NOT_PROMOTED');
    chk('every FCS team carries rating, sd, samples, completeness and confidence', Object.values(F.teams).every((t) => t.fcs_team_rating != null && t.rating_sd > 0
      && t.fcs_games_sample >= 0 && t.fcs_fbs_bridge_sample >= 0 && t.data_completeness != null && ['STRONG', 'MODERATE', 'WEAK', 'NONE'].indexOf(t.fcs_rating_confidence) >= 0));
    chk('the walk-forward is published with its verdict', F.validation && F.validation.n > 0 && /DEMONSTRATED|ELIGIBLE/.test(F.validation.verdict));
  }
}

/* ======================================================================== */
console.log('');
if (fail) {
  failures.forEach((f) => console.log('  FAIL ' + f));
  console.log('\nFAIL | enrichment | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(1);
}
console.log('ALL GREEN ' + pass + ' passed, 0 failed');
