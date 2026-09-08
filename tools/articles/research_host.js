#!/usr/bin/env node
/* ============================================================================
   THE RESEARCH HOST — run EdgeDesk's REAL research, headless.

   WHY THIS EXISTS. The article system publishes what EdgeDesk already knows.
   It must therefore READ the research rather than recompute it, and the
   research lives in one place: the football module inside app.html, reached
   through window.fbBriefGame() and window.fbNflBriefGame(). A generator that
   re-derived a fair spread from the rankings artifact would be a SECOND model
   wearing the first one's name, and the first time the two disagreed the
   published article would be wrong in a way nothing could catch.

   So this file boots the actual module — the real script block, out of the
   real file, in a VM — exactly the way tools/football/_module.js boots it for
   the test suite, and then drives the actual load path:

     window.loadFootball()   the NFL board (nflverse schedule + trained engine)
     window.fbP4Load()       the Power 4 board (cfbfastR schedule + P4 engine)
     window.fbBriefGame()    the CFB matchup research payload
     window.fbNflBriefGame() the NFL matchup research payload

   NOTHING HERE COMPUTES A NUMBER. Every projection, probability, confidence
   figure and status label in an article came out of those four calls.

   THE TWO THINGS A BROWSER HAS THAT NODE DOES NOT are supplied here and
   nowhere else:
     1  fetch — served from the repo for its own committed artifacts, from a
        cache directory for the two public schedule feeds, and refused (404)
        for everything else. A refused fetch is a normal condition the module
        already handles; it is never faked into a success.
     2  <script src> — fbScript() appends a tag and waits for onload. The stub
        DOM here loads the repo file into the same VM and fires it, so the
        roster bundler the talent layer needs actually arrives.

   OFFLINE BY DEFAULT. The feeds are cached under football/data/cache/ (the
   same place the pipeline scripts cache theirs). Pass { network: true } to
   let a cache miss go to the network; without it a miss is reported, and the
   generator says which feed it could not read rather than publishing a game
   it could not price.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const M = require(path.join(__dirname, '..', 'football', '_module.js'));
const ROOT = M.ROOT;
/* the pipeline's own cache convention (EDP_CACHE / --cache DIR), so one build
   shares a download with build_box, build_players and build_rankings */
const CACHE_DIR = process.env.EDP_CACHE || path.join(ROOT, 'football', 'data', 'cache');

/* The two public, keyless feeds the board itself reads. Same URLs as app.html
   (FBP4_URL_SCHED and FB_URL_NFL); if those ever move, they move here too and
   tools/articles/articles.test.js says so. */
const FEEDS = {
  cfb: y => 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_' + y + '.csv',
  nfl: () => 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'
};

function cacheNameFor(url) {
  const base = String(url).split('?')[0].split('/').pop() || 'feed';
  return 'articles_' + base.replace(/[^A-Za-z0-9._-]/g, '_');
}

/* ------------------------------------------------------------------ fetch */
/* Repo-relative first (an artifact this checkout already carries), then the
   feed cache, then — only with { network: true } — the network. */
function makeFetch(opts, log) {
  const network = !!opts.network;
  const seen = { served: [], refused: [], fetched: [] };
  const mem = Object.create(null);

  function reply(text) {
    return { ok: true, status: 200, headers: { get: () => null },
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(JSON.parse(text)) };
  }
  const missing = { ok: false, status: 404, headers: { get: () => null },
    text: () => Promise.resolve(''), json: () => Promise.resolve(null) };

  function edgedeskFetch(url) {
    const u = String(url);
    if (mem[u] !== undefined) return Promise.resolve(mem[u] === null ? missing : reply(mem[u]));

    if (!/^[a-z]+:/i.test(u)) {
      const f = path.join(ROOT, u.split('?')[0].replace(/^\/+/, ''));
      if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const text = fs.readFileSync(f, 'utf8');
        seen.served.push(u); mem[u] = text;
        return Promise.resolve(reply(text));
      }
      seen.refused.push(u); mem[u] = null;
      return Promise.resolve(missing);
    }

    const cached = path.join(CACHE_DIR, cacheNameFor(u));
    if (fs.existsSync(cached)) {
      const text = fs.readFileSync(cached, 'utf8');
      seen.served.push(u); mem[u] = text;
      return Promise.resolve(reply(text));
    }
    if (!network) { seen.refused.push(u); mem[u] = null; return Promise.resolve(missing); }

    return globalThis.fetch(u).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(text => {
      try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cached, text); } catch (_) {}
      seen.fetched.push(u); mem[u] = text;
      log('  fetched ' + u.split('/').pop() + ' (' + Math.round(text.length / 1024) + ' KB)');
      return reply(text);
    }).catch(e => {
      seen.refused.push(u + ' — ' + (e && e.message));
      mem[u] = null;
      return missing;
    });
  };
  return [edgedeskFetch, seen];
}

/* --------------------------------------------------------- the stub browser */
/* fbScript() is the module's own loader for the P4 engine, its params and the
   roster bundler. In a browser those arrive as <script src>. Here the element
   runs the repo file in this VM and fires onload, so the module's own
   `if (!window.EDEspnRosterBundles) throw` check is a real check. */
function installScriptLoader(win, seen) {
  const doc = win.document;
  const loaded = Object.create(null);
  doc.createElement = function (tag) {
    const el = M.stubElement();
    if (String(tag).toLowerCase() !== 'script') return el;
    let src = null;
    const handlers = { load: [], error: [] };
    Object.defineProperty(el, 'src', {
      get() { return src; },
      set(v) {
        src = String(v);
        const file = path.join(ROOT, src.split('?')[0].replace(/^\/+/, ''));
        setTimeout(function () {
          let okRun = false;
          if (!loaded[src] && file.startsWith(ROOT) && fs.existsSync(file)) {
            try {
              win.module = { exports: {} };
              vm.runInContext(fs.readFileSync(file, 'utf8'), win, { filename: src });
              delete win.module;
              loaded[src] = true; okRun = true;
              seen.served.push(src);
            } catch (e) { seen.refused.push(src + ' — ' + (e && e.message)); }
          } else if (loaded[src]) { okRun = true; }
          else { seen.refused.push(src); }
          if (okRun) { if (el.onload) el.onload(); handlers.load.forEach(f => f()); }
          else { if (el.onerror) el.onerror(new Error('failed to load ' + src)); handlers.error.forEach(f => f()); }
        }, 0);
      }
    });
    el.setAttribute = function (k, v) { if (k === 'src') el.src = v; };
    el.getAttribute = function (k) { return k === 'src' ? src : null; };
    el.addEventListener = function (ev, fn) { if (handlers[ev]) handlers[ev].push(fn); };
    return el;
  };
  doc.querySelector = function () { return null; };
}

/* ------------------------------------------------------------------- boot */
/* Everything the football module reaches for that lives in ANOTHER script
   block of app.html. Each one is a no-op that resolves, never a value that
   invents data: edHealthFetch returning null is "the health record could not
   be read", which the board already renders honestly. */
function installPageGlobals(win) {
  win.$ = function () { return null; };
  win.edHealthFetch = function () { return Promise.resolve(null); };
  win.edUser = function () { return null; };
  win.edToken = function () { return Promise.resolve(null); };
  win.edEvent = function () {};
  win.renderFootball = function () {};
  win.rsMetaRender = function () {};
  win.rsParseStamp = function (s) { const t = Date.parse(s); return isFinite(t) ? t : null; };
  win.rsTkDrawerClose = function () {};
  win.researchGo = function () {};
}

/* Inject captured quotes into the two boards' signal maps. Returns a
   provenance sentence for the article, or null when nothing was injected. */
function installMarketSnapshot(win, quotes) {
  const byGame = Object.create(null);
  if (!quotes || !quotes.length) return byGame;
  quotes.forEach(function (q) {
    const sport = String(q.sport || '').toUpperCase();
    const bag = sport === 'NFL' ? win.FB.nfl.sig : sport === 'CFB' ? win.FB.p4.sig : null;
    if (!bag || !q.home || !q.away || !q.kickoff) return;
    const rows = [];
    const at = q.captured_at || null;
    if (q.spread && q.spread.point != null && q.spread.selection) {
      rows.push({ market: 'spreads', selection: q.spread.selection, point: +q.spread.point,
        best_book: q.spread.book || null, last_seen_at: at, first_seen_at: at });
    }
    if (q.total && q.total.point != null) {
      rows.push({ market: 'totals', selection: 'Over', point: +q.total.point,
        best_book: q.total.book || (q.spread && q.spread.book) || null, last_seen_at: at, first_seen_at: at });
    }
    if (!rows.length) return;
    bag['snapshot:' + q.game_id] = { home: q.home, away: q.away, t: q.kickoff, rows: rows };
    const books = [...new Set([q.spread && q.spread.book, q.total && q.total.book].filter(Boolean))];
    byGame[sport + ':' + q.game_id] =
      'The sportsbook number on this page is a quote EdgeDesk captured'
      + (books.length ? ' at ' + books.join(' and ') : '')
      + (q.captured_at ? ' on ' + String(q.captured_at).slice(0, 10) : '')
      + ', replayed from a committed snapshot rather than read live. It is the book\u2019s number, not EdgeDesk\u2019s, and EdgeDesk\u2019s own number was produced before it was read.'
      + (q.from ? ' Source: ' + q.from + '.' : '');
  });
  return byGame;
}

/* Wait for a condition the load path sets, bounded. The board's own loader
   has exactly this shape (FBP4_LOAD_TIMEOUT_MS): an optional data source that
   never answers must not hold the whole build, and what did arrive is used. */
function waitFor(test, ms) {
  const until = Date.now() + ms;
  return new Promise(function (resolve) {
    (function tick() {
      let done = false;
      try { done = !!test(); } catch (_) { done = false; }
      if (done || Date.now() > until) return resolve(done);
      setTimeout(tick, 100);
    })();
  });
}

const LOAD_TIMEOUT_MS = 120000;

/* Boot the module, load both boards, and hand back the doors the article
   generator uses. Returns { win, cfb(home,away), nfl(home,away), slate(), notes }. */
async function open(opts) {
  opts = opts || {};
  const log = opts.quiet ? function () {} : function (...a) { console.log(...a); };
  if (opts.marketQuotes === undefined) {
    try { opts.marketQuotes = require(path.join(__dirname, 'store.js')).loadMarketSnapshots(); }
    catch (_) { opts.marketQuotes = []; }
  }

  const boot = M.boot();
  if (boot.error) throw new Error('the football module would not run: ' + (boot.error.message || boot.error));
  const win = boot.win;

  installPageGlobals(win);
  const [fetchImpl, seen] = makeFetch(opts, log);
  win.fetch = fetchImpl;
  installScriptLoader(win, seen);

  /* the committed engines, in the same globals fbP4Ensure()/fbEnsureEngine()
     check for, so both short-circuit to the shipped build rather than racing
     a script tag for it */
  M.loadEngine(win, ROOT);
  M.loadNflEngine(win, ROOT);

  log('booting the EdgeDesk football module…');
  try { await win.loadFootball(false); } catch (e) { log('  NFL board: ' + (e && e.message)); }
  await waitFor(() => (win.FB.nfl.up || []).length, 5000);
  log('  NFL board: ' + (win.FB.nfl.up || []).length + ' upcoming, season ' + win.FB.nfl.curSeason);

  if (typeof win.fbP4Load !== 'function') {
    throw new Error('app.html does not export window.fbP4Load — the Power 4 board cannot be loaded headlessly');
  }
  /* The P4 load ends in optional joins (rosters, book lines, weather). Any of
     them can be unreachable here, and the board is built to render without
     them, so the slate is awaited rather than the whole chain. */
  let p4Settled = false;
  win.fbP4Load(false).then(() => { p4Settled = true; }, () => { p4Settled = true; });
  await waitFor(() => p4Settled || (win.FB.p4.up || []).length, LOAD_TIMEOUT_MS);
  if (!p4Settled) await waitFor(() => p4Settled, 15000);
  log('  Power 4 board: ' + (win.FB.p4.up || []).length + ' upcoming, season ' + win.FB.p4.season
    + (win.FB.p4.gate ? ' — GATE: ' + win.FB.p4.gate : ''));

  /* ---- captured book quotes, replayed --------------------------------- */
  /* The live capture (Supabase `signals`) is behind an account and a build
     server has no session for it, so without this a headless build sees NO
     MARKET on every college game while the terminal sees the quote it
     captured hours earlier — two different research states for one game.
     A snapshot is injected in the SAME shape fbMarketFromEvent() reads a
     live capture in, so the module's own fbP4Market() / fbNflMarketFor()
     join it, its own fbP4StatusFor() classifies it, and its own orientation
     check can still throw it out. Nothing here decides anything: it makes a
     number visible to code that was always going to judge it. */
  const marketSourceByGame = installMarketSnapshot(win, opts.marketQuotes || []);

  const notes = {
    market_snapshots: Object.keys(marketSourceByGame).length,
    served: [...new Set(seen.served)],
    refused: [...new Set(seen.refused)],
    fetched: [...new Set(seen.fetched)],
    cfb_gate: win.FB.p4.gate || null,
    cfb_notes: (win.FB.p4.notes || []).slice(),
    nfl_notes: (win.FB.nfl.notes || []).slice(),
    rankings: {
      season: win.FB.rk.data && win.FB.rk.data.season,
      week_label: win.FB.rk.data && win.FB.rk.data.week_label,
      generated_at: win.FB.rk.data && win.FB.rk.data.generated_at,
      team_count: win.FB.rk.data && win.FB.rk.data.team_count
    }
  };

  /* ---- the slate: every upcoming game on either board, one shape --------- */
  function slate() {
    const out = [];
    (win.FB.p4.up || []).forEach(function (u) {
      out.push({
        sport: 'CFB', game_id: String(u.g.game_id), kickoff: u.g.start_date,
        kickoff_ms: u.t, home: u.g.home_team, away: u.g.away_team,
        venue: u.g.venue || null, neutral_site: !!u.g.neutral_site,
        conference_game: !!u.g.conference_game, week: u.g.week == null ? null : +u.g.week,
        season: +u.g.season,
        home_conference: u.g.home_conference || null, away_conference: u.g.away_conference || null,
        home_division: u.g.home_division || null, away_division: u.g.away_division || null
      });
    });
    (win.FB.nfl.up || []).forEach(function (u) {
      const g = u.g;
      out.push({
        sport: 'NFL', game_id: String(g.game_id), kickoff: new Date(u.t).toISOString(),
        kickoff_ms: u.t, home: g.home_team, away: g.away_team,
        venue: g.stadium || null, neutral_site: String(g.location || '').toLowerCase() === 'neutral',
        division_game: String(g.div_game) === '1', week: g.week == null ? null : +g.week,
        season: +g.season, roof: g.roof || null, surface: g.surface || null,
        game_type: g.game_type || 'REG'
      });
    });
    out.sort((a, b) => a.kickoff_ms - b.kickoff_ms);
    return out;
  }

  return {
    win: win,
    notes: notes,
    slate: slate,
    /* the two research doors, called exactly as the terminal calls them */
    cfb: (home, away, t) => win.fbBriefGame({ home: home, away: away, t: t }),
    nfl: (home, away, t) => win.fbNflBriefGame({ home: home, away: away, t: t }),
    /* where THIS game's sportsbook number came from, when it came from a
       committed snapshot rather than the live capture */
    marketSourceFor: (sport, gameId) => marketSourceByGame[sport + ':' + gameId] || null
  };
}

module.exports = { open, FEEDS, CACHE_DIR, cacheNameFor, ROOT };
