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
   forgive. So the match requires BOTH teams to resolve to this game's own
   teams and the kickoff to be within a bounded window; anything else is
   refused, with the reason kept.

   THE TWO FEEDS DO NOT AGREE ON NAMES, and the first version of this file
   assumed they did. The odds capture writes the book's name — "Texas
   Longhorns", "San Diego State Aztecs", "Louisiana Ragin Cajuns" — and the
   college schedule writes the school alone: "Texas", "San Diego State",
   "Louisiana". Comparing normalised strings therefore matched NOTHING: a
   live run read 410 college signal rows and joined zero, and every refusal
   said `no_slate_game_with_both_teams`.

   THE FIX IS NOT A FUZZY MATCH, and it is not new code either. football/fbs/
   already owns the resolver the terminal's own board uses for exactly this
   join (`fbP4Market` → `EDFbs.matchesEvent`), and its comment names the trap
   a naive prefix test falls into:

       "a bare prefix test is how 'Miami (OH) RedHawks' ends up priced
        against Miami Florida, and across a full FBS slate both are on the
        board in the same week"

   `EDFbs.resolveTeam` tries an exact key, then a curated alias, then a state
   expansion, then the LONGEST UNAMBIGUOUS PREFIX — where a tie between two
   different schools resolves to nothing rather than to a guess. "Ohio" never
   swallows "Ohio State" and neither Miami takes the other's number. Using it
   here rather than a second name table is the whole point: one resolver, one
   set of aliases, and a college board and a college newsletter that cannot
   disagree about who is playing.

   THE NFL SIDE STAYS ON EXACT KEYS. nflverse and the odds capture both write
   the full club name, so there is nothing to resolve; and the FBS universe
   contains no professional teams, so running NFL rows through it would
   resolve nothing and refuse everything.

   WITH NO CREDENTIAL IT IS A NO-OP THAT SAYS SO. `refresh()` returns
   `{ ok: false, reason: 'no_service_credential' }` rather than throwing, and
   the pipeline records that the market was not refreshed. The committed
   snapshot still replays and the edition still builds.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const SNAP = require(path.join(__dirname, '..', 'lib', 'snapshot_contract.js'));

const ROOT = path.join(__dirname, '..', '..');
/* The FBS universe, its alias table and its resolver — the same module
   app.html loads as window.EDFbs. It exports for Node, so this is the real
   thing rather than a copy of it. */
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
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
/* THE PRICE WAS ALWAYS THERE AND WAS NEVER READ. The capture stores the best
   decimal odds it saw and how old that quote was when it stored it
   (`best_dec`, `best_quote_age_s`), and this projection asked for neither —
   so every committed snapshot carried a handicap with no price on it, and
   nothing downstream could compute an expected value or say how stale the
   number was when it was captured. Both columns are read now and travel into
   the snapshot under the shared contract's names. */
const COLUMNS = [
  'sig_key', 'event_id', 'sport_key', 'market', 'selection', 'point',
  'commence_time', 'home_team', 'away_team', 'best_book', 'best_dec', 'best_quote_age_s',
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
/* THE RESOLVER, built from the slate itself. The universe only has to contain
   the teams playing this week: a quote for a game that is not on the slate is
   refused either way, and a smaller universe is a smaller chance of an
   ambiguous prefix. Built once per refresh and handed to every row. */
function indexFor(games) {
  const rows = (games || []).map(g => ({ home_team: g.home, away_team: g.away }));
  const season = (games || []).map(g => g.season).filter(x => x != null)[0] || null;
  const universe = FBS.buildUniverse({ rows, season });
  return { ix: FBS.teamIndex(universe), universe };
}

/* One side of one row, resolved and memoised. 410 signal rows carry about 150
   distinct names between them and each resolution walks a prefix list, so
   resolving per NAME rather than per row is the difference between a
   millisecond and a second. */
function resolverFor(index) {
  const memo = Object.create(null);
  return function resolve(name) {
    const n = txt(name);
    if (!n) return null;
    if (memo[n] !== undefined) return memo[n];
    const r = FBS.resolveTeam(n, index.ix);
    memo[n] = r && r.key ? r : (r || null);
    return memo[n];
  };
}

/* ------------------------------------------------------------- the join */
/* Group signal rows into one quote per fixture, keeping the most recently
   seen spread and total. `selection` on a spreads row names the team the
   `point` belongs to, which is exactly what the snapshot schema stores.

   THE RULE IS EDFbs.matchesEvent's: both sides resolve to the game's own
   teams, and the kickoffs agree within a bounded window. It is applied here
   through a resolved-pair index rather than by calling matchesEvent once per
   (row, game) pair, which would be thirty thousand prefix scans a run — and
   newsletter.test.js pins this implementation to matchesEvent's own answer on
   a sample, so the two cannot drift apart quietly. */
function quotesFromSignals(rows, games, opts) {
  opts = opts || {};
  const nowMs = opts.now || Date.now();
  const list = (games || []).filter(Boolean);
  const sport = String((list[0] && list[0].sport) || 'NFL').toUpperCase();
  const useResolver = sport === 'CFB';
  const index = useResolver ? indexFor(list) : null;
  const resolve = useResolver ? resolverFor(index) : null;

  /* Each slate game under the key pair its OWN names resolve to, so a row and
     a game are compared on the same footing. */
  const byPair = Object.create(null);
  const unresolvedSlate = [];
  list.forEach(g => {
    if (!g.home || !g.away || g.kickoff_ms == null) return;
    let hk, ak;
    if (useResolver) {
      const rh = resolve(g.home), ra = resolve(g.away);
      if (!rh || !rh.key || !ra || !ra.key) {
        unresolvedSlate.push({ key: g.key, home: g.home, away: g.away });
        return;
      }
      hk = rh.key; ak = ra.key;
    } else {
      hk = teamKey(g.home); ak = teamKey(g.away);
    }
    byPair[hk + '|' + ak] = g;
  });

  const perGame = Object.create(null);
  const refused = [];
  (rows || []).forEach(r => {
    let hk, ak;
    if (useResolver) {
      const rh = resolve(r.home_team), ra = resolve(r.away_team);
      /* AN AMBIGUOUS NAME IS ITS OWN REFUSAL, not a miss. "Miami" with both
         Miamis on the board is a thing a person should see, because the fix
         is an alias rather than a wider match. */
      if ((rh && rh.how === 'ambiguous') || (ra && ra.how === 'ambiguous')) {
        refused.push({ sig_key: txt(r.sig_key), why: 'team_name_ambiguous',
          detail: txt(r.away_team) + ' at ' + txt(r.home_team)
            + ' — ' + JSON.stringify((rh && rh.ambiguous) || (ra && ra.ambiguous)) });
        return;
      }
      if (!rh || !rh.key || !ra || !ra.key) {
        refused.push({ sig_key: txt(r.sig_key), why: 'team_name_unresolved',
          detail: txt(r.away_team) + ' at ' + txt(r.home_team) });
        return;
      }
      hk = rh.key; ak = ra.key;
    } else {
      hk = teamKey(r.home_team); ak = teamKey(r.away_team);
    }
    const g = byPair[hk + '|' + ak];
    if (!g) { refused.push({ sig_key: txt(r.sig_key), why: 'no_slate_game_with_both_teams', detail: txt(r.away_team) + ' at ' + txt(r.home_team) }); return; }
    const t = Date.parse(r.commence_time);
    if (!Number.isFinite(t) || Math.abs(t - g.kickoff_ms) > KICKOFF_TOLERANCE_MS) {
      refused.push({ sig_key: txt(r.sig_key), why: 'kickoff_disagreement',
        detail: txt(r.away_team) + ' at ' + txt(r.home_team) + ' — capture ' + txt(r.commence_time) + ' vs schedule ' + g.kickoff });
      return;
    }
    const seen = Date.parse(r.last_seen_at || r.first_seen_at || r.commence_time);
    const slot = perGame[g.key] || (perGame[g.key] = { game: g, sides: { home: null, away: null }, total: null });
    if (r.market === 'spreads' && num(r.point) != null && txt(r.selection)) {
      /* The selection must be one of the two teams; a spreads row naming
         anything else is not a side of this game. Resolved the same way the
         fixture was, so "Texas Longhorns" is Texas here too. */
      const sk = useResolver
        ? ((resolve(r.selection) || {}).key || null)
        : teamKey(r.selection);
      if (sk !== hk && sk !== ak) { refused.push({ sig_key: txt(r.sig_key), why: 'spread_selection_is_neither_team', detail: txt(r.selection) }); return; }
      /* ONE HANDICAP, TWO ROWS. The capture writes a row per selection, so a
         priced game arrives as the home side and the away side of the same
         number. Keeping the freshest row across BOTH of them used to store
         whichever side happened to be seen last, and roughly half the college
         slate came out quoted from the away team — which the terminal's
         replay reads past, because it looks for the home side. So the
         freshest row of each side is held separately and the write below
         states which one the stored point belongs to. */
      const side = sk === hk ? 'home' : 'away';
      if (!slot.sides[side] || seen > slot.sides[side].seen) {
        slot.sides[side] = { selection: side === 'home' ? g.home : g.away, side, point: num(r.point),
          book: txt(r.best_book), best_dec: num(r.best_dec), quote_age_s: num(r.best_quote_age_s),
          seen, seen_at: txt(r.last_seen_at || r.first_seen_at) };
      }
    } else if (r.market === 'totals' && num(r.point) != null) {
      if (!slot.total || seen > slot.total.seen) {
        slot.total = { point: num(r.point), book: txt(r.best_book), best_dec: num(r.best_dec),
          quote_age_s: num(r.best_quote_age_s), seen,
          seen_at: txt(r.last_seen_at || r.first_seen_at) };
      }
    }
  });

  const quotes = [];
  Object.keys(perGame).sort().forEach(k => {
    const s = perGame[k];
    /* EdgeDesk quotes a spread from the home side everywhere it prints one,
       and the replay that feeds the terminal reads the home row. When the
       capture holds both sides the home row is stored as captured; when it
       holds only the away side the row is stored AS CAPTURED TOO — the side
       is named rather than flipped, so the file says what the book said and
       the replay does the arithmetic in one place. */
    s.spread = s.sides.home || s.sides.away || null;
    if (!s.spread && !s.total) return;
    const at = (s.spread && s.spread.seen_at) || (s.total && s.total.seen_at) || null;
    const q = {
      sport: s.game.sport, game_id: s.game.game_id,
      home: s.game.home, away: s.game.away,
      kickoff: s.game.kickoff,
      captured_at: at,
      from: 'EdgeDesk odds capture (public.signals), read by the newsletter pipeline',
    };
    /* The legacy shape stays exactly as it was, because the terminal replay
       and every committed article read it. The shared contract rides BESIDE
       it under `contract`, carrying the price, the market type, the capture
       age and the freshness state that the legacy shape has no room for. */
    if (s.spread) q.spread = { selection: s.spread.selection, side: s.spread.side, point: s.spread.point, book: s.spread.book,
      odds_american: SNAP.decToAmerican(s.spread.best_dec), odds_decimal: s.spread.best_dec == null ? null : s.spread.best_dec,
      captured_at: s.spread.seen_at, quote_age_s: s.spread.quote_age_s };
    if (s.total) q.total = { point: s.total.point, book: s.total.book,
      odds_american: SNAP.decToAmerican(s.total.best_dec), odds_decimal: s.total.best_dec == null ? null : s.total.best_dec,
      captured_at: s.total.seen_at, quote_age_s: s.total.quote_age_s };
    q.contract = [];
    if (s.spread) q.contract.push(SNAP.quote({
      game_id: s.game.game_id, sport: s.game.sport, market: 'spreads', selection: s.spread.selection,
      side: s.spread.side, point: s.spread.point, book: s.spread.book, best_dec: s.spread.best_dec,
      captured_at: s.spread.seen_at, kickoff: s.game.kickoff,
      source: 'EdgeDesk odds capture (public.signals)'
    }, { snapshot_kind: 'EDITION', now: nowMs, model_version: opts.model_version || null,
      model_generated_at: opts.model_generated_at || null, input_cutoff: opts.input_cutoff || null }));
    if (s.total) q.contract.push(SNAP.quote({
      game_id: s.game.game_id, sport: s.game.sport, market: 'totals', selection: 'total',
      point: s.total.point, book: s.total.book, best_dec: s.total.best_dec,
      captured_at: s.total.seen_at, kickoff: s.game.kickoff,
      source: 'EdgeDesk odds capture (public.signals)'
    }, { snapshot_kind: 'EDITION', now: nowMs, model_version: opts.model_version || null,
      model_generated_at: opts.model_generated_at || null, input_cutoff: opts.input_cutoff || null }));
    quotes.push(q);
  });
  return { quotes, refused, unresolved_slate: unresolvedSlate, resolver: useResolver ? 'EDFbs' : 'exact_key' };
}

/* ------------------------------------------------------------- the write */
/* One file per season and week, in the schema store.loadMarketSnapshots()
   already reads. Rewritten rather than appended: a week's file is the current
   capture for that week, and two rows for one game would make the replay
   depend on iteration order. */
/* The refusals as a histogram. "410 read, 0 joined" is a fact; "410 read, 0
   joined, 410 of them team_name_unresolved" is a diagnosis, and the
   difference cost a round trip to a live runner to discover. */
function countBy(refused) {
  const out = Object.create(null);
  (refused || []).forEach(r => { out[r.why] = (out[r.why] || 0) + 1; });
  return out;
}

function snapshotFileFor(season, week, dir) {
  const w = String(week == null ? 0 : week).padStart(2, '0');
  return path.join(dir || MARKET_DIR, String(season) + '-week-' + w + '.json');
}

function writeSnapshot(file, season, quotes, opts) {
  const body = writeSnapshotBody(season, quotes, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return body;
}

function writeSnapshotBody(season, quotes, opts) {
  opts = opts || {};
  const body = {
    schema: 'edgedesk_article_market_snapshot_v1',
    season: season,
    generated_at: opts.now ? new Date(opts.now).toISOString() : new Date().toISOString(),
    source: 'Captured book quotes read from EdgeDesk’s own odds capture (public.signals) by '
      + 'tools/newsletter/market.js. Replayed here so a headless build joins the same sportsbook '
      + 'number the terminal joins; the live capture is behind an account and a build server has no session for it.',
    convention: 'spread.selection names the team spread.point belongs to and spread.side says whether that is the '
      + 'home or the away side of the game. A point spread is one handicap with two sides, so a quote captured on the '
      + 'away side is the same number seen from the other end; the replay presents both and never invents a second price.',
    note: 'These are SPORTSBOOK numbers, not EdgeDesk numbers, and every article and newsletter that uses one '
      + 'says so and names the book. Nothing here is an EdgeDesk projection, and no line in this file is read by '
      + 'any model: the engine has already priced the game before the market section is assembled.',
    /* THE FRESHNESS PICTURE OF THE WHOLE FILE, so nothing downstream has to
       infer it from a scatter of per-quote timestamps — and so a reader is
       told when an edition was assembled from prices captured two days
       earlier instead of being left to notice. */
    contract_schema: SNAP.SCHEMA,
    snapshot_kind: 'EDITION',
    model_version: opts.model_version || null,
    model_generated_at: opts.model_generated_at || null,
    input_cutoff: opts.input_cutoff || null,
    freshness: SNAP.coverage([].concat.apply([], quotes.map(q => q.contract || [])),
      { model_generated_at: opts.model_generated_at || null }),
    quotes: quotes,
  };
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
  /* THE MODEL'S OWN STAMPS travel with the prices, so a reader of the file
     can see the gap between "when this number was captured" and "when the
     model that it is compared against was rebuilt". They were never in the
     file before, which is why a fresh model could sit beside a two-day-old
     price with nothing saying so. */
  const joined = quotesFromSignals(read.rows, games, { now: opts.now });
  if (!joined.quotes.length) {
    return { ok: true, reason: 'no_quotes_joined', wrote: null, quotes: 0,
      signals_read: read.rows.length, resolver: joined.resolver,
      refused_count: joined.refused.length,
      refused_by_reason: countBy(joined.refused),
      unresolved_slate: (joined.unresolved_slate || []).slice(0, 10),
      refused: joined.refused.slice(0, 20) };
  }
  const file = snapshotFileFor(opts.season, opts.week, opts.dir);
  const body = opts.dry ? writeSnapshotBody(opts.season, joined.quotes, opts)
    : writeSnapshot(file, opts.season, joined.quotes, opts);
  return {
    ok: true, reason: null,
    freshness: body.freshness,
    wrote: opts.dry ? null : path.relative(ROOT, file),
    quotes: joined.quotes.length,
    signals_read: read.rows.length,
    resolver: joined.resolver,
    refused: joined.refused.slice(0, 20),
    refused_count: joined.refused.length,
    refused_by_reason: countBy(joined.refused),
    unresolved_slate: (joined.unresolved_slate || []).slice(0, 10),
    books: [...new Set(joined.quotes.map(q => (q.spread && q.spread.book) || (q.total && q.total.book)).filter(Boolean))],
  };
}

module.exports = {
  SPORT_KEYS, KICKOFF_TOLERANCE_MS, MARKET_DIR, COLUMNS,
  teamKey, config, readSignals, quotesFromSignals, snapshotFileFor, writeSnapshot, writeSnapshotBody, refresh, SNAP,
  indexFor, resolverFor, countBy, FBS,
};
