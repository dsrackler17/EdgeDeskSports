#!/usr/bin/env node
/* ============================================================================
   ALTITUDE MONITORING — football/altitude/monitoring.json.

   Three questions, answered every run, none of which ever changes a number:

     1  IS ANYTHING MOVING THAT SHOULD NOT? Every slate row's altitude section
        is read; a single applied point while the parameters are not
        VALIDATED is CRITICAL, and so is an engine contribution that disagrees
        with the section.
     2  IS THE DATA THERE? Slate coverage: how many games have a usable
        altitude context, and which venues have no sourced elevation.
     3  HOW IS THE SHADOW DOING, PROSPECTIVELY? The 2026 season was never
        seen by the fit (2006-2025). For every completed 2026 FBS game in the
        published record (record/football/cfb_2026.json: V1's pregame line,
        the close, the final) the frozen shadow candidate is applied to V1's
        own published margin and both are graded. It is the same question the
        backtest asked, on games that did not exist when it was asked.

   POLICY: warnings inform a person. Nothing here retrains, re-tunes, enables
   or disables anything (football/cfb_v2/monitoring.json's rule).

     node football/altitude/monitor.js [--write] [--season 2026]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
const A = require('./engine.js');
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const OUT = path.join(__dirname, 'monitoring.json');

function arg(name, fb) { const i = process.argv.indexOf('--' + name); if (i < 0) return fb; const v = process.argv[i + 1]; return v == null || String(v).startsWith('--') ? true : v; }
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (_) { return fb; } };
const num = (x) => (x == null || x === '' || x === 'NA' || !isFinite(+x) ? null : +x);
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length === head.length).map((r) => { const o = {}; head.forEach((h, j) => { o[h] = r[j]; }); return o; });
}
/* the season's schedule: the slate build's cache, then this module's */
function schedule(season) {
  for (const f of [path.join(ROOT, 'football', 'fbs', '.cache', 'cfb_schedules_' + season + '.csv'),
    path.join(__dirname, '.cache', 'cfb_schedules_' + season + '.csv')]) {
    if (fs.existsSync(f)) return parseCsv(fs.readFileSync(f, 'utf8')).map((r) => ({ game_id: r.game_id, season: num(r.season), start_date: r.start_date,
      neutral_site: /^true$/i.test(r.neutral_site), venue_id: num(r.venue_id), home_team: r.home_team, away_team: r.away_team }));
  }
  return null;
}

function build(opts) {
  opts = opts || {};
  const params = opts.params || require('./params.js');
  const registry = opts.registry || require('./venues.json');
  const slate = opts.slate || readJson('football/fbs/slate.json', { games: [] });
  const season = +(opts.season || slate.season || new Date().getUTCFullYear());
  const alerts = [];
  const validated = params.status === 'VALIDATED' && params.points_applied === true;

  /* 1 + 2 — the published slate */
  const games = slate.games || [];
  const withSec = games.filter((g) => g.altitude_travel);
  const usable = withSec.filter((g) => g.altitude_travel.quality && g.altitude_travel.quality.usable);
  const exposure = {};
  withSec.forEach((g) => { const k = g.altitude_travel.exposure ? g.altitude_travel.exposure.class : 'UNKNOWN'; exposure[k] = (exposure[k] || 0) + 1; });
  const applied = withSec.filter((g) => { const ec = g.altitude_travel.engine_contribution; return ec && ec.available === true && Math.abs(num(ec.points) || 0) > 0; });
  if (applied.length && !validated) alerts.push({ kind: 'POINTS_WITHOUT_VALIDATION', level: 'CRITICAL', message: applied.length + ' published game(s) carry altitude points while params.js is ' + params.status, evidence: applied.map((g) => g.game_id).slice(0, 10) });
  const disagree = withSec.filter((g) => { const ec = g.altitude_travel.engine_contribution, ad = g.altitude_travel.adjustment || {};
    const ep = ec && ec.available === true ? num(ec.points) || 0 : 0; return Math.abs(ep - (ad.applied ? num(ad.applied_points) || 0 : 0)) > 1e-6; });
  if (disagree.length) alerts.push({ kind: 'SECTION_ENGINE_DISAGREE', level: 'CRITICAL', message: 'the section and the engine disagree on applied points for ' + disagree.length + ' game(s)', evidence: disagree.map((g) => g.game_id).slice(0, 10) });
  const unavailable = withSec.filter((g) => !(g.altitude_travel.quality && g.altitude_travel.quality.usable))
    .map((g) => ({ game_id: g.game_id, game: g.away_team + ' @ ' + g.home_team, why: (g.altitude_travel.missing || []).join('; ') }));
  if (unavailable.length) alerts.push({ kind: 'ELEVATION_UNAVAILABLE', level: 'WARN', message: unavailable.length + ' slate game(s) have no usable altitude context (a venue without a sourced elevation)', evidence: unavailable.slice(0, 10) });
  if (games.length && !withSec.length) alerts.push({ kind: 'SECTION_NOT_PUBLISHED', level: 'WARN', message: 'football/fbs/slate.json carries no altitude_travel section (the slate was built before the module, or the module failed to load)', evidence: { slate_generated_at: slate.generated_at || null } });
  const regAgeDays = registry.generated_at ? (Date.now() - Date.parse(registry.generated_at)) / 864e5 : null;
  if (regAgeDays != null && regAgeDays > 400) alerts.push({ kind: 'REGISTRY_STALE', level: 'WARN', message: 'football/altitude/venues.json is ' + Math.round(regAgeDays) + ' days old: rebuild it (npm run cfb:altitude:venues)', evidence: { generated_at: registry.generated_at } });

  /* 3 — the prospective shadow record on completed games of this season */
  const rec = opts.record || readJson('record/football/cfb_' + season + '.json', null);
  const sched = opts.schedule || schedule(season);
  let prospective = { available: false, reason: !rec ? 'no record/football/cfb_' + season + '.json' : 'no ' + season + ' schedule in the build cache' };
  if (rec && sched) {
    const byId = {}; sched.forEach((r) => { byId[String(r.game_id)] = r; });
    const env = { registry, normKey: FBS.normKey, index: A.teamIndex(sched, FBS.normKey) };
    const graded = [];
    Object.keys(rec.games || {}).forEach((id) => {
      const g = rec.games[id], s = byId[id];
      if (!s || !g.final || g.final.home_score == null || g.home_division !== 'fbs' || g.away_division !== 'fbs') return;
      const pre = g.pick || g.first;
      if (!pre || num(pre.home_line) == null) return;
      const ctx = A.context(s, env);
      const adj = A.adjustment(ctx, params, { flag_enabled: false });
      const v1 = -num(pre.home_line), margin = g.final.home_score - g.final.away_score;
      graded.push({ game_id: id, kickoff: g.kickoff, v1, arm: v1 + (num(adj.shadow_points) || 0), shadow: num(adj.shadow_points) || 0,
        margin, close: g.close && num(g.close.home_line) != null ? -num(g.close.home_line) : null,
        exposure: ctx.exposure.class, usable: ctx.quality.usable, neutral: ctx.neutral_site });
    });
    const aff = graded.filter((x) => Math.abs(x.shadow) > 1e-9);
    const mae = (rows, k) => r3(mean(rows.map((x) => Math.abs(x.margin - x[k]))));
    const high = graded.filter((x) => x.exposure === 'HIGH' && !x.neutral);
    const withClose = high.filter((x) => x.close != null && x.margin !== x.close);
    prospective = {
      available: true, season, fit_window: params.shadow_candidate ? params.shadow_candidate.fitted_on : null,
      what: 'the frozen shadow candidate applied to V1’s own published pregame margin (record/football/cfb_' + season + '.json), graded on finals; ' + season + ' was never seen by the fit',
      graded_games: graded.length, usable: graded.filter((x) => x.usable).length,
      affected: { n: aff.length, mae_v1: mae(aff, 'v1'), mae_shadow: mae(aff, 'arm'), improvement: aff.length ? r3(mae(aff, 'v1') - mae(aff, 'arm')) : null,
        v1_bias: r3(mean(aff.map((x) => x.margin - x.v1))) },
      high_exposure: { n: high.length, v1_residual: r3(mean(high.map((x) => x.margin - x.v1))),
        close_residual: withClose.length ? r3(mean(withClose.map((x) => x.margin - x.close))) : null,
        visitor_covers: withClose.length ? withClose.filter((x) => x.margin < x.close).length + ' of ' + withClose.length : null },
      reading: aff.length < 30 ? 'fewer than 30 affected games: too few to read anything into, by design' : 'compare with the backtest’s confirmation window (docs/cfb-altitude/BACKTEST.md)'
    };
    if (aff.length >= 30 && prospective.affected.improvement < -0.5) alerts.push({ kind: 'SHADOW_UNDERPERFORMING', level: 'INFO', message: 'the shadow adjustment is ' + Math.abs(prospective.affected.improvement) + ' pts of MAE worse than V1 on ' + aff.length + ' affected ' + season + ' games', evidence: prospective.affected });
  }

  return {
    schema: 'edgedesk_cfb_altitude_monitoring_v1',
    generated_at: new Date().toISOString(),
    policy: 'warnings inform a person; nothing here retrains, re-tunes, enables or disables anything',
    ok: !alerts.some((a) => a.level === 'CRITICAL'),
    params: { model_version: params.model_version, status: params.status, points_applied: params.points_applied === true,
      shadow_candidate: params.shadow_candidate ? params.shadow_candidate.id : null, flag: 'cfb_altitude_adjustment_enabled' },
    slate: { generated_at: slate.generated_at || null, games: games.length, with_section: withSec.length, usable: usable.length, exposure,
      applied_games: applied.length, unavailable },
    registry: { generated_at: registry.generated_at || null, venues: registry.counts ? registry.counts.venues : null, by_confidence: registry.counts ? registry.counts.by_confidence : null },
    prospective,
    alerts
  };
}

if (require.main === module) {
  const out = build({ season: arg('season', null) });
  if (arg('write', false)) fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ ok: out.ok, slate: { games: out.slate.games, with_section: out.slate.with_section, applied_games: out.slate.applied_games },
    prospective: out.prospective.available ? { graded: out.prospective.graded_games, affected: out.prospective.affected } : out.prospective.reason,
    alerts: out.alerts.map((a) => a.level + ' ' + a.kind) }, null, 1));
  process.exit(out.ok ? 0 : 2);
}
module.exports = { build };
