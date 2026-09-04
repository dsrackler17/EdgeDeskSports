#!/usr/bin/env node
/* ============================================================================
   EdgeDesk Games — build the challenge artifact.

   Writes games/data/challenges.json: the small, committed, public file the
   /games pages read. The browser computes no price and calls no model; it
   renders what this build already decided, which is the same doctrine the rest
   of the repository runs on.

   WHERE EVERY NUMBER COMES FROM
     EdgeDesk projected spread   football/cfb_p4/export_csv.js  (the canonical
                                 Power 4 exporter, run as a child process —
                                 this file contains NO model logic and no
                                 second pricing engine)
     market spread               cfb.lines in Supabase, the same table the
                                 research terminal reads for book context,
                                 handed to the exporter through its own
                                 --lines option so the join happens in the
                                 canonical place
     research context            the exporter's own driver / data-quality
                                 columns, passed through as text
     research state              games/lib/research_state.js, which re-derives
                                 the terminal's thresholds from
                                 football/cfb_p4/params.js

   Usage
     node games/build_challenges.js                  # current season, upcoming
     node games/build_challenges.js --season 2026
     node games/build_challenges.js --no-market      # skip the Supabase read
     node games/build_challenges.js --out path.json

   Exit codes: 0 wrote (or nothing changed), 1 refused to write.
   A build that cannot produce at least one playable challenge REFUSES rather
   than committing an empty artifact over a good one.
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
var P4PARAMS = global.window.EDCfbP4Params;
var STATE = require(path.join(__dirname, 'lib', 'research_state.js'));

/* The national rankings artifact — the canonical, already-committed home of
   per-team roster context (returning production, QB / OL continuity, portal
   churn). The games layer READS it; it never recomputes any of it. */
var RANKINGS = null;
try { RANKINGS = require(path.join(ROOT, 'football', 'rankings', 'current.json')); }
catch (e) { RANKINGS = null; }
var CH = require(path.join(__dirname, 'lib', 'challenge.js'));
var SCORING = require(path.join(__dirname, 'lib', 'scoring.js'));

var ARTIFACT_SCHEMA = 'edgedesk_games_challenges_v1';

/* ------------------------------------------------------------------ args */
function parseArgs(argv) {
  var a = { market: true };
  for (var i = 2; i < argv.length; i++) {
    var k = argv[i];
    if (k === '--season') a.season = parseInt(argv[++i], 10);
    else if (k === '--no-market') a.market = false;
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--slate') a.slate = argv[++i];   /* a pre-built CSV, for tests */
    else if (k === '--quiet') a.quiet = true;
  }
  return a;
}

function currentSeason() {
  var d = new Date(), m = d.getUTCMonth();
  return m <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

function log() { if (!ARGS.quiet) console.error.apply(console, arguments); }

/* ------------------------------------------------------------------- csv */
/* The exporter's own quoting rules, read back. */
function parseCsv(text) {
  var rows = [], row = [], cell = '', q = false, i, c;
  for (i = 0; i < text.length; i++) {
    c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvObjects(text) {
  var rows = parseCsv(text);
  if (!rows.length) return [];
  var head = rows[0];
  return rows.slice(1).filter(function (r) { return r.length > 1; }).map(function (r) {
    var o = {}, j;
    for (j = 0; j < head.length; j++) o[head[j]] = r[j] == null ? '' : r[j];
    return o;
  });
}

function num(x) { if (x == null || x === '') return null; var v = +x; return isFinite(v) ? v : null; }
function txt(x) { var s = String(x == null ? '' : x).trim(); return s || null; }
function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }

/* --------------------------------------------------------- market lines */
/* The project URL and the public anon key are READ OUT OF app.html rather than
   copied here: the terminal is where they are declared, and a second copy is a
   second thing to get wrong.
   
   THE KEY MATTERS, AND ANON IS NOT ENOUGH. app.html says it plainly:
   
       Reads MUST carry the user's access_token, not the anon key: auth.uid()
       is what every RLS policy keys on, and it is NULL for an anon bearer.
   
   A build has no user, so it reads with the SERVICE ROLE. Without it every
   market read comes back as zero rows — not an error, just silence — and the
   board ships with no book numbers at all, which is exactly what happened the
   first time. `role` is reported on every run so a board built without a
   market says so out loud rather than looking like a quiet day. */
function supabaseConfig() {
  var url = process.env.EDGD_SB_URL || null;
  var app = null;
  try { app = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8'); } catch (e) { app = null; }
  if (!url && app) {
    var u = app.match(/SB_URL\s*=\s*"([^"]+)"/);
    url = u ? u[1] : null;
  }
  if (!url) return null;

  if (process.env.EDGD_SB_SERVICE)
    return { url: url, key: process.env.EDGD_SB_SERVICE, role: 'service', src: 'environment' };
  if (process.env.EDGD_SB_KEY)
    return { url: url, key: process.env.EDGD_SB_KEY, role: 'anon', src: 'environment' };
  if (app) {
    var k = app.match(/SB_KEY\s*=\s*"([^"]+)"/);
    if (k) return { url: url, key: k[1], role: 'anon', src: 'app.html' };
  }
  return null;
}

/* Loose team matching, the way the board does it: lowercase, strip everything
   that is not a letter or digit, then prefix-match. Feeds name their teams
   differently enough ("Miami (FL)" / "Miami FL") that exact equality drops
   real games. */
function normTeam(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* EVERY HOME TEAM A DOG IS A SIGN ERROR, not a slate.
   
   Ported from fbP4SpreadSanity in app.html, and it is not paranoia: cfb.lines
   carries the home team's BETTING number, so a table filled with positive
   magnitudes arrives with every line inverted. Nothing downstream can tell —
   the gaps just come out enormous and every game looks like a huge
   disagreement. Home teams are favoured in most college games, so a set where
   nearly all of them are underdogs is refused rather than published. */
function linesLookInverted(homeLines) {
  var n = 0, dogs = 0;
  homeLines.forEach(function (v) {
    if (v == null || !isFinite(v) || v === 0) return;
    n++;
    if (v > 0) dogs++;
  });
  if (n < 8) return false;                  /* too few to judge */
  return (dogs / n) > 0.85;
}

/* ── the market ────────────────────────────────────────────────────────────
   EdgeDesk already has two sources for a book number, and the research
   terminal prefers them in this order, so this does too:

     1. `signals`   the live captured quotes the odds scanner writes. Fresher,
                    and the only source during the week a game is played.
     2. `cfb.lines` the ingested reference table. Slower-moving, wider coverage.

   Both are read with whatever role supabaseConfig() found. With the anon key
   they will almost certainly come back EMPTY rather than erroring, because RLS
   keys on auth.uid() — which is why every count below is reported, and why a
   zero on an anon key says so explicitly instead of looking like a quiet day.

   Output is the CSV shape the exporter's own --lines option understands, whose
   `spread` column is the HOME team's betting line (home -7 = -7). That is the
   same convention cfb.lines.spread uses, and the negation of the engine's
   margin convention — getting it backwards inverts every game on the board. */

function sbHeaders(cfg, extra) {
  var h = { apikey: cfg.key, authorization: 'Bearer ' + cfg.key };
  if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) h[k] = extra[k];
  return h;
}

async function sbGet(cfg, query, headers) {
  var r = await fetch(cfg.url + '/rest/v1/' + query, { headers: sbHeaders(cfg, headers) });
  var body = await r.text();
  if (!r.ok) {
    var e = new Error('HTTP ' + r.status + (body ? ' ' + body.slice(0, 160) : ''));
    e.status = r.status;
    throw e;
  }
  try { return JSON.parse(body); } catch (_) { return []; }
}

/* Live captured quotes -> { game_id: homeLine }.
   `signals` is keyed by the odds feed's own event_id, so games are matched the
   way the board matches them: normalised team names plus a kickoff within a
   day and a half. A spreads row's `point` for the HOME selection IS the home
   betting line, which is what we want and what the exporter expects. */
async function linesFromSignals(cfg, games) {
  var now = new Date().toISOString();
  var hi = new Date(Date.now() + 21 * 864e5).toISOString();
  var rows = await sbGet(cfg,
    'signals?select=event_id,market,selection,point,home_team,away_team,commence_time'
    + '&sport_key=eq.americanfootball_ncaaf&market=eq.spreads'
    + '&commence_time=gte.' + now + '&commence_time=lte.' + hi + '&limit=2000');
  if (!rows.length) return { lines: {}, rows: 0 };

  var ev = {};
  rows.forEach(function (r) {
    (ev[r.event_id] = ev[r.event_id] || { home: r.home_team, away: r.away_team,
      t: r.commence_time, rows: [] }).rows.push(r);
  });

  var out = {}, matched = 0;
  games.forEach(function (g) {
    var hN = normTeam(g.home_team), aN = normTeam(g.away_team);
    var kt = Date.parse(String(g.kickoff || '').replace(' ', 'T'));
    for (var k in ev) {
      if (!ev.hasOwnProperty(k)) continue;
      var e = ev[k];
      if (normTeam(e.home).indexOf(hN) !== 0 && hN.indexOf(normTeam(e.home)) !== 0) continue;
      if (normTeam(e.away).indexOf(aN) !== 0 && aN.indexOf(normTeam(e.away)) !== 0) continue;
      var et = Date.parse(e.t);
      if (isFinite(kt) && isFinite(et) && Math.abs(et - kt) > 36 * 3600e3) continue;
      for (var i = 0; i < e.rows.length; i++) {
        var r = e.rows[i];
        if (normTeam(r.selection) === normTeam(e.home) && r.point != null) {
          out[g.game_id] = +r.point;    /* the home team's betting line */
          matched++;
          break;
        }
      }
      break;
    }
  });
  return { lines: out, rows: rows.length, matched: matched };
}

/* The ingested reference table -> { game_id: homeLine }. */
async function linesFromCfbLines(cfg, games) {
  var ids = games.map(function (g) { return g.game_id; }).filter(Boolean);
  var out = [], CHUNK = 120, i;
  for (i = 0; i < ids.length; i += CHUNK) {
    var chunk = ids.slice(i, i + CHUNK);
    out = out.concat(await sbGet(cfg,
      'lines?select=game_id,provider,spread,over_under,home_moneyline,away_moneyline'
      + '&game_id=in.(' + chunk.map(encodeURIComponent).join(',') + ')',
      { 'accept-profile': 'cfb' }));
  }
  var by = {};
  out.forEach(function (l) {
    var cur = by[l.game_id];
    if (!cur || String(l.provider || '').toLowerCase().indexOf('consensus') >= 0) by[l.game_id] = l;
  });
  return { rowsRaw: out.length, by: by };
}

async function fetchLines(games) {
  var cfg = supabaseConfig();
  if (!cfg) { log('[market] no Supabase config found — building without book numbers'); return null; }
  if (typeof fetch !== 'function') { log('[market] no fetch in this runtime'); return null; }
  log('[market] reading as the ' + cfg.role + ' role (config from ' + cfg.src + ')');

  var home = {}, totals = {}, mlH = {}, mlA = {}, note = [];

  /* 1. live captured quotes */
  try {
    var sig = await linesFromSignals(cfg, games);
    Object.keys(sig.lines).forEach(function (g) { home[g] = sig.lines[g]; });
    note.push('signals: ' + sig.rows + ' row(s), ' + Object.keys(sig.lines).length + ' matched');
  } catch (e) {
    note.push('signals: ' + ((e && e.message) || 'failed'));
  }

  /* 2. the reference table, for anything the live feed did not cover */
  try {
    var ref = await linesFromCfbLines(cfg, games);
    var added = 0;
    Object.keys(ref.by).forEach(function (g) {
      var l = ref.by[g];
      if (home[g] == null && l.spread != null) { home[g] = +l.spread; added++; }
      if (l.over_under != null && totals[g] == null) totals[g] = l.over_under;
      if (l.home_moneyline != null && mlH[g] == null) mlH[g] = l.home_moneyline;
      if (l.away_moneyline != null && mlA[g] == null) mlA[g] = l.away_moneyline;
    });
    note.push('cfb.lines: ' + ref.rowsRaw + ' row(s), ' + added + ' added');
  } catch (e) {
    note.push('cfb.lines: ' + ((e && e.message) || 'failed'));
  }

  note.forEach(function (n) { log('[market]   ' + n); });

  var ids = Object.keys(home);
  if (!ids.length) {
    log('[market] NO BOOK NUMBER ON ANY GAME.');
    if (cfg.role !== 'service') {
      log('[market] This build read as the ANON role. app.html states that every RLS');
      log('[market] policy keys on auth.uid(), which is NULL for an anon bearer, so an');
      log('[market] anon read of signals or cfb.lines returns zero rows rather than an');
      log('[market] error. Set EDGD_SB_SERVICE (the service-role key) to read them.');
    } else {
      log('[market] Read as the service role and both sources were genuinely empty for');
      log('[market] this slate — the odds scanner and cfb ingest may not have run yet.');
    }
    return null;
  }

  /* refuse an inverted table rather than publishing a board of fake blowouts */
  if (linesLookInverted(ids.map(function (g) { return home[g]; }))) {
    log('[market] REFUSING these lines: ' + ids.length + ' games and nearly every home team');
    log('[market] is a market underdog, which is a sign error, not a slate. Building');
    log('[market] without book numbers rather than inverting every game on the board.');
    return null;
  }

  var csv = ['game_id,spread,over_under,home_moneyline,away_moneyline'];
  ids.forEach(function (g) {
    csv.push([g, home[g],
      totals[g] == null ? '' : totals[g],
      mlH[g] == null ? '' : mlH[g],
      mlA[g] == null ? '' : mlA[g]].join(','));
  });
  log('[market] ' + ids.length + ' game(s) carry a book number');
  return csv.join('\n') + '\n';
}

/* ------------------------------------------------- run the real exporter */
function runExporter(season, linesPath, outPath, scope) {
  var args = [path.join(ROOT, 'football', 'cfb_p4', 'export_csv.js'),
    '--season', String(season), '--' + (scope || 'upcoming'), '--out', outPath];
  if (linesPath) args.push('--lines', linesPath);
  var r = cp.spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0)
    throw new Error('the Power 4 exporter failed:\n' + (r.stderr || r.stdout || '(no output)'));
  (r.stderr || '').split('\n').filter(Boolean).forEach(function (l) { log('  ' + l); });
  return fs.readFileSync(outPath, 'utf8');
}

/* ------------------------------------------------------ record assembly */
var P4_CONFS = (P4PARAMS.universe && P4PARAMS.universe.p4_conferences) || ['SEC', 'Big Ten', 'Big 12', 'ACC'];

/* The 2-4 short research factors the reveal shows. These are the exporter's
   own driver sentences, shortened at a sentence boundary — never rewritten,
   never generated, never numbers this file invented. */
function factors(o) {
  var out = [];
  ['primary_driver_1', 'primary_driver_2', 'primary_driver_3'].forEach(function (k) {
    var t = txt(o[k]);
    if (!t) return;
    out.push({ sign: '+', text: shorten(t) });
  });
  var counter = txt(o.counterargument_1);
  if (counter) out.push({ sign: '-', text: shorten(counter) });
  var missing = txt(o.unavailable_inputs);
  if (missing && out.length < 4) {
    var n = missing.split(';').length;
    out.push({ sign: '?', text: n + ' input' + (n === 1 ? '' : 's') + ' EdgeDesk could not read for this game' });
  }
  return out.slice(0, 4);
}

/* Keep it short without truncating mid-word: cut at the first em-dash or
   sentence end, then hard-cap. */
function shorten(s) {
  var t = String(s).split(' — ')[0].split('. ')[0].trim();
  if (t.length > 118) t = t.slice(0, 115).replace(/\s+\S*$/, '') + '…';
  return t;
}

/* ── the pre-lock matchup context ───────────────────────────────────────────
   What a player is shown BEFORE they price the game. Every value below is read
   straight out of football/rankings/current.json — the same numbers the
   rankings page renders — and is rounded for display, never derived, blended
   or invented. A team the rankings artifact has never seen contributes
   nothing rather than a zero.

   DELIBERATELY ABSENT: the team's overall rating. It is very nearly the answer
   to "where would you price this game", and handing it over turns the puzzle
   into arithmetic. Continuity and roster churn inform the read without
   resolving it. */
function teamContext(name) {
  if (!RANKINGS || !RANKINGS.teams) return null;
  var key = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  var t = RANKINGS.teams[key];
  if (!t) return null;
  var comp = {};
  ((t.continuity && t.continuity.components) || []).forEach(function (c) { comp[c.id] = c.value; });
  function pct(v) { return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) : null; }
  var out = {
    conference: txt(t.conference),
    returning_production: pct(comp.value_continuity),
    qb_continuity: pct(comp.qb_continuity),
    ol_continuity: pct(comp.ol_continuity),
    starts_continuity: pct(comp.starts_continuity),
    transfer_churn: pct(comp.transfer_churn)
  };
  var any = false, k;
  for (k in out) if (out.hasOwnProperty(k) && out[k] != null) any = true;
  return any ? out : null;
}

function toRecord(o) {
  var edge = num(o.model_home_line);
  var mkt = num(o.ref_home_line);
  var conf = num(o.confidence);
  var gap = (edge != null && mkt != null) ? (edge - mkt) : null;
  var st = STATE.classify(conf, gap);
  return {
    game_id: String(o.game_id),
    season: num(o.season),
    week: num(o.week),
    kickoff: txt(o.kickoff_local),
    home_team: txt(o.home_team),
    away_team: txt(o.away_team),
    home_conference: txt(o.home_conference),
    away_conference: txt(o.away_conference),
    neutral_site: String(o.neutral_site) === 'true' || String(o.neutral_site) === 'TRUE',
    venue: txt(o.venue),
    /* ---- the two prices, straight from the canonical export ---- */
    edgedesk_spread: r1(edge),
    market_spread: r1(mkt),
    market_source: txt(o.ref_source),
    spread_gap: r1(gap),
    /* ---- context the reveal is allowed to show ---- */
    confidence: conf == null ? null : Math.round(conf),
    status: txt(o.data_status),
    research_state: st.key,
    research_state_label: st.label,
    research_state_means: st.means,
    factors: factors(o),
    qb_status: txt(o.qb_status),
    context: { home: teamContext(o.home_team), away: teamContext(o.away_team) },
    /* ---- selection inputs ---- */
    p4: P4_CONFS.indexOf(txt(o.home_conference)) >= 0 || P4_CONFS.indexOf(txt(o.away_conference)) >= 0,
    both_fbs: true,
    unproven: true
  };
}

/* Final scores for every completed game, keyed by game_id. Nothing here grades
   anything: the score is a fact, and the ATS rule that turns it into a result
   is in games/lib/scoring.js where it can be tested on its own. */
function collectFinals(csv) {
  var out = {};
  csvObjects(csv).forEach(function (o) {
    var hs = num(o.home_score), as = num(o.away_score);
    if (hs == null || as == null) return;
    out[String(o.game_id)] = { home_score: hs, away_score: as };
  });
  return out;
}

/* ------------------------------------------------------------------ main */
var ARGS = parseArgs(process.argv);
var finals = {};

async function main() {
  var season = ARGS.season || currentSeason();
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-games-'));
  var csv;

  if (ARGS.slate) {
    log('[slate] reading a supplied slate: ' + ARGS.slate);
    csv = fs.readFileSync(ARGS.slate, 'utf8');
  } else {
    log('[build] season ' + season + ' — running the canonical Power 4 exporter');
    /* Pass one: no lines, purely to learn which games are on the slate. */
    var first = runExporter(season, null, path.join(tmp, 'slate0.csv'));
    /* the market matcher needs teams and kickoffs, not just ids: `signals` is
       keyed by the odds feed's own event_id and has to be matched by name */
    var slate = csvObjects(first).map(function (o) {
      return { game_id: o.game_id, home_team: o.home_team,
        away_team: o.away_team, kickoff: o.kickoff_local };
    }).filter(function (g) { return g.game_id; });
    var linesPath = null;
    if (ARGS.market && slate.length) {
      var lines = await fetchLines(slate);
      if (lines) { linesPath = path.join(tmp, 'lines.csv'); fs.writeFileSync(linesPath, lines); }
    }
    /* Pass two: the real slate, with book numbers joined by the exporter. */
    csv = linesPath ? runExporter(season, linesPath, path.join(tmp, 'slate.csv')) : first;

    /* Pass three: the whole season, for FINAL SCORES. A Pick 5 card promises
       results, so the artifact has to carry them. Only the score is taken —
       the settlement rule lives in games/lib/scoring.js and grades a card
       against the line the player actually picked at, not against whatever
       the market moved to afterwards. */
    try {
      finals = collectFinals(runExporter(season, linesPath, path.join(tmp, 'season.csv'), 'all'));
      log('[finals] ' + Object.keys(finals).length + ' completed game(s) carry a score');
    } catch (e) {
      log('[finals] could not read completed games (' + (e && e.message) + ') — '
        + 'cards will settle on the next build');
    }
  }

  var records = csvObjects(csv).map(toRecord);

  /* slugs, with a rematch disambiguated rather than silently colliding */
  var counts = {};
  records.forEach(function (r) {
    var b = CH.baseSlug(r.away_team, r.home_team);
    counts[b] = (counts[b] || 0) + 1;
  });
  records.forEach(function (r) {
    r.slug = CH.slugFor(r, counts[CH.baseSlug(r.away_team, r.home_team)] > 1);
  });

  var playable = CH.playable(records);
  if (!playable.length) {
    console.error('REFUSING TO WRITE: no playable challenge in this slate ('
      + records.length + ' game(s) read). The existing artifact is left alone.');
    process.exit(1);
  }

  var withMarket = playable.filter(function (r) { return r.market_spread != null; }).length;
  var artifact = {
    schema: ARTIFACT_SCHEMA,
    generated_at: new Date().toISOString(),
    season: season,
    model_version: P4PARAMS.model_version,
    feature_version: P4PARAMS.feature_version,
    scoring_version: SCORING.SCORING_VERSION,
    thresholds: STATE.thresholds(),
    context_source: RANKINGS
      ? { artifact: 'football/rankings/current.json', schema: RANKINGS.schema,
          season: RANKINGS.season, week: RANKINGS.week_label }
      : null,
    counts: { games: records.length, playable: playable.length, with_market: withMarket },
    /* the honesty line the pages must render somewhere on every reveal */
    basis: 'EdgeDesk’s projection is research, not a proven edge: it does not beat the '
      + 'closing line. Free to play, no real-money wagering.',
    challenges: CH.rank(playable),
    /* game_id -> { home_score, away_score } for every completed game this
       season. Pick 5 settles its stored cards from these. */
    finals: finals
  };

  var out = ARGS.out || path.join(__dirname, 'data', 'challenges.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(artifact, null, 1) + '\n');

  /* The social layer's endpoint, READ OUT OF app.html rather than copied into
     a second place by hand. Both values are already public — the anon key
     authenticates nothing on its own and RLS governs what it can reach — but
     having one declared home for them is what stops the games pages drifting
     onto a stale project after a rotation. */
  if (!ARGS.out) {
    var cfg = supabaseConfig();
    if (cfg) {
      fs.writeFileSync(path.join(__dirname, 'data', 'config.json'),
        JSON.stringify({
          schema: 'edgedesk_games_config_v1',
          generated_at: artifact.generated_at,
          supabase_url: cfg.url,
          supabase_anon_key: cfg.key,
          source: cfg.src
        }, null, 1) + '\n');
      log('[config] endpoint written from ' + cfg.src);
    } else {
      log('[config] no Supabase config found — the social layer will report itself undeployed');
    }
  }
  log('[write] ' + out + '  ' + playable.length + ' playable challenge(s), '
    + withMarket + ' with a book number');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

main().catch(function (e) { console.error(e && (e.stack || e.message)); process.exit(1); });
