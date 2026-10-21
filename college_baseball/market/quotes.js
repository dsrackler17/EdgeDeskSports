'use strict';
/* ===========================================================================
   EdgeDesk college baseball — sportsbook prices, kept so the model can be
   graded against the closing line (EXPERIMENTS.md, college baseball).

   Input: the odds gateway's `featured` payload for baseball_ncaa (The Odds
   API v4: events → bookmakers → markets h2h / spreads / totals → outcomes
   {name, price, point}), American prices.

   IDENTITY. A provider team name is our team id only by an exact key: the
   registry's school name with its nickname ("Adams St." + "Grizzlies" ->
   "adamsstategrizzlies", "St." read as "State"), our NCAA name with the
   nickname, or an entry in college_baseball/market/aliases.json (each one
   written by a person from an unmatched name this job reported). A key two
   teams share is never used. An event whose two teams do not both resolve is
   kept in `unmatched` with the names, never guessed onto a game; the contest
   is joined later, at grading, by date and the two team ids.

   WHAT IS KEPT, per event, book and market (h2h, spreads, totals):
     - every observation that differs from the last one kept (a change log,
       observations/<date>.jsonl.gz, by capture date in UTC);
     - the first price seen (OPEN) and the last price seen before the first
       pitch (CLOSE), with when each was seen. An event is finalised into
       lines.jsonl at the first run after its start; prices captured at or
       after the start are live prices and are never kept as pregame ones.
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const keyName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and')
  .replace(/\bst\b\.?/g, 'state').replace(/[^a-z0-9]/g, '');
const amToDec = (a) => { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; };
/* two-way no-vig by the multiplicative method (the harness's default) */
function noVig(a, b) { const da = amToDec(a), db = amToDec(b); if (!da || !db) return null; const ia = 1 / da, ib = 1 / db; return { a: ia / (ia + ib), b: ib / (ia + ib), overround: ia + ib - 1 }; }

/* provider name -> team id: { resolve(name) -> { id } | { id: null, why } } */
function teamIndex(o) {
  o = o || {};
  const by = new Map();
  const add = (k, id, src) => { if (!k) return; const e = by.get(k); if (!e) by.set(k, { id: String(id), src }); else if (e.id !== String(id)) e.ambiguous = true; };
  for (const s of o.schools || []) {
    if (!s.baseball_team_id || !s.nickname) continue;
    for (const n of [s.name, s.ncaa_name]) if (n) add(keyName(n + ' ' + s.nickname), s.baseball_team_id, 'registry');
  }
  const nick = new Map((o.schools || []).filter((s) => s.baseball_team_id && s.nickname).map((s) => [String(s.baseball_team_id), s.nickname]));
  for (const t of o.teamSeasons || []) { const nk = nick.get(String(t.team_id)); if (nk) add(keyName(t.name + ' ' + nk), t.team_id, 'ncaa_name'); }
  const alias = new Map(Object.entries((o.aliases && o.aliases.aliases) || {}).map(([k, v]) => [keyName(k), String(v.team_id != null ? v.team_id : v)]));
  /* our Division I teams' own names (our NCAA names for the season, and the registry's), for the second tier */
  const names = new Map();
  const addName = (n, id) => { const k = keyName(n); if (!k) return; const e = names.get(k); if (!e) names.set(k, { id: String(id) }); else if (e.id !== String(id)) e.ambiguous = true; };
  for (const t of o.teamSeasons || []) if (!o.division || +t.division === o.division) addName(t.name, t.team_id);
  for (const s of o.schools || []) if (s.baseball_team_id && s.division === 1) for (const n of [s.name, s.ncaa_name]) if (n) addName(n, s.baseball_team_id);
  return {
    /* 1. an alias a person wrote; 2. school and nickname, exactly; 3. the LONGEST of our team names the provider's name
       starts with, the rest read as its nickname ("Texas A&M Aggies" is Texas A&M, never Texas). The third is kept as
       via "name_prefix" and listed for review in quotes.json; and at grading an event joins a contest only when our
       record has those two teams playing that date, so a prefix can never put a price on a game that was not played */
    resolve(name) {
      const k = keyName(name);
      if (alias.has(k)) return { id: alias.get(k), via: 'alias' };
      const e = by.get(k);
      if (e && e.ambiguous) return { id: null, why: '"' + name + '" names two of our teams' };
      if (e) return { id: e.id, via: e.src };
      /* whole words only: the first i words of the provider's name are one of our names, the rest its nickname */
      const words = String(name || '').trim().split(/\s+/);
      for (let i = words.length - 1; i >= 1; i--) {
        const v = names.get(keyName(words.slice(0, i).join(' ')));
        if (!v) continue;
        if (v.ambiguous) break;
        const nk = nick.get(v.id);
        const rest = keyName(words.slice(i).join(' '));
        /* where the registry knows the team's nickname, the rest must be it (or its last words: "Tigers" of "Fighting Tigers") */
        if (!nk || keyName(nk).endsWith(rest)) return { id: v.id, via: 'name_prefix' };
        break;
      }
      return { id: null, why: 'no team of ours is named "' + name + '"; add it to college_baseball/market/aliases.json if it is one' };
    },
    size: by.size,
  };
}

/* one provider event -> { event_id, commence_time, home_id, away_id, home_name, away_name, books: { book: { h2h, spreads, totals } } } */
function normaliseEvent(e, index) {
  const h = index.resolve(e.home_team), a = index.resolve(e.away_team);
  const base = { event_id: e.id, commence_time: e.commence_time, home_name: e.home_team, away_name: e.away_team };
  if (!h.id || !a.id || h.id === a.id) return Object.assign(base, { unmatched: [h.why, a.why].filter(Boolean).join('; ') || 'both names are one team' });
  const books = {};
  for (const b of e.bookmakers || []) {
    const row = {};
    for (const m of b.markets || []) {
      const out = m.outcomes || [];
      const byName = (n) => out.find((x) => x.name === n);
      if (m.key === 'h2h' && out.length === 2) {
        const ho = byName(e.home_team), ao = byName(e.away_team);
        if (ho && ao) row.h2h = { home: Number(ho.price), away: Number(ao.price) };
      } else if (m.key === 'spreads') {
        const ho = byName(e.home_team), ao = byName(e.away_team);
        if (ho && ao && Number(ho.point) === -Number(ao.point)) row.spreads = { home_line: Number(ho.point), home: Number(ho.price), away: Number(ao.price) };
      } else if (m.key === 'totals') {
        const ov = out.find((x) => /^over$/i.test(x.name)), un = out.find((x) => /^under$/i.test(x.name));
        if (ov && un && Number(ov.point) === Number(un.point)) row.totals = { line: Number(ov.point), over: Number(ov.price), under: Number(un.price) };
      }
    }
    if (Object.keys(row).length) books[b.key] = row;
  }
  return Object.assign(base, { home_id: h.id, away_id: a.id, home_via: h.via, away_via: a.via, books });
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/* fold one capture into the state; returns { observations: changed rows, finalised: lines rows } */
function fold(state, events, at) {
  state.events = state.events || {};
  const observations = []; const finalised = [];
  const t = Date.parse(at);
  for (const e of events) {
    if (e.unmatched) continue;
    const start = Date.parse(e.commence_time);
    if (!(t < start)) continue;                                     /* a price at or after the first pitch is live: never pregame */
    const s = state.events[e.event_id] || (state.events[e.event_id] = { commence_time: e.commence_time, home_id: e.home_id, away_id: e.away_id, home_name: e.home_name, away_name: e.away_name,
      home_via: e.home_via, away_via: e.away_via, books: {} });
    s.commence_time = e.commence_time;                               /* a moved start moves the close with it */
    for (const [book, mk] of Object.entries(e.books)) {
      const sb = s.books[book] || (s.books[book] = {});
      for (const [market, price] of Object.entries(mk)) {
        const sm = sb[market];
        const changed = !sm || !same(sm.last, price);
        if (!sm) sb[market] = { open_at: at, open: price, last_at: at, last: price };
        else { sm.last_at = at; sm.last = price; }
        if (changed) observations.push({ at, event_id: e.event_id, commence_time: e.commence_time, home_id: e.home_id, away_id: e.away_id, book, market, price });
      }
    }
  }
  /* events whose first pitch has passed: their last pregame price is the close */
  for (const [id, s] of Object.entries(state.events)) {
    if (!(t >= Date.parse(s.commence_time))) continue;
    for (const [book, sb] of Object.entries(s.books)) for (const [market, sm] of Object.entries(sb)) {
      finalised.push({ event_id: id, commence_time: s.commence_time, home_id: s.home_id, away_id: s.away_id, home_name: s.home_name, away_name: s.away_name, home_via: s.home_via, away_via: s.away_via, book, market,
        open_at: sm.open_at, open: sm.open, close_at: sm.last_at, close: sm.last, close_age_min: Math.round((Date.parse(s.commence_time) - Date.parse(sm.last_at)) / 60000) });
    }
    delete state.events[id];
  }
  return { observations, finalised };
}

/* -------------------------------------------------------------- files */
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
function appendJsonl(f, rows) { if (!rows.length) return; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); }
function appendGz(f, rows) {
  if (!rows.length) return;
  const zlib = require('zlib');
  const prev = fs.existsSync(f) ? zlib.gunzipSync(fs.readFileSync(f)).toString('utf8') : '';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, zlib.gzipSync(prev + rows.map((r) => JSON.stringify(r)).join('\n') + '\n'));
}
function readJsonl(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } }

module.exports = { keyName, amToDec, noVig, teamIndex, normaliseEvent, fold, readJson, readJsonl, appendJsonl, appendGz };
