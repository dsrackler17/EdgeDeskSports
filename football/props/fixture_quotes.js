/* ===========================================================================
   TEST FIXTURE — priced player-prop artifacts for the UI tests ONLY.

   EdgeDesk has no captured sportsbook prop quote in this repository (capture
   needs the ODDS_API_KEY and vars.PROPS_CAPTURE), yet the page must render the
   priced paths: market consensus, line shopping, movement, the alternate-line
   ladder with its best-value row, EV and the capped decision. This module
   builds those paths from the REAL published board and cards plus a quote set
   invented here and labelled as such at every level:

     - every sportsbook is named FIXTURE-A / FIXTURE-B / FIXTURE-C
     - the market file and the board carry fixture: 'TEST FIXTURE …'
     - nothing is ever written under football/props/published: the tests
       serve these objects from memory

   The quotes go through the production path (the kernel's reprice(), then the
   publisher's pack functions), so what the page shows is exactly what a live
   capture of the same prices would show. They are NEVER historical lines and
   never enter a ledger, a backtest or the database.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const EDP = require('../../lib/player_props.js');

const PUB = path.join(__dirname, 'published');
const LABEL = 'TEST FIXTURE — invented quotes for the UI tests; not sportsbook data';
const BOOKS = ['FIXTURE-A', 'FIXTURE-B', 'FIXTURE-C'];

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
function am(p) { p = Math.min(0.97, Math.max(0.03, p)); return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p); }

/* one prop's quotes: an opener six hours ago, the current poll 20 minutes
   ago; main lines near the model median (shifted per prop so some sides are
   +EV and some are not), alternates on the yardage markets */
function quotesFor(p, now) {
  const opener = new Date(now - 6 * 3600e3).toISOString(), cur = new Date(now - 20 * 60e3).toISOString();
  const u = hash(p.id), d = p.model.dist, out = [];
  const base = { game_id: p.game_id, player_id: p.player_id, market_key: p.market_key, lineage: 'observed' };
  if (d.t === 'bern') {
    const pm = Math.min(0.9, Math.max(0.05, d.p * (0.85 + 0.3 * u)));
    BOOKS.forEach((b, i) => { const s = 0.015 * i;
      out.push(Object.assign({ sportsbook: b, side: 'yes', line: null, american_price: am(pm * 1.04 + s), snapshot_at: cur, is_main_line: true }, base));
      out.push(Object.assign({ sportsbook: b, side: 'no', line: null, american_price: am((1 - pm) * 1.04 - s), snapshot_at: cur, is_main_line: true }, base)); });
    return out;
  }
  /* a book hangs its number near the median, never below the first half point */
  const shift = [-1, 0, 0, 1][Math.floor(u * 4)] * Math.max(0.5, Math.round((p.model.sd || 1) * 0.1 * 2) / 2);
  const main = Math.max(0.5, Math.floor(p.model.median + shift) + 0.5);
  /* the fixture "market" disagrees with the model a little, in log-odds, so the
     tails stay priced like a book prices them (some sides +EV, most not) */
  const lg = (x) => Math.log(x / (1 - x)), ex = (z) => 1 / (1 + Math.exp(-z));
  const pOver = (line) => { const pr = EDP.dist.probs(d, line); const po = Math.min(0.985, Math.max(0.015, pr.over / Math.max(1e-9, 1 - pr.push))); return ex(0.93 * lg(po) + 0.5 * (u - 0.5)); };
  BOOKS.forEach((b, i) => {
    const line = i === 2 ? main + 1 : main, po = pOver(line), vig = 1.045 + 0.01 * i;
    const open = Math.max(0.5, line - 1);
    out.push(Object.assign({ sportsbook: b, side: 'over', line: open, american_price: am(pOver(open) * vig), snapshot_at: opener, is_main_line: true }, base));
    out.push(Object.assign({ sportsbook: b, side: 'under', line: open, american_price: am((1 - pOver(open)) * vig), snapshot_at: opener, is_main_line: true }, base));
    out.push(Object.assign({ sportsbook: b, side: 'over', line, american_price: am(po * vig), snapshot_at: cur, is_main_line: true }, base));
    out.push(Object.assign({ sportsbook: b, side: 'under', line, american_price: am((1 - po) * vig), snapshot_at: cur, is_main_line: true }, base));
  });
  if (EDP.MARKETS[p.market_key] && EDP.MARKETS[p.market_key].family === 'continuous') {
    const step = Math.max(2.5, Math.round((p.model.sd || 10) * 0.4 / 2.5) * 2.5);
    [-2, -1, 1, 2, 3].forEach((k) => {
      const line = main + k * step; if (line < 0.5) return;
      BOOKS.slice(0, 2).forEach((b, i) => out.push(Object.assign({ sportsbook: b, side: 'over', line, american_price: am(pOver(line) * (1.06 + 0.02 * i)), snapshot_at: cur, is_main_line: false, is_alt_line: true }, base)));
    });
  }
  return out;
}
function listingsFor(qs) {
  const by = {};
  qs.forEach((q) => { const L = by[q.sportsbook] || (by[q.sportsbook] = { sportsbook: q.sportsbook, snapshot_at: q.snapshot_at, keys: [] }); if (q.snapshot_at > L.snapshot_at) { L.snapshot_at = q.snapshot_at; L.keys = []; } });
  qs.forEach((q) => { const L = by[q.sportsbook]; if (q.snapshot_at === L.snapshot_at) L.keys.push(EDP.quoteKey(q)); });
  return Object.values(by);
}

/* the priced fixture for one league: { board, markets: {game_id: market}, game_id, n_quotes } */
function build(league, opts) {
  opts = opts || {};
  const lg = String(league).toLowerCase();
  const now = opts.now || Date.now();
  const raw = JSON.parse(fs.readFileSync(path.join(PUB, 'board_' + lg + '.json'), 'utf8'));
  const games = raw.games.filter((g) => fs.existsSync(path.join(PUB, lg, g.game_id + '.json')));
  if (!games.length) return null;
  const pricedIds = new Set((opts.games || [games[0].game_id]).slice(0, 3));
  const nowIso = new Date(now).toISOString();
  const all = [], markets = {};
  let nQ = 0, last = '';
  games.forEach((g) => {
    const card = JSON.parse(fs.readFileSync(path.join(PUB, lg, g.game_id + '.json'), 'utf8'));
    const props = EDP.wire.expandCard(card, null);
    if (pricedIds.has(g.game_id)) {
      const priced = [];
      props.forEach((p, i) => {
        /* books list the headline markets for the main players: price about half */
        if (hash(p.id + 'x') > 0.55 && i > 3) { priced.push(p); return; }
        const qs = quotesFor(p, now);
        nQ += qs.length; qs.forEach((q) => { if (q.snapshot_at > last) last = q.snapshot_at; });
        priced.push(EDP.reprice(p, qs, { now, listings: listingsFor(qs) }));
      });
      const mk = EDP.wire.packMarket(priced, { league: raw.league, game_id: g.game_id, as_of: nowIso });
      if (mk) { mk.fixture = LABEL; markets[g.game_id] = mk; }
      priced.forEach((p) => all.push(p));
    } else props.forEach((p) => all.push(p));
  });
  const meta = {};
  Object.keys(raw).forEach((k) => { if (['players', 'markets', 'models', 'cols', 'rows', 'n_props'].indexOf(k) < 0) meta[k] = raw[k]; });
  meta.generated_at = nowIso; meta.as_of = nowIso; meta.fixture = LABEL;
  meta.quotes = { captured: true, provider: 'TEST FIXTURE', n_quotes: nQ, last_capture: last || null, note: LABEL };
  const byKick = (a, b) => (a.kickoff_utc < b.kickoff_utc ? -1 : a.kickoff_utc > b.kickoff_utc ? 1 : 0) || String(a.player).localeCompare(String(b.player)) || String(a.market_key).localeCompare(String(b.market_key));
  const board = EDP.wire.packBoard(meta, all.sort(byKick));
  return { board, markets, game_id: Array.from(pricedIds)[0], n_quotes: nQ, label: LABEL };
}

module.exports = { build, quotesFor, listingsFor, LABEL, BOOKS };
