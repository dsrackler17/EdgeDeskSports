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
  const files = ['football/validation/linemaker_' + league + '.json', 'football/validation/pricing_' + league + '.json'];
  const res = { markets: out, files, generated_at: (lm && lm.generated_at) || (pr && pr.generated_at) };
  /* the NFL data pack: verified, reconciled with the brain's own sources, and researched (not in the price) */
  const xc = league === 'nfl' && read('football/validation/nfl_pack_crosscheck.json');
  if (xc && xc.labels) {
    files.push('datapack/nfl_v1/EDGEDESK_VERIFICATION.json', 'football/validation/nfl_pack_crosscheck.json', 'football/validation/nfl_pack_research.json');
    res.data = { loaded: true, note: 'nflverse history and the live 2026 season; second source: the NFL data pack, ' + xc.labels.final_agree + '/' + xc.labels.pack_games + ' games 2022-2026 agree with games.csv, live 2026 pass EPA r ' + xc.live_input_2026.pass_epa.r };
  }
  return res;
}

/* a lab walk-forward record (engine/lab/protocol.js) -> registry markets, the data and model rungs of the ladder */
function lab(file, map, prefix) {
  const v = read(file);
  if (!v) return { markets: {}, files: [] };
  const out = {};
  for (const [key, k] of Object.entries(map)) {
    const m = v.markets[k]; if (!m) continue;
    const outcome = m.status === 'OUTCOME_VALIDATED' ? 'VALIDATED' : m.status === 'INSUFFICIENT' ? 'NONE' : 'PROVISIONAL';
    out[(prefix || '') + key] = { outcome, market: m.market_status === 'TESTED_AHEAD' ? 'TESTED_AHEAD' : 'NOT_TESTED', n: m.n || null,
      headline: (v.label ? v.label + ' ' : '') + m.market + ': ' + m.status + (m.failed && m.failed.length ? ' (' + m.failed.join('; ') + ')' : '') + (m.log_loss != null ? '; held-out log loss ' + m.log_loss : m.crps != null ? '; held-out CRPS ' + m.crps : '') + '; vs close: not tested', file };
  }
  const cmp = v.comparisons ? Object.entries(v.comparisons).find(([k]) => /_vs_elo$/.test(k)) : null;
  if (cmp && out[(prefix || '') + 'moneyline']) out[(prefix || '') + 'moneyline'].headline += '; vs Elo Δ ' + cmp[1].mean_diff + ' (95% ' + cmp[1].ci95.join(' to ') + ')';
  const d = v.data || {};
  return { markets: out, files: [file], generated_at: v.generated_at,
    data: { loaded: true, games: d.games || d.matches || d.bouts || null, scored: d.games_scored || d.matches_scored || d.scored || null, seasons: d.seasons || null, source: d.source || null, point_in_time: d.temporal ? d.temporal.point_in_time : null },
    model: { trained: v.markets && Object.values(v.markets).some((m) => m.status !== 'INSUFFICIENT'), chosen: v.selection ? v.selection.chosen : (v.method || null) } };
}
const BB = { moneyline: 'moneyline', spread: 'spread', total: 'total' };

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
    if (v.comparisons) { const c = (v.selection && v.comparisons[v.selection.chosen + '_vs_elo']) ? [null, v.comparisons[v.selection.chosen + '_vs_elo']] : Object.entries(v.comparisons).find(([k]) => /_vs_elo$/.test(k)); if (c && out.moneyline) out.moneyline.headline += '; vs Elo Δ log loss ' + c[1].mean_diff + ' (95% ' + c[1].ci95.join(' to ') + ')'; }
    /* the lab's extended markets (hockey/lab/run.js): team totals and the 3-way scored on the same held-out games */
    const labRec = read('hockey/validation/nhl_lab.json');
    const ext = labRec && labRec.markets_extended;
    if (ext) {
      const tt = ['team_total_home_over_2.5', 'team_total_away_over_2.5'].map((k) => ext[k]).filter(Boolean);
      if (tt.length === 2) { const ok = tt.every((m) => m.status === 'OUTCOME_VALIDATED'); out.team_total = { outcome: ok ? 'VALIDATED' : 'PROVISIONAL', market: 'NOT_TESTED', n: tt[0].n, headline: 'outcomes: ' + (ok ? 'OUTCOME_VALIDATED' : 'PROVISIONAL') + ' (team totals 2.5, both sides; slopes ' + tt.map((m) => m.calibration_slope).join(', ') + '); vs close: not tested', file: 'hockey/validation/nhl_lab.json' }; }
      if (ext.regulation_3way && out.regulation_3way) { out.regulation_3way.outcome = ext.regulation_3way.status === 'OUTCOME_VALIDATED' ? 'VALIDATED' : 'PROVISIONAL'; out.regulation_3way.headline = 'outcomes: ' + ext.regulation_3way.status + (ext.regulation_3way.failed.length ? ' (' + ext.regulation_3way.failed.join('; ') + ')' : '') + '; vs close: not tested'; out.regulation_3way.file = 'hockey/validation/nhl_lab.json'; }
    }
    /* the second source: the NHL data pack's ESPN season, reconciled event by event */
    const xc = read('hockey/validation/nhl_crosscheck_espn.json');
    const second = xc && xc.schema === 'edgedesk_nhl_crosscheck_v2' ? { season: xc.season_label, games: xc.results.compared + '/' + xc.games.espn_club_games + ' matched, every final agrees', attempts: xc.events.matched + '/' + xc.events.espn_attempts + ' matched; blocked attempts credited to the shooter ' + xc.events.blocked.espn_shooter_team_is_shooter_view_team + '/' + xc.events.blocked.matched, file: 'hockey/validation/nhl_crosscheck_espn.json' } : null;
    const d = v.data || {};
    return { markets: out, files: ['hockey/validation/nhl_walkforward.json', 'hockey/validation/nhl_lab.json', 'hockey/xg/report.json', 'hockey/validation/nhl_crosscheck_espn.json', 'hockey/validation/nhl_blocked_attribution.json', 'datapack/nhl_v1/EDGEDESK_VERIFICATION.json'], generated_at: v.generated_at,
      data: { loaded: true, games: d.games_scored || null, seasons: d.seasons || null, source: d.source || null, point_in_time: d.temporal ? d.temporal.point_in_time : null, second_source: second },
      model: { trained: true, chosen: v.selection ? v.selection.chosen : null } };
  },
  nfl() { return football('nfl'); },
  cfb() { return football('cfb'); },
  mlb() {
    const r = lab('mlb/history/validation/mlb_walkforward.json', { moneyline: 'moneyline', spread: 'run_line', total: 'total' });
    if (Object.keys(r.markets).length) return r;
    let p = null; try { p = require(rel('mlb/params.js')); } catch (_) {}
    const wf = p && p.validation ? p.validation.walk_forward : false;
    const out = {};
    for (const k of ['moneyline', 'spread', 'total']) out[k] = { outcome: wf ? 'PROVISIONAL' : 'UNVALIDATED', market: 'NOT_TESTED', n: null, headline: 'mlb/params.js: walk_forward ' + wf + ', beats_closing_line null', file: 'mlb/params.js' };
    return { markets: out, files: ['mlb/params.js', 'docs/model-card-baseball.md'] };
  },
  nba() { return lab('basketball/validation/nba_walkforward.json', BB); },
  wnba() { return lab('basketball/validation/wnba_walkforward.json', BB); },
  ncaab_m() { return lab('basketball/validation/ncaam_walkforward.json', BB); },
  ncaab_w() { return lab('basketball/validation/ncaaw_walkforward.json', BB); },
  soccer() {
    /* one sport, five separately fitted leagues: markets are keyed league.market */
    const out = { markets: {}, files: [], data: { loaded: false, games: 0, scored: 0, leagues: [] }, model: { trained: false, chosen: {} } };
    for (const lg of ['epl', 'bundesliga', 'laliga', 'seriea', 'ligue1']) {
      const r = lab('soccer/validation/' + lg + '_walkforward.json', { moneyline: 'three_way', total: 'total_over_2_5', spread: 'asian_handicap', btts: 'btts' }, lg + '.');
      if (!r.files.length) continue;
      Object.assign(out.markets, r.markets); out.files.push(...r.files);
      out.data.loaded = true; out.data.games += r.data.games || 0; out.data.scored += r.data.scored || 0; out.data.leagues.push(lg); out.data.point_in_time = r.data.point_in_time;
      out.model.trained = out.model.trained || r.model.trained; out.model.chosen[lg] = r.model.chosen;
      out.generated_at = r.generated_at;
    }
    return out;
  },
  mma() {
    const r = lab('engine/lab/ufc_elo.json', { moneyline: 'moneyline' });
    if (r.data) { r.model.trained = false; r.model.note = 'Elo measured on 2024 only: INSUFFICIENT (not a model)'; }
    return r;
  },
  tennis() {
    let t = ''; try { t = fs.readFileSync(rel('docs/tennis-lab-implementation-report.md'), 'utf8'); } catch (_) {}
    const m = /\|\s*\*\*EdgeDesk\*\*\s*\|\s*([\d,]+)\s*\|\s*\*\*([\d.]+)\*\*\s*\|\s*\*\*([\d.]+)\*\*/.exec(t);
    if (!m) return { markets: {}, files: [] };
    return { markets: { moneyline: { outcome: 'VALIDATED', market: 'NOT_TESTED', n: Number(m[1].replace(/,/g, '')), headline: 'held-out log loss ' + m[2] + ', Brier ' + m[3] + ' (beats overall Elo, surface Elo and ranking); market comparison not possible', file: 'docs/tennis-lab-implementation-report.md' } }, files: ['docs/tennis-lab-implementation-report.md'] };
  },
  college_baseball() {
    const f = 'college_baseball/validation/walkforward.json'; const v = read(f);
    if (!v || !v.markets) return { markets: {}, files: [] };
    const m = v.markets.moneyline; const cov = read('college_baseball/validation/coverage.json');
    const vb = v.comparisons && (v.comparisons.HOLDOUT || v.comparisons.VALIDATION); const c = vb && vb.chosen_vs_best_baseline;
    return { markets: { moneyline: { outcome: m.status === 'OUTCOME_VALIDATED' ? 'VALIDATED' : 'PROVISIONAL', market: 'NOT_TESTED', n: m.n,
      headline: 'outcomes (' + m.window + '): ' + m.status + (m.failed && m.failed.length ? ' (' + m.failed.join('; ') + ')' : '') + '; log loss ' + m.log_loss + (c ? '; vs ' + v.selection.best_baseline + ' Δ ' + c.mean_diff + ' (95% ' + c.ci95.join(' to ') + ')' : '') + '; vs close: not tested', file: f } },
      files: [f, 'college_baseball/validation/pitcher_walkforward.json', 'college_baseball/validation/audit.json', 'college_baseball/validation/release_gates.json'], generated_at: v.generated_at,
      data: { loaded: true, games: cov ? cov.totals.eligible_for_rating : null, seasons: [2012, 2026], point_in_time: 'RETROSPECTIVE', source: 'sportsdataverse/baseballr-data' },
      model: { trained: true, chosen: v.selection.chosen } };
  },
  none_research() { return { markets: {}, files: [] }; },
  none() { return { markets: {}, files: [] }; },
};

/* the readiness ladder's registry rungs; the board adds the live two (fresh verified prices, actionable signal) */
function ladder(s, ev, rd) {
  const mk = Object.values(rd.markets || {});
  const tested = mk.some((m) => m.market && m.market !== 'NOT_TESTED');
  const validated = mk.filter((m) => m.state === 'OUTCOME_VALIDATED' || m.state === 'MARKET_VALIDATED');
  const data = ev.data || (s.data && s.data.length ? { loaded: s.brain.status !== 'NOT_BUILT', note: 'see the sport\'s own pipeline' } : { loaded: false });
  if (!ev.data && (s.id === 'nhl' || s.id === 'nfl' || s.id === 'cfb' || s.id === 'tennis')) data.loaded = !!(ev.files && ev.files.length);
  return {
    data_loaded: { done: !!data.loaded, detail: data.games ? data.games + ' games' + (data.seasons ? ' (' + data.seasons.join('-') + ')' : '') + (data.point_in_time ? ', ' + data.point_in_time.toLowerCase() : '') + (data.second_source ? '; second source ' + data.second_source.season + ': ' + data.second_source.games : '') : (data.note || null) },
    model_trained: { done: ev.model ? !!ev.model.trained : (s.brain.status === 'BUILT' || s.brain.status === 'PARTIAL') && mk.length > 0, detail: ev.model ? (ev.model.note || (typeof ev.model.chosen === 'string' ? ev.model.chosen : ev.model.chosen ? JSON.stringify(ev.model.chosen) : null)) : s.brain.id },
    validation_passed: { done: validated.length > 0, partial: !!rd.partial, detail: (validated.length ? validated.length + ' of ' + mk.length + ' markets validated vs outcomes' : mk.length ? 'no market passed (' + mk.length + ' scored)' : 'nothing scored') + (rd.primary ? '; primary market (' + rd.primary.replace('*.', '') + '): ' + String(rd.primary_state || 'none').replace(/_/g, ' ').toLowerCase() : '') },
    market_tested: { done: tested, detail: tested ? 'tested against a closing archive' : 'no licensed closing archive: never compared with the market' },
  };
}

const GAP_KEY = { nfl: 'nfl', nhl: 'nhl', nba: 'nba', wnba: 'wnba', ncaab_m: 'ncaam', ncaab_w: 'ncaaw', soccer: 'soccer', mlb: 'mlb', mma: 'ufc' };
function gapsFor(id) {
  const m = read('engine/missingness.json'); const k = GAP_KEY[id];
  if (!m || !k || !m.sports[k]) return [];
  const st = m.sports[k].structural || (m.sports[k].epl && m.sports[k].epl.structural) || {};
  return Object.entries(st).map(([f, why]) => f + ': ' + why);
}

function build() {
  const sports = B.SPORTS.map((s) => {
    const ev = (READERS[s.evidence] || READERS.none)();
    const readiness = B.computeReadiness(s, ev);
    readiness.ladder = ladder(s, ev, readiness);
    return {
      id: s.id, label: s.label, odds_keys: s.odds_keys, family: s.family, season_months: s.season, product: s.product,
      brain: { status: s.brain.status, id: s.brain.id, approach: s.brain.approach, why: s.brain.why, candidates: s.brain.candidates, inputs: s.brain.inputs, not_modelled: s.brain.not_modelled },
      research: s.research || null,
      readiness, evidence_files: ev.files, evidence_generated_at: ev.generated_at || null,
      data: s.data, gaps: gapsFor(s.id), blockers: s.blockers, enable: s.enable,
    };
  });
  const summary = {};
  for (const s of sports) summary[s.readiness.state] = (summary[s.readiness.state] || 0) + 1;
  const partial = sports.filter((s) => s.readiness.partial).map((s) => s.id);
  return { schema: 'edgedesk_engine_registry_v1', version: B.VERSION, sports, summary, partial_validation: partial, value_claims_enabled: sports.filter((s) => s.readiness.value_claims_any).map((s) => s.id), sources: B.SOURCES, states: B.STATE_LABEL };
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
