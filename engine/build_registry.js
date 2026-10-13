#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk ENGINE — the readiness registry, rebuilt from evidence.

     node engine/build_registry.js          write engine/registry.json
     node engine/build_registry.js --check  fail if the committed file is stale
                                            or claims value it cannot support

   Each sport's readiness is COMPUTED (lib/edgedesk_sport_brains.js
   computeReadiness) from the validation files its brain produced — never typed
   in. A file that is missing makes its markets disappear, which lowers the
   state; nothing here can raise one.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const B = require('../lib/edgedesk_sport_brains');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'registry.json');
const rel = (p) => path.join(ROOT, p);
function read(p) { try { return JSON.parse(fs.readFileSync(rel(p), 'utf8')); } catch (_) { return null; } }

const TIER_TO_MARKET = { VALIDATED: 'TESTED_AHEAD', LEAN: 'TESTED_EVEN', PROBABILITY: 'TESTED_EVEN', RESEARCH: 'TESTED_BEHIND' };

function football(league) {
  const lm = read('football/validation/linemaker_' + league + '.json');
  const pr = read('football/validation/pricing_' + league + '.json');
  if (!lm && !pr) return { markets: {}, files: [] };
  const out = {};
  for (const [k, key] of [['spread', 'spread'], ['moneyline', 'moneyline'], ['total', 'total'], ['team_total', 'team_total']]) {
    const m = lm && lm.markets && lm.markets[k];
    const t = pr && pr.markets && pr.markets[k];
    if (!m && !t) continue;
    out[key] = {
      outcome: m ? (m.status === 'CALIBRATED' ? 'VALIDATED' : 'PROVISIONAL') : 'NONE',
      market: t && t.tier ? (TIER_TO_MARKET[t.tier] || 'TESTED_BEHIND') : 'NOT_TESTED',
      n: t && t.n ? t.n : null,
      headline: (m ? 'outcomes: ' + m.status + (m.status_reasons && m.status_reasons.length ? ' (' + m.status_reasons[0] + ')' : '') : 'outcomes: not scored') + '; vs close: ' + (t && t.tier ? t.tier : 'not tested'),
      file: ['football/validation/linemaker_' + league + '.json', 'football/validation/pricing_' + league + '.json'].join(' + '),
    };
  }
  return { markets: out, files: ['football/validation/linemaker_' + league + '.json', 'football/validation/pricing_' + league + '.json'], generated_at: (lm && lm.generated_at) || (pr && pr.generated_at) };
}

const READERS = {
  nhl() {
    const v = read('hockey/validation/nhl_walkforward.json');
    if (!v) return { markets: {}, files: [] };
    const map = { moneyline: 'moneyline', spread: 'puck_line_home_minus_1_5', total: 'total_over_5_5', regulation_3way: 'regulation_3way' };
    const out = {};
    for (const [key, k] of Object.entries(map)) {
      const m = v.markets[k]; if (!m) continue;
      out[key] = { outcome: m.status === 'OUTCOME_VALIDATED' ? 'VALIDATED' : 'PROVISIONAL', market: m.market_status === 'TESTED_AHEAD' ? 'TESTED_AHEAD' : 'NOT_TESTED', n: m.n || null,
        headline: 'outcomes: ' + m.status + (m.failed && m.failed.length ? ' (' + m.failed.join('; ') + ')' : '') + (m.log_loss != null ? '; held-out log loss ' + m.log_loss : '') + '; vs close: not tested', file: 'hockey/validation/nhl_walkforward.json' };
    }
    if (v.comparisons) { const c = Object.entries(v.comparisons).find(([k]) => /_vs_elo$/.test(k)); if (c && out.moneyline) out.moneyline.headline += '; vs Elo Δ log loss ' + c[1].mean_diff + ' (95% ' + c[1].ci95.join(' to ') + ')'; }
    return { markets: out, files: ['hockey/validation/nhl_walkforward.json', 'hockey/xg/report.json'], generated_at: v.generated_at };
  },
  nfl() { return football('nfl'); },
  cfb() { return football('cfb'); },
  mlb() {
    let p = null; try { p = require(rel('mlb/params.js')); } catch (_) {}
    const wf = p && p.validation ? p.validation.walk_forward : false;
    const out = {};
    for (const k of ['moneyline', 'spread', 'total']) out[k] = { outcome: wf ? 'PROVISIONAL' : 'UNVALIDATED', market: 'NOT_TESTED', n: null, headline: 'mlb/params.js: walk_forward ' + wf + ', beats_closing_line null', file: 'mlb/params.js' };
    return { markets: out, files: ['mlb/params.js', 'docs/model-card-baseball.md'] };
  },
  tennis() {
    let t = ''; try { t = fs.readFileSync(rel('docs/tennis-lab-implementation-report.md'), 'utf8'); } catch (_) {}
    const m = /\|\s*\*\*EdgeDesk\*\*\s*\|\s*([\d,]+)\s*\|\s*\*\*([\d.]+)\*\*\s*\|\s*\*\*([\d.]+)\*\*/.exec(t);
    if (!m) return { markets: {}, files: [] };
    return { markets: { moneyline: { outcome: 'VALIDATED', market: 'NOT_TESTED', n: Number(m[1].replace(/,/g, '')), headline: 'held-out log loss ' + m[2] + ', Brier ' + m[3] + ' (beats overall Elo, surface Elo and ranking); market comparison not possible', file: 'docs/tennis-lab-implementation-report.md' } }, files: ['docs/tennis-lab-implementation-report.md'] };
  },
  none_research() { return { markets: {}, files: [] }; },
  none() { return { markets: {}, files: [] }; },
};

function build() {
  const sports = B.SPORTS.map((s) => {
    const ev = (READERS[s.evidence] || READERS.none)();
    const readiness = B.computeReadiness(s, ev);
    return {
      id: s.id, label: s.label, odds_keys: s.odds_keys, family: s.family, season_months: s.season, product: s.product,
      brain: { status: s.brain.status, id: s.brain.id, approach: s.brain.approach, why: s.brain.why, candidates: s.brain.candidates, inputs: s.brain.inputs, not_modelled: s.brain.not_modelled },
      readiness, evidence_files: ev.files, evidence_generated_at: ev.generated_at || null,
      data: s.data, blockers: s.blockers, enable: s.enable,
    };
  });
  const summary = {};
  for (const s of sports) summary[s.readiness.state] = (summary[s.readiness.state] || 0) + 1;
  return { schema: 'edgedesk_engine_registry_v1', version: B.VERSION, sports, summary, value_claims_enabled: sports.filter((s) => s.readiness.value_claims_any).map((s) => s.id), sources: B.SOURCES, states: B.STATE_LABEL };
}

function main() {
  const reg = build();
  const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  if (process.argv.includes('--check')) {
    const fails = [];
    if (!old) fails.push('engine/registry.json missing');
    else {
      /* a changed headline or timestamp (another sport's weekly record) is a WARNING: the 3-hourly build
         rebuilds the registry. A changed STATE is a failure: what the board may claim would differ. */
      const strip = (r) => JSON.stringify(Object.assign({}, r, { generated_at: null, sports: r.sports.map((s) => Object.assign({}, s, { evidence_generated_at: null })) }));
      if (strip(old) !== strip(reg)) console.warn('[registry --check] WARNING: engine/registry.json differs from a fresh build in detail; run node engine/build_registry.js');
      for (const s of reg.sports) {
        const o = old.sports.find((x) => x.id === s.id);
        const st = (r) => JSON.stringify([r.readiness.state, Object.entries(r.readiness.markets || {}).map(([k, m]) => k + ':' + m.state + ':' + m.value_claims)]);
        if (!o || st(o) !== st(s)) fails.push(s.id + ': the committed readiness state differs from the evidence (run node engine/build_registry.js)');
      }
      for (const s of old.sports) for (const [k, m] of Object.entries(s.readiness.markets || {})) if (m.value_claims && m.state !== 'MARKET_VALIDATED') fails.push(s.id + '.' + k + ' claims value without a market validation');
      for (const s of old.sports) if (s.brain.status === 'NOT_BUILT' && ['MARKET_VALIDATED', 'OUTCOME_VALIDATED', 'EXPERIMENTAL'].includes(s.readiness.state)) fails.push(s.id + ' has no brain but a model state');
    }
    if (fails.length) { console.error('[registry --check] FAILED: ' + fails.join('; ')); process.exit(1); }
    console.log('[registry --check] ok: ' + JSON.stringify(old.summary));
    return;
  }
  reg.generated_at = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(reg, null, 1) + '\n');
  console.log('[registry] ' + JSON.stringify(reg.summary) + '; value claims enabled in: ' + (reg.value_claims_enabled.join(', ') || 'none'));
  for (const s of reg.sports) console.log('  ' + s.label.padEnd(28) + s.readiness.state.padEnd(18) + Object.entries(s.readiness.markets).map(([k, m]) => k + '=' + m.state).join(' '));
}

if (require.main === module) main();
module.exports = { build, READERS };
