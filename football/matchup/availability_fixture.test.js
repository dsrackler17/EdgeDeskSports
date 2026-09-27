#!/usr/bin/env node
'use strict';

const I = require('./inputs.js');

let pass = 0, fail = 0;
function chk(name, fn, detail) {
  let ok = false, why = detail;
  try { ok = !!fn(); } catch (e) { why = e && e.stack || String(e); }
  if (ok) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.error('FAIL | ' + name + (why ? ' | ' + why : '')); }
}

function ctx(team, players) {
  return {
    availability_by_team: { texastech: team },
    availability_as_of: '2026-09-21T18:00:00Z',
    player_details_by_team: players ? {
      texastech: {
        by_name: players.by_name || {},
        groups: players.groups || {}
      }
    } : {}
  };
}
function official(gameId, o) {
  return Object.assign({
    ok: true, game_id: String(gameId), conference: 'Big 12 Conference',
    source_url: 'https://big12sports.com/', published_at: '2026-09-21T17:00:00Z',
    retrieved_at: '2026-09-21T17:05:00Z', comprehensive: true
  }, o || {});
}
function player(gameId, status, name) {
  return {
    player_name: name || 'Test Quarterback', position: 'QB', status,
    game_id: gameId == null ? null : String(gameId), source_name: 'Big 12 availability report',
    observed_at: '2026-09-21T17:00:00Z', depth_role: 'QB1'
  };
}

chk('an OUT from a prior fixture cannot leak into the current game', () => {
  const t = {
    team_name: 'Texas Tech', dataQuality: 'OFFICIAL',
    official_report: official('OLD'),
    players: [player('OLD', 'OUT')]
  };
  return I.injuriesFor(ctx(t), 'Texas Tech', 'NEW') === null;
});

chk('a comprehensive report from a prior fixture cannot become a clean current report', () => {
  const t = {
    team_name: 'Texas Tech', dataQuality: 'OFFICIAL',
    official_report: official('OLD', { report_of_no_absences: true }),
    players: []
  };
  return I.injuriesFor(ctx(t), 'Texas Tech', 'NEW') === null;
});

chk('a matching official OUT is handed to the engine', () => {
  const t = {
    team_name: 'Texas Tech', dataQuality: 'OFFICIAL',
    official_report: official('NEW'),
    players: [player('NEW', 'OUT')]
  };
  const r = I.injuriesFor(ctx(t), 'Texas Tech', 'NEW');
  return Array.isArray(r) && r.length === 1 && r[0].status === 'out'
    && r[0].player === 'Test Quarterback';
});

chk('a matching comprehensive report naming nobody is the one clean empty array', () => {
  const t = {
    team_name: 'Texas Tech', dataQuality: 'OFFICIAL',
    official_report: official('NEW', { report_of_no_absences: true }),
    players: []
  };
  const r = I.injuriesFor(ctx(t), 'Texas Tech', 'NEW');
  return Array.isArray(r) && r.length === 0;
});

chk('a matching selected report naming nobody stays unknown', () => {
  const t = {
    team_name: 'Texas Tech', dataQuality: 'OFFICIAL',
    official_report: official('NEW', { comprehensive: false, report_of_no_absences: false }),
    players: []
  };
  return I.injuriesFor(ctx(t), 'Texas Tech', 'NEW') === null;
});

chk('unscoped live evidence still carries into the current game', () => {
  const t = {
    team_name: 'Texas Tech', dataQuality: 'PARTIAL', official_report: null,
    players: [player(null, 'QUESTIONABLE', 'Live Evidence QB')]
  };
  /* dated: a team-scoped row is judged against the kickoff it is for */
  const r = I.injuriesFor(ctx(t), 'Texas Tech', 'NEW',
    { now: Date.parse('2026-09-21T20:00:00Z'), kickoff: '2026-09-26T19:00:00Z' });
  return Array.isArray(r) && r.length === 1 && r[0].status === 'questionable'
    && r[0].player === 'Live Evidence QB';
});

chk('OUT_FIRST_HALF maps to the engine 0.50 questionable state', () => {
  const t = {
    team_name: 'Texas Tech', dataQuality: 'OFFICIAL',
    official_report: official('NEW'),
    players: [player('NEW', 'OUT_FIRST_HALF')]
  };
  const r = I.injuriesFor(ctx(t), 'Texas Tech', 'NEW');
  return Array.isArray(r) && r.length === 1 && r[0].status === 'questionable'
    && I.AVAIL_TO_ENGINE.OUT_FIRST_HALF === 'questionable';
});

chk('identity enrichment uses the rated athlete and best same-group replacement', () => {
  const t = {
    team_name: 'Texas Tech', dataQuality: 'OFFICIAL',
    official_report: official('NEW'),
    players: [player('NEW', 'OUT', 'Test Quarterback')]
  };
  const starter = {
    id: '111', n: 'Test Quarterback', p: 'QB', g: 'QB',
    e: 61, cf: 0.84, role: 'STARTER', share: 0.93
  };
  const backup = {
    id: '222', n: 'Backup Quarterback', p: 'QB', g: 'QB',
    e: 54, cf: 0.70, role: 'BACKUP', share: 0.07
  };
  const r = I.injuriesFor(ctx(t, {
    by_name: { testquarterback: starter, backupquarterback: backup },
    groups: { QB: [starter, backup] }
  }), 'Texas Tech', 'NEW');
  return Array.isArray(r) && r.length === 1
    && r[0].athlete_id === '111'
    && r[0].starter === true
    && Math.abs(r[0].snap_share - 0.93) < 1e-9
    && r[0].replacement_player_id === '222'
    && r[0].replacement_quality === null
    && Math.abs(r[0].replacement_quality_research - 0.54) < 1e-9
    && r[0].player_rating === 61;
});

chk('ambiguous player identity stays generic instead of guessing', () => {
  const t = {
    team_name: 'Texas Tech', dataQuality: 'OFFICIAL',
    official_report: official('NEW'),
    players: [player('NEW', 'OUT', 'Duplicate Name')]
  };
  const r = I.injuriesFor(ctx(t, {
    by_name: { duplicatename: null },
    groups: { QB: [] }
  }), 'Texas Tech', 'NEW');
  return Array.isArray(r) && r.length === 1
    && r[0].athlete_id === null
    && r[0].snap_share === null
    && r[0].replacement_quality === null;
});

chk('officialReportForGame requires exact fixture identity', () => {
  const t = { official_report: official('401') };
  return I.officialReportForGame(t, '401') != null
    && I.officialReportForGame(t, '402') == null;
});

/* ==========================================================================
   FIXTURE-SCOPED, DATED AVAILABILITY. Three input-contract defects let
   evidence that is not about THIS game reach the priced injury list and the
   engine's QB confidence. Each group below pins one of them.
   ========================================================================== */
const path = require('path');
const C = require('./contract.js');
const OV = require('../availability/overlay.js');
const AVL = require('../availability/availability.js');
const QBC = require('./qb_context.js');
const S = require('../starters/starters.js');
const BS = require('../starters/build_starters.js');
global.window = global.window || global;
require(path.join(__dirname, '..', 'cfb_p4', 'params.js'));
const E = require('../cfb_p4/engine.js');

const KICK = '2026-09-26T19:30:00Z';
const NOW_MS = Date.parse('2026-09-25T18:00:00Z');
const OPTS = { now: NOW_MS, kickoff: KICK };
const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();

/* the automated collector's row, exactly as football/availability/current.json
   carries it: `availability_status`, a publication date, and an observed_at
   the sync stamps on every re-read */
function espnRow(name, status, publishedAt, o) {
  return Object.assign({ player_name: name, position: 'QB', depth_role: 'QB1', availability_status: status,
    source_name: 'ESPN injuries', source_type: 'REPUTABLE_MEDIA', source_url: 'https://www.espn.com/',
    source_published_at: publishedAt, observed_at: iso(NOW_MS - H) }, o || {});
}
function teamOf(players, o) {
  return Object.assign({ team_name: 'Texas Tech', dataQuality: 'PARTIAL', automated_grade: 'PARTIAL',
    official_report: null, official_reports: {}, players }, o || {});
}

/* ---- 1. historical ESPN rows never reach the priced injury list ---------- */
chk('1a a 2020 ESPN designation re-read this morning never reaches the engine', () => {
  const t = teamOf([espnRow('Old Name', 'OUT', '2020-11-21T18:31Z')]);
  return I.injuriesFor(ctx(t), 'Texas Tech', 'NEW', OPTS) === null;
});
chk('1b a graded read whose only rows are historical is unknown (null), never a clean []', () => {
  const t = teamOf([espnRow('Old Name', 'AVAILABLE', '2022-10-30T06:13Z')]);
  return I.injuriesFor(ctx(t), 'Texas Tech', 'NEW', OPTS) === null;
});
chk('1c HISTORICAL is judged against THIS kickoff: filed 8 days before it is refused though only 5 days old', () => {
  const kick = iso(NOW_MS + 3 * 24 * H);
  const t = teamOf([espnRow('Week Old', 'OUT', iso(NOW_MS - 5 * 24 * H))]);
  return I.injuriesFor(ctx(t), 'Texas Tech', 'NEW', { now: NOW_MS, kickoff: kick }) === null
    && Array.isArray(I.injuriesFor(ctx(t), 'Texas Tech', 'NEW', { now: NOW_MS, kickoff: iso(NOW_MS + 24 * H) }));
});
chk('1d a current row is kept beside a historical one, and only it', () => {
  const t = teamOf([espnRow('Old Name', 'OUT', '2020-11-21T18:31Z'),
    espnRow('Current Name', 'DOUBTFUL', iso(NOW_MS - 30 * H))]);
  const r = I.injuriesFor(ctx(t), 'Texas Tech', 'NEW', OPTS);
  return Array.isArray(r) && r.length === 1 && r[0].player === 'Current Name' && r[0].status === 'doubtful';
});
chk('1e as_of is the PUBLICATION time, not the moment a sync re-read the page', () => {
  const pub = iso(NOW_MS - 30 * H);
  const t = teamOf([espnRow('Current Name', 'OUT', pub)]);
  const r = I.injuriesFor(ctx(t), 'Texas Tech', 'NEW', OPTS);
  return r && r.length === 1 && r[0].as_of === pub && r[0].as_of !== t.players[0].observed_at;
});
chk('1f the overlay ladder is availability.js getAvailabilityFreshness, case for case', () => {
  const kicks = [null, NOW_MS + 2 * H, NOW_MS + 30 * H, NOW_MS + 5 * 24 * H];
  const ages = [null, -2, 0, 3, 7, 30, 49, 95, 97, 150, 169, 400, 1e5];
  for (const k of kicks) for (const a of ages) {
    const rec = { source_published_at: a == null ? null : iso(NOW_MS - a * H) };
    const o = { now: NOW_MS, kickoff: k == null ? null : iso(k) };
    const x = OV.freshness(rec, o), y = AVL.getAvailabilityFreshness(rec, o);
    if (x.state !== y.state || x.reason !== y.reason) throw new Error(JSON.stringify({ k, a, x, y }));
  }
  return true;
});
chk('1g a row filed FOR this game is about this game whenever it was filed (freshness is the contract\'s STALE)', () => {
  const t = { team_name: 'Texas Tech', dataQuality: 'OFFICIAL', official_report: official('NEW', { published_at: null }),
    players: [Object.assign(player('NEW', 'OUT'), { observed_at: null, source_published_at: null })] };
  const r = I.injuriesFor(ctx(t), 'Texas Tech', 'NEW', OPTS);
  return Array.isArray(r) && r.length === 1;
});

/* ---- 2. QB availability: the right field, a clock, and the state it gives - */
chk('2a the starter build reads the collector\'s availability_status', () => {
  const r = BS.availabilityRow({ player_name: 'A', availability_status: 'OUT', source_published_at: '2026-09-24T12:00Z',
    observed_at: '2026-09-25T12:00Z' }, { lastUpdated: null }, null);
  return r.status === 'OUT' && r.published_at === '2026-09-24T12:00Z' && r.retrieved_at === '2026-09-25T12:00Z';
});
const SMU_IDX = S.rosterIndex([{ athlete_id: '1001', name: 'Kevin Jennings', position: 'QB', team: 'SMU' }], { team: 'SMU' });
function resolveWith(avail) {
  return S.resolveStarter({ team: 'SMU', team_id: 'smu', season: 2026, week: 5, position: 'QB',
    evidence: [{ kind: 'GAME_USAGE', player_id: '1001', team: 'SMU', season: 2026, week: 4, source: 'fixture',
      source_url: 'https://example.invalid', published_at: iso(NOW_MS - 30 * H), retrieved_at: iso(NOW_MS - 24 * H) }],
    roster_index: SMU_IDX, availability_checked: true, availability: avail, now: NOW_MS });
}
chk('2b the starter layer refuses a report published years ago (SMU: a 2022 ESPN row)', () => {
  const r = resolveWith([{ player_id: null, player_name: 'Kevin Jennings', status: 'AVAILABLE',
    source: 'ESPN injuries', published_at: '2022-10-30T06:13Z', retrieved_at: iso(NOW_MS - H) }]);
  return r.availability.evidence === 'NONE' && r.availability.state === 'UNKNOWN' && r.availability.historical === true;
});
chk('2c a report that names him with no designation is not EXPLICIT', () => {
  const r = resolveWith([{ player_id: '1001', player_name: 'Kevin Jennings', status: null,
    source: 'ESPN injuries', published_at: iso(NOW_MS - 6 * H), retrieved_at: iso(NOW_MS - H) }]);
  return r.availability.evidence === 'NONE';
});
chk('2d a current designation stays EXPLICIT with its state', () => {
  const r = resolveWith([{ player_id: '1001', player_name: 'Kevin Jennings', status: 'QUESTIONABLE',
    source: 'official report', published_at: iso(NOW_MS - 6 * H), retrieved_at: iso(NOW_MS - H) }]);
  return r.availability.evidence === 'EXPLICIT' && r.availability.state === 'QUESTIONABLE';
});
const QB = { player_id: '1001', player_name: 'Kevin Jennings', availability: {} };
chk('2e the contract reads this fixture\'s row for the QB: EXPLICIT with the state it gives', () => {
  const t = teamOf([espnRow('Kevin Jennings', 'OUT', iso(NOW_MS - 20 * H))]);
  const fx = C.fixtureAvailability(ctx(t), 'Texas Tech', 'NEW', { AV_OVERLAY: OV }, OPTS);
  const q = C.qbAvailabilityFor(ctx(t), 'Texas Tech', 'NEW', QB, fx, { AV_OVERLAY: OV });
  return q.evidence === 'EXPLICIT' && q.state === 'OUT';
});
chk('2f a historical row naming the QB is not evidence about this game', () => {
  const t = teamOf([espnRow('Kevin Jennings', 'AVAILABLE', '2022-10-30T06:13Z')]);
  const fx = C.fixtureAvailability(ctx(t), 'Texas Tech', 'NEW', { AV_OVERLAY: OV }, OPTS);
  return C.qbAvailabilityFor(ctx(t), 'Texas Tech', 'NEW', QB, fx, { AV_OVERLAY: OV }).evidence === 'NONE';
});
chk('2g the starter record\'s stale EXPLICIT/UNKNOWN (the committed SMU record) is refused', () => {
  const rec = { player_id: '1001', player_name: 'Kevin Jennings', availability: { state: 'UNKNOWN', evidence: 'EXPLICIT',
    source: 'ESPN injuries', published_at: '2022-10-30T06:13Z', retrieved_at: iso(NOW_MS - H) } };
  const t = teamOf([]);
  const fx = C.fixtureAvailability(ctx(t), 'Texas Tech', 'NEW', { AV_OVERLAY: OV }, OPTS);
  const q1 = C.qbAvailabilityFor(ctx(t), 'Texas Tech', 'NEW', rec, fx, { AV_OVERLAY: OV });
  const rec2 = JSON.parse(JSON.stringify(rec)); rec2.availability.state = 'AVAILABLE';
  const q2 = C.qbAvailabilityFor(ctx(t), 'Texas Tech', 'NEW', rec2, fx, { AV_OVERLAY: OV });
  return q1.evidence === 'NONE' && q2.evidence === 'NONE' && /historical/.test(q2.why);
});
const FRESH = { published_at: iso(NOW_MS - 20 * H), retrieved_at: iso(NOW_MS - 19 * H) };
function filedTeam(off, rows) {
  return { team_name: 'Texas Tech', dataQuality: 'OFFICIAL', automated_grade: 'LIMITED',
    official_reports: { NEW: off }, official_report: off, players: rows };
}
function qbOn(t) {
  const fx = C.fixtureAvailability(ctx(t), 'Texas Tech', 'NEW', { AV_OVERLAY: OV }, OPTS);
  return C.qbAvailabilityFor(ctx(t), 'Texas Tech', 'NEW', QB, fx, { AV_OVERLAY: OV });
}
chk('2h COMPREHENSIVE_SILENCE when this game\'s comprehensive filing lists others but not the QB', () => {
  const q = qbOn(filedTeam(official('NEW', Object.assign({ names: 2 }, FRESH)),
    [player('NEW', 'OUT', 'Some Linebacker'), player('NEW', 'QUESTIONABLE', 'Some Receiver')]));
  return q.evidence === 'COMPREHENSIVE_SILENCE' && q.state === 'AVAILABLE';
});
chk('2h\' silence is read only from a FRESH filing (the aggregator\'s 48h), never a 97-hour-old one', () => {
  const q = qbOn(filedTeam(official('NEW', { names: 1 }), [player('NEW', 'OUT', 'Some Linebacker')]));
  return q.evidence === 'NONE' && /hours old/.test(q.why);
});
chk('2h\'\' a filing that NAMES him with a designation EdgeDesk cannot read is not silence', () => {
  const q = qbOn(filedTeam(official('NEW', Object.assign({ names: 1 }, FRESH)), [player('NEW', 'NOT_LISTED', 'Kevin Jennings')]));
  return q.evidence === 'NONE' && /cannot read/.test(q.why);
});
chk('2h\'\'\' a filing with lines the parser could not read is not silence (one of them may be him)', () => {
  const q = qbOn(filedTeam(official('NEW', Object.assign({ names: 1, unparsed: 2 }, FRESH)), [player('NEW', 'OUT', 'Some Linebacker')]));
  return q.evidence === 'NONE' && /could not be read/.test(q.why);
});
chk('2i no silence from a comprehensive filing for ANOTHER game, nor from a selective one for this game', () => {
  const other = { team_name: 'Texas Tech', dataQuality: 'OFFICIAL', automated_grade: 'LIMITED',
    official_reports: { OLD: official('OLD') }, official_report: official('OLD'), players: [] };
  const selective = { team_name: 'Texas Tech', dataQuality: 'OFFICIAL', automated_grade: 'LIMITED',
    official_reports: { NEW: official('NEW', { comprehensive: false }) }, players: [] };
  return [other, selective].every(t => {
    const fx = C.fixtureAvailability(ctx(t), 'Texas Tech', 'NEW', { AV_OVERLAY: OV }, OPTS);
    return C.qbAvailabilityFor(ctx(t), 'Texas Tech', 'NEW', QB, fx, { AV_OVERLAY: OV }).evidence === 'NONE';
  });
});
chk('2j qb_context carries the state beside the evidence', () => {
  const rec = { player_id: '1001', player_name: 'Kevin Jennings', status: 'PREVIOUS_GAME' };
  const a = QBC.build(rec, { availability_evidence: 'EXPLICIT', availability_state: 'out' });
  const b = QBC.build(rec, { availability_evidence: 'COMPREHENSIVE_SILENCE' });
  const c = QBC.build(rec, { availability_evidence: 'NONE', availability_state: 'AVAILABLE' });
  return a.availability_state === 'OUT' && b.availability_state === 'AVAILABLE' && c.availability_state === null;
});
function qbAvail(ev, st) {
  const m = E.uncertainty.information.quarterback({ player: 'X', player_id: '1', status: 'PREVIOUS_GAME',
    persistence: { rate: 0.9, pairs: 100, band: 'x' }, identity_corroborated: true, dropbacks: 100, starts: 4,
    efficiency_history: true, availability_evidence: ev, availability_state: st }, 'home');
  return m.components.available.value;
}
chk('2k the engine reads the state: EXPLICIT OUT scores 0, not 1', () => qbAvail('EXPLICIT', 'OUT') === 0);
chk('2l QUESTIONABLE, DOUBTFUL and PROBABLE through the trained status weights', () => {
  const W = global.EDCfbP4Params.injury.status_weight;
  return Math.abs(qbAvail('EXPLICIT', 'QUESTIONABLE') - (1 - W.questionable)) < 1e-12
    && Math.abs(qbAvail('EXPLICIT', 'DOUBTFUL') - (1 - W.doubtful)) < 1e-12
    && Math.abs(qbAvail('EXPLICIT', 'PROBABLE') - (1 - W.probable)) < 1e-12;
});
chk('2m AVAILABLE and comprehensive silence score 1; an unreadable state and silence score 0', () =>
  qbAvail('EXPLICIT', 'AVAILABLE') === 1 && qbAvail('COMPREHENSIVE_SILENCE', 'AVAILABLE') === 1
  && qbAvail('EXPLICIT', 'UNKNOWN') === 0 && qbAvail('NONE', null) === 0);

/* ---- 3. one official-report slot per FIXTURE ---------------------------- */
function rep(team, gid, o) {
  return Object.assign({ schema: 'edgedesk_availability_report_v1', ok: true, team, team_id: null,
    conference: 'ACC', source_url: 'https://theacc.com/' + gid, game_id: gid, comprehensive: true,
    silence_means_available: true, published_at: iso(NOW_MS - 20 * H), retrieved_at: iso(NOW_MS - 19 * H),
    /* a filing that lists nobody must say so to survive corroborate() */
    explicit_none: true, rows: [] }, o || {});
}
const AUTO = { generated_at: iso(NOW_MS - H), teams: { '228': { team_id: '228', team_name: 'Clemson', dataQuality: 'LIMITED',
  lastUpdated: iso(NOW_MS - H), players: [] } } };
function merged(reports) {
  const m = OV.build({ current: AUTO, operator: { live: [] }, reports, now: NOW_MS, normKey: OV.normKey });
  return m.teams['228'];
}
chk('3a two filings for one team keep one slot each, keyed by the game they were read for', () => {
  /* file order puts the OTHER game's filing last. The legacy slot kept the
     last file, so this is the order that hid this week's filing: it happens
     whenever the next game carries the lower ESPN id (ids are assigned when
     the schedule is loaded, not in date order) */
  const t = merged([rep('Clemson', 'THIS', { rows: [{ player_name: 'A Guard', position: 'OL', status: 'OUT' }] }),
    rep('Clemson', 'OTHER', { published_at: iso(NOW_MS - 200 * H) })]);
  return C.officialReportForGame(t, 'THIS') && C.officialReportForGame(t, 'THIS').game_id === 'THIS'
    && C.officialReportForGame(t, 'OTHER') && C.officialReportForGame(t, 'OTHER').game_id === 'OTHER'
    && t.official_report.game_id === 'OTHER';
});
chk('3b this game\'s comprehensive filing still reaches the engine when another filing sorts after it', () => {
  const t = merged([rep('Clemson', 'THIS'), rep('Clemson', 'OTHER', { rows: [{ player_name: 'Old', position: 'QB', status: 'OUT' }] })]);
  const c = { availability_by_team: { clemson: t }, availability_as_of: null, player_details_by_team: {} };
  const r = C.injuriesFor(c, 'Clemson', 'THIS', { AV_OVERLAY: OV }, OPTS);
  return Array.isArray(r) && r.length === 0;
});
chk('3c the grade is the fixture\'s: a filing for another game does not make this one OFFICIAL', () => {
  const t = merged([rep('Clemson', 'OTHER')]);
  return t.dataQuality === 'OFFICIAL' && OV.gradeFor(t, 'OTHER', OPTS) === 'OFFICIAL'
    && OV.gradeFor(t, 'NEXT', OPTS) === 'LIMITED'
    && C.injuriesFor({ availability_by_team: { clemson: t }, player_details_by_team: {} }, 'Clemson', 'NEXT',
      { AV_OVERLAY: OV }, OPTS) === null;
});
chk('3d an operator entry grades its own fixture STRONG, and only its own', () => {
  const t = OV.build({ current: AUTO, reports: [], now: NOW_MS, normKey: OV.normKey,
    operator: { live: [{ kind: 'AVAILABILITY', team: 'Clemson', player: 'Some Back', position: 'RB', status: 'OUT',
      game_id: 'THIS', published_at: iso(NOW_MS - 5 * H), source_name: 'team release', tier: 1 }] } }).teams['228'];
  return OV.gradeFor(t, 'THIS', OPTS) === 'STRONG' && OV.gradeFor(t, 'NEXT', OPTS) === 'LIMITED';
});
chk('3e the same holds in the full assembly: one fixture\'s contract row reads its own filing', () => {
  const IN = I;
  const P = global.EDCfbP4Params;
  const FBS = require('../fbs/fbs.js');
  const real = IN.load({ season: 2026, params: P, normKey: FBS.normKey });
  const t = merged([rep('Clemson', 'THIS', { names: 0 }), rep('Clemson', 'OTHER',
    { rows: [{ player_name: 'Old', position: 'QB', status: 'OUT' }] })]);
  real.availability_by_team = Object.assign({}, real.availability_by_team, { clemson: t });
  const g = { game_id: 'THIS', season: 2026, week: 5, start_date: KICK, home_team: 'Clemson', away_team: 'Duke',
    neutral_site: false, venue_id: 1, home_conference: 'ACC', away_conference: 'ACC' };
  const meta = { home: { key: 'clemson', is_fbs: true }, away: { key: 'duke', is_fbs: true } };
  const asm = IN.buildRequest(real, { game: g, meta, state: E.newState(), now: NOW_MS });
  const g2 = Object.assign({}, g, { game_id: 'NEXT' });
  const asm2 = IN.buildRequest(real, { game: g2, meta, state: E.newState(), now: NOW_MS });
  const row2 = asm2.contract.find(c => c.field === 'availability' && c.side === 'home');
  return Array.isArray(asm.baseline.teams.home.injuries) && asm.baseline.teams.home.injuries.length === 0
    && asm.baseline.teams.home.qb_context && asm.baseline.teams.home.qb_context.availability_evidence === 'COMPREHENSIVE_SILENCE'
    && asm2.baseline.teams.home.injuries === null
    && !/graded OFFICIAL/.test(row2.detail || '');
});

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
