#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The DAILY refresh: the champion's ratings on the newest games, immutable
   pregame forecasts for the next games, Upset Watch, atomic publication.

     node basketball/ncaam_forecast/refresh.js [--hours 48] [--publish] [--now ISO]

   The window: games starting in the next --hours, except in the PRESEASON.
   Before the season's first regular-season game (the earliest season_type 2
   game in its schedule file) the window runs to the end of the opening week
   (opener + 7 days): no game moves a rating before then, so the opening slate
   is priced from preseason ratings (last season's, carried) and every such
   forecast is flagged PRESEASON_RATINGS. From the opener on, the routine
   window applies with no change by anyone.

   Exhibitions: the schedule files carry none (the source has no season_type 1
   row in any season). The schools list theirs, and basketball/exhibitions.js
   reads them from the collegiate collector's copies of their schedules. Each
   one in the window is priced as a game between the same two teams would be,
   flagged EXHIBITION (a school may rest its regulars: the model was never
   tested on these games), never in Upset Watch, and never a game the ratings
   learn from (it is not in the dataset).

   Routine only: the champion's CONFIGURATION is fixed (registry/champion.json);
   only its ratings and calibration move with new results. No parameter is
   chosen and nothing is promoted here (weekly.js does that, behind gates).

   Gates that BLOCK publication (the previous published run stays visible):
     data.hashes        every season file matches data/manifest.json
     data.fresh         the season-in-progress source was fetched within 36 h
     data.box_coverage  >= 97% of the season's finals have usable box scores
                        (checked once the season has 200 finals)
     run.finite         every probability finite and inside (0, 1); margin and
                        total distributions coherent (P(win) = PMF mass > 0)
     model.champion     the champion is a model this system can serve (the
                        incumbent points model is served by basketball/
                        build_slate.js until a challenger is promoted)
   Each forecast carries: model version and artifact sha256, the training
   snapshot sha256, availability assumption, data-quality flags, provenance
   (Research = model output), the probability and interval definitions.
   Premium output: written to basketball/ncaam_forecast/out/ (gitignored) and
   published through Supabase only — never committed.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const DS = require('./dataset');
const MD = require('./model');
const UP = require('./upset');
const FA = require('./factors');
const RG = require('./registry');
const EX = require('../exhibitions');

const AVAILABILITY = 'Not modelled: no owned college-basketball availability feed. Ratings reflect the players who have actually played; an absence announced before tip is NOT in this number.';
const DEFINITIONS = {
  p_home: 'probability the home (listed first) team wins, overtime included; read from the same distribution as the margin',
  margin_interval_80: 'central 80% interval of the final margin (home minus away), overtime included; integer valued, never 0',
  total_interval_80: 'central 80% interval of total points, overtime included',
  provenance: 'Research = model output; Observed = recorded fact; Estimated = assumption-based input',
};

function quarantinedThisSeason(games, season) { const m = new Map(); for (const g of games) if (g.season === season && g.quarantine.length) for (const t of [g.home_id, g.away_id]) m.set(t, (m.get(t) || 0) + 1); return m; }

/** the season's first regular-season game (ms), or Infinity when its schedule lists none yet */
function regularSeasonStart(games, season) { let t = Infinity; for (const g of games) if (g.season === season && g.season_type === 2 && g.start_ms < t) t = g.start_ms; return t; }
const OPENING_WEEK_MS = 7 * 86400e3;
/** the forecast window: PRESEASON (before the opener) through the end of the opening week; the routine hours from the opener on */
function forecastWindow(games, season, nowMs, hours) {
  const opener = regularSeasonStart(games, season); const routine = nowMs + (hours || 48) * 3600e3;
  const iso = Number.isFinite(opener) ? new Date(opener).toISOString() : null;
  if (nowMs < opener && Number.isFinite(opener)) return { phase: 'preseason', from: nowMs, to: Math.max(routine, opener + OPENING_WEEK_MS), regular_season_start: iso };
  return { phase: 'season', from: nowMs, to: routine, regular_season_start: iso };
}

/** the season's Division I teams (the dataset's own membership flags); a team the season does not list yet keeps last season's */
function d1Teams(games, season) {
  const now = new Map(), before = new Set();
  for (const g of games) {
    if (g.season === season) { now.set(g.home_id, now.get(g.home_id) || g.home_d1 === 1); now.set(g.away_id, now.get(g.away_id) || g.away_d1 === 1); }
    else if (g.season === season - 1) { if (g.home_d1 === 1) before.add(g.home_id); if (g.away_d1 === 1) before.add(g.away_id); }
  }
  const out = new Set([...now].filter(([, d1]) => d1).map(([id]) => id));
  for (const id of before) if (!now.has(id)) out.add(id);
  return out;
}

function buildForecasts(games, art, policy, o) {
  o = o || {};
  const nowMs = o.nowMs; const horizon = o.toMs || nowMs + (o.hours || 48) * 3600e3; const season = art.season;
  const teams = JSON.parse(fs.readFileSync(C.PATHS.teams, 'utf8')).teams;
  const quar = quarantinedThisSeason(games, season);
  const fac = FA.teamFactors(games.filter((g) => g.season === season && Date.parse(g.assumed_available_at) < nowMs),
    games.filter((g) => g.season === season && g.status === 'SCHEDULED' && g.start_ms >= nowMs && g.start_ms < horizon));
  const out = [];
  for (const g of games) {
    if (g.season !== season || g.status !== 'SCHEDULED' || !(g.start_ms >= nowMs && g.start_ms < horizon)) continue;
    if (!g.home_id || !g.away_id || g.home_id === g.away_id) continue;
    const pr = MD.predict(art, g);
    const flags = [];
    const gh = art.teams[g.home_id] ? art.teams[g.home_id].games : 0, ga = art.teams[g.away_id] ? art.teams[g.away_id].games : 0;
    if (g.exhibition) flags.push('EXHIBITION');
    if (g.start_approx) flags.push('START_TIME_APPROX');
    if (o.preseason) flags.push('PRESEASON_RATINGS');
    if (Math.min(gh, ga) < 5) flags.push('EARLY_SEASON_FEW_GAMES');
    if (!art.teams[g.home_id] || !art.teams[g.away_id]) flags.push('TEAM_WITHOUT_RATING_HISTORY');
    if (pr.raw.regime === 'D1_OTHER') flags.push('NON_D1_OPPONENT_POOLED');
    if ((quar.get(g.home_id) || 0) + (quar.get(g.away_id) || 0) > 0) flags.push('TEAM_HAS_QUARANTINED_GAMES');
    const base = { game_id: g.game_id, start_utc: g.start_utc, home_id: g.home_id, away_id: g.away_id, home_name: g.home_name || (teams[g.home_id] || {}).name || g.home_id, away_name: g.away_name || (teams[g.away_id] || {}).name || g.away_id,
      neutral: !!g.neutral, event: g.event, regime: pr.raw.regime, games_played: { home: gh, away: ga }, data_quality: flags, availability_assumption: AVAILABILITY, provenance: 'Research' };
    if (!pr.available) { out.push(Object.assign(base, { available: false, reason: pr.reason })); continue; }
    const f = pr.fc;
    const rec = Object.assign(base, {
      available: true, p_home: f.p_home, p_away: f.p_away, p_ot: f.p_ot,
      margin: { mean: f.margin.mean, sd: f.margin.sd, q05: f.margin.q05, q10: f.margin.q10, q50: f.margin.q50, q90: f.margin.q90, q95: f.margin.q95 },
      total: { mean: f.total.mean, sd: f.total.sd, q05: f.total.q05, q10: f.total.q10, q50: f.total.q50, q90: f.total.q90, q95: f.total.q95 },
      pts_home: f.pts_home, pts_away: f.pts_away, regulation: f.regulation,
      /* what live_writer.js conditions on: this game's regulation distribution and its regime's endgame/overtime calibration */
      live_inputs: { mu: f.regulation.mu, sd: f.regulation.sd, kappa: (art.calibration[pr.raw.regime] || {}).kappa, ot_sd: f.overtime.sd },
    });
    if (policy && !g.exhibition) {
      const fa = fac.get(g.game_id) || {};
      const up = UP.classify(g, f, policy, { seeds_verified: false, games_home: gh, games_away: ga });
      const dog = up.underdog === 'home' ? fa.home : fa.away, fav = up.underdog === 'home' ? fa.away : fa.home;
      rec.upset = Object.assign(up, { factors: FA.hypotheses(dog, fav, pr.raw.tempo), factor_status: 'descriptive (config/upset_policy.json verdicts; no factor changes a probability)' });
    }
    out.push(rec);
  }
  return out.sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
}

function gates(games, art, fcs, nowMs) {
  const man = DS.manifest(); const cur = art.season; const cov = DS.coverage(games)[cur];
  const src = man.seasons[cur] && man.seasons[cur].sources && man.seasons[cur].sources.schedule;
  const age = src ? (nowMs - Date.parse(src.fetched_at)) / 3600e3 : Infinity;
  const G = [];
  G.push({ id: 'data.hashes', pass: true, detail: 'every season file matched data/manifest.json (dataset.load throws otherwise)' });
  G.push({ id: 'data.fresh', pass: age <= 36, detail: 'season ' + cur + ' schedule fetched ' + (Number.isFinite(age) ? age.toFixed(1) + ' h' : 'never') + ' ago (limit 36 h)' });
  G.push({ id: 'data.box_coverage', pass: !cov || cov.final < 200 || cov.box_coverage >= 0.97, detail: cov ? cov.box_ok + ' of ' + cov.final + ' finals have usable box scores' : 'no finals yet' });
  const bad = fcs.filter((f) => f.available && !(f.p_home > 0 && f.p_home < 1 && Number.isFinite(f.margin.mean) && Number.isFinite(f.total.mean)));
  G.push({ id: 'run.finite', pass: !bad.length, detail: bad.length ? bad.length + ' non-finite forecasts' : fcs.length + ' forecasts finite and inside (0, 1)' });
  return G;
}

async function refresh(o) {
  o = o || {};
  const nowMs = o.now ? Date.parse(o.now) : Date.now();
  const ptr = RG.readPointer() || RG.init();
  const rv = RG.verify();
  if (!rv.ok) { const e = new Error('the registry disagrees with itself (' + rv.reasons.join('; ') + '): nothing built or published'); e.exitCode = 1; throw e; }
  const champ = RG.readModel(ptr.current.key);
  if (!champ || champ.engine !== 'research_team_model') {
    const r = { status: 'NOT_SERVED', champion: ptr.current.key, reason: 'the champion is the incumbent points model, served by basketball/build_slate.js; this system publishes forecasts once a challenger passes the weekly gates' };
    console.log(JSON.stringify(r)); return r;
  }
  const games = DS.load();
  const art = MD.buildArtifact(games, champ.config, nowMs, { season: C.currentSeason(nowMs) });
  const policyFile = C.PATHS.upsetPolicy; const policy = fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : null;
  const win = forecastWindow(games, art.season, nowMs, o.hours);
  const ex = EX.exhibitions('ncaam', games, { season: art.season, fromMs: nowMs, toMs: win.to, d1: d1Teams(games, art.season) });
  const fcs = buildForecasts(games.concat(ex.games), art, policy, { nowMs, toMs: win.to, preseason: win.phase === 'preseason' });
  const G = gates(games, art, fcs, nowMs);
  const publishable = G.every((g) => g.pass);
  const doc = { schema: 'edgedesk_ncaam_fc_forecasts_v1', as_of: new Date(nowMs).toISOString(), model: { key: ptr.current.key, model_id: champ.model_id, version: champ.version, config_sha256: champ.config_sha256 },
    artifact: { sha256: art.artifact_sha256, code_sha256: art.code_sha256, training_snapshot: art.training_snapshot, calibration_n: art.calibration.D1_D1 && art.calibration.D1_D1.n, kappa: art.calibration.D1_D1 && art.calibration.D1_D1.kappa },
    upset_policy: policy ? { version: policy.version, theta: policy.signals.upset_probability.theta } : null, definitions: DEFINITIONS,
    window: { phase: win.phase, from: new Date(win.from).toISOString(), to: new Date(win.to).toISOString(), regular_season_start: win.regular_season_start },
    exhibitions: { source: 'the schools\' own schedules (collegiate/data/schedules)', schools_read: ex.schools_read, schools_matched: ex.schools_matched, priced: ex.games.length,
      skipped: ex.skipped.reduce((a, x) => (a[x.why] = (a[x.why] || 0) + 1, a), {}), unmatched: ex.unmatched.length },
    gates: G, publishable, forecasts: fcs };
  const outDir = path.join(C.PATHS.out, 'forecasts'); fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, doc.as_of.replace(/[:.]/g, '').slice(0, 15) + '.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
  console.log('[ncaam refresh] ' + win.phase + ' window to ' + new Date(win.to).toISOString() + ': ' + fcs.length + ' forecasts (' + ex.games.length + ' exhibitions), ' + (publishable ? 'PUBLISHABLE' : 'BLOCKED: ' + G.filter((g) => !g.pass).map((g) => g.id + ' ' + g.detail).join('; ')) + ' -> ' + path.relative(C.ROOT, file));
  if (o.publish) {
    if (!publishable) { const e = new Error('nothing published: a gate failed'); e.exitCode = 1; throw e; }
    const P = require('./publish');
    const res = await P.publishForecasts(doc, { log: console.log });
    console.log('[ncaam refresh] published ' + JSON.stringify(res));
  }
  return doc;
}

module.exports = { refresh, buildForecasts, forecastWindow, regularSeasonStart, d1Teams, gates, AVAILABILITY, DEFINITIONS };

if (require.main === module) {
  const a = process.argv; const val = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : null; };
  refresh({ hours: val('hours') ? +val('hours') : 48, publish: a.includes('--publish'), now: val('now') })
    .catch((e) => { console.error('[ncaam refresh] ' + e.message + ' — the previously published forecasts are unchanged'); process.exit(e.exitCode || 3); });
}
