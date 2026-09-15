#!/usr/bin/env node
/* ============================================================================
   BEFORE AND AFTER, ON THE SAME SLATE.

   "Coverage improved" is the easiest sentence in this business to write and
   the hardest to mean, because the cheapest way to raise a coverage number is
   to widen what counts as covered. So this measures BOTH pipelines over the
   SAME games, with the SAME definitions, in one process:

     BEFORE  the engine request as football/fbs/build_coverage.js used to
             assemble it — every optional input hard-coded null. Reconstructed
             here rather than remembered, so the comparison is against the code
             that actually ran and not against a recollection of it.
     AFTER   the assembly in football/matchup/inputs.js, which is what the
             builder uses now.

   And it reports the things a coverage percentage cannot say on its own:
   which fields moved, which are still empty, WHY each one is still empty, and
   how many of the remaining holes are "nobody publishes this" rather than
   "EdgeDesk did not go and get it".

     node tools/football/coverage_report.js [--season 2026] [--json] [--out FILE]
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
const SNAP = require(path.join(ROOT, 'tools', 'lib', 'snapshot_contract.js'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function pct(v) { return v == null ? '—' : (Math.round(v * 1000) / 10) + '%'; }

/* THE OLD ASSEMBLY, reconstructed exactly. This is the request the offline
   builder sent before this change: four optional inputs, all null. */
function beforeRequest(st, item) {
  const g = item.g, m = item.meta;
  const V = (P.universe && P.universe.venues) || {};
  return {
    season: g.season, week: g.week, state: st,
    game: { home: g.home_team, away: g.away_team, neutral_site: g.neutral_site,
      venue_id: g.venue_id, kickoff: g.start_date, home_fbs: m.home.is_fbs, away_fbs: m.away.is_fbs },
    teams: {
      home: { conference: g.home_conference, roster: null, qb: null, injuries: null, news: null, coaching: null, schedule: null },
      away: { conference: g.away_conference, roster: null, qb: null, injuries: null, news: null, coaching: null, schedule: null }
    },
    venue: { home: V[FBS.normKey(g.home_team)] || null, away: V[FBS.normKey(g.away_team)] || null },
    weather: null, market: {}, timestamps: {}
  };
}

async function main() {
  const season = +(arg('season', defaultSeason()));
  const asJson = !!arg('json', false);
  const outFile = arg('out', null);
  const cacheFile = path.join(ROOT, 'football', 'fbs', '.cache', `cfb_schedules_${season}.csv`);
  let text = null;
  try { text = await BC.loadSeason(season, true); } catch (_) { /* fall through */ }
  if (!text && fs.existsSync(cacheFile)) text = fs.readFileSync(cacheFile, 'utf8');
  if (!text) { console.error('[coverage] the ' + season + ' schedule could not be read; nothing is measured rather than a pass reported on no data'); return 2; }

  const rows = BC.normRows(BC.parseCsv(text));
  const universe = FBS.buildUniverse({ rows, season, params: P, knownFbs: (P.rating && P.rating.seed_ratings) || null });
  const { st } = BC.buildState({ [season]: rows }, season);
  const built = FBS.buildSlate({ rows, universe, now: Date.now(), lookaheadDays: 10 });
  const slate = built.items;

  const ctx = IN.load({ season, params: P, normKey: FBS.normKey });
  const si = IN.scheduleIndex(rows, st.r);
  const now = Date.now();

  const before = { games: 0, engine_completeness: [], qb_known: 0, roster: 0, injuries: 0, schedule: 0, weather: 0, warnings: {} };
  const after = { games: 0, engine_completeness: [], input_coverage: [], priced_coverage: [],
    starter_resolved_home: 0, starter_resolved_away: 0, starter_status: {}, states: {}, fields: {} };
  const stillEmpty = {};
  const byMatchup = {};

  for (const it of slate) {
    const m = it.meta;
    const tier = m.fbs_sides === 2 ? (m.home.group === 'p4' || m.away.group === 'p4' ? 'p4_involved' : 'other_fbs') : 'fbs_fcs';
    const bucket = byMatchup[tier] || (byMatchup[tier] = { games: 0, before: [], after: [], starters: 0 });
    bucket.games++;

    /* BEFORE */
    let bp = null;
    try { bp = E.projectGame(beforeRequest(st, it)); } catch (_) { bp = null; }
    if (bp && bp.status === 'PREDICTED') {
      before.games++;
      const c = bp.layers && bp.layers.uncertainty && bp.layers.uncertainty.context;
      if (c && c.information_missing != null) { before.engine_completeness.push(1 - c.information_missing); bucket.before.push(1 - c.information_missing); }
      (bp.data_quality && bp.data_quality.warnings || []).forEach(w => { before.warnings[w] = (before.warnings[w] || 0) + 1; });
    }

    /* AFTER */
    let asm = null, ap = null;
    try {
      asm = IN.buildRequest(ctx, { game: it.g, meta: m, state: st, schedule_index: si, now });
      ap = E.projectGame(asm.baseline);
    } catch (e) { /* recorded as a game the assembly could not build */ }
    if (asm && ap && ap.status === 'PREDICTED') {
      after.games++;
      const c = ap.layers && ap.layers.uncertainty && ap.layers.uncertainty.context;
      if (c && c.information_missing != null) { after.engine_completeness.push(1 - c.information_missing); bucket.after.push(1 - c.information_missing); }
      after.input_coverage.push(asm.summary.input_coverage);
      after.priced_coverage.push(asm.summary.priced_coverage);
      Object.keys(asm.summary.by_state).forEach(s => { after.states[s] = (after.states[s] || 0) + asm.summary.by_state[s]; });
      asm.contract.forEach(c2 => {
        const k = c2.field + (c2.side ? ':' + c2.side : '');
        const f = after.fields[k] || (after.fields[k] = {});
        f[c2.state] = (f[c2.state] || 0) + 1;
        if (c2.state === 'UNAVAILABLE' || c2.state === 'FETCH_FAILED') {
          const key = c2.field + ' — ' + (c2.detail || c2.state);
          stillEmpty[key] = (stillEmpty[key] || 0) + 1;
        }
      });
      if (asm.starters.home && asm.starters.home.player_id) { after.starter_resolved_home++; bucket.starters++; }
      if (asm.starters.away && asm.starters.away.player_id) after.starter_resolved_away++;
      ['home', 'away'].forEach(s => {
        const r = asm.starters[s];
        if (r) after.starter_status[r.status] = (after.starter_status[r.status] || 0) + 1;
      });
    }
  }

  /* MARKET FRESHNESS, measured on the committed snapshot the newsletter reads */
  const week = slate.length ? (slate[0].g.week || null) : null;
  const mkFile = path.join(ROOT, 'articles', 'data', 'market',
    `${season}-week-${String(week == null ? 0 : week).padStart(2, '0')}.json`);
  const mk = readJson(mkFile, null);
  let marketBefore = null, marketAfter = null;
  if (mk && mk.quotes) {
    const withOdds = mk.quotes.filter(q => (q.spread && q.spread.odds_american != null) || (q.total && q.total.odds_american != null)).length;
    const normalised = [];
    mk.quotes.forEach(q => {
      if (q.spread) normalised.push(SNAP.quote({ game_id: q.game_id, market: 'spreads', selection: q.spread.selection,
        side: q.spread.side, point: q.spread.point, book: q.spread.book, best_dec: q.spread.odds_decimal,
        captured_at: q.captured_at, kickoff: q.kickoff }, { now, snapshot_kind: 'EDITION' }));
    });
    marketBefore = { quotes: mk.quotes.length, carrying_a_price: withOdds,
      freshness_state_published: !!mk.freshness,
      note: 'the committed snapshot as it stands in the repository right now' };
    marketAfter = SNAP.coverage(normalised, { model_generated_at: (readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'), {}) || {}).generated_at });
  }

  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const report = {
    schema: 'edgedesk_football_coverage_delta_v1',
    season, generated_at: new Date().toISOString(),
    slate: { games: slate.length, by_matchup: Object.keys(byMatchup).reduce((m, k) => { m[k] = byMatchup[k].games; return m; }, {}) },
    before: {
      projected: before.games,
      engine_data_completeness_mean: mean(before.engine_completeness),
      engine_data_completeness_zero: before.engine_completeness.filter(x => x === 0).length,
      games_with_unknown_qb: before.warnings['home starting QB unknown'] || 0,
      warnings: before.warnings,
      basis: 'the engine request as the offline builder assembled it before this change: roster, qb, injuries, '
        + 'news, coaching, schedule and weather all hard-coded null'
    },
    after: {
      projected: after.games,
      engine_data_completeness_mean: mean(after.engine_completeness),
      engine_data_completeness_zero: after.engine_completeness.filter(x => x === 0).length,
      input_coverage_mean: mean(after.input_coverage),
      priced_input_coverage_mean: mean(after.priced_coverage),
      starter_resolved_home: after.starter_resolved_home,
      starter_resolved_away: after.starter_resolved_away,
      starter_status: after.starter_status,
      contract_states: after.states,
      basis: 'the assembly in football/matchup/inputs.js, which is what the builder uses now'
    },
    by_matchup: Object.keys(byMatchup).reduce((m, k) => {
      m[k] = { games: byMatchup[k].games,
        before_completeness_mean: mean(byMatchup[k].before),
        after_completeness_mean: mean(byMatchup[k].after),
        home_starters_resolved: byMatchup[k].starters };
      return m;
    }, {}),
    field_states: after.fields,
    still_empty: Object.keys(stillEmpty).sort((a, b) => stillEmpty[b] - stillEmpty[a])
      .map(k => ({ cause: k, games: stillEmpty[k] })),
    market: { file: path.relative(ROOT, mkFile), before: marketBefore, after: marketAfter },
    honesty: 'The AFTER definitions are STRICTER, not looser: input_coverage counts a field as known only when it was '
      + 'actually retrieved, research-only fields are counted separately from priced ones, and NOT_APPLICABLE fields '
      + 'are removed from the denominator rather than being counted as covered. Nothing here was made to look better '
      + 'by weakening what "covered" means.'
  };

  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n');
  if (asJson) { console.log(JSON.stringify(report, null, 1)); return 0; }

  const L = console.log;
  L('');
  L(`EdgeDesk football coverage — ${season}, ${slate.length} games in the next 10 days`);
  L('');
  L('                                          BEFORE        AFTER');
  L(`  games projected                         ${String(report.before.projected).padStart(6)}       ${String(report.after.projected).padStart(6)}`);
  L(`  engine data completeness (mean)         ${pct(report.before.engine_data_completeness_mean).padStart(6)}       ${pct(report.after.engine_data_completeness_mean).padStart(6)}`);
  L(`  games at zero completeness              ${String(report.before.engine_data_completeness_zero).padStart(6)}       ${String(report.after.engine_data_completeness_zero).padStart(6)}`);
  L(`  games with an unknown starting QB       ${String(report.before.games_with_unknown_qb).padStart(6)}       ${String(slate.length - report.after.starter_resolved_home).padStart(6)}  (home side)`);
  L(`  input coverage, applicable fields       ${'  n/a'.padStart(6)}       ${pct(report.after.input_coverage_mean).padStart(6)}`);
  L(`  of which priced                         ${'  n/a'.padStart(6)}       ${pct(report.after.priced_input_coverage_mean).padStart(6)}`);
  L('');
  L('  starter status across both sides of every game');
  Object.keys(report.after.starter_status).forEach(k => L(`    ${k.padEnd(16)} ${report.after.starter_status[k]}`));
  L('');
  L('  by matchup tier                         before   after   home starters');
  Object.keys(report.by_matchup).forEach(k => {
    const b = report.by_matchup[k];
    L(`    ${k.padEnd(14)} ${String(b.games).padStart(3)} games  ${pct(b.before_completeness_mean).padStart(6)}  ${pct(b.after_completeness_mean).padStart(6)}   ${b.home_starters_resolved}`);
  });
  L('');
  L('  still empty, and why');
  report.still_empty.slice(0, 12).forEach(e => L(`    ${String(e.games).padStart(3)}x  ${e.cause.slice(0, 150)}`));
  if (report.market.after) {
    L('');
    L('  market snapshot: ' + report.market.file);
    L('    ' + report.market.after.statement);
    L(`    quotes carrying an American price: ${report.market.before.carrying_a_price} of ${report.market.before.quotes}`);
  }
  L('');
  L('  ' + report.honesty);
  L('');
  return 0;
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('[coverage] ' + ((e && e.stack) || e)); process.exit(2); });
}
module.exports = { beforeRequest };
