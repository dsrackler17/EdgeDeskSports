#!/usr/bin/env node
/* ============================================================================
   MANUAL MARKET ENTRY — a market number the owner types in, with its time.
   docs/market-resilience/README.md (§ Market states)

   When no sportsbook feed is reachable (quota exhausted, provider outage, a
   game the feeds do not carry), the owner can record the number he sees. It
   becomes the game's MANUAL market state:

     - always labelled MANUAL, with who entered it and when;
     - used for research comparison only (the spread and total difference);
     - never LIVE, never a verified quote, never eligible for a betting
       decision (lib/edgedesk_market_state.js CAPABILITIES.MANUAL);
     - checked like any captured quote (impossible spreads and totals, a
       total that reads like a spread, malformed prices are refused).

   The file is append-only (football/markets/manual/cfb_<season>.jsonl): an
   entry is withdrawn by appending a withdrawal, never by editing a line.

     node tools/football/manual_market.js add --game 401856824 --spread -10.5 [--total 53.5]
          [--price-home -110 --price-away -110] [--note "DK app, 9:40 CT"] [--by owner] [--season 2026]
     node tools/football/manual_market.js list [--game 401856824] [--season 2026]
     node tools/football/manual_market.js withdraw --entry <entry_id> [--season 2026]

   --spread is the HOME line in book notation (negative = home favoured).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const MKS = require(path.join(ROOT, 'lib', 'edgedesk_market_state.js'));

function arg(argv, k, d) { const i = argv.indexOf('--' + k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; }
function numArg(argv, k) { const v = arg(argv, k, null); if (v == null) return null; const n = Number(v); if (!Number.isFinite(n)) throw new Error('--' + k + ' must be a number, got "' + v + '"'); return n; }
function fileFor(season, root) { return path.join(root || ROOT, 'football', 'markets', 'manual', 'cfb_' + season + '.jsonl'); }
function readRows(f) { return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
function gameOf(gid, root) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root || ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
    return (s.games || []).find((g) => String(g.game_id) === String(gid)) || null;
  } catch (e) { return null; }
}

/* the entry, checked; throws with the reason when the number cannot be a market */
function makeEntry(o, now) {
  if (o.game_id == null) throw new Error('--game is required');
  if (o.home_line == null && o.total == null) throw new Error('give --spread and/or --total');
  const g = o.game || null;
  const game = g ? { game_id: String(g.game_id), season: g.season, kickoff: g.kickoff, home: g.home_team, away: g.away_team } : { game_id: String(o.game_id) };
  const at = new Date(now == null ? Date.now() : now).toISOString();
  ['spread', 'total'].forEach((type) => {
    const v = type === 'spread' ? o.home_line : o.total;
    if (v == null) return;
    const c = MKS.checkQuote({ book: 'manual', source: 'manual', market_key: type, manual: true, home_line: type === 'spread' ? v : null, total: type === 'total' ? v : null,
      price_home: type === 'spread' ? o.price_home : null, price_away: type === 'spread' ? o.price_away : null,
      price_over: type === 'total' ? o.price_over : null, price_under: type === 'total' ? o.price_under : null, observed_at: at, game_id: String(o.game_id) }, game, Date.parse(at));
    if (!c.ok) throw new Error('refused (' + c.codes.join(', ') + '): ' + c.reasons.join('; '));
  });
  if (g && Date.parse(g.kickoff) <= Date.parse(at)) throw new Error('the game has kicked off (' + g.kickoff + '): a manual market is a pregame number');
  const body = { game_id: String(o.game_id), season: o.season, home: g ? g.home_team : null, away: g ? g.away_team : null,
    home_line: o.home_line, total: o.total, price_home: o.price_home, price_away: o.price_away, price_over: o.price_over, price_under: o.price_under,
    entered_at: at, entered_by: o.entered_by || 'owner', note: o.note || null, label: 'MANUAL' };
  body.entry_id = 'man_' + crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return body;
}

function main(argv) {
  const cmd = argv[0];
  const season = Number(arg(argv, 'season', String(new Date().getUTCFullYear())));
  const f = fileFor(season);
  if (cmd === 'add') {
    const gid = arg(argv, 'game', null);
    const e = makeEntry({ game_id: gid, game: gameOf(gid), season, home_line: numArg(argv, 'spread'), total: numArg(argv, 'total'),
      price_home: numArg(argv, 'price-home'), price_away: numArg(argv, 'price-away'), price_over: numArg(argv, 'price-over'), price_under: numArg(argv, 'price-under'),
      note: arg(argv, 'note', null), entered_by: arg(argv, 'by', 'owner') });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(e) + '\n');
    console.log('recorded ' + e.entry_id + ': ' + (e.away || '?') + ' @ ' + (e.home || '?') + (e.home_line != null ? ' · home ' + e.home_line : '') + (e.total != null ? ' · total ' + e.total : '')
      + ' · MANUAL, entered ' + e.entered_at + '. It is research context only: never LIVE, never a betting decision. Rebuild the terminal to show it.');
    return 0;
  }
  if (cmd === 'withdraw') {
    const id = arg(argv, 'entry', null);
    if (!id) throw new Error('--entry is required');
    if (!readRows(f).some((r) => r.entry_id === id)) throw new Error('no entry ' + id + ' in ' + path.relative(ROOT, f));
    fs.appendFileSync(f, JSON.stringify({ withdraws: id, at: new Date().toISOString(), by: arg(argv, 'by', 'owner') }) + '\n');
    console.log('withdrew ' + id + ' (appended; the original line is kept)');
    return 0;
  }
  if (cmd === 'list') {
    const gid = arg(argv, 'game', null), rows = readRows(f);
    const gone = new Set(rows.filter((r) => r.withdraws).map((r) => r.withdraws));
    rows.filter((r) => r.entry_id && (!gid || r.game_id === String(gid))).forEach((r) => console.log((gone.has(r.entry_id) ? '[withdrawn] ' : '') + r.entry_id + '  ' + r.entered_at + '  ' + (r.away || '?') + ' @ ' + (r.home || '?')
      + (r.home_line != null ? '  home ' + r.home_line : '') + (r.total != null ? '  total ' + r.total : '') + (r.note ? '  · ' + r.note : '')));
    return 0;
  }
  console.log('usage: manual_market.js add --game <id> --spread <home line> [--total <pts>] [--note ...] | list [--game <id>] | withdraw --entry <id>');
  return 2;
}

module.exports = { makeEntry, fileFor, readRows };
if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); }
}
