'use strict';
/* ===========================================================================
   EdgeDesk college baseball — measure the rules before the simulator uses them.

     node college_baseball/rules_evidence.js          write validation/rules_evidence.json
     node college_baseball/rules_evidence.js --check  fail if it does not reproduce

   From every final game with an inning-by-inning line (2017-2026):
     - scheduled length by context (doubleheader game number, season)
     - how often a ten-run lead after seven complete innings ended the game,
       by context (conference, non-conference, inferred NCAA tournament)
     - whether the home side ever batted in the final inning while ahead (R02)
     - runs per extra half-inning vs regulation (R07: an automatic runner
       would show up as roughly +0.5 runs per extra half-inning)
     - the share of runs by inning (used to scale a game that is not nine)
   =========================================================================== */
const fs = require('fs');
const C = require('./config');
const W = require('./lib/warehouse');
const K = require('./ingest/common');
const RULES = require('./lib/rules');

function build() {
  const all = []; const perSeason = {};
  for (let s = C.SEASONS.pbp[0]; s <= C.SEASONS.last; s++) {
    const gs = W.games(s).filter((g) => W.usable(g) && g.away_line);
    all.push(...gs);
    perSeason[s] = RULES.measure(gs);
  }
  const pooled = RULES.measure(all);
  /* share of runs by inning in nine-inning games */
  const share = new Array(9).fill(0); let tot = 0;
  const halfDist = {};
  for (const g of all) {
    const inf = RULES.inferScheduled(g); if (inf.scheduled !== 9 || inf.ended_early) continue;
    for (const line of [RULES.parseLine(g.away_line), RULES.parseLine(g.home_line)]) {
      for (let i = 0; i < Math.min(9, line.length); i++) if (line[i] != null) { share[i] += line[i]; tot += line[i]; }
    }
  }
  /* games by basis */
  const basis = {}; for (const g of all) { const b = RULES.inferScheduled(g).basis; basis[b] = (basis[b] || 0) + 1; }
  const p7 = {}; for (const [k, v] of Object.entries(pooled.by_context)) p7[k] = { n: v.n, seven: v.seven, share: v.n ? Math.round(v.seven / v.n * 1000) / 1000 : null };
  return {
    schema: 'edgedesk_cbase_rules_evidence_v1', rules_version: RULES.RULES_VERSION, registry: RULES.REGISTRY,
    games_with_lines: all.length, scheduled_basis: basis,
    by_context: pooled.by_context, seven_inning_share: p7,
    run_rule: pooled.run_rule, home_not_batting_when_leading: pooled.home_not_batting_when_leading,
    extra_inning_runs: pooled.extra_inning_runs,
    run_share_by_inning: share.map((v) => Math.round(v / tot * 10000) / 10000),
    per_season: Object.fromEntries(Object.entries(perSeason).map(([s, m]) => [s, { run_rule: m.run_rule, extra_inning_runs: m.extra_inning_runs, home_not_batting_when_leading: m.home_not_batting_when_leading }])),
    findings: [],
  };
}

function findings(ev) {
  const f = [];
  const x = ev.extra_inning_runs;
  if (x.mean != null && x.regulation_mean != null) f.push(`R07: extra half-innings average ${x.mean} runs vs ${x.regulation_mean} in innings 1-9 (n=${x.half_innings}); ${x.mean - x.regulation_mean > 0.35 ? 'consistent with an automatic runner — R07 NOT supported' : 'no sign of an automatic runner — R07 supported'}`);
  const h = ev.home_not_batting_when_leading;
  f.push(`R02: home led after the top of the final scheduled inning in ${h.leading_after_top_of_last} games; bottom half recorded x ${h.recorded_x}, recorded 0 (source convention) ${h.recorded_zero_convention}, runs scored anyway (violation) ${h.runs_scored_violation}`);
  for (const [k, v] of Object.entries(ev.run_rule)) f.push(`R06 ${k}: a 10+ lead after 7 complete ended the game in ${v.stopped}/${v.eligible} (${v.eligible ? Math.round(v.stopped / v.eligible * 1000) / 10 : '-'}%)`);
  for (const k of ['single', 'dh', 'dh1', 'dh2']) { const v = ev.seven_inning_share[k]; if (v) f.push(`R05 ${k}: scheduled seven in ${v.seven}/${v.n} (${Math.round(v.share * 1000) / 10}%)`); }
  return f;
}

function main() {
  const ev = build(); ev.findings = findings(ev);
  const text = JSON.stringify(ev, null, 1) + '\n';
  const file = require('path').join(C.PATHS.validation, 'rules_evidence.json');
  if (process.argv.includes('--check')) { if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { console.error('rules_evidence drift'); process.exit(1); } console.log('rules evidence reproduces'); return; }
  K.writeIfChanged(file, text);
  for (const l of ev.findings) console.log(l);
}

if (require.main === module) main();
module.exports = { build, findings };
