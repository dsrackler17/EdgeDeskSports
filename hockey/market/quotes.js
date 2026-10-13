'use strict';
/* ===========================================================================
   EdgeDesk NHL — sportsbook quotes, normalised and matched to games.

   Input: The Odds API v4 `odds` payload for icehockey_nhl as the odds gateway
   returns it (events with bookmakers → markets h2h / spreads / totals →
   outcomes {name, price, point}), American prices.
   Output (schema edgedesk_market_quotes_v1, shared by every sport):
     { game_id, event_id, home, away, commence_time,
       books: [{ book, last_update, h2h:{home,away}, spreads:[{home_line,home,away}], totals:[{line,over,under}] }] }

   IDENTITY. A provider event is matched to an NHL game by both clubs
   (hockey/data/teams.json names and aliases) and a start within 6 hours of
   the schedule's. Anything unmatched is kept in `unmatched` with the reason —
   never guessed onto a game.

   SETTLEMENT. The provider's NHL `h2h` is the two-way moneyline including
   overtime and the shootout, `spreads` the puck line including OT/SO, and
   `totals` include OT with the shootout winner credited one goal — the
   common North American rules, which are the ones hockey/model/distribution.js
   prices. A 60-minute (three-way) market is a different contract and is not
   requested. This mapping is an ASSUMPTION about the provider's market
   definitions, documented in docs/engine/DATA.md; a book that settles
   otherwise must not be compared.
   =========================================================================== */
const TEAMS = require('../data/teams.json').teams;

function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
const NAME_TO_ABBR = (() => {
  const m = new Map();
  for (const [abbr, t] of Object.entries(TEAMS)) { if (t.inactive_since) continue; m.set(norm(t.name), abbr); for (const a of t.aliases || []) if (!m.has(norm(a))) m.set(norm(a), abbr); }
  return m;
})();
function abbrOf(name) { return NAME_TO_ABBR.get(norm(name)) || null; }

function normaliseEvents(events, schedule) {
  const out = []; const unmatched = [];
  for (const e of events || []) {
    const home = abbrOf(e.home_team), away = abbrOf(e.away_team);
    if (!home || !away) { unmatched.push({ event_id: e.id, home_team: e.home_team, away_team: e.away_team, reason: 'club name not in hockey/data/teams.json' }); continue; }
    const t = Date.parse(e.commence_time);
    const g = (schedule || []).find((x) => x.home === home && x.away === away && Math.abs(Date.parse(x.start_utc) - t) <= 6 * 3600e3);
    if (!g) { unmatched.push({ event_id: e.id, home, away, commence_time: e.commence_time, reason: 'no scheduled game with these clubs within 6 hours' }); continue; }
    const books = [];
    for (const b of e.bookmakers || []) {
      const row = { book: b.key, title: b.title || b.key, last_update: b.last_update || null, h2h: null, spreads: [], totals: [] };
      for (const m of b.markets || []) {
        const lu = m.last_update || b.last_update || null;
        if (lu && (!row.last_update || lu > row.last_update)) row.last_update = lu;
        if (m.key === 'h2h') {
          const h = (m.outcomes || []).find((o) => abbrOf(o.name) === home), a = (m.outcomes || []).find((o) => abbrOf(o.name) === away);
          if (h && a && (m.outcomes || []).length === 2) row.h2h = { home: Number(h.price), away: Number(a.price) };
        } else if (m.key === 'spreads') {
          const h = (m.outcomes || []).find((o) => abbrOf(o.name) === home), a = (m.outcomes || []).find((o) => abbrOf(o.name) === away);
          if (h && a && Number(h.point) === -Number(a.point)) row.spreads.push({ home_line: Number(h.point), home: Number(h.price), away: Number(a.price) });
        } else if (m.key === 'totals') {
          const ov = (m.outcomes || []).find((o) => /^over$/i.test(o.name)), un = (m.outcomes || []).find((o) => /^under$/i.test(o.name));
          if (ov && un && Number(ov.point) === Number(un.point)) row.totals.push({ line: Number(ov.point), over: Number(ov.price), under: Number(un.price) });
        }
      }
      if (row.h2h || row.spreads.length || row.totals.length) books.push(row);
    }
    out.push({ game_id: g.game_id, event_id: e.id, home, away, commence_time: e.commence_time, books });
  }
  return { events: out, unmatched };
}

/* two-way no-vig by the multiplicative method; Shin differs by < 0.5 pp at NHL margins (strumbelj2014) */
function amToDec(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
function noVig(a, b) { const da = amToDec(a), db = amToDec(b); if (!da || !db) return null; const ia = 1 / da, ib = 1 / db; return { a: ia / (ia + ib), b: ib / (ia + ib), overround: ia + ib - 1 }; }

module.exports = { abbrOf, normaliseEvents, noVig, amToDec };
