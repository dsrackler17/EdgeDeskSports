#!/usr/bin/env node
/* ============================================================================
   NFL — A NEUTRAL SITE HAS NO HOME TEAM (second follow-up to the 2026-09-30
   audit; found by item 3's orientation / home-field check).

   The NFL engine's spread intercept is the fitted home-field advantage. It was
   applied to the nominal home side of every game, including the international
   and neutral-site games nflverse marks location = Neutral. This reads the
   walk-forward out-of-sample predictions (football/research/nfl_regime.py
   writes .cache/research_out/nfl_oos.csv: each season predicted with weights
   fitted on the seasons before it) on those games and asks what the intercept
   did there, with no parameter fitted here:

     residual        final margin - model, on neutral sites (a misapplied home
                     field shows as the nominal home side finishing under it)
     MAE             with the intercept vs without it (the shipped change),
                     paired bootstrap 95% CI, games resampled
     |model - close| the same, for context only (the market is never an input)

     node football/research/nfl_neutral_site.js
   Writes football/research/report/nfl_neutral_site.json
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CACHE = path.join(ROOT, 'football', 'nfl', '.cache');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'params.js'));
const W = global.window.EDFootballParams.nfl || global.window.EDFootballParams;

function readCsv(file) {
  const t = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const split = (l) => { const o = []; let f = '', q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"') { if (l[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { o.push(f); f = ''; } else f += c; } o.push(f); return o; };
  const h = split(t[0]);
  return t.slice(1).map((l) => { const v = split(l); const o = {}; h.forEach((k, i) => { o[k] = v[i]; }); return o; });
}
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
const r3 = (x) => x == null ? null : Math.round(x * 1000) / 1000;
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
function boot(a, seed) {
  let s = seed >>> 0; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const B = 4000, m = [];
  for (let b = 0; b < B; b++) { let t = 0; for (let i = 0; i < a.length; i++) t += a[Math.floor(rnd() * a.length)]; m.push(t / a.length); }
  m.sort((x, y) => x - y);
  return [r3(m[Math.floor(0.025 * B)]), r3(m[Math.floor(0.975 * B)])];
}

const gamesFile = path.join(CACHE, 'https_raw.githubusercontent.com_nflverse_nfldata_master_data_games.csv');
const oosFile = path.join(CACHE, 'research_out', 'nfl_oos.csv');
if (!fs.existsSync(gamesFile) || !fs.existsSync(oosFile)) {
  console.error('missing ' + (!fs.existsSync(gamesFile) ? gamesFile : oosFile) + ' (run tools/football/build_nfl_slate.js and football/research/nfl_regime.py first)');
  process.exit(2);
}
const loc = {}; readCsv(gamesFile).forEach((g) => { loc[g.game_id] = { location: g.location, stadium: g.stadium, type: g.game_type }; });
const H = W.w_spread[W.w_spread.length - 1];
const rows = readCsv(oosFile).filter((o) => loc[o.game_id] && loc[o.game_id].location === 'Neutral')
  .map((o) => ({ id: o.game_id, season: +o.season, margin: num(o.margin), model: num(o.model_spread), close: num(o.spread_line), type: loc[o.game_id].type }))
  .filter((r) => r.margin != null && r.model != null);
const dMae = rows.map((r) => Math.abs(r.margin - (r.model - H)) - Math.abs(r.margin - r.model));
const withClose = rows.filter((r) => r.close != null);
const dClose = withClose.map((r) => Math.abs((r.model - H) - r.close) - Math.abs(r.model - r.close));
const reg = rows.filter((r) => r.type === 'REG');
const dReg = reg.map((r) => Math.abs(r.margin - (r.model - H)) - Math.abs(r.margin - r.model));
const ciMae = boot(dMae, 20260930);
const rep = {
  schema: 'edgedesk_nfl_neutral_site_v1', generated_at: new Date().toISOString(), generated_by: 'football/research/nfl_neutral_site.js',
  data: { predictions: 'football/nfl/.cache/research_out/nfl_oos.csv (walk-forward: each season from weights fitted on the seasons before it)',
    sites: 'nflverse games.csv location = Neutral', games: rows.length, seasons: rows.length ? [Math.min(...rows.map((r) => r.season)), Math.max(...rows.map((r) => r.season))] : null,
    regular_season: reg.length, postseason: rows.length - reg.length },
  intercept_removed_pts: r3(H),
  intercept_note: 'the shipped intercept (football/params.js w_spread), removed from every season\u2019s walk-forward prediction; nfl_oos.csv does not carry each season\u2019s own fitted intercept, so earlier seasons are approximated',
  mean_residual_at_neutral_sites: r3(mean(rows.map((r) => r.margin - r.model))),
  mean_residual_ci95: boot(rows.map((r) => r.margin - r.model), 7),
  mae: { with_home_field: r3(mean(rows.map((r) => Math.abs(r.margin - r.model)))), without: r3(mean(rows.map((r) => Math.abs(r.margin - (r.model - H))))),
    delta: r3(mean(dMae)), delta_ci95: ciMae, significant: ciMae[1] < 0 },
  regular_season_only: { games: reg.length, delta: r3(mean(dReg)), delta_ci95: boot(dReg, 11) },
  context_gap_to_close: { games: withClose.length, delta: r3(mean(dClose)), delta_ci95: boot(dClose, 13),
    note: 'context only: the market is never an input to the number, and the pass/fail is the final margin' },
  decision: ciMae[1] < 0 ? 'the removal improves MAE with a 95% interval below zero'
    : 'NOT significant on final margins (the interval includes zero). Shipped as a correction of what the term means — a neutral site has no home team — not as a fitted gain.'
};
fs.mkdirSync(path.join(__dirname, 'report'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'report', 'nfl_neutral_site.json'), JSON.stringify(rep, null, 1) + '\n');
console.log(JSON.stringify(rep, null, 1));
