#!/usr/bin/env node
/* ============================================================================
   WHERE EVERY MISSING CONFIDENCE POINT WENT.

   "Data confidence 73%" is not an answer to anything on its own. This prints
   the other twenty-seven points: which field is missing, what that field
   means, where it would come from, when it was last observed, whether the
   published number prices it, exactly how many points it is costing, and what
   would fill it. It also prints the five numbers a card shows under their own
   names, because three of them had no published definition and a reader
   comparing 73% with "11 of 17" was entitled to conclude the page was broken.

   Every number here is READ, not recomputed: the states come from the input
   contract, the measurements come from the engine, and the arithmetic is
   checked — if the ledger does not add to 100 it says so.

     node tools/football/confidence_ledger.js                    the slate
     node tools/football/confidence_ledger.js --game "miami @ wake forest"
     node tools/football/confidence_ledger.js --json --out FILE
     node tools/football/confidence_ledger.js --tier fbs_fcs
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
const CONF = require(path.join(ROOT, 'football', 'matchup', 'confidence.js'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function rpad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function pctl(a, q) { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * (b.length - 1)))]; }

async function main() {
  const season = +(arg('season', defaultSeason()));
  const want = arg('game', null);
  const tier = arg('tier', null);
  const asJson = !!arg('json', false);
  const outFile = arg('out', null);

  const cacheFile = path.join(ROOT, 'football', 'fbs', '.cache', `cfb_schedules_${season}.csv`);
  let text = null;
  try { text = await BC.loadSeason(season, true); } catch (_) { /* fall through to the cache */ }
  if (!text && fs.existsSync(cacheFile)) text = fs.readFileSync(cacheFile, 'utf8');
  if (!text) { console.error('[ledger] the ' + season + ' schedule could not be read; nothing is measured'); return 2; }

  const rows = BC.normRows(BC.parseCsv(text));
  const universe = FBS.buildUniverse({ rows, season, params: P, knownFbs: (P.rating && P.rating.seed_ratings) || null });
  const { st } = BC.buildState({ [season]: rows }, season);
  const built = FBS.buildSlate({ rows, universe, now: Date.now(), lookaheadDays: 10 });
  const ctx = IN.load({ season, params: P, normKey: FBS.normKey });
  const si = IN.scheduleIndex(rows, st.r);
  const now = Date.now();
  const W = (P.confidence && P.confidence.weights) || {};
  const weightTotal = Object.keys(W).reduce((a, k) => a + W[k], 0);

  const ledgers = [];
  const byField = {};
  const byInput = {};
  for (const it of built.items) {
    const g = it.g, m = it.meta;
    const t = m.fbs_sides === 2 ? (m.home.group === 'p4' || m.away.group === 'p4' ? 'p4_involved' : 'other_fbs') : 'fbs_fcs';
    if (tier && t !== tier) continue;
    let asm, p;
    try {
      asm = IN.buildRequest(ctx, { game: g, meta: m, state: st, schedule_index: si, now });
      p = E.projectGame(asm.baseline);
    } catch (e) { continue; }
    if (!p || p.status !== 'PREDICTED') continue;
    const unc = (p.layers && p.layers.uncertainty && p.layers.uncertainty.context) || {};
    const L = CONF.ledger({
      contract: asm.contract,
      information: (p.layers.uncertainty && p.layers.uncertainty.information) || {},
      weights: W, summary: asm.summary,
      confidence: p.scores.confidence, confidence_priced: p.scores.confidence_priced,
      engine_completeness: unc.information_missing != null ? 1 - unc.information_missing : null,
      home_win_prob: p.model.home_win_prob, weight_total: weightTotal,
      home: g.home_team, away: g.away_team, now
    });
    L.tier = t;
    L.label = g.away_team + ' @ ' + g.home_team;
    L.warnings = (p.data_quality && p.data_quality.warnings) || [];
    ledgers.push(L);
    L.fields.forEach(f => {
      const k = f.field + (f.side ? ':' + f.side : '');
      const b = byField[k] || (byField[k] = { field: k, games: 0, lost: 0, by_state: {}, fixes: {} });
      b.games++; b.lost += f.lost_points || 0;
      b.by_state[f.state] = (b.by_state[f.state] || 0) + 1;
      if (f.fix && (f.lost_points || 0) > 0) b.fixes[f.fix] = (b.fixes[f.fix] || 0) + 1;
    });
    L.inputs.forEach(i => {
      const b = byInput[i.input] || (byInput[i.input] = { input: i.input, weight: i.weight, max: i.max_points, lost: 0, unmeasured: 0, games: 0 });
      b.games++; b.lost += i.lost_points; if (!i.measured) b.unmeasured++;
    });
  }

  const confs = ledgers.map(l => l.scoreboard.information_confidence.value_pct).filter(x => x != null);
  const summary = {
    schema: 'edgedesk_confidence_ledger_report_v1',
    season, generated_at: new Date(now).toISOString(),
    games: ledgers.length,
    confidence: {
      mean: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10) / 10 : null,
      min: pctl(confs, 0), p10: pctl(confs, 0.1), median: pctl(confs, 0.5), max: pctl(confs, 1),
      at_90: confs.filter(x => x >= 90).length, at_95: confs.filter(x => x >= 95).length,
      at_100: confs.filter(x => x >= 99.995).length
    },
    by_input: Object.keys(byInput).sort((a, b) => byInput[b].lost - byInput[a].lost).map(k => {
      const b = byInput[k];
      return { input: k, weight: b.weight, max_points: b.max,
        mean_lost: Math.round((b.lost / b.games) * 100) / 100,
        unmeasured_games: b.unmeasured, games: b.games };
    }),
    by_field: Object.keys(byField).sort((a, b) => byField[b].lost - byField[a].lost).map(k => {
      const b = byField[k];
      return { field: k, games: b.games, mean_lost: Math.round((b.lost / b.games) * 100) / 100,
        total_lost: Math.round(b.lost * 10) / 10, by_state: b.by_state,
        fixes: Object.keys(b.fixes).slice(0, 2) };
    }),
    reconciliation_failures: ledgers.filter(l => l.reconciles.agrees === false)
      .map(l => ({ game: l.label, reconciles: l.reconciles }))
  };

  if (asJson || outFile) {
    const payload = { summary, ledgers: want ? ledgers.filter(l => l.label.toLowerCase().indexOf(String(want).toLowerCase()) >= 0) : ledgers };
    const txt = JSON.stringify(payload, null, 1);
    if (outFile) { fs.writeFileSync(path.join(ROOT, String(outFile)), txt + '\n'); console.error('[ledger] wrote ' + outFile); }
    else console.log(txt);
    return 0;
  }

  if (want) {
    const hit = ledgers.filter(l => l.label.toLowerCase().indexOf(String(want).toLowerCase()) >= 0);
    if (!hit.length) { console.error('[ledger] no game matched "' + want + '"'); return 2; }
    hit.forEach(printGame);
    return 0;
  }

  console.log('\nEdgeDesk FBS confidence ledger — ' + season + ', ' + ledgers.length + ' games'
    + (tier ? ' (' + tier + ')' : ''));
  const c = summary.confidence;
  console.log('  information confidence   mean ' + c.mean + '%   median ' + (c.median == null ? '—' : c.median.toFixed(1))
    + '%   lower decile ' + (c.p10 == null ? '—' : c.p10.toFixed(1)) + '%   min ' + (c.min == null ? '—' : c.min.toFixed(1)) + '%');
  console.log('  games at 90% / 95% / 100%: ' + c.at_90 + ' / ' + c.at_95 + ' / ' + c.at_100);
  console.log('\n  WHERE THE POINTS GO — by engine input (mean points lost per game, of the input’s maximum)');
  summary.by_input.forEach(i => console.log('    ' + pad(i.input, 16) + rpad(i.mean_lost.toFixed(2), 6) + ' of '
    + rpad(i.max_points.toFixed(2), 6) + '   unmeasured on ' + i.unmeasured_games + '/' + i.games + ' games'));
  console.log('\n  WHERE THE POINTS GO — by contract field');
  summary.by_field.slice(0, 18).forEach(f => console.log('    ' + pad(f.field, 28) + rpad(f.mean_lost.toFixed(2), 6)
    + '   ' + Object.keys(f.by_state).map(s => s + ' x' + f.by_state[s]).join(', ')));
  console.log('\n  THE FIXES THE LEDGER NAMES');
  const fixes = {};
  summary.by_field.forEach(f => f.fixes.forEach(x => { fixes[x] = (fixes[x] || 0) + f.games; }));
  Object.keys(fixes).sort((a, b) => fixes[b] - fixes[a]).slice(0, 8)
    .forEach(f => console.log('    ' + rpad(fixes[f], 4) + '  ' + f.slice(0, 150)));
  if (summary.reconciliation_failures.length) {
    console.log('\n  !! ' + summary.reconciliation_failures.length + ' game(s) whose ledger does not add to 100');
    summary.reconciliation_failures.slice(0, 3).forEach(r => console.log('    ' + r.game + ': ' + JSON.stringify(r.reconciles)));
  } else {
    console.log('\n  every game’s ledger adds to 100: the displayed score plus every attributed point.');
  }
  return 0;
}

function printGame(L) {
  console.log('\n══ ' + L.label + '  (' + L.tier + ')');
  console.log('  THE FIVE NUMBERS, EACH WITH ITS OWN DENOMINATOR');
  Object.keys(L.scoreboard).forEach(k => {
    const v = L.scoreboard[k];
    if (!v || typeof v !== 'object') return;
    console.log('    ' + pad(k, 26) + rpad(v.value_pct == null ? '—' : v.value_pct + '%', 8) + '  ' + v.measures);
    console.log('    ' + ' '.repeat(26) + '          over ' + v.denominator);
    console.log('    ' + ' '.repeat(26) + '          NOT ' + v.not_the_same_as);
  });
  console.log('\n  THE LEDGER — every applicable field, and what it costs');
  console.log('    ' + pad('field', 28) + pad('state', 16) + rpad('lost', 6) + rpad('of', 7) + '  priced  observed');
  L.fields.slice().sort((a, b) => (b.lost_points || 0) - (a.lost_points || 0)).forEach(f => {
    console.log('    ' + pad(f.field + (f.side ? ':' + f.side : ''), 28) + pad(f.state, 16)
      + rpad((f.lost_points || 0).toFixed(2), 6) + rpad((f.weight_share || 0).toFixed(2), 7)
      + '  ' + pad(f.affects_pricing ? 'yes' : 'no', 7)
      + (f.observed_at ? String(f.observed_at).slice(0, 16) : (f.scored ? '—' : 'not scored')));
    if (f.means) console.log('      ' + f.means + (f.unit ? '  [' + f.unit + ']' : ''));
    if (f.source) console.log('      source: ' + f.source + (f.age_hours != null ? '  (' + f.age_hours + 'h old'
      + (f.freshness_floor_hours != null ? ', floor ' + f.freshness_floor_hours + 'h' + (f.past_freshness_floor ? ' — PAST IT' : '') : '') + ')' : ''));
    if (f.identity_resolution) console.log('      identity: ' + f.identity_resolution);
    if (f.evidence) console.log('      evidence: ' + String(f.evidence).slice(0, 220));
    if (f.why_costing) console.log('      note: ' + f.why_costing);
    if (f.fix) console.log('      FIX: ' + f.fix);
  });
  console.log('\n  BY ENGINE INPUT');
  L.inputs.slice().sort((a, b) => b.lost_points - a.lost_points).forEach(i => {
    console.log('    ' + pad(i.input, 16) + 'w=' + pad(i.weight, 7) + 'max ' + rpad(i.max_points.toFixed(2), 6)
      + '  earned ' + rpad(i.earned_points.toFixed(2), 6) + '  lost ' + rpad(i.lost_points.toFixed(2), 6)
      + '  ' + (i.measured ? 'conf ' + i.confidence : 'UNMEASURED'));
    if (i.basis) console.log('      ' + String(i.basis).slice(0, 200));
  });
  console.log('\n  RECONCILES: ' + JSON.stringify(L.reconciles));
  if (L.warnings && L.warnings.length) console.log('  ENGINE WARNINGS: ' + JSON.stringify(L.warnings));
}

if (require.main === module) main().then(c => process.exit(c || 0)).catch(e => { console.error('[ledger] ' + ((e && e.stack) || e)); process.exit(2); });
module.exports = { main };
