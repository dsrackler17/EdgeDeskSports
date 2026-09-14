#!/usr/bin/env node
/* ============================================================================
   THE MARKET REFRESH — join live captured book quotes to the upcoming slate.

   WHY THE NEWSLETTER NEEDS THIS AND THE ARTICLE BUILD DID NOT. The article
   generator runs headless with no Supabase session, so college games reach it
   with no book quote at all: `research_host.js` says as much in its own
   comment and replays a COMMITTED snapshot instead. That is fine for an
   article, which prints what it has. It is not fine for a newsletter whose
   whole ranking rests on model-versus-market, because "no market" is not a
   small gap — it removes the largest component of the score for every college
   game at once.

   The capture this platform already runs writes `public.signals`. The
   newsletter job already holds the service role, because it has to write
   editions and deliveries. So the quotes are reachable; nothing new is
   needed, and nothing new is invented here:

     read    public.signals            the existing capture table
     write   articles/data/market/*.json in the EXISTING committed schema
             (`edgedesk_article_market_snapshot_v1`)
     replay  tools/articles/research_host.js installMarketSnapshot(), the
             existing injection path, which puts the rows in the same shape
             the board reads a live capture in

   A WRONG JOIN IS WORSE THAN A MISSING ONE. A newsletter that prints one
   game's line against another game's model number is not a bug a reader can
   forgive. So the match requires BOTH team keys to agree and the kickoff to
   be within a bounded window; anything else is refused, with the reason kept.
   Fuzzy name matching is deliberately not attempted.

   WITH NO CREDENTIAL IT IS A NO-OP THAT SAYS SO. `refresh()` returns
   `{ ok: false, reason: 'no_service_credential' }` rather than throwing, and
   the pipeline records that the market was not refreshed. The committed
   snapshot still replays and the edition still builds.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MARKET_DIR = path.join(ROOT, 'articles', 'data', 'market');

/* The two sport keys the odds capture writes for football, as app.html reads
   them (`americanfootball_nfl`, `americanfootball_ncaaf`). */
const SPORT_KEYS = { NFL: 'americanfootball_nfl', CFB: 'americanfootball_ncaaf' };

/* How far a captured fixture's kickoff may sit from the schedule's kickoff and
   still be the same game. Books move a start time by minutes; a feed and a
   book disagreeing by more than half a day are describing different games. */
const KICKOFF_TOLERANCE_MS = 12 * 3600000;

function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

/* The same team-key rule the rest of the repository uses (featured.js
   teamKey, the engine's normKey): fold accents rather than strip them, so
   "San José State" and "San Jose State" are one team. */
function teamKey(s) {
  if (s == null) return '';
  let t = String(s).trim().toLowerCase();
  try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
  return t.replace(/[^a-z0-9]+/g, '');
}

function config(env) {
  env = env || process.env;
  const key = String(env.SB_SERVICE_ROLE || env.EDGD_SB_SERVICE || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const url = String(env.EDART_SB_URL || env.EDGD_SB_URL || env.SB_URL || env.SUPABASE_URL
    || 'https://iattxbkbufslbauoumga.supabase.co').trim().replace(/\/$/, '');
  return { url, key };
}

/* ------------------------------------------------------------- the fetch */
/* signals carries one row per (fixture, market, selection). The board reads
   `market`, `selection`, `point`, `best_book`, `first_seen_at`, `last_seen_at`;
   those and the join columns are all this asks for. */
const COLUMNS = [
  'sig_key', 'event_id', 'sport_key', 'market', 'selection', 'point',
  'commence_time', 'home_team', 'away_team', 'best_book',
  'first_seen_at', 'last_seen_at',
].join(',');

async function readSignals(opts) {
  opts = opts || {};
  const cfg = opts.config || config(opts.env);
  if (!cfg.key) return { ok: false, reason: 'no_service_credential', rows: [] };
  const f = opts.fetch || ((...a) => fetch(...a));
  const sports = (opts.sports || ['NFL', 'CFB']).map(s => SPORT_KEYS[String(s).toUpperCase()]).filter(Boolean);
  const from = new Date(opts.from || Date.now()).toISOString();
  const to = new Date(opts.to || (Date.now() + 14 * 86400000)).toISOString();
  const q = 'signals?select=' + COLUMNS
    + '&sport_key=in.(' + sports.join(',') + ')'
    + '&market=in.(spreads,totals)'
    + '&commence_time=gte.' + from
    + '&commence_time=lte.' + to
    + '&order=last_seen_at.desc&limit=4000';
  const res = await f(cfg.url + '/rest/v1/' + q, {
    headers: { apikey: cfg.key, authorization: 'Bearer ' + cfg.key, accept: 'application/json' },
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, reason: 'signals_read_failed', detail: res.status + ': ' + body.slice(0, 200), rows: [] };
  let rows = [];
  try { rows = JSON.parse(body); } catch (e) { return { ok: false, reason: 'signals_unparseable', detail: String(e && e.message), rows: [] }; }
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

/* ------------------------------------------------------------- the join */
/* Group signal rows into one quote per fixture, keeping the most recently
   seen spread and total. `selection` on a spreads row names the team the
   `point` belongs to, which is exactly what the snapshot schema stores. */
function quotesFromSignals(rows, games) {
  const byKey = Object.create(null);
  (games || []).forEach(g => {
    if (!g || !g.home || !g.away || g.kickoff_ms == null) return;
    byKey[teamKey(g.home) + '|' + teamKey(g.away)] = g;
  });

  const perGame = Object.create(null);
  const refused = [];
  (rows || []).forEach(r => {
    const hk = teamKey(r.home_team), ak = teamKey(r.away_team);
    const g = byKey[hk + '|' + ak];
    if (!g) { refused.push({ sig_key: txt(r.sig_key), why: 'no_slate_game_with_both_teams', detail: txt(r.away_team) + ' at ' + txt(r.home_team) }); return; }
    const t = Date.parse(r.commence_time);
    if (!Number.isFinite(t) || Math.abs(t - g.kickoff_ms) > KICKOFF_TOLERANCE_MS) {
      refused.push({ sig_key: txt(r.sig_key), why: 'kickoff_disagreement',
        detail: txt(r.away_team) + ' at ' + txt(r.home_team) + ' — capture ' + txt(r.commence_time) + ' vs schedule ' + g.kickoff });
      return;
    }
    const seen = Date.parse(r.last_seen_at || r.first_seen_at || r.commence_time);
    const slot = perGame[g.key] || (perGame[g.key] = { game: g, spread: null, total: null });
    if (r.market === 'spreads' && num(r.point) != null && txt(r.selection)) {
      /* The selection must be one of the two teams; a spreads row naming
         anything else is not a side of this game. */
      const sk = teamKey(r.selection);
      if (sk !== hk && sk !== ak) { refused.push({ sig_key: txt(r.sig_key), why: 'spread_selection_is_neither_team', detail: txt(r.selection) }); return; }
      if (!slot.spread || seen > slot.spread.seen) {
        slot.spread = { selection: sk === hk ? g.home : g.away, point: num(r.point),
          book: txt(r.best_book), seen, seen_at: txt(r.last_seen_at || r.first_seen_at) };
      }
    } else if (r.market === 'totals' && num(r.point) != null) {
      if (!slot.total || seen > slot.total.seen) {
        slot.total = { point: num(r.point), book: txt(r.best_book), seen,
          seen_at: txt(r.last_seen_at || r.first_seen_at) };
      }
    }
  });

  const quotes = [];
  Object.keys(perGame).sort().forEach(k => {
    const s = perGame[k];
    if (!s.spread && !s.total) return;
    const at = (s.spread && s.spread.seen_at) || (s.total && s.total.seen_at) || null;
    const q = {
      sport: s.game.sport, game_id: s.game.game_id,
      home: s.game.home, away: s.game.away,
      kickoff: s.game.kickoff,
      captured_at: at,
      from: 'EdgeDesk odds capture (public.signals), read by the newsletter pipeline',
    };
    if (s.spread) q.spread = { selection: s.spread.selection, point: s.spread.point, book: s.spread.book };
    if (s.total) q.total = { point: s.total.point, book: s.total.book };
    quotes.push(q);
  });
  return { quotes, refused };
}

/* ------------------------------------------------------------- the write */
/* One file per season and week, in the schema store.loadMarketSnapshots()
   already reads. Rewritten rather than appended: a week's file is the current
   capture for that week, and two rows for one game would make the replay
   depend on iteration order. */
function snapshotFileFor(season, week, dir) {
  const w = String(week == null ? 0 : week).padStart(2, '0');
  return path.join(dir || MARKET_DIR, String(season) + '-week-' + w + '.json');
}

function writeSnapshot(file, season, quotes, opts) {
  opts = opts || {};
  const body = {
    schema: 'edgedesk_article_market_snapshot_v1',
    season: season,
    generated_at: opts.now ? new Date(opts.now).toISOString() : new Date().toISOString(),
    source: 'Captured book quotes read from EdgeDesk’s own odds capture (public.signals) by '
      + 'tools/newsletter/market.js. Replayed here so a headless build joins the same sportsbook '
      + 'number the terminal joins; the live capture is behind an account and a build server has no session for it.',
    note: 'These are SPORTSBOOK numbers, not EdgeDesk numbers, and every article and newsletter that uses one '
      + 'says so and names the book. Nothing here is an EdgeDesk projection, and no line in this file is read by '
      + 'any model: the engine has already priced the game before the market section is assembled.',
    quotes: quotes,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return body;
}

/* refresh({ games, season, week, now, fetch, env, dry })

   Returns what happened, always — never throws for a missing credential or an
   unreachable database, because a newsletter that cannot refresh the market
   should still be built from the research it has and SAY the market was not
   refreshed. */
async function refresh(opts) {
  opts = opts || {};
  const games = (opts.games || []).filter(g => g && g.kickoff_ms != null);
  if (!games.length) return { ok: false, reason: 'no_games', wrote: null, quotes: 0 };

  const from = opts.from || Math.min.apply(null, games.map(g => g.kickoff_ms)) - 6 * 3600000;
  const to = opts.to || Math.max.apply(null, games.map(g => g.kickoff_ms)) + 6 * 3600000;
  const read = await readSignals(Object.assign({}, opts, { from, to, sports: [games[0].sport] }));
  if (!read.ok) {
    return { ok: false, reason: read.reason, detail: read.detail || null, wrote: null, quotes: 0,
      note: 'the committed market snapshot still replays; the edition records that the market was not refreshed' };
  }
  const joined = quotesFromSignals(read.rows, games);
  if (!joined.quotes.length) {
    return { ok: true, reason: 'no_quotes_joined', wrote: null, quotes: 0,
      signals_read: read.rows.length, refused: joined.refused.slice(0, 20) };
  }
  const file = snapshotFileFor(opts.season, opts.week, opts.dir);
  if (!opts.dry) writeSnapshot(file, opts.season, joined.quotes, opts);
  return {
    ok: true, reason: null,
    wrote: opts.dry ? null : path.relative(ROOT, file),
    quotes: joined.quotes.length,
    signals_read: read.rows.length,
    refused: joined.refused.slice(0, 20),
    refused_count: joined.refused.length,
    books: [...new Set(joined.quotes.map(q => (q.spread && q.spread.book) || (q.total && q.total.book)).filter(Boolean))],
  };
}

module.exports = {
  SPORT_KEYS, KICKOFF_TOLERANCE_MS, MARKET_DIR, COLUMNS,
  teamKey, config, readSignals, quotesFromSignals, snapshotFileFor, writeSnapshot, refresh,
};
