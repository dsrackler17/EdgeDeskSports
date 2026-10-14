'use strict';
/* ===========================================================================
   EdgeDesk NHL LAB — context features, point in time.

   Two kinds, both known before puck drop:

   SCHEDULE (known weeks ahead): for each club, from its previous game's
   location to tonight's (hockey/data/arenas.json):
     travel_km     great-circle distance travelled since the previous game
     tz_shift      hours of clock change since the previous game (+ = east,
                   i.e. the body clock is behind; IANA offsets at the date, so
                   daylight saving and Arizona are exact)
     games_3d      games in the three days before today (2 → tonight is the
                   third in four days)
     road_len      consecutive road games including tonight (0 at home)
     season_games  games this club has played this season before tonight

   RESULTS (games on EARLIER dates only, the ratings pass's rule):
     form_off      ln(5v5 xG for per 60 over the last 10 games / over the last 40)
     form_def      ln(5v5 xG against per 60, last 10 / last 40)   (+ = worse)
     luck_fin      ln((goals + 10) / (xG + 10)) on unblocked attempts against a
                   goalie, last 20 games: finishing above expectation recently
     luck_sv       ln((goals against + 10) / (xG against + 10)), last 20 games
                   (− = the goaltending has been stopping more than expected)
   Short windows are shrunk by pseudo-counts so a new club's first games read
   as average. These are candidates: hockey/lab/run.js decides, out of sample,
   whether any of them earns a place (most published work says rest and
   travel effects in the NHL are small; the lab measures it here).

   Each snapshot side carries its own values and the opponent's (`*_opp`).
   =========================================================================== */
const path = require('path');

let ARENAS = null;
function arenas() { if (!ARENAS) ARENAS = require(path.join(__dirname, '..', 'data', 'arenas.json')).arenas; return ARENAS; }
function dayNum(date) { return Math.floor(Date.parse(date + 'T12:00:00Z') / 864e5); }

function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const OFF_CACHE = new Map();
/** UTC offset in hours of an IANA zone at a date (noon UTC) */
function tzOffset(tz, date) {
  const k = tz + '|' + date; if (OFF_CACHE.has(k)) return OFF_CACHE.get(k);
  let off = null;
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).format(new Date(date + 'T12:00:00Z'));
    const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(s); off = m ? Number(m[1]) + (m[2] ? Math.sign(Number(m[1])) * Number(m[2]) / 60 : 0) : 0;
  } catch (_) { off = null; }
  OFF_CACHE.set(k, off); return off;
}
function locOf(homeTeam) { return arenas()[homeTeam] || null; }

/** schedule features of `team` playing at `homeTeam`'s arena on `date`, given its earlier appearances [{date, at}] (most recent last) */
function scheduleFeatures(team, homeTeam, date, earlier) {
  const here = locOf(homeTeam);
  const prev = earlier.length ? earlier[earlier.length - 1] : null;
  const day = dayNum(date);
  let travel = 0, tz = 0;
  if (prev && here) {
    const there = locOf(prev.at);
    const d = haversineKm(there, here); travel = d == null ? 0 : d;
    const o1 = there ? tzOffset(there.tz, prev.date) : null, o2 = tzOffset(here.tz, date);
    tz = o1 == null || o2 == null ? 0 : o2 - o1;
  }
  let g3 = 0; for (let i = earlier.length - 1; i >= 0; i--) { const dd = day - dayNum(earlier[i].date); if (dd <= 0) continue; if (dd > 3) break; g3++; }
  let road = 0;
  if (homeTeam !== team) { road = 1; for (let i = earlier.length - 1; i >= 0; i--) { if (earlier[i].at === team) break; road++; } }
  return { travel_km: Math.round(travel), tz_shift: tz, games_3d: g3, road_len: road, first_game: prev ? 0 : 1 };
}

class ContextState {
  constructor() { this.hist = new Map(); /* team → [{xgf5, xga5, toi5, gf, xgf, ga, xga}] newest last */ this.app = new Map(); /* team → [{date, at}] */ this.sg = new Map(); /* team → { season, n } */ }
  results(team) {
    const h = this.hist.get(team) || [];
    const win = (n) => { const a = h.slice(-n); const s = { xgf5: 0, xga5: 0, toi5: 0, gf: 0, xgf: 0, ga: 0, xga: 0, n: a.length }; for (const x of a) for (const k in x) s[k] += x[k]; return s; };
    const s10 = win(10), s40 = win(40), s20 = win(20);
    const rate = (num, toi, pNum, pToi) => (num + pNum) / (toi + pToi);
    /* 5v5 per-60 rates, each window shrunk toward the long window with 3 games (~2.5 h) of pseudo-time */
    const lgOff = s40.toi5 > 0 ? s40.xgf5 / s40.toi5 : null, lgDef = s40.toi5 > 0 ? s40.xga5 / s40.toi5 : null;
    const form_off = lgOff ? Math.log(rate(s10.xgf5, s10.toi5, lgOff * 8100, 8100) / lgOff) : 0;
    const form_def = lgDef ? Math.log(rate(s10.xga5, s10.toi5, lgDef * 8100, 8100) / lgDef) : 0;
    return { form_off, form_def, luck_fin: Math.log((s20.gf + 10) / (s20.xgf + 10)), luck_sv: Math.log((s20.ga + 10) / (s20.xga + 10)), form_games: s10.n };
  }
  /** features for one team tonight; `at` = the home club */
  features(team, at, date, season) {
    const c = this.sg.get(team);
    return Object.assign(scheduleFeatures(team, at, date, this.app.get(team) || []), this.results(team), { season_games: c && c.season === season ? c.n : 0 });
  }
  /** record a scheduled appearance (call in date order, after the snapshot) */
  appear(team, at, date, season) {
    const a = this.app.get(team) || []; a.push({ date, at }); if (a.length > 12) a.shift(); this.app.set(team, a);
    const c = this.sg.get(team); this.sg.set(team, c && c.season === season ? { season, n: c.n + 1 } : { season, n: 1 });
  }
  /** absorb a completed game's two team-game rows */
  absorb(rows) {
    const [a, b] = rows;
    for (const x of rows) {
      const o = x === a ? b : a;
      const vsT = (r) => (r.ev5_xgf || 0) + (r.evo_xgf || 0) + (r.pp_xgf || 0) + (r.sh_xgf || 0);
      const gT = (r) => (r.ev5_gf || 0) + (r.evo_gf || 0) + (r.pp_gf || 0) + (r.sh_gf || 0);
      const h = this.hist.get(x.team) || [];
      h.push({ xgf5: x.ev5_xgf || 0, xga5: o.ev5_xgf || 0, toi5: x.toi_ev5 || 0, gf: gT(x), xgf: vsT(x), ga: gT(o), xga: vsT(o) });
      if (h.length > 40) h.shift();
      this.hist.set(x.team, h);
    }
  }
}

const KEYS = ['travel_km', 'tz_shift', 'games_3d', 'road_len', 'first_game', 'form_off', 'form_def', 'luck_fin', 'luck_sv', 'season_games'];
function pairFeatures(own, opp) { const o = Object.assign({}, own); for (const k of KEYS) o[k + '_opp'] = opp[k]; return o; }

/** game_id → { home, away } context for completed games (one chronological pass, date-batched) */
function contextFeatures(games) {
  const st = new ContextState(); const out = new Map();
  let i = 0;
  while (i < games.length) {
    const date = games[i].date; let j = i;
    while (j < games.length && games[j].date === date) j++;
    const day = games.slice(i, j);
    for (const g of day) {
      const h = st.features(g.home, g.home, g.date, g.season), a = st.features(g.away, g.home, g.date, g.season);
      out.set(g.game_id, { home: pairFeatures(h, a), away: pairFeatures(a, h) });
    }
    for (const g of day) { st.appear(g.home, g.home, g.date, g.season); st.appear(g.away, g.home, g.date, g.season); st.absorb([g.h, g.a]); }
    i = j;
  }
  return out;
}

module.exports = { ContextState, contextFeatures, scheduleFeatures, pairFeatures, haversineKm, tzOffset, KEYS, arenas };
