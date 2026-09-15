#!/usr/bin/env node
/* ============================================================================
   WHAT EACH REMAINING GAP IS WORTH — measured, and labelled as a hypothesis.

   The ledger says a field is missing and what it costs. The question a person
   actually asks next is "so what happens when we go and get it", and the only
   honest way to answer that is to RUN THE ENGINE with the field supplied and
   print the difference.

   SO EVERY NUMBER BELOW IS A HYPOTHETICAL AND SAYS SO. Nothing here is
   written to an artifact, nothing here reaches a card, and the supplied
   values are deliberately minimal — a forecast that exists, a report that
   names somebody, an announcement that names the starter. The scenario does
   not invent a temperature or a diagnosis; it supplies the SHAPE of the
   evidence and lets the engine say what knowing it is worth.

   This is the difference between "acquire the data and the number will go
   up" and "acquiring this specific field on this specific slate returns 2.4
   points, and this other one returns 6.2". Only the second is a plan.

     node tools/football/confidence_scenarios.js [--season 2026]
          [--game "miami @ wake forest"] [--json]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P = global.EDCfbP4Params;
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const BC = require(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'));
const IN = require(path.join(ROOT, 'football', 'matchup', 'inputs.js'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function pctl(a, q) { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * (b.length - 1)))]; }

/* ---------------------------------------------------------------------------
   THE SCENARIOS. Each one describes an acquisition that is ALREADY BUILT and
   waiting on access, and mutates only the request — never the engine, never a
   weight, never a threshold.
   --------------------------------------------------------------------------- */
const SCENARIOS = [
  {
    id: 'weather',
    title: 'the forecast provider answers',
    what: 'football/matchup/weather.js already fetches this from open-meteo, keyless, joined on the venue '
      + 'coordinates. It is missing here because THIS build ran where the host is blocked; a build with network '
      + 'access supplies it.',
    apply: (req) => { if (!req.weather) req.weather = { temp_f: 60, wind_mph: 6, precip_in: 0, dome: false,
      as_of: new Date().toISOString(), source: 'SCENARIO — a forecast exists for this kickoff' }; }
  },
  {
    id: 'availability_report',
    title: 'the conference availability report is ingested',
    what: 'the SEC, Big Ten, ACC, Big 12, Mountain West, Conference USA and Sun Belt each file one for '
      + 'conference games. football/availability/sync_reports.js fetches whichever are inside their filing '
      + 'window; the scenario supplies a report that named somebody.',
    apply: (req) => {
      ['home', 'away'].forEach(side => {
        const t = req.teams[side];
        if (t && t.injuries == null) t.injuries = [{ player: 'SCENARIO — a named absence', position: 'WR',
          starter: false, status: 'out', source: 'SCENARIO conference availability report',
          as_of: new Date().toISOString(), snap_share: null, severity: null, replacement_quality: null }];
      });
    }
  },
  {
    id: 'qb_availability',
    title: 'that report also designates the quarterback',
    what: 'the same document. A comprehensive report designates every player, so it settles the starter’s '
      + 'own status as well as the roster’s.',
    apply: (req) => {
      ['home', 'away'].forEach(side => {
        const c = req.teams[side] && req.teams[side].qb_context;
        if (c && c.availability_evidence !== 'EXPLICIT') c.availability_evidence = 'EXPLICIT';
      });
    }
  },
  {
    id: 'qb_announced',
    title: 'the team announces its starter',
    what: 'a team or conference source naming the starter for THIS game moves the record from LAST_GAME_PROXY to '
      + 'CONFIRMED. football/availability/record_correction.js is the route when no feed carries it.',
    apply: (req) => {
      ['home', 'away'].forEach(side => {
        const c = req.teams[side] && req.teams[side].qb_context;
        if (c && c.player_id) { c.status = 'ANNOUNCED'; c.evidence_class = 'CONFIRMED'; }
      });
    }
  },
  {
    id: 'off_field',
    title: 'an off-field reporting feed is wired in',
    what: 'the engine scores this input and it is missing on every game. A feed of public, sourced, dated, '
      + 'severity-graded signals — even one that carries nothing this week — answers the question.',
    apply: (req) => {
      ['home', 'away'].forEach(side => { if (req.teams[side] && req.teams[side].news == null) req.teams[side].news = []; });
    }
  }
];

async function main() {
  const season = +(arg('season', defaultSeason()));
  const want = arg('game', null);
  const asJson = !!arg('json', false);

  const cacheFile = path.join(ROOT, 'football', 'fbs', '.cache', `cfb_schedules_${season}.csv`);
  let text = null;
  try { text = await BC.loadSeason(season, true); } catch (_) { /* cache below */ }
  if (!text && fs.existsSync(cacheFile)) text = fs.readFileSync(cacheFile, 'utf8');
  if (!text) { console.error('[scenarios] the ' + season + ' schedule could not be read'); return 2; }

  const rows = BC.normRows(BC.parseCsv(text));
  const universe = FBS.buildUniverse({ rows, season, params: P, knownFbs: (P.rating && P.rating.seed_ratings) || null });
  const { st } = BC.buildState({ [season]: rows }, season);
  const built = FBS.buildSlate({ rows, universe, now: Date.now(), lookaheadDays: 10 });
  const ctx = IN.load({ season, params: P, normKey: FBS.normKey });
  const si = IN.scheduleIndex(rows, st.r);
  const now = Date.now();

  const base = [], perScenario = {}, cumulative = [];
  SCENARIOS.forEach(s => { perScenario[s.id] = []; });
  const rowsOut = [];

  for (const it of built.items) {
    const g = it.g, m = it.meta;
    const label = g.away_team + ' @ ' + g.home_team;
    if (want && label.toLowerCase().indexOf(String(want).toLowerCase()) < 0) continue;
    let asm, p0;
    try { asm = IN.buildRequest(ctx, { game: g, meta: m, state: st, schedule_index: si, now });
      p0 = E.projectGame(asm.baseline); } catch (e) { continue; }
    if (!p0 || p0.status !== 'PREDICTED') continue;
    base.push(p0.scores.confidence);
    const row = { game: label, base: Math.round(p0.scores.confidence * 10) / 10, deltas: {} };

    /* each scenario ON ITS OWN, against the same baseline */
    SCENARIOS.forEach(s => {
      const req = JSON.parse(JSON.stringify(asm.baseline));
      s.apply(req);
      let p;
      try { p = E.projectGame(req); } catch (e) { return; }
      if (!p || p.status !== 'PREDICTED') return;
      const d = p.scores.confidence - p0.scores.confidence;
      perScenario[s.id].push(d);
      row.deltas[s.id] = Math.round(d * 100) / 100;
    });

    /* and all of them together, which is NOT the sum: the quarterback term
       blends four components and the injury term takes the better of two
       sources, so the parts interact */
    const all = JSON.parse(JSON.stringify(asm.baseline));
    SCENARIOS.forEach(s => s.apply(all));
    let pa = null;
    try { pa = E.projectGame(all); } catch (e) { /* leave null */ }
    if (pa && pa.status === 'PREDICTED') {
      cumulative.push(pa.scores.confidence);
      row.all = Math.round(pa.scores.confidence * 10) / 10;
      row.all_delta = Math.round((pa.scores.confidence - p0.scores.confidence) * 10) / 10;
    }
    rowsOut.push(row);
  }

  const out = {
    schema: 'edgedesk_confidence_scenarios_v1',
    season, generated_at: new Date(now).toISOString(),
    games: rowsOut.length,
    disclaimer: 'EVERY NUMBER HERE IS A HYPOTHETICAL. The scenarios supply the SHAPE of evidence EdgeDesk does '
      + 'not currently hold, to measure what holding it would be worth. Nothing here is written to an artifact '
      + 'or shown on a card, and no scenario changes a weight, a threshold or an engine rule.',
    today: { mean: round(mean(base)), median: round(pctl(base, 0.5)), p10: round(pctl(base, 0.1)),
      at_90: base.filter(x => x >= 90).length, at_95: base.filter(x => x >= 95).length },
    with_everything: cumulative.length ? { mean: round(mean(cumulative)), median: round(pctl(cumulative, 0.5)),
      p10: round(pctl(cumulative, 0.1)), at_90: cumulative.filter(x => x >= 90).length,
      at_95: cumulative.filter(x => x >= 95).length, at_100: cumulative.filter(x => x >= 99.995).length } : null,
    by_scenario: SCENARIOS.map(s => ({ id: s.id, title: s.title, what: s.what,
      mean_points: round(mean(perScenario[s.id]) || 0), games: perScenario[s.id].length,
      best: round(Math.max.apply(null, perScenario[s.id].concat([0]))) })),
    games_detail: rowsOut.slice(0, want ? 20 : 8)
  };

  if (asJson) { console.log(JSON.stringify(out, null, 1)); return 0; }
  console.log('\nWhat each remaining gap is worth — ' + out.games + ' games, ' + season);
  console.log('  ' + out.disclaimer.replace(/\s+/g, ' '));
  console.log('\n  today          mean ' + out.today.mean + '%  median ' + out.today.median + '%  lower decile '
    + out.today.p10 + '%   at 90%: ' + out.today.at_90 + '   at 95%: ' + out.today.at_95);
  if (out.with_everything) console.log('  all of it       mean ' + out.with_everything.mean + '%  median '
    + out.with_everything.median + '%  lower decile ' + out.with_everything.p10 + '%   at 90%: '
    + out.with_everything.at_90 + '   at 95%: ' + out.with_everything.at_95);
  console.log('\n  each acquisition on its own (mean points returned per game):');
  out.by_scenario.slice().sort((a, b) => b.mean_points - a.mean_points).forEach(s => {
    console.log('    ' + String(s.mean_points).padStart(6) + '  ' + s.title);
    console.log('            ' + s.what.replace(/\s+/g, ' ').slice(0, 150));
  });
  console.log('\n  per game:');
  out.games_detail.forEach(r => {
    console.log('    ' + r.game.padEnd(34) + String(r.base).padStart(6) + '%  ->  ' + String(r.all).padStart(6)
      + '%   (' + Object.keys(r.deltas).map(k => k + ' +' + r.deltas[k]).join(', ') + ')');
  });
  return 0;
}
function round(x) { return x == null ? null : Math.round(x * 10) / 10; }

if (require.main === module) main().then(c => process.exit(c || 0)).catch(e => { console.error('[scenarios] ' + ((e && e.stack) || e)); process.exit(2); });
module.exports = { SCENARIOS };
