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
  const r = I.injuriesFor(ctx(t), 'Texas Tech', 'NEW');
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
    && Math.abs(r[0].replacement_quality - 0.54) < 1e-9
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

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
