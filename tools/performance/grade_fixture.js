'use strict';
/* ===========================================================================
   A throwaway repository for the research grade suites: the lib/ and tools/
   folders linked in, a slate, a football record, and projection builders in
   the shape of the projection contract (lib/edgedesk_projections.js). The
   lifecycle below drives the real hourly job (run.js runAll) through a game's
   life — graded, revised, settled — so the ledger rows the SQL suite mirrors
   are rows the job itself wrote.
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function makeRoot(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), label || 'grade-life-'));
  ['lib', 'tools'].forEach((d) => fs.symlinkSync(path.join(ROOT, d), path.join(tmp, d)));
  ['today', 'record/football', 'articles/data/records'].forEach((d) => fs.mkdirSync(path.join(tmp, d), { recursive: true }));
  return tmp;
}
function writeJson(root, rel, obj) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), JSON.stringify(obj)); }
function readJson(root, rel) { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }

/** An NFL projection in the contract's shape. o: { id, start, pred, p, line, total, model, certainty, research, invalidated, freshness, sensitivity } */
function proj(o) {
  const margin = -o.line;
  return { schema: 'edgedesk_independent_projection_v1', event_key: 'NFL|' + o.id, sport: 'nfl', league: 'NFL', event_id: o.id, start_utc: o.start,
    home: { name: 'Green Bay Packers', abbr: 'GB' }, away: { name: 'Atlanta Falcons', abbr: 'ATL' }, neutral: false, venue: 'Lambeau Field',
    model: { kind: 'INDEPENDENT', market_inputs: [], id: o.model || 'edgedesk_football_v1.0.0', version: 'nfl_fv1', artifact: 'football/nfl/slate.json', predicted_at: o.pred, artifact_generated_at: o.pred },
    outcome: { p_home: o.p, p_away: +(1 - o.p).toFixed(4) },
    fair: { moneyline: { home: -150, away: 150 }, spread: { home_line: o.line }, total: { line: o.total, expected: o.total } },
    projected_score: { home: (o.total + margin) / 2, away: (o.total - margin) / 2, margin, total: o.total },
    uncertainty: { model_sd: 0.03, calibration_sd: 0.0343, lineup_sd: 0.005, margin_sd: 10.7, basis: 'model_sd: the board default for football; calibration_sd: registry' },
    validation: { markets: { moneyline: { state: 'EXPERIMENTAL', n: 2647 }, spread: { state: 'OUTCOME_VALIDATED', n: 2658 } } },
    availability: { key_role: 'QB', certainty: o.certainty || 'PROJECTED_LIKELY' },
    matchup: { factors: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }], metrics: { spread: {} } },
    provenance: [{ what: 'schedule', authority: 'THIRD_PARTY' }, { what: 'projection', authority: 'EDGEDESK_MODEL' }],
    freshness: Object.assign({ state: 'FRESH', age_hours: 1, max_age_hours: 30 }, o.freshness || {}),
    invalidators: ['A quarterback change.'], limitations: [],
    integrity: { invalidated: !!o.invalidated, conflicts: o.invalidated ? [{ kind: 'STARTER_CONFLICT' }] : [] },
    sensitivity: o.sensitivity || [{ what: 'GB quarterback replaced', delta_home_line: 0.6, p_home: o.p - 0.02 }],
    research: { outcome: o.research || 'RESEARCH_CONDITIONAL', reasons: [] },
    projection_id: 'pj_' + o.id + o.pred, projection_hash: 'ph_' + o.id };
}
function slateFile(events, markets, at) { return { schema: 'edgedesk_slate/1', generated_at: at, events, upcoming: [], markets: markets || {} }; }
function ev(o) {
  return { id: 'nfl:espn:' + o.espn, sport: 'nfl', league: 'NFL', start_utc: o.start, time_tbd: false, status: o.status || 'SCHEDULED', status_detail: o.detail || '', updated_at: o.at,
    home: { name: 'Green Bay Packers', abbr: 'GB', score: o.hs == null ? null : o.hs }, away: { name: 'Atlanta Falcons', abbr: 'ATL', score: o.as == null ? null : o.as } };
}
function market(at, homePoint, total) {
  return { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: at, moneyline: { home: -160, away: 135 },
    spread: { home: { point: homePoint == null ? -3 : homePoint, price: -110 }, away: { point: homePoint == null ? 3 : -homePoint, price: -110 } },
    total: { point: total == null ? 44.5 : total, over: -110, under: -110 } };
}

/**
 * The full life of one NFL game through the real job: graded pregame twice
 * (a line move), refused at kickoff, settled from two agreeing sources.
 * Returns { root, runs } and leaves the ledger on disk.
 */
async function lifecycle(o) {
  o = o || {};
  const RUN = require('./run.js');
  const root = o.root || makeRoot();
  const START = '2026-10-02T00:15:00.000Z';
  const run = (now, projections) => RUN.runAll({ root, now, write: true, network: false, projections: projections || [], log: () => {} });
  writeJson(root, 'record/football/nfl_2026.json', { games: { G1: { kickoff: START, home: 'Green Bay Packers', away: 'Atlanta Falcons' } } });
  writeJson(root, 'today/slate.json', slateFile([ev({ espn: 9001, start: START, at: '2026-10-01T11:00:00.000Z' })], { 'nfl:espn:9001': market('2026-10-01T11:00:00.000Z', -3, 44.5) }, '2026-10-01T11:00:00.000Z'));
  const runs = [];
  runs.push(await run(Date.parse('2026-10-01T12:00:00Z'), [proj({ id: 'G1', start: START, pred: '2026-10-01T10:00:00.000Z', p: 0.6, line: -3.5, total: 44 })]));
  writeJson(root, 'today/slate.json', slateFile([ev({ espn: 9001, start: START, at: '2026-10-01T20:00:00.000Z' })], { 'nfl:espn:9001': market('2026-10-01T20:00:00.000Z', -4.5, 45.5) }, '2026-10-01T20:00:00.000Z'));
  runs.push(await run(Date.parse('2026-10-01T21:00:00Z'), [proj({ id: 'G1', start: START, pred: '2026-10-01T10:00:00.000Z', p: 0.6, line: -3.5, total: 44 })]));
  writeJson(root, 'today/slate.json', slateFile([ev({ espn: 9001, start: START, status: 'FINAL', detail: 'Final/OT', hs: 27, as: 24, at: '2026-10-02T03:30:00.000Z' })], {}, '2026-10-02T03:40:00.000Z'));
  writeJson(root, 'record/football/nfl_2026.json', { games: { G1: { kickoff: START, home: 'Green Bay Packers', away: 'Atlanta Falcons',
    final: { home_score: 27, away_score: 24, source: 'nflverse', at: '2026-10-02T03:50:00.000Z' }, close: { home_line: -5, total: 46, source: 'nflverse', book: 'consensus' } } } });
  runs.push(await run(Date.parse('2026-10-02T04:00:00Z'), []));
  return { root, runs, START };
}

module.exports = { ROOT, makeRoot, writeJson, readJson, proj, slateFile, ev, market, lifecycle };
