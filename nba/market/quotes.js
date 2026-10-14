'use strict';
/* ===========================================================================
   EdgeDesk NBA — sportsbook quotes, normalised and matched to games.

   Input: The Odds API v4 `odds` payload for basketball_nba as the odds gateway
   returns it (events → bookmakers → markets h2h / spreads / totals →
   outcomes {name, price, point}), American prices. Output: the shared
   edgedesk_market_quotes_v1 rows, keyed by the ESPN game id:
     { game_id, event_id, home, away, commence_time,
       books: [{ book, last_update, h2h:{home,away}, spreads:[{home_line,home,away}], totals:[{line,over,under}] }] }

   IDENTITY. A provider event is matched to a scheduled game by both teams
   (full names from nba/data/teams.json) and a start within 6 hours. Anything
   unmatched is kept in `unmatched` with the reason, never guessed.

   SETTLEMENT (assumed provider defaults, the common North American rules the
   distribution prices): h2h is the two-way moneyline incl. overtime; spreads
   and totals include overtime. A book that settles otherwise must not be
   compared.
   =========================================================================== */
const path = require('path');
const fs = require('fs');

function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
const ALIASES = { 'la clippers': '12', 'los angeles clippers': '12', 'la lakers': '13' };
function nameToId() {
  const teams = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'teams.json'), 'utf8'));
  const m = new Map(); for (const [id, name] of Object.entries(teams)) if (Number(id) > 0 && !/^TBD$/.test(name)) m.set(norm(name), id);
  for (const [a, id] of Object.entries(ALIASES)) if (!m.has(a)) m.set(a, id);
  return m;
}

function normaliseEvents(events, schedule) {
  const N = nameToId(); const idOf = (n) => N.get(norm(n)) || null;
  const out = []; const unmatched = [];
  for (const e of events || []) {
    const home = idOf(e.home_team), away = idOf(e.away_team);
    if (!home || !away) { unmatched.push({ event_id: e.id, home_team: e.home_team, away_team: e.away_team, reason: 'team name not in nba/data/teams.json' }); continue; }
    const t = Date.parse(e.commence_time);
    const g = (schedule || []).find((x) => x.home === home && x.away === away && Math.abs(Date.parse(x.start_utc) - t) <= 6 * 3600e3);
    if (!g) { unmatched.push({ event_id: e.id, home, away, commence_time: e.commence_time, reason: 'no scheduled game with these teams within 6 hours' }); continue; }
    const books = [];
    for (const b of e.bookmakers || []) {
      const row = { book: b.key, title: b.title || b.key, last_update: b.last_update || null, h2h: null, spreads: [], totals: [] };
      for (const m of b.markets || []) {
        const lu = m.last_update || b.last_update || null; if (lu && (!row.last_update || lu > row.last_update)) row.last_update = lu;
        const oc = m.outcomes || [];
        if (m.key === 'h2h') { const h = oc.find((o) => idOf(o.name) === home), a = oc.find((o) => idOf(o.name) === away); if (h && a && oc.length === 2) row.h2h = { home: Number(h.price), away: Number(a.price) }; }
        else if (m.key === 'spreads') { const h = oc.find((o) => idOf(o.name) === home), a = oc.find((o) => idOf(o.name) === away); if (h && a && Number(h.point) === -Number(a.point)) row.spreads.push({ home_line: Number(h.point), home: Number(h.price), away: Number(a.price) }); }
        else if (m.key === 'totals') { const ov = oc.find((o) => /^over$/i.test(o.name)), un = oc.find((o) => /^under$/i.test(o.name)); if (ov && un && Number(ov.point) === Number(un.point)) row.totals.push({ line: Number(ov.point), over: Number(ov.price), under: Number(un.price) }); }
      }
      if (row.h2h || row.spreads.length || row.totals.length) books.push(row);
    }
    out.push({ game_id: g.game_id, event_id: e.id, home, away, commence_time: e.commence_time, books });
  }
  return { events: out, unmatched };
}

function amToDec(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
/* two-way no-vig, multiplicative (Shin differs by < 0.5 pp at NBA margins; strumbelj2014) */
function noVig(a, b) { const da = amToDec(a), db = amToDec(b); if (!da || !db) return null; const ia = 1 / da, ib = 1 / db; return { a: ia / (ia + ib), b: ib / (ia + ib), overround: ia + ib - 1 }; }

module.exports = { normaliseEvents, noVig, amToDec, norm };
