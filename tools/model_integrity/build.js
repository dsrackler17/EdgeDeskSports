#!/usr/bin/env node
/* ===========================================================================
   THE MODEL INTEGRITY AUDIT — engine/model_integrity.json
   (lib/edgedesk_model_integrity.js is the contract; docs/system-integrity/
   MODEL_INTEGRITY.md the narrative).

   For every NBA, NFL, college football and NHL projection the engine
   publishes (lib/edgedesk_projections.js, built in memory from the committed
   sport artifacts — the same contract engine/projections.json freezes), it
   reads the sport's own artifact for the inputs the number assumed, joins the
   market captured BEFORE the projection (the hash-chained quote ledger,
   performance/ledger/quotes, and the latest today/slate.json snapshot), and
   classifies the game. It changes no number and reads no price into a model.

     node tools/model_integrity/build.js              writes engine/model_integrity.json
     node tools/model_integrity/build.js --check      builds, compares (generated_at aside), writes nothing
     node tools/model_integrity/build.js --now <ISO>  replays a moment
     node tools/model_integrity/build.js --out <file> writes elsewhere

   Thresholds live in engine/model_integrity_config.json and are VALIDATED
   here against what is on file, chronologically: every row a projection made
   before its game and graded after it (the 2026 performance ledger; for
   college football also the 2022-2025 out-of-sample replay,
   football/cfb_ev/data). The record is published beside the games so the
   signal rule (MI.signalRule) reads a measurement, never a hope.
   Exit 0 = written / current; 1 = --check differs; 2 = nothing could be read.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT_DEFAULT = path.join(__dirname, '..', '..');
const SPORTS = ['nba', 'nfl', 'cfb', 'nhl'];
const UNAVAILABLE_ROSTER = /^(RES|CUT|RET|SUS)$/;

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d === undefined ? null : d; } }
function readLines(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } }
function csvRows(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const parse = (l) => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };
  const head = parse(lines[0]);
  return lines.slice(1).map((l) => { const v = parse(l); const o = {}; head.forEach((h, i) => { o[h] = v[i]; }); return o; });
}
const num = (x) => (x === null || x === undefined || x === '' || !isFinite(Number(x)) ? null : Number(x));
const ms = (t) => { const v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; };
const r = (x, d) => (x == null || !isFinite(x) ? null : Math.round(x * Math.pow(10, d == null ? 2 : d)) / Math.pow(10, d == null ? 2 : d));
const hoursBetween = (a, b) => (ms(a) != null && ms(b) != null ? r((ms(b) - ms(a)) / 3600e3, 1) : null);

/* ===================================================== the sport's own inputs
   Each returns, per projection: { checks: [...], assumptions, roster_freshness,
   injury_feed }. A check names its code, how severe it is, the component that
   produced it and the evidence, so the reader can see why. */

/* NBA — nba/slate.json (the price's availability) and nba/roster_inputs.json (the
   current rosters the same build read) */
function nbaInputs(root, now) {
  const slate = readJson(path.join(root, 'nba', 'slate.json'), {});
  const ri = readJson(path.join(root, 'nba', 'roster_inputs.json'), {});
  const rosterOf = {}; const teamOf = {};
  Object.entries((ri.rosters_fallback && ri.rosters_fallback.teams) || {}).forEach(([t, list]) => { rosterOf[t] = new Set(list.map((x) => String(x.id))); list.forEach((x) => { teamOf[String(x.id)] = t; }); });
  const rosterAt = slate.rosters && slate.rosters.fetched_at || null;
  const byId = {};
  (slate.games || []).forEach((g) => {
    const checks = [], unresolved = [];
    const side = (k) => g.availability && g.availability[k] || {};
    /* a player the price or its scenarios read for one team who is on ANOTHER team's current roster */
    ['home', 'away'].forEach((k) => {
      const t = String(g[k].id), A = side(k);
      (A.absent_regulars || []).forEach((p) => {
        const now_ = teamOf[String(p.id)];
        const asReturn = (g.scenarios || []).some((s) => s.kind === 'returns' && String(s.player_id) === String(p.id));
        if (rosterOf[t] && now_ && now_ !== t) checks.push({ code: 'INPUT_ERROR', severity: asReturn ? 'high' : 'medium', component: 'nba/build_slate.js absent regulars', chip: 'Roster data error',
          message: p.name + ' is listed as ' + g[k].abbr + '’s absent regular' + (asReturn ? ', and priced as a "returns" scenario,' : '') + ' but is on another team’s current roster.', evidence: { player_id: String(p.id), team: g[k].abbr, roster_team_id: now_, roster_fetched_at: rosterAt, priced_as_return: asReturn } });
      });
      (A.projected || []).forEach((p) => { if (p.on_current_roster === false) checks.push({ code: 'INPUT_ERROR', severity: 'high', component: 'nba/build_slate.js projected rotation', chip: 'Roster data error', message: p.name + ' is in ' + g[k].abbr + '’s projected rotation but not on its current roster.', evidence: { player_id: String(p.id) } }); });
    });
    /* no injury feed in the baseline: the rotation is the last game's */
    const gate = ((g.decision && g.decision.gates) || []).find((x) => /availability/.test(x.gate));
    checks.push({ code: 'MISSING_CRITICAL_INPUT', severity: 'medium', component: 'nba/build_slate.js availability', chip: 'Missing injury inputs',
      message: 'No injury report or confirmed lineup is in the price: each team’s rotation is its last game’s (' + (side('home').rotation_source || 'previous game') + '). A player listed questionable or out since is not reflected.',
      evidence: { gate: gate || null } });
    (g.scenarios || []).filter((s) => Math.abs(num(s.delta_p_home) || 0) >= 0.05).forEach((s) => unresolved.push({ player: s.player, team: s.team, kind: s.kind, delta_p_home_pp: r(100 * s.delta_p_home, 1), delta_margin: s.delta_margin }));
    if (unresolved.length) checks.push({ code: 'MISSING_CRITICAL_INPUT', severity: 'high', component: 'nba/build_slate.js scenarios', chip: 'Key player status unresolved',
      message: 'Scenario-sensitive, status unresolved: ' + unresolved.map((u) => u.player + ' (' + u.team + ', ' + (u.kind === 'sits' ? 'if he sits ' : 'if he returns ') + (u.delta_p_home_pp > 0 ? '+' : '') + u.delta_p_home_pp + ' pts)').join('; ') + '.', evidence: { unresolved } });
    if (g.uncertainty && g.uncertainty.early_season) checks.push({ code: 'CALIBRATION_WARNING', severity: 'low', component: 'nba ratings (prior-season carryover)', chip: 'Historical sample insufficient',
      message: 'Early season: a team has fewer than 10 games, so its ratings lean on last season, regressed. The record is thinnest here.', evidence: { notes: g.uncertainty.notes || [] } });
    byId['NBA|' + g.game_id] = {
      checks,
      roster_freshness: { source: 'hoopR ESPN rosters', fetched_at: rosterAt, age_hours_at_prediction: hoursBetween(rosterAt, g.predicted_at) },
      injury_feed: { state: 'NOT_IN_PRICE', note: 'the baseline reads no injury report; the experimental roster-adjusted projection (nba/injury/core.js) does' },
      assumptions: { rotation_source: side('home').rotation_source || null, likely_starters: { home: side('home').likely_starters || [], away: side('away').likely_starters || [] },
        assumed_active: { home: (side('home').projected || []).map((p) => p.name), away: (side('away').projected || []).map((p) => p.name) },
        left_team: { home: (side('home').regulars_left_team || []).map((p) => p.name), away: (side('away').regulars_left_team || []).map((p) => p.name) }, unresolved }
    };
  });
  return byId;
}

/* NHL — hockey/slate.json goalies, data state and the calibration bin the game sits in */
function nhlInputs(root) {
  const slate = readJson(path.join(root, 'hockey', 'slate.json'), {});
  const byId = {};
  const dataState = slate.readiness && slate.readiness.data ? slate.readiness.data.state : null;
  (slate.games || []).forEach((g) => {
    const checks = [], G = g.goalies || {};
    const side = (k) => (G[k] || []).map((x) => (x.name || x.goalie) + ' ' + Math.round(100 * (num(x.p_start) || 0)) + '%' + (x.confirmed ? ' (confirmed)' : '')).join(' / ');
    const confirmedBoth = ['home', 'away'].every((k) => (G[k] || []).length === 1 && G[k][0].confirmed);
    if (G.certainty === 'CONFIRMED' && !confirmedBoth) checks.push({ code: 'INPUT_ERROR', severity: 'high', component: 'hockey/build_slate.js goalie certainty', chip: 'Goalie data error', message: 'The game is labelled CONFIRMED but a side’s goalie is not confirmed.', evidence: { certainty: G.certainty } });
    (G.conflicts || []).forEach((c) => checks.push({ code: 'INPUT_ERROR', severity: 'high', component: 'hockey/build_slate.js startersFor', chip: 'Goalie data error', message: 'A confirmation names ' + (c.name || c.goalie) + ' (' + g[c.side] + '), who is listed unavailable' + (c.reason ? ' (' + c.reason + ')' : '') + '.', evidence: c }));
    if (!confirmedBoth) checks.push({ code: 'MISSING_CRITICAL_INPUT', severity: 'medium', component: 'hockey/model/ratings.js projectStarters', chip: 'Starting goalie unconfirmed',
      message: 'Starting goalie unconfirmed: ' + g.home + ' ' + (side('home') || 'none on record') + '; ' + g.away + ' ' + (side('away') || 'none on record') + '. A usage projection; no NHL injury feed says who is available. The headline price has no goalie term; the goalie scenarios move the home win probability across ' + (g.uncertainty && g.uncertainty.goalie_range_p_home ? g.uncertainty.goalie_range_p_home.map((x) => r(100 * x, 1) + '%').join('–') : 'their range') + '.',
      evidence: { certainty: G.certainty || null, home: G.home || [], away: G.away || [] } });
    const b = g.uncertainty && g.uncertainty.calibration_bin;
    if (b && Array.isArray(b.wilson95) && (b.model_mean < b.wilson95[0] || b.model_mean > b.wilson95[1])) checks.push({ code: 'CALIBRATION_WARNING', severity: 'medium', component: 'hockey/validation/nhl_walkforward.json (confirmation window)', chip: 'Calibration under review',
      message: 'Games priced in the ' + b.range.map((x) => Math.round(100 * x) + '%').join('–') + ' bin ran ' + r(100 * b.model_mean, 1) + '% predicted against ' + r(100 * b.observed, 1) + '% observed (n ' + b.n + '), outside the 95% interval.', evidence: b });
    if (dataState && dataState !== 'FRESH') checks.push({ code: 'STALE_DATA', severity: 'high', component: 'hockey/slate.json readiness', chip: 'Roster data stale', message: 'The NHL results the ratings read are ' + String(dataState).toLowerCase() + '.', evidence: slate.readiness.data });
    byId['NHL|' + g.game_id] = { checks,
      roster_freshness: { source: 'NHL box scores (last game’s lineups)', latest_result: slate.readiness && slate.readiness.data ? slate.readiness.data.latest_completed_game : null },
      injury_feed: { state: 'NONE', note: 'no timestamped NHL injury or lineup feed (hockey/contracts/canonical.js)' },
      assumptions: { goalies: { home: G.home || [], away: G.away || [], certainty: G.certainty || null, availability: G.availability || null }, lineups: g.lineups ? g.lineups.state : null } };
  });
  return byId;
}

/* NFL — football/nfl/slate.json starters, the roster's reserve list and the injury report's age */
function nflInputs(root, now) {
  const slate = readJson(path.join(root, 'football', 'nfl', 'slate.json'), {});
  const season = slate.season || 2026;
  const roster = {}; csvRows((() => { try { return fs.readFileSync(path.join(root, 'football', 'nfl', 'qbs_' + season + '.csv'), 'utf8'); } catch (_) { return ''; } })()).forEach((x) => { if (x.gsis_id) { const prev = roster[x.gsis_id]; if (!prev || num(x.week) >= num(prev.week)) roster[x.gsis_id] = x; } });
  const inj = readJson(path.join(root, 'football', 'injuries', 'nfl_' + season + '.json'), {});
  const injAge = inj.retrieved_at ? hoursBetween(inj.retrieved_at, now) : null;
  const byId = {};
  (slate.games || []).forEach((g) => {
    const checks = [];
    ['home', 'away'].forEach((k) => {
      const st = g[k + '_starter'], team = g[k + '_code'];
      if (!st) { checks.push({ code: 'MISSING_CRITICAL_INPUT', severity: 'high', component: 'tools/football/build_nfl_slate.js starterOf', chip: 'Starting QB unconfirmed', message: team + ': no starting QB is named; the engine prices the club’s carried QB level.', evidence: null }); return; }
      const rr = st.player_id ? roster[st.player_id] : null;
      if (rr && UNAVAILABLE_ROSTER.test(rr.status) && rr.team === team) checks.push({ code: 'INPUT_ERROR', severity: 'high', component: 'app.html fbNflReconcileRoster', chip: 'QB data error',
        message: team + ': the priced QB ' + st.player_name + ' is ' + rr.status + ' on the week-' + rr.week + ' roster.', evidence: { player_id: st.player_id, roster_status: rr.status, roster_week: num(rr.week) } });
      const rep = g[k + '_qb_report'];
      if (rep && /^(out|doubtful)$/i.test(String(rep.status || ''))) checks.push({ code: 'INPUT_ERROR', severity: 'high', component: 'app.html fbNflReconcileStarters', chip: 'QB data error', message: team + ': the priced QB ' + st.player_name + ' is ' + rep.status + ' on the injury report.', evidence: rep });
      if (/STARTER_UNKNOWN/.test(st.status)) checks.push({ code: 'MISSING_CRITICAL_INPUT', severity: 'high', component: 'tools/football/build_nfl_slate.js starterOf', chip: 'Starting QB unconfirmed', message: team + ': starting QB unknown (' + (st.scheduled ? st.scheduled.player_name + ' ' + st.scheduled.status : 'no replacement on record') + '); the engine prices the club’s carried QB level.', evidence: st });
      else if (/PENDING$/.test(st.status)) checks.push({ code: 'MISSING_CRITICAL_INPUT', severity: 'medium', component: 'tools/football/build_nfl_slate.js starterOf', chip: 'Starting QB unconfirmed',
        message: team + ': ' + st.player_name + ' is priced in place of ' + (st.scheduled ? st.scheduled.player_name + ' (' + st.scheduled.status + ', week ' + st.scheduled.report_week + ')' : 'the feed’s starter') + ', pending this week’s ' + (/ROSTER/.test(st.status) ? 'roster' : 'injury report') + '. Starting QB unconfirmed.', evidence: st });
    });
    if (injAge != null && injAge > 8 * 24) checks.push({ code: 'STALE_DATA', severity: 'medium', component: 'football/injuries/nfl_' + season + '.json', chip: 'Injury data stale', message: 'The injury report on file was retrieved ' + r(injAge / 24, 1) + ' days ago.', evidence: { retrieved_at: inj.retrieved_at } });
    byId['NFL|' + g.game_id] = { checks,
      roster_freshness: { source: 'nflverse roster (football/nfl/qbs_' + season + '.csv) and depth chart (football/starters)', latest_week: Object.values(roster).reduce((m, x) => Math.max(m, num(x.week) || 0), 0) || null },
      injury_feed: { state: inj.published ? 'ON_FILE' : 'MISSING', retrieved_at: inj.retrieved_at || null, latest_week: inj.latest_week || null, age_hours: injAge },
      assumptions: { qb: { home: g.home_starter ? { name: g.home_starter.player_name, status: g.home_starter.status, source: g.home_starter.source } : null, away: g.away_starter ? { name: g.away_starter.player_name, status: g.away_starter.status, source: g.away_starter.source } : null },
        weather: 'the total reads neutral weather (68°F, no wind) for an unplayed game; the forecast is shown, not priced' } };
  });
  return byId;
}

/* College football — football/fbs/slate.json (the published V1 number), its starters, and the 2026 live calibration record */
function cfbInputs(root) {
  const slate = readJson(path.join(root, 'football', 'fbs', 'slate.json'), {});
  const cal = readJson(path.join(root, 'football', 'validation', 'cfb_live_calibration.json'), {});
  const D = cal.diagnostics || {};
  const ninety = ((D.calibration && D.calibration.table_fbs_vs_fbs) || []).find((b) => b.bucket === '90-100') || null;
  const big = ((D.margin_buckets && D.margin_buckets.fbs_vs_fbs) || []).find((b) => b.bucket === '21+') || null;
  const byId = {};
  (slate.games || []).forEach((g) => {
    const checks = [];
    const p = num(g.model_home_win_prob), m = num(g.model_home_margin), fbs = g.home_division === 'fbs' && g.away_division === 'fbs';
    const pFav = p == null ? null : Math.max(p, 1 - p);
    if (fbs && pFav != null && pFav >= 0.9 && ninety && ninety.inside_interval === false) checks.push({ code: 'CALIBRATION_WARNING', severity: 'medium', component: 'football/validation/cfb_live_calibration.json (FBS vs FBS, 90-100%)', chip: 'Calibration under review',
      message: 'The favourite is priced at ' + r(100 * pFav, 1) + '%. FBS-vs-FBS favourites priced 90%+ won ' + r(100 * ninety.actual, 1) + '% of ' + ninety.n + ' games this season against ' + r(100 * ninety.avg_pred, 1) + '% predicted, outside the 95% interval (' + cal.data_through + ').', evidence: ninety });
    if (fbs && m != null && Math.abs(m) > 21 && big) checks.push({ code: 'CALIBRATION_WARNING', severity: 'low', component: 'football/validation/cfb_live_calibration.json (FBS vs FBS, 21+ margins)', chip: 'Calibration under review',
      message: 'A projected margin of ' + r(Math.abs(m), 1) + ': FBS-vs-FBS favourites of 21+ this season finished ' + Math.abs(big.model_bias) + ' points ' + (big.model_bias < 0 ? 'short of' : 'past') + ' the projection on average (n ' + big.n + ', se ' + big.bias_se + ').', evidence: big });
    ['home', 'away'].forEach((k) => {
      const st = g[k + '_starter'];
      if (!st || /UNKNOWN|COMPETITION/.test(String(st.status || ''))) checks.push({ code: 'MISSING_CRITICAL_INPUT', severity: 'low', component: 'football/starters/cfb_2026.json', chip: 'Starting QB unconfirmed',
        message: g[k + '_team'] + ': starting QB ' + (st ? (st.player_name || st.name || 'unnamed') + ' (' + String(st.status).toLowerCase().replace(/_/g, ' ') + ')' : 'unknown') + '. The college price carries no QB term, so a change cannot move this number.', evidence: st || null });
    });
    byId['CFB|' + g.game_id] = { checks,
      roster_freshness: { source: 'cfbfastR rosters and the starter context', data_completeness: num(g.data_completeness) },
      injury_feed: { state: 'OPERATOR_ONLY', note: 'operator-entered availability only (no official college feed)' },
      assumptions: { qb: { home: g.home_starter ? { name: g.home_starter.player_name || g.home_starter.name || null, status: g.home_starter.status || null } : null, away: g.away_starter ? { name: g.away_starter.player_name || g.away_starter.name || null, status: g.away_starter.status || null } : null }, matchup: g.matchup_type || null, divisions: [g.home_division, g.away_division] } };
  });
  return byId;
}

/* ===================================================== the market on file */
/* every season's ledger file for a sport (performance/ledger/<kind>/<sport>-<season>.jsonl) */
function ledgerFiles(root, kind, sport) {
  const dir = path.join(root, 'performance', 'ledger', kind);
  let names = []; try { names = fs.readdirSync(dir); } catch (_) { names = []; }
  return names.filter((f) => new RegExp('^' + sport + '-\\d{4}\\.jsonl$').test(f)).sort().map((f) => path.join(dir, f));
}
const ledgerLines = (root, kind, sport) => [].concat.apply([], ledgerFiles(root, kind, sport).map(readLines));
function quotesBySport(root) {
  const out = {};
  SPORTS.forEach((s) => { out[s] = {}; ledgerLines(root, 'quotes', s).forEach((q) => { (out[s][q.event_key] = out[s][q.event_key] || []).push(q); }); });
  return out;
}

/* ===================================================== threshold validation
   Chronological by construction: each forecast row is the last one recorded
   before its game started, each quote the last captured at or before that
   forecast, each result graded after. */
function ledgerRows(root, sport) {
  const F = ledgerLines(root, 'forecasts', sport), Q = ledgerLines(root, 'quotes', sport), R = ledgerLines(root, 'results', sport);
  const res = {}; R.forEach((x) => { if (x.state === 'FINAL' && num(x.home_score) != null) res[x.event_key] = x; });
  const fc = {}; F.forEach((f) => { const t = ms(f.model && f.model.predicted_at), st = ms(f.start_utc); if (t == null || st == null || t >= st) return; if (!fc[f.event_key] || ms(fc[f.event_key].model.predicted_at) < t) fc[f.event_key] = f; });
  const qb = {}; Q.forEach((q) => { (qb[q.event_key] = qb[q.event_key] || []).push(q); });
  const rows = [];
  Object.keys(fc).forEach((k) => {
    const f = fc[k], x = res[k]; if (!x) return;
    const t = ms(f.model.predicted_at);
    const qs = (qb[k] || []).filter((q) => ms(q.captured_at) != null && ms(q.captured_at) <= t).sort((a, b) => ms(a.captured_at) - ms(b.captured_at));
    const q = qs.length ? qs[qs.length - 1] : (f.quote && ms(f.quote.captured_at) != null && ms(f.quote.captured_at) <= t ? f.quote : null);
    if (!q) return;
    const nv = q.moneyline && num(q.moneyline.home) != null && num(q.moneyline.away) != null ? (() => { const a = num(q.moneyline.home), b = num(q.moneyline.away); const ia = a < 0 ? -a / (-a + 100) : 100 / (a + 100), ib = b < 0 ? -b / (-b + 100) : 100 / (b + 100); return ia / (ia + ib); })() : null;
    rows.push({ event_key: k, predicted_at: f.model.predicted_at, model_version: f.model.version, model_home_line: num(f.forecast.fair_home_line), model_total: num(f.forecast.fair_total != null ? f.forecast.fair_total : f.forecast.expected_total),
      model_p_home: num(f.forecast.p_home), market_home_line: q.spread ? num(q.spread.home_point) : null, market_total: q.total ? num(q.total.point) : null, market_novig_home: nv,
      final_margin: num(x.home_score) - num(x.away_score), final_total: num(x.home_score) + num(x.away_score), home_won: num(x.home_score) > num(x.away_score) ? 1 : 0 });
  });
  return rows;
}
function cfbHistoryRows(root) {
  let text = '';
  try { text = zlib.gunzipSync(fs.readFileSync(path.join(root, 'football', 'cfb_ev', 'data', 'cfb_ev_calibration_rows_v1.csv.gz'))).toString('utf8'); } catch (_) { return []; }
  /* the opener is the market nearest the Tuesday freeze the projection was made at (the market never an input) */
  return csvRows(text).filter((x) => x.window === 'OOS' && x.checkpoint === 'open').map((x) => ({ event_key: 'CFB|' + x.game_id, season: num(x.season), model_home_line: -num(x.fair_margin), market_home_line: num(x.market_home_line), final_margin: num(x.final_margin) }))
    .filter((x) => x.model_home_line != null && x.market_home_line != null && x.final_margin != null);
}
function thresholdValidation(root, MI, cfg) {
  const out = {};
  const T = cfg.thresholds;
  ['nba', 'nfl', 'cfb'].forEach((s) => {
    const rows = ledgerRows(root, s).filter((x) => x.model_home_line != null && x.market_home_line != null);
    out[s] = { spread: Object.assign({ source: 'performance/ledger (last forecast before start; last quote at or before it)', n_rows: rows.length }, MI.thresholdRecord(rows, 'spread', T[s].spread_pts)) };
  });
  const hist = cfbHistoryRows(root);
  out.cfb.spread_history = Object.assign({ source: 'football/cfb_ev/data/cfb_ev_calibration_rows_v1 OOS 2022-2025 (cold Tuesday freeze vs the opener; edgedesk_cfb_p4_v1.0.0)', n_rows: hist.length }, MI.thresholdRecord(hist, 'spread', T.cfb.spread_pts));
  const nhl = ledgerRows(root, 'nhl');
  out.nhl = {
    moneyline: Object.assign({ source: 'performance/ledger', n_rows: nhl.filter((x) => x.model_p_home != null && x.market_novig_home != null).length }, MI.thresholdRecord(nhl.filter((x) => x.model_p_home != null && x.market_novig_home != null), 'moneyline', T.nhl.ml_pp)),
    total: Object.assign({ source: 'performance/ledger', n_rows: nhl.filter((x) => x.model_total != null && x.market_total != null).length }, MI.thresholdRecord(nhl.filter((x) => x.model_total != null && x.market_total != null), 'total', T.nhl.total_goals))
  };
  return out;
}

/* ===================================================== the build */
function build(o) {
  o = o || {};
  const root = o.root || ROOT_DEFAULT;
  const MI = require(path.join(root, 'lib', 'edgedesk_model_integrity.js'));
  const S = require(path.join(root, 'tools', 'performance', 'sources.js'));
  const now = o.now ? ms(o.now) : Date.now();
  const cfgFile = readJson(path.join(root, 'engine', 'model_integrity_config.json'), {}) || {};
  const cfg = MI.config(cfgFile);
  const cur = S.currentProjections(root, now);
  const projections = cur.projections.filter((p) => SPORTS.indexOf(p.sport) >= 0);
  const inputs = { nba: nbaInputs(root, now), nhl: nhlInputs(root), nfl: nflInputs(root, now), cfb: cfbInputs(root) };
  const Q = quotesBySport(root);
  const slate = S.loadSlate(root);
  const tv = thresholdValidation(root, MI, cfg);
  const primary = { nba: tv.nba.spread, nfl: tv.nfl.spread, cfb: tv.cfb.spread_history && tv.cfb.spread_history.above && tv.cfb.spread_history.above.n ? tv.cfb.spread_history : tv.cfb.spread, nhl: tv.nhl.moneyline };
  const games = projections.map((p) => {
    const mm = S.matchSlate(slate, { sport: p.sport, event_id: p.event_id, start_utc: p.start_utc, home: p.home, away: p.away });
    const slateId = mm.match ? mm.match.id : null;
    const quotes = (Q[p.sport][p.event_key] || []).slice();
    if (slateId && slate.markets[slateId]) quotes.push(Object.assign({ event_key: p.event_key }, slate.markets[slateId]));
    const si = (inputs[p.sport] || {})[p.event_key] || { checks: [] };
    return MI.auditGame({ sport: p.sport, projection: p, quotes, checks: si.checks, assumptions: si.assumptions || null, roster_freshness: si.roster_freshness || null,
      injury_feed: si.injury_feed || null, record: primary[p.sport] || null, slate_id: slateId, now }, cfg);
  }).sort((a, b) => (ms(a.start_utc) || 0) - (ms(b.start_utc) || 0) || String(a.event_key).localeCompare(String(b.event_key)));
  return {
    schema: MI.SCHEMA, version: MI.VERSION, generated_at: new Date(now).toISOString(),
    note: 'Every published NBA, NFL, college football and NHL projection checked against its own inputs and the market captured before it. A classification is a reason to look, never a change to the number; a disagreement with the market is not an error. Research, not picks.',
    config: { file: 'engine/model_integrity_config.json', thresholds: cfg.thresholds, quote: cfg.quote, signal: cfg.signal },
    inputs: { projections: { contract: 'lib/edgedesk_projections.js (in memory, from the committed artifacts)', count: projections.length },
      quotes: 'performance/ledger/quotes/<sport>-2026.jsonl and today/slate.json markets (' + (slate.generated_at || 'not read') + ')',
      artifacts: ['nba/slate.json', 'nba/roster_inputs.json', 'hockey/slate.json', 'football/nfl/slate.json', 'football/nfl/qbs_<season>.csv', 'football/injuries/nfl_<season>.json', 'football/fbs/slate.json', 'football/validation/cfb_live_calibration.json'] },
    summary: MI.summarize(games),
    threshold_validation: tv,
    games
  };
}

function main() {
  const a = process.argv.slice(2), arg = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : null; };
  const root = arg('root') || ROOT_DEFAULT;
  const out = arg('out') || path.join(root, 'engine', 'model_integrity.json');
  let art;
  try { art = build({ root, now: arg('now') }); } catch (e) { console.error('the model integrity audit could not be built: ' + (e && e.stack || e)); process.exit(2); }
  const text = JSON.stringify(art, null, 1) + '\n';
  const s = art.summary;
  console.log('model integrity: ' + s.games + ' games — ' + Object.entries(s.by_status).map(([k, v]) => k + ' ' + v).join(', '));
  if (a.includes('--check')) {
    const cur = readJson(out, null);
    const strip = (x) => JSON.stringify(Object.assign({}, x, { generated_at: null, games: (x.games || []).map((g) => Object.assign({}, g, { audited_at: null })) }));
    const same = !!cur && strip(cur) === strip(Object.assign({}, art, { generated_at: cur.generated_at }));
    console.log(same ? 'CHECK: engine/model_integrity.json is current' : 'CHECK: engine/model_integrity.json differs from a fresh build');
    process.exit(same ? 0 : 1);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log('wrote ' + path.relative(root, out));
}
module.exports = { build, ledgerRows, cfbHistoryRows, nbaInputs, nhlInputs, nflInputs, cfbInputs };
if (require.main === module) main();
