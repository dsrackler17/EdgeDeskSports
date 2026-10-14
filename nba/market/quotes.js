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
   unmatched is kept in `unmatched` with the reason, never guessed. A book
   listed twice for one event keeps its latest update; two provider events for
   one game keep the one with more books; both are counted, never merged.

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
    const books = []; const seenBook = new Map(); let dupBooks = 0;
    for (const b of e.bookmakers || []) {
      /* a book listed twice for one event: keep its latest update, count the other */
      const prev = seenBook.get(b.key);
      if (prev) { dupBooks++; if (String(b.last_update || '') <= String(prev.last_update || '')) continue; books.splice(books.indexOf(prev.row), 1); }
      const row = { book: b.key, title: b.title || b.key, last_update: b.last_update || null, h2h: null, spreads: [], totals: [] };
      for (const m of b.markets || []) {
        const lu = m.last_update || b.last_update || null; if (lu && (!row.last_update || lu > row.last_update)) row.last_update = lu;
        const oc = m.outcomes || [];
        if (m.key === 'h2h') { const h = oc.find((o) => idOf(o.name) === home), a = oc.find((o) => idOf(o.name) === away); if (h && a && oc.length === 2) row.h2h = { home: Number(h.price), away: Number(a.price) }; }
        else if (m.key === 'spreads') { const h = oc.find((o) => idOf(o.name) === home), a = oc.find((o) => idOf(o.name) === away); if (h && a && Number(h.point) === -Number(a.point)) row.spreads.push({ home_line: Number(h.point), home: Number(h.price), away: Number(a.price) }); }
        else if (m.key === 'totals') { const ov = oc.find((o) => /^over$/i.test(o.name)), un = oc.find((o) => /^under$/i.test(o.name)); if (ov && un && Number(ov.point) === Number(un.point)) row.totals.push({ line: Number(ov.point), over: Number(ov.price), under: Number(un.price) }); }
      }
      if (row.h2h || row.spreads.length || row.totals.length) { books.push(row); seenBook.set(b.key, { row, last_update: row.last_update }); }
    }
    /* two provider events for one game: keep the one with more books, report the other */
    const twin = out.find((x) => x.game_id === g.game_id);
    if (twin) {
      const keepNew = books.length > twin.books.length;
      unmatched.push({ event_id: keepNew ? twin.event_id : e.id, game_id: g.game_id, reason: 'duplicate provider event for one game (kept the one with more books)' });
      if (!keepNew) continue;
      out.splice(out.indexOf(twin), 1);
    }
    out.push({ game_id: g.game_id, event_id: e.id, home, away, commence_time: e.commence_time, books, duplicate_books_dropped: dupBooks });
  }
  return { events: out, unmatched };
}

function amToDec(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
/* two-way no-vig, multiplicative (the reference method; Shin differs by < 0.5 pp at NBA margins; strumbelj2014) */
function noVig(a, b) { const da = amToDec(a), db = amToDec(b); if (!da || !db) return null; const ia = 1 / da, ib = 1 / db; return { a: ia / (ia + ib), b: ib / (ia + ib), overround: ia + ib - 1 }; }

/* the same two prices under four published de-vig methods, and how far they
   disagree (the sensitivity of any market comparison to the method chosen):
     multiplicative  π_i / Σπ                       (proportional)
     additive        π_i − (Σπ − 1)/2               (equal margin per side, floored at 0.001)
     power           π_i^k with Σ π_i^k = 1         (favourite–longshot shaped)
     shin            Shin (1993): z solves Σ p_i(z) = 1, p_i = (√(z² + 4(1−z)π_i²/Σπ) − z) / (2(1−z))
   Each returns P(first side). */
function noVigMethods(a, b) {
  const da = amToDec(a), db = amToDec(b); if (!da || !db) return null;
  const ia = 1 / da, ib = 1 / db, S = ia + ib, m = S - 1;
  const mult = ia / S;
  const add = Math.min(0.999, Math.max(0.001, ia - m / 2)); const addN = add / (add + Math.min(0.999, Math.max(0.001, ib - m / 2)));
  let lo = 0.2, hi = 5; for (let i = 0; i < 80; i++) { const k = (lo + hi) / 2; if (Math.pow(ia, k) + Math.pow(ib, k) > 1) lo = k; else hi = k; }
  const k = (lo + hi) / 2; const pw = Math.pow(ia, k) / (Math.pow(ia, k) + Math.pow(ib, k));
  const shinP = (z, pi) => (Math.sqrt(z * z + 4 * (1 - z) * pi * pi / S) - z) / (2 * (1 - z));
  let zl = 0, zh = 0.4; for (let i = 0; i < 80; i++) { const z = (zl + zh) / 2; if (shinP(z, ia) + shinP(z, ib) > 1) zl = z; else zh = z; }
  const z = (zl + zh) / 2; const sh = shinP(z, ia) / (shinP(z, ia) + shinP(z, ib));
  const all = [mult, addN, pw, sh];
  return { multiplicative: mult, additive: addN, power: pw, shin: sh, overround: m, spread: Math.max(...all) - Math.min(...all) };
}

module.exports = { normaliseEvents, noVig, noVigMethods, amToDec, norm };
