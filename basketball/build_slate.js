#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk basketball — fair prices for the next games of every league.

     node basketball/build_slate.js [--hours 72]      writes basketball/slate.json
     node basketball/build_slate.js --check

   For each league, the scheduled games starting in the next `hours` are
   priced from basketball/params/<league>_live.json (the ratings carried to
   today and the calibration fitted on earlier seasons): moneyline, the fair
   spread with cover probabilities at nearby lines (pushes on whole numbers),
   and the fair total likewise. Every number says which market it belongs to
   and that market's validation status. No book price is captured for
   basketball, so every row is research: value claims are off.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const I = require('./ingest');
const P = require('../engine/lab/protocol');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);
function decToAm(d) { if (!(d > 1)) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
const fair = (p, push) => { const l = 1 - p - (push || 0); return p > 0 && l > 0 ? decToAm(1 + l / p) : null; };

/** P(X > L), P(X = L) for an integer-valued normal(mu, sd) */
function overUnder(mu, sd, L) {
  if (Math.abs(L - Math.round(L)) < 1e-9) { const over = 1 - P.Phi((L + 0.5 - mu) / sd), push = P.Phi((L + 0.5 - mu) / sd) - P.Phi((L - 0.5 - mu) / sd); return { over, push, under: 1 - over - push }; }
  const over = 1 - P.Phi((L - mu) / sd); return { over, push: 0, under: 1 - over };
}
/** the same for a final MARGIN, which includes overtime and so is never 0: at a
    pick'em line the regulation-tie mass is split between the sides (overtime is
    a coin flip to this model), never priced as a push (audit_report.md §8.2 B2) */
function marginOverUnder(mu, sd, L) {
  if (Math.abs(L) > 1e-9) return overUnder(mu, sd, L);
  const o = overUnder(mu, sd, 0);
  return { over: o.over + o.push / 2, push: 0, under: o.under + o.push / 2 };
}

function priceGame(g, live, lastStart) {
  const R = live.ratings; const cal = live.calibration;
  const T = (id) => R.teams[id] || { o: 0, d: 0, games: 0 };
  const H = T(g.home_id), A = T(g.away_id); const hh = g.neutral ? 0 : R.h / 2;
  const ph = R.mu + hh + H.o - A.d, pa = R.mu - hh + A.o - H.d;
  const m = ph - pa, t = ph + pa;
  const start = Date.parse(g.start_utc);
  const b2b = (id) => { const l = lastStart(id, start); return l != null && start - l <= 30 * 3600e3 ? 1 : 0; };
  const x = b2b(g.home_id) - b2b(g.away_id);
  const sig = (z) => 1 / (1 + Math.exp(-z));
  const rest = live.model === 'points_rest';
  /* the fitted intercept: every game under calibration v1, home games only
     from v2 (basketball/walkforward.js CAL_VERSION) */
  const on = cal.intercept === 'home_games_only' ? (g.neutral ? 0 : 1) : 1;
  const pHome = rest ? sig(cal.win_rest[0] * on + cal.win_rest[1] * m + cal.win_rest[2] * x) : sig(cal.win[0] * on + cal.win[1] * m);
  const mu = cal.margin.a * on + cal.margin.b * m + (rest ? cal.rest_points * x : 0);
  const tmu = cal.total.a + cal.total.b * t;
  const fairSpread = -Math.round(mu * 2) / 2; /* the home line at which the home side is closest to even */
  const spreadLines = {}; for (const L of [fairSpread - 1, fairSpread - 0.5, fairSpread, fairSpread + 0.5, fairSpread + 1]) { const o = marginOverUnder(mu, cal.sd_margin, -L); spreadLines[L] = { home_cover: r4(o.over), push: r4(o.push), away_cover: r4(o.under), fair_home: fair(o.over, o.push), fair_away: fair(o.under, o.push) }; }
  const fairTotal = Math.round(tmu * 2) / 2;
  const totalLines = {}; for (const L of [fairTotal - 2, fairTotal - 1, fairTotal, fairTotal + 1, fairTotal + 2]) { const o = overUnder(tmu, cal.sd_total, L); totalLines[L] = { over: r4(o.over), push: r4(o.push), under: r4(o.under), fair_over: fair(o.over, o.push), fair_under: fair(o.under, o.push) }; }
  return { p_home: pHome, margin: mu, total: tmu, fairSpread, spreadLines, fairTotal, totalLines, b2b: { home: b2b(g.home_id), away: b2b(g.away_id) }, history_games: { home: H.games, away: A.games } };
}

function build(o) {
  const now = o.now; const hours = o.hours;
  const out = { schema: 'edgedesk_lab_slate_v1', sport: 'basketball', generated_at: new Date(now).toISOString(), horizon_hours: hours, leagues: {} };
  for (const league of Object.keys(C.LEAGUES)) {
    const L = C.LEAGUES[league];
    let live = null, val = null;
    try { live = JSON.parse(fs.readFileSync(C.PATHS.params(league), 'utf8')); val = JSON.parse(fs.readFileSync(C.PATHS.validation(league), 'utf8')); } catch (_) {}
    if (!live || !val) { out.leagues[league] = { label: L.label, state: 'NO_MODEL', games: [] }; continue; }
    const teams = (() => { try { return JSON.parse(fs.readFileSync(path.join(C.PATHS.data(league), 'teams.json'), 'utf8')); } catch (_) { return {}; } })();
    const cur = C.currentSeason(league, now);
    const season = I.loadGames(league, [cur - 1, cur]);
    const starts = new Map(); for (const g of season) for (const id of [g.home_id, g.away_id]) { if (!starts.has(id)) starts.set(id, []); starts.get(id).push(Date.parse(g.start_utc)); }
    for (const v of starts.values()) v.sort((a, b) => a - b);
    const lastStart = (id, t) => { const v = starts.get(id) || []; let best = null; for (const x of v) if (x < t) best = x; return best; };
    const upcoming = season.filter((g) => g.status === 'SCHEDULED' && Date.parse(g.start_utc) > now && Date.parse(g.start_utc) <= now + hours * 3600e3).sort((a, b) => (a.start_utc < b.start_utc ? -1 : 1));
    const next = season.filter((g) => g.status === 'SCHEDULED' && Date.parse(g.start_utc) > now).sort((a, b) => (a.start_utc < b.start_utc ? -1 : 1))[0] || null;
    const lastFinal = season.filter((g) => g.status === 'FINAL').sort((a, b) => (a.start_utc < b.start_utc ? 1 : -1))[0] || null;
    const status = Object.fromEntries(Object.entries(val.markets).map(([k, m]) => [k, m.status]));
    out.leagues[league] = {
      /* the model id carries the calibration version, so the board, the
         projections and the performance ledger split on the change */
      label: L.label, sport_key: L.sport_key, registry: L.registry,
      model: live.model + (live.calibration && live.calibration.version ? '+' + live.calibration.version : ''),
      calibration_version: (live.calibration && live.calibration.version) || null,
      params_generated_at: live.generated_at, for_season: live.for_season,
      validation: status, value_claims: 'DISABLED', value_reason: 'never compared with closing prices, and no book price is captured for basketball',
      latest_result: lastFinal ? lastFinal.date : null, next_game: next ? next.start_utc : null,
      /* the last game the RATINGS absorbed (the live params), which is what the
         price knows — not the last final in the data, which it may not */
      ratings_through: live.last_game_date || null,
      note: upcoming.length ? null : (next ? 'no game in the next ' + hours + ' h; the next is ' + next.start_utc : 'no scheduled game on file for the ' + cur + ' season'),
      early_season: live.ratings && Object.values(live.ratings.teams).every((t) => t.games === 0),
      games: upcoming.map((g) => {
        const p = priceGame(g, live, lastStart);
        return {
          event_key: L.label.replace(/[^A-Za-z]/g, '').toUpperCase() + '|' + g.game_id, game_id: g.game_id, start_utc: g.start_utc, date: g.date, neutral: !!g.neutral,
          home: teams[g.home_id] || g.home_id, away: teams[g.away_id] || g.away_id, home_id: g.home_id, away_id: g.away_id,
          prices: {
            moneyline: { home: r4(p.p_home), away: r4(1 - p.p_home), fair_home: fair(p.p_home), fair_away: fair(1 - p.p_home), settles: 'including overtime', status: status.moneyline },
            spread: { projected_margin: Math.round(p.margin * 10) / 10, fair_home_line: p.fairSpread, lines: p.spreadLines, settles: 'including overtime; a whole-number line can push', status: status.spread },
            total: { projected: Math.round(p.total * 10) / 10, fair_line: p.fairTotal, lines: p.totalLines, settles: 'including overtime', status: status.total },
          },
          inputs: { back_to_back: p.b2b, games_this_season: p.history_games },
          data_quality: { early_season: p.history_games.home < 5 || p.history_games.away < 5, lineup: 'UNKNOWN — no availability feed' },
          invalidators: ['A star or starter ruled out: availability is not modelled.', 'Early in a season, ratings lean on last season (carried at ' + live.params.carry + ').'].concat(p.b2b.home || p.b2b.away ? ['A back-to-back: rest decisions are announced late.'] : []),
        };
      }),
    };
  }
  return out;
}

function check() {
  const s = JSON.parse(fs.readFileSync(C.PATHS.slate, 'utf8')); const fails = [];
  if (s.schema !== 'edgedesk_lab_slate_v1') fails.push('schema');
  for (const [k, L] of Object.entries(s.leagues)) { if (L.value_claims && L.value_claims !== 'DISABLED') fails.push(k + ' claims value'); for (const g of L.games || []) if (!(g.prices.moneyline.home > 0 && g.prices.moneyline.home < 1)) fails.push(k + ' bad probability ' + g.game_id); }
  if (fails.length) { console.error('[bb slate --check] FAILED ' + fails.join('; ')); process.exit(1); }
  console.log('[bb slate --check] ok: ' + Object.entries(s.leagues).map(([k, L]) => k + ' ' + (L.games || []).length).join(', '));
}

module.exports = { marginOverUnder, build, priceGame, overUnder };
if (require.main === module) {
  if (process.argv.includes('--check')) check();
  else { const s = build({ now: Date.now(), hours: Number(arg('hours', 72)) }); fs.writeFileSync(C.PATHS.slate, JSON.stringify(s, null, 1) + '\n'); console.log('[bb slate] ' + Object.entries(s.leagues).map(([k, L]) => k + ': ' + L.games.length + ' games' + (L.note ? ' (' + L.note + ')' : '')).join(' | ')); }
}
