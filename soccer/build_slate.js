#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk soccer — fair prices for the next match days of five leagues.

     node soccer/build_slate.js [--days 4]       writes soccer/slate.json
     node soccer/build_slate.js --check

   Each league's next matches (within `days`) are priced from
   soccer/params/<league>_live.json — the Dixon-Coles fit as of today and its
   pair recalibration when the chosen candidate uses it: 1X2, total goals at
   1.5 / 2.5 / 3.5, both teams to score, and Asian handicaps from -1.5 to +1.5
   in quarter steps (a quarter line settles as two half stakes: full win,
   half win, push, half loss, full loss). Kick-off times are local and the
   source gives no zone, so a match is keyed by date.

   DATA FRESHNESS. The source lags: a match day already played but without
   results makes the ratings stale. A league with a RESULT_MISSING match in
   the last 14 days is marked STALE, and the board's data gate holds it.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const I = require('./ingest');
const { DixonColes, markets, asian } = require('./model');
const GLM = require('../hockey/model/glm');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);
function decToAm(d) { if (!(d > 1)) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
const fair = (p, push) => { const l = 1 - p - (push || 0); return p > 0 && l > 0 ? decToAm(1 + l / p) : null; };

function modelFromLive(live) {
  const dc = new DixonColes(live.params);
  dc.mu = live.fit.mu; dc.home = live.fit.home; dc.rho = live.fit.rho;
  for (const [c, v] of Object.entries(live.fit.clubs)) { dc.att.set(c, v.att); dc.def.set(c, v.def); }
  return dc;
}

function priceMatch(dc, live, h, a) {
  const L = dc.lambdas(h, a);
  const cal = /_cal$/.test(live.model) ? live.pair_calibration : { a: 1, b: 1 };
  const { lh, la } = GLM.applyPairCalibration(L.lh, L.la, cal);
  dc2 = dc2 || new DixonColes({}); dc2.lambdas = () => ({ lh, la });
  const S = dc2.score(null, null, /^dixon_coles/.test(live.model) ? dc.rho : 0);
  const mk = markets(S);
  let o15 = 0, o35 = 0; for (let x = 0; x < S.mat.length; x++) for (let y = 0; y < S.mat[x].length; y++) { if (x + y > 1.5) o15 += S.mat[x][y]; if (x + y > 3.5) o35 += S.mat[x][y]; }
  const ah = {}; for (let L2 = -1.5; L2 <= 1.5001; L2 += 0.25) { const q = Math.round(L2 * 4) / 4; const s = asian(mk.diff, q); const ew = s.full_win + s.half_win / 2, el = s.full_loss + s.half_loss / 2; ah[q] = { full_win: r4(s.full_win), half_win: r4(s.half_win), push: r4(s.push), half_loss: r4(s.half_loss), full_loss: r4(s.full_loss), split: s.split, fair_home: fair(ew, 1 - ew - el) }; }
  return { lh, la, mk, o15, o35, ah };
}
let dc2 = null;

function build(o) {
  const now = o.now; const days = o.days; const today = new Date(now).toISOString().slice(0, 10);
  const until = new Date(now + days * 864e5).toISOString().slice(0, 10);
  const out = { schema: 'edgedesk_lab_slate_v1', sport: 'soccer', generated_at: new Date(now).toISOString(), horizon_days: days, leagues: {} };
  for (const league of Object.keys(C.LEAGUES)) {
    const Lg = C.LEAGUES[league];
    let live = null, val = null;
    try { live = JSON.parse(fs.readFileSync(C.PATHS.params(league), 'utf8')); val = JSON.parse(fs.readFileSync(C.PATHS.validation(league), 'utf8')); } catch (_) {}
    if (!live || !val) { out.leagues[league] = { label: Lg.label, state: 'NO_MODEL', games: [] }; continue; }
    const cur = C.currentSeason(now);
    const season = I.loadMatches(league, [cur]);
    const recentMissing = season.filter((m) => m.status === 'RESULT_MISSING' && (Date.parse(today) - Date.parse(m.date)) / 864e5 <= 14);
    const upcoming = season.filter((m) => m.status === 'SCHEDULED' && m.date >= today && m.date <= until);
    const status = Object.fromEntries(Object.entries(val.markets).map(([k, m]) => [k, m.status]));
    const dc = modelFromLive(live);
    const names = (() => { try { const t = JSON.parse(fs.readFileSync(path.join(C.PATHS.data(league), 'manifest.json'), 'utf8')).teams || {}; return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v[v.length - 1]])); } catch (_) { return {}; } })();
    out.leagues[league] = {
      label: Lg.label, sport_key: Lg.sport_key, model: live.model, params_generated_at: live.generated_at, validation: status,
      value_claims: 'DISABLED', value_reason: 'never compared with closing prices, and no book price is captured for soccer',
      data: { state: recentMissing.length ? 'STALE' : 'FRESH', results_missing_last_14_days: recentMissing.length, latest_result: live.last_result_date, note: recentMissing.length ? 'the source has not published ' + recentMissing.length + ' recent result(s); ratings miss them' : null },
      games: upcoming.map((m) => {
        const p = priceMatch(dc, live, m.home, m.away);
        return {
          event_key: 'SOCCER|' + m.match_id, match_id: m.match_id, date: m.date, time_local: m.time_local, home: names[m.home] || m.home, away: names[m.away] || m.away, home_key: m.home, away_key: m.away,
          lambda: { home: r4(p.lh), away: r4(p.la) },
          prices: {
            three_way: { home: r4(p.mk.home), draw: r4(p.mk.draw), away: r4(p.mk.away), fair_home: fair(p.mk.home), fair_draw: fair(p.mk.draw), fair_away: fair(p.mk.away), settles: '90 minutes plus stoppage time', status: status.three_way },
            total: { expected: Math.round(p.mk.exp_total * 100) / 100, over_1_5: r4(p.o15), over_2_5: r4(p.mk.over_2_5), over_3_5: r4(p.o35), fair_over_2_5: fair(p.mk.over_2_5), fair_under_2_5: fair(1 - p.mk.over_2_5), status: status.total_over_2_5 },
            btts: { yes: r4(p.mk.btts), fair_yes: fair(p.mk.btts), fair_no: fair(1 - p.mk.btts), status: status.btts },
            asian_handicap_home: Object.assign(p.ah, { settles: 'quarter lines as two half stakes', status: status.asian_handicap }),
          },
          data_quality: { state: recentMissing.length ? 'STALE' : 'FRESH', lineup: 'UNKNOWN — no lineup feed' },
          invalidators: ['Team news (injuries, rotation before a European or cup match) is not modelled.', 'Kick-off time zone is not in the source; prices are keyed by date.'].concat(recentMissing.length ? ['The source is missing recent results: ratings are stale.'] : []),
        };
      }),
    };
  }
  return out;
}

function check() {
  const s = JSON.parse(fs.readFileSync(C.PATHS.slate, 'utf8')); const fails = [];
  for (const [k, L] of Object.entries(s.leagues)) { if (L.value_claims && L.value_claims !== 'DISABLED') fails.push(k + ' claims value'); for (const g of L.games || []) { const t = g.prices.three_way; if (Math.abs(t.home + t.draw + t.away - 1) > 0.002) fails.push(k + ' 1X2 does not sum to 1 ' + g.match_id); } }
  if (fails.length) { console.error('[soccer slate --check] FAILED ' + fails.join('; ')); process.exit(1); }
  console.log('[soccer slate --check] ok: ' + Object.entries(s.leagues).map(([k, L]) => k + ' ' + (L.games || []).length).join(', '));
}

module.exports = { build, priceMatch, modelFromLive };
if (require.main === module) {
  if (process.argv.includes('--check')) check();
  else { const s = build({ now: Date.now(), days: Number(arg('days', 4)) }); fs.writeFileSync(C.PATHS.slate, JSON.stringify(s, null, 1) + '\n'); console.log('[soccer slate] ' + Object.entries(s.leagues).map(([k, L]) => k + ': ' + (L.games || []).length + (L.data ? ' (' + L.data.state + ')' : '')).join(' | ')); }
}
