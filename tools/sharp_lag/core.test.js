#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_sharp_lag.js — the Sharp-lag research core, without a network.
     devig     Shin, identical to capture's devig() (imported from the deployed
               function under Node's type stripping), underround -> proportional
     quotes    a gateway body (decimal or American, /odds or one event) -> rows
     rules     every number is public.sharp_lag_rule()'s
     triggers  Kalshi moves of 3c+, starter status changes, goalie changes
   Run: node tools/sharp_lag/core.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const L = require(path.join(ROOT, 'lib', 'edgedesk_sharp_lag.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e == null ? 1e-9 : e);

const NOW = '2026-11-02T18:00:00Z', T = Date.parse(NOW);
const at = (min) => new Date(T + min * 60000).toISOString();
const KICK = at(240);
const EV = { event_id: 'ev1', sport_key: 'americanfootball_nfl', home_team: 'Philadelphia Eagles', away_team: 'Dallas Cowboys', commence_time: KICK };
const row = (book, market, side, dec, point, participant) => ({ event_id: 'ev1', book, market, side, point: point == null ? null : point, participant: participant || null, price_dec: dec });
const pinRows = (h, a) => [row('pinnacle', 'h2h', 'Philadelphia Eagles', h), row('pinnacle', 'h2h', 'Dallas Cowboys', a),
  row('pinnacle', 'spreads', 'Philadelphia Eagles', 1.95, -3.5), row('pinnacle', 'spreads', 'Dallas Cowboys', 1.95, 3.5),
  row('pinnacle', 'totals', 'Over', 1.91, 47.5), row('pinnacle', 'totals', 'Under', 1.99, 47.5)];
const PIN = (min, h, a, extra) => Object.assign({ observed_at: at(min), request_id: 100 + Math.abs(min), category: 'featured', resolution_s: 3600, rows: pinRows(h || 1.6, a || 2.5) }, extra || {});

(async () => {
  /* ── devig ──────────────────────────────────────────────────────────── */
  let cap = null;
  try { cap = await import(path.join(ROOT, 'supabase', 'functions', 'capture', 'index.ts')); } catch (e) { cap = null; }
  const pairs = [[1.6, 2.5], [1.91, 1.91], [1.25, 4.4], [3.1, 1.42], [1.05, 13.0]];
  chk('devig: Shin here is capture\'s devig() to 1e-12 on every pair (one Pinnacle fair across the stack)', cap && pairs.every((p) => {
    const a = L.devigShin(p).probs, b = cap.devig(p, 'shin'); return near(a[0], b[0], 1e-12) && near(a[1], b[1], 1e-12);
  }), cap ? null : 'capture/index.ts could not be imported');
  const d = L.devigShin([1.6, 2.5]);
  chk('devig: a normal pair is Shin, sums to 1, and keeps the favourite above its multiplicative share', d.method === 'shin' && near(d.probs[0] + d.probs[1], 1, 1e-12) && d.probs[0] > (1 / 1.6) / (1 / 1.6 + 1 / 2.5));
  const u = L.devigShin([2.1, 2.1]);
  chk('devig: an underround pair is normalised proportionally and SAYS so', u.method === 'multiplicative' && near(u.probs[0], 0.5));

  /* ── quotes ─────────────────────────────────────────────────────────── */
  const body = [{ id: 'ev1', sport_key: 'americanfootball_nfl', commence_time: KICK, home_team: EV.home_team, away_team: EV.away_team, bookmakers: [
    { key: 'pinnacle', last_update: at(-5), markets: [{ key: 'h2h', outcomes: [{ name: EV.home_team, price: 1.6 }, { name: EV.away_team, price: 2.5 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: EV.home_team, price: 1.62 }, { name: EV.away_team, price: 2.4 }] }] },
    { key: 'draftkings', markets: [{ key: 'spreads', outcomes: [{ name: EV.home_team, price: 1.91, point: -3.5 }, { name: EV.away_team, price: 1.91, point: 3.5 }] }] }] }];
  const q = L.quotesFromOdds(body, { books: ['pinnacle', 'draftkings'], markets: ['h2h', 'spreads', 'totals'] });
  chk('quotes: only the named books (Pinnacle and DraftKings), each outcome a row', q.length === 4 && q.every((r) => r.book !== 'fanduel'), q.map((r) => r.book + r.market));
  const qa = L.quotesFromOdds({ id: 'e2', bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'A', price: -150 }, { name: 'B', price: 130 }] }] }] }, { books: ['pinnacle'], format: 'american' });
  chk('quotes: one event (/events/{id}/odds) in American is converted to decimal', qa.length === 2 && near(qa[0].price_dec, 1.6667, 1e-4) && qa[1].price_dec === 2.3);
  const qp = L.quotesFromOdds({ id: 'e3', bookmakers: [{ key: 'draftkings', markets: [{ key: 'player_rebounds', outcomes: [{ name: 'Over', description: 'Miles Bridges', price: 1.87, point: 6.5 }, { name: 'Under', description: 'Miles Bridges', price: 1.95, point: 6.5 }, { name: 'Over', description: 'Someone Else', price: 1.9, point: 3.5 }] }] }] },
    { books: ['draftkings'], participants: (n) => n === 'Miles Bridges' });
  chk('quotes: a player market keeps the player, and only the players asked for', qp.length === 2 && qp.every((r) => r.participant === 'Miles Bridges'));

  /* ── triggers ───────────────────────────────────────────────────────── */
  const snaps = [{ id: 1, ticker: 'K', captured_at: at(-15), yes_bid: 0.5, yes_ask: 0.52 }, { id: 2, ticker: 'K', captured_at: at(-10), yes_bid: 0.53, yes_ask: 0.55 },
    { id: 3, ticker: 'K', captured_at: at(-5), yes_bid: 0.53, yes_ask: 0.6 }, { id: 4, ticker: 'K', captured_at: at(-4), yes_bid: 0.49, yes_ask: 0.51 }, { id: 5, ticker: 'K', captured_at: at(20), yes_bid: 0.2, yes_ask: 0.22 }];
  const mv = L.kalshiMoves(snaps);
  chk('triggers: a 3c mid move between consecutive two-sided snapshots is a move; a wide quote and a 24-minute gap are not', mv.length === 1 && mv[0].from_snapshot_id === 1 && mv[0].to_snapshot_id === 2 && near(mv[0].move, 0.03, 1e-9), mv);
  const ch = L.statusChanges({ a: 'QUESTIONABLE', b: 'OUT' }, { a: 'OUT', c: 'DOUBTFUL' }, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }]);
  chk('triggers: a starter\'s status change, listed -> off the report and on, each count; an unchanged one does not', ch.length === 3 && ch.find((x) => x.player_id === 'b').to === 'NOT_LISTED' && ch.find((x) => x.player_id === 'c').from === 'NOT_LISTED', ch);
  const gc = L.goalieChanges([{ id: 1, game_id: 'g', team: 'TOR', side: 'home', goalie_id: '8', goalie_name: 'A', status: 'projected', fetched_at: at(-60) },
    { id: 2, game_id: 'g', team: 'TOR', side: 'home', goalie_id: '8', goalie_name: 'A', status: 'confirmed', fetched_at: at(-30) },
    { id: 3, game_id: 'g', team: 'TOR', side: 'home', goalie_id: '9', goalie_name: 'B', status: 'confirmed', fetched_at: at(-10) }]);
  chk('triggers: a goalie\'s status change and a change of goalie are each a change', gc.length === 2 && gc[1].to.goalie === 'B', gc);
  chk('triggers: the top 5 of a reference rotation by minutes are the starters', L.topByMinutes([{ id: 1, minutes: 10 }, { id: 2, minutes: 30 }, { id: 3, minutes: 20 }], 2).map((p) => p.id).join() === '2,3');
  const ix = L.nameIndex({ 12: ['LA Clippers', 'Los Angeles Clippers'], 13: ['Los Angeles Lakers'] });
  const m1 = L.matchEvent({ home: '12', away: '13', start: at(0) }, [{ id: 'x', home_team: 'Los Angeles Clippers', away_team: 'Los Angeles Lakers', commence_time: at(30) }, { id: 'y', home_team: 'Los Angeles Lakers', away_team: 'Los Angeles Clippers', commence_time: at(30) }], ix);
  chk('identity: a provider event matches on both clubs (aliases included) and a start within 6 h', m1 && m1.id === 'x');
  chk('identity: two candidates are no match, never a guess', L.matchEvent({ home: '12', away: '13', start: at(0) }, [{ id: 'x', home_team: 'LA Clippers', away_team: 'Los Angeles Lakers', commence_time: at(30) }, { id: 'z', home_team: 'Los Angeles Clippers', away_team: 'Los Angeles Lakers', commence_time: at(60) }], ix) === null);

  /* ── the rules are the database's ───────────────────────────────────── */
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'sharp_lag.sql'), 'utf8');
  const sqlRule = (k) => { const m = new RegExp("when '" + k + "'\\s+then ([0-9.]+)").exec(sql); return m ? Number(m[1]) : null; };
  const keys = ['gap_pp', 'role_shift_gap_pp', 'converge_pp', 'reference_max_age_min', 'book_target_max_age_min', 'kalshi_max_age_min', 'kalshi_max_spread', 'kalshi_move', 'kalshi_pair_max_min', 'close_max_lead_min', 'check_window_hours', 'validation_min_graded', 'ci_level', 'past_price_min'];
  chk('rules: every number in RULES is public.sharp_lag_rule()\'s (supabase/sharp_lag.sql)', keys.every((k) => sqlRule(k) === L.RULES[k]), keys.filter((k) => sqlRule(k) !== L.RULES[k]));
  chk('rules: the past-price limit is the existing display rule', /market_limit_min: 90/.test(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_games.js'), 'utf8')) && L.RULES.past_price_min === 90);

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' sharp lag core: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
})();
