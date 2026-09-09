#!/usr/bin/env node
/* ===========================================================================
   Keep the Collective's schedule complete, by itself, every day.

   THE PROBLEM THIS EXISTS FOR

   A creator uploaded a correct thirty-game college slate and ten of it
   quarantined, every week, forever. Not because anything in the file was
   wrong -- because the backend's week had 49 games in it and the real week
   had 59. Ten fixtures had never been ingested, so ten rows had no game to
   attach to, and the only cure was a human noticing and loading them by hand.

   So this closes the loop. It reads the real schedule from ESPN, compares it
   against what the Collective holds for the same sport, season and week, and
   loads whatever is missing -- teams first, because a game cannot reference a
   team the backend has never been given, then the games themselves.

   WHY IT HAD NEVER LOADED ANYTHING

   It could only write through collective_admin with an admin refresh token,
   and that secret was never set. Every scheduled run since the job was
   written printed "COLLECTIVE_ADMIN_REFRESH_TOKEN is not set" and exited 0,
   green. Week 2 of the 2026 college season was on the site because somebody
   loaded it by hand. The service-role credential this repository already
   holds for the settle job WAS passed in, and was used for one thing only:
   updating a moved kickoff. So the run could correct a game it could not
   create.

   Now the service role is a full door (`direct` mode below): it reads the
   season straight off the database, creates the teams and games it is short
   of, and updates the ones that moved -- and it still works through
   collective_admin when that is the credential a run has.

   WHAT A GAME IS, TO THIS JOB

   The provider's own fixture id. ESPN's event id is stable across a kickoff
   moving, a network changing and a postponement, which two team names and a
   date are not; it is stored on the game as external_ref ("espn:<id>") the
   first time the fixture is seen, and read back on every run after. A game
   loaded before this existed is matched by its two teams inside its own
   week and given its id then. Matching is in three passes, strongest first,
   and a held game is claimed at most once:

     1. by external_ref, anywhere in the season -- the fixture MOVED if its
        week or kickoff now differs, and is updated in place;
     2. by both teams, inside the week the provider files it under;
     3. by both teams across weeks, but only for a game that has not been
        played and is postponed or still ahead -- a fixture re-filed under a
        new week, never a played game, so a rematch can never be "moved".

   Whatever matches nothing is missing and is loaded. A held game that
   matches nothing in the feed is reported, never deleted.

   WHAT IT DOES TO A GAME IT ALREADY HAS

   Four columns, and no others: kickoff_at and status when the feed restates
   them, week only when the provider moved the fixture, external_ref only to
   fill a blank. The fixture is updated IN PLACE, keeping its id and therefore
   every projection, captured price and snapshot already attached to it. It
   is never re-loaded, which is the only way a moved kickoff could become a
   second copy of the same game. It never touches a settled game and never
   names a score, a closing line or a grade. UPDATE_COLS is the entire write
   set and the suites hold it.

   It writes nothing without --commit. The default run says what it would do.

   CREDENTIALS

     EDGD_SB_SERVICE + EDGD_SB_URL   the service role (SB_SERVICE_ROLE /
                                     SB_URL in the workflow). Preferred: it
                                     reads the season exactly and writes
                                     everything.
     COLLECTIVE_ADMIN_REFRESH_TOKEN  a Supabase refresh token for an account
                                     on admin.user_ids; loads through
                                     collective_admin.
     COLLECTIVE_ADMIN_ACCESS_TOKEN   a short-lived access token, for a manual
                                     invocation.

   USAGE

     node tools/collective/sync_schedule.js                 # dry run, says what is missing
     node tools/collective/sync_schedule.js --verify        # prove ESPN answers, no credential needed
     node tools/collective/sync_schedule.js --commit        # actually load
     node tools/collective/sync_schedule.js --sport CFB --season 2026 --week 1
     node tools/collective/sync_schedule.js --weeks 4       # this week and the next three

   It is SAFE TO RUN REPEATEDLY, and meant to be: a fixture already held is
   not offered again, and a fixture whose facts already agree produces no
   write. A day on which nothing changed costs a handful of reads and writes
   nothing at all.
   =========================================================================== */
'use strict';

const S = require('./settle_finals.js');
/* The one rule for which week is current, shared with the site. */
const MCWeek = require('../../collective/week.js');

const API = (process.env.COLLECTIVE_API ||
  'https://iattxbkbufslbauoumga.supabase.co/functions/v1').replace(/\/$/, '');
const SB_URL = process.env.EDGEDESK_SUPABASE_URL ||
  'https://iattxbkbufslbauoumga.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYzMzU4NzUsImV4cCI6MjA3MTkxMTg3NX0.Ej0xLYSNJgvDCMCLxHPQTG7ivRUyPvvSGKvUlgQ4qYA';

/* ESPN's own season/week addressing, which is what a schedule is actually
   organised by -- asking by date means guessing which days a week touches,
   and a week that stretches Thursday to Monday makes that a bad guess. */
const ESPN_PATH = { NFL: 'football/nfl', CFB: 'football/college-football' };
/* The source's origin, overridable so the whole job can be driven end to end
   against a recorded feed with no network. The default is the real thing. */
const ESPN_API = (process.env.ESPN_API || 'https://site.api.espn.com').replace(/\/$/, '');
/* Division I FBS. A game between an FBS team and anybody else is still an FBS
   team's game and comes back in this group -- which is the entire point, since
   those are the fixtures that were missing. */
const ESPN_GROUP = { CFB: '80' };

/* WHERE THE POSTSEASON LIVES.

   The Collective numbers a season straight through: college football's weeks
   1-15 are the regular season and 16-20 are Conference Championships, Bowl
   Season and the three playoff rounds; the NFL's 1-18 are the regular season
   and 19-22 the playoffs through the Super Bowl. That numbering is the site's
   own (collective/index.html's SPORTS registry holds the names) and it is what
   the week strip's postseason tabs are.

   ESPN addresses the same games as season type 3 with its own week numbering
   restarting at 1. So the two have to be mapped, and the map is stated HERE,
   explicitly, per sport -- not computed, because the arithmetic that looks
   obvious is wrong: the NFL's season type 3 week 4 is the Pro Bowl, so the
   Super Bowl is week 5 and not week 4.

   `regular` is the last week that lives in season type 2. Anything past it is
   looked up in `post`; a week with no entry is not requested at all, which is
   how a round nobody has mapped shows up in the log as unsupported instead of
   as somebody else's games. */
const ESPN_SEASON = {
  NFL: { regular: 18, post: { 19: 1, 20: 2, 21: 3, 22: 5 } },
  CFB: { regular: 15, post: { 16: 1, 17: 2, 18: 3, 19: 4, 20: 5 } },
};

function log(...a) { console.log('[schedule]', ...a); }

/* The Collective's week -> the season type and week ESPN keeps it under.
   Null when this sport has no postseason mapping for it. */
function espnAddress(sport, week) {
  const cal = ESPN_SEASON[sport];
  const w = Number(week);
  if (!Number.isFinite(w) || w < 0) return null;
  /* Week 0 is asked for as week 0. Whether the provider files the opening
     Saturday under 0 or under 1 is the provider's business: the rows come
     back stamped with the week ESPN states (collectiveWeekOf) and are stored
     under that, so nothing here invents a week for them either way. */
  if (!cal || w <= cal.regular) return { seasontype: 2, week: w };
  const p = cal.post[w];
  return p == null ? null : { seasontype: 3, week: p };
}

function espnScoreboardUrl(sport, season, week) {
  const path = ESPN_PATH[sport];
  if (!path) return null;
  const at = espnAddress(sport, week);
  if (!at) return null;
  const g = ESPN_GROUP[sport] ? `&groups=${ESPN_GROUP[sport]}` : '';
  return `${ESPN_API}/apis/site/v2/sports/${path}/scoreboard` +
    `?limit=400&year=${encodeURIComponent(season)}&seasontype=${at.seasontype}` +
    `&week=${encodeURIComponent(at.week)}${g}`;
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts || {});
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error.message; } catch (_) {}
    const e = new Error(`${res.status}: ${String(msg).slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

/* The week as ESPN has it, normalised through the settler's own reader so the
   two tools cannot drift on what a team is called.

   Every row is stamped with the Collective week it belongs to. That is the
   week ESPN itself states for the event whenever the payload carries one and
   it addresses the same bucket that was asked for; otherwise it is the week
   that was asked for, which is what the request already means. Either way the
   number is the PROVIDER'S -- nothing here derives a week from a date. */
async function espnWeek(sport, season, week) {
  const url = espnScoreboardUrl(sport, season, week);
  if (!url) return [];
  const at = espnAddress(sport, week);
  const d = await fetchJson(url);
  return ((d && d.events) || []).map(S.normEspn)
    .filter(r => r.home_team && r.away_team && r.start_date)
    .map(r => Object.assign({}, r, { week: collectiveWeekOf(sport, r, at, week) }));
}

/* Which of the Collective's weeks an ESPN event belongs to. The event's own
   week wins, but only inside the season type that was asked for -- season type
   3 restarts its week numbering at 1, so an unqualified "week 1" from a bowl
   payload filed as regular-season week 1 would put the Rose Bowl on the first
   Saturday in September. */
function collectiveWeekOf(sport, row, at, asked) {
  const want = Number(asked);
  if (!at) return want;
  const evWeek = Number(row && row.espn_week);
  const evType = Number(row && row.espn_season_type);
  if (!Number.isFinite(evWeek)) return want;
  if (Number.isFinite(evType) && evType !== at.seasontype) return want;
  if (at.seasontype === 2) return evWeek;
  /* Season type 3: turn ESPN's round number back into the Collective's week
     through the same map that addressed the request, so the two directions
     cannot disagree. */
  const cal = ESPN_SEASON[sport];
  if (!cal) return want;
  const hit = Object.keys(cal.post).filter(k => cal.post[k] === evWeek)[0];
  return hit == null ? want : Number(hit);
}

/* ---- what the Collective already holds ---------------------------------- */

async function collectiveWeek(sport, season, week, token) {
  const q = `/v1/games?sport=${encodeURIComponent(sport)}&season=${encodeURIComponent(season)}` +
    `&week=${encodeURIComponent(week)}`;
  const d = await fetchJson(`${API}/collective_public${q}`,
    token ? { headers: { authorization: `Bearer ${token}` } } : {});
  /* A function deployed before rows carried their week answers rows without
     one; they are this week's, because this week is what was asked for. */
  return MCWeek.withWeek((d && d.games) || [], week);
}

/* Is this ESPN fixture the same game as this Collective row, by its two
   teams? Through the settler's team matcher, which already understands that
   the Collective clips its names -- NORTHCAROL is North Carolina, and a
   comparison that does not know that reports every game as missing and loads
   the whole week a second time. */
function alreadyHave(game, feed) {
  const home = String(game.home || game.home_team || '');
  const away = String(game.away || game.away_team || '');
  if (!home || !away) return false;
  return S.teamsAgreeAny(home, feed.home_names.concat([feed.home_team])) &&
    S.teamsAgreeAny(away, feed.away_names.concat([feed.away_team]));
}

/* ---- the provider's stable id ------------------------------------------ */
const REF_PREFIX = 'espn:';
function refOf(feed) {
  return (feed && feed.espn_id != null && feed.espn_id !== '') ? REF_PREFIX + String(feed.espn_id) : null;
}
/* A ref stored by this job ("espn:401628") or, defensively, the bare id a
   different loader might have written. Anything else is not a match. */
function refMatches(have, feed) {
  const id = feed && feed.espn_id;
  if (id == null || id === '' || have == null || have === '') return false;
  const h = String(have);
  return h === REF_PREFIX + String(id) || h === String(id);
}

/* Every team named by the fixtures that are missing. The backend cannot
   reference a team it has never been given, so these go first or the games
   come straight back as unknown_team_away. */
function teamsNeeded(rows) {
  const out = [], seen = Object.create(null);
  rows.forEach(r => {
    [r.home_team, r.away_team].forEach(n => {
      const k = S.teamKey(n);
      if (!k || seen[k]) return;
      seen[k] = 1; out.push(n);
    });
  });
  return out;
}

/* The shape /v1/admin/games takes. Kickoff stays exactly as ESPN stated it --
   an ISO instant, never a local wall clock, because a schedule that disagrees
   with itself about time zones is worse than one that is short a game.

   The week is the row's own where it has one (see collectiveWeekOf), so a
   fixture ESPN files under a different week than the bucket it came back in
   is stored under the week ESPN says, not the week that was asked for. */
function gamePayload(rows, week) {
  return rows.map(r => ({
    week: Number(r && r.week != null ? r.week : week),
    kickoff: r.start_date,
    home: r.home_team,
    away: r.away_team,
  }));
}

/* ==== A FIXTURE THAT MOVED IS NOT A NEW FIXTURE ==========================
   The write set for a game the Collective already holds, and the ENTIRE
   write set: kickoff_at and status when the feed restates them, week only
   when the provider re-filed the fixture, external_ref only to fill a blank.
   It cannot touch a score, a closing line or a grade, because it never names
   one: a settled week's facts are not reachable from this code path even if
   the feed changes its mind about them. Nothing settled is touched at all. */
const UPDATE_COLS = ['kickoff_at', 'status', 'week', 'external_ref'];

/* ESPN's status vocabulary reduced to the two states that are a schedule
   fact rather than a clock reading. Everything else -- scheduled, in
   progress, final -- is either the default or somebody else's job (the
   settler owns "final"), so this returns null and the status is left alone
   rather than being written over on every daily run. */
function statusFromFeed(row) {
  const st = String((row && row.espn_status) || '').toUpperCase();
  if (/POSTPONED/.test(st)) return 'postponed';
  if (/CANCEL/.test(st)) return 'canceled';
  return null;
}

function settledAlready(game) {
  if (!game) return false;
  const r = game.result;
  if (r && r.home_score != null && r.away_score != null) return true;
  if (game.home_score != null && game.away_score != null) return true;
  return String(game.status || '').toLowerCase() === 'final';
}

/* Two kickoffs are the same kickoff unless they differ by a minute or more.
   Sub-minute noise is a feed re-stating the same instant with a different
   precision, and writing on it would make every run a write. */
function kickoffMoved(have, want) {
  const a = new Date(have || 0).getTime(), b = new Date(want || 0).getTime();
  if (!isFinite(a) || !isFinite(b) || !b) return false;
  return Math.abs(a - b) >= 60000;
}

/* What has actually changed about a game the Collective already holds, or
   null. Only ever the columns above.

     opts.moveWeek   the match is the fixture itself (by stable id, or a
                     re-filed unplayed game), so a different provider week
                     is a move and is written
     opts.ref        fill a blank external_ref with the provider's id  */
function drift(game, feed, opts) {
  opts = opts || {};
  if (settledAlready(game)) return null;
  const patch = {};
  if (kickoffMoved(game.kickoff_at, feed.start_date)) patch.kickoff_at = feed.start_date;
  const st = statusFromFeed(feed);
  if (st && String(game.status || '').toLowerCase() !== st) patch.status = st;
  if (opts.moveWeek) {
    const w = MCWeek.weekOf(feed), have = MCWeek.weekOf(game);
    if (w != null && have !== w) patch.week = w;
  }
  if (opts.ref) {
    const ref = refOf(feed);
    if (ref && (game.external_ref == null || game.external_ref === '')) patch.external_ref = ref;
  }
  return Object.keys(patch).length ? patch : null;
}

/* ==== THE PLAN: one week of the feed against what the Collective holds ====
   `held` is every Collective game in reach -- the week's bucket when the
   run reads through the public API, the whole season through the service
   role. `week` is the bucket that was asked for; a feed row's own week wins
   where it has one. Returns what to insert, what to update and by which
   rule, what is held twice, and what the feed no longer carries. Pure: the
   run applies it, the suites hold it. */
const SLATE_WINDOW_MS = 4 * 86400e3;
function planWeek(held, feed, week, opts) {
  opts = opts || {};
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const rows = (feed || []).map(f => Object.assign({}, f,
    { week: f.week != null ? Number(f.week) : (week == null ? null : Number(week)) }));
  const games = (held || []).slice();
  const claimed = new Set();
  const matched = new Map();     /* feed index -> { game, how } */
  const free = g => !claimed.has(g);
  const inBucket = (g, f) => {
    const gw = MCWeek.weekOf(g);
    return f.week == null || gw == null || gw === f.week;
  };
  const unplayed = g => {
    if (settledAlready(g)) return false;
    if (String(g.status || '').toLowerCase() === 'postponed') return true;
    const k = new Date(g.kickoff_at || 0).getTime();
    return isFinite(k) && k > now;
  };

  /* pass 1: the provider's own id, anywhere */
  rows.forEach((f, i) => {
    const g = games.find(x => free(x) && refMatches(x.external_ref, f));
    if (g) { claimed.add(g); matched.set(i, { game: g, how: 'ref' }); }
  });
  /* pass 2: both teams, inside the week the provider files it under */
  rows.forEach((f, i) => {
    if (matched.has(i)) return;
    const g = games.find(x => free(x) && inBucket(x, f) && alreadyHave(x, f));
    if (g) { claimed.add(g); matched.set(i, { game: g, how: 'teams' }); }
  });
  /* pass 3: both teams across weeks, unplayed only -- a re-filed fixture */
  rows.forEach((f, i) => {
    if (matched.has(i)) return;
    const g = games.find(x => free(x) && !inBucket(x, f) && unplayed(x) && alreadyHave(x, f));
    if (g) { claimed.add(g); matched.set(i, { game: g, how: 'moved' }); }
  });

  const inserts = [], updates = [], duplicates = [];
  let unchanged = 0;
  rows.forEach((f, i) => {
    const m = matched.get(i);
    if (!m) { inserts.push(f); return; }
    const patch = drift(m.game, f, { moveWeek: m.how !== 'teams', ref: !!opts.refs });
    if (patch) updates.push({ game: m.game, feed: f, patch, how: m.how });
    else unchanged++;
    /* the same fixture held a second time -- the same two teams, unplayed,
       inside the same slate window: reported, never deleted. A rematch
       weeks away is a different game and is left alone. */
    const fk = new Date(f.start_date || 0).getTime();
    games.forEach(x => {
      if (!free(x) || settledAlready(x) || !alreadyHave(x, f)) return;
      const xk = new Date(x.kickoff_at || 0).getTime();
      if (isFinite(fk) && fk && isFinite(xk) && xk && Math.abs(xk - fk) > SLATE_WINDOW_MS) return;
      duplicates.push({ game: x, feed: f, of: m.game });
    });
  });
  /* held in this bucket, absent from the feed: reported, never deleted */
  const notInFeed = games.filter(x => free(x) && !duplicates.some(d => d.game === x)
    && (week == null || MCWeek.weekOf(x) === Number(week)));
  return { inserts, updates, duplicates, notInFeed, unchanged };
}

/* The two questions the older callers asked, answered by the planner. */
function missingFrom(collectiveGames, feedRows, week) {
  return planWeek(collectiveGames, feedRows, week == null ? null : week).inserts;
}
function updatesFor(collectiveGames, feedRows, week, opts) {
  return planWeek(collectiveGames, feedRows, week == null ? null : week, opts).updates;
}

/* The write, through the same service-role door settle_finals already uses:
   PATCH collective.games by id. The id is the Collective's own and never
   changes, so a moved fixture keeps every projection, every captured price
   and every snapshot already attached to it -- which is the whole reason this
   updates rather than re-loading.

   Columns are read off the database's own OpenAPI listing first and only ones
   that exist are written, so a deployment whose games table is shaped
   differently is told rather than half-written. */
async function applyUpdates(db, schema, updates) {
  const cols = (schema && schema.games) || [];
  const out = { updated: 0, refused: [], skipped: [] };
  for (const u of updates) {
    const patch = {};
    UPDATE_COLS.forEach(c => { if (c in u.patch && cols.indexOf(c) >= 0) patch[c] = u.patch[c]; });
    const missing = Object.keys(u.patch).filter(c => !(c in patch));
    if (missing.length) out.skipped.push({ game_id: u.game.game_id, columns: missing });
    if (!Object.keys(patch).length) continue;
    try {
      const rows = await db.patch('games', `id=eq.${encodeURIComponent(String(u.game.game_id))}`, patch);
      if (!rows.length) { out.refused.push({ game_id: u.game.game_id, detail: 'no row with that id' }); continue; }
      Object.assign(u.game, patch);          /* the plan for the next week reads the truth */
      out.updated++;
    } catch (e) {
      out.refused.push({ game_id: u.game.game_id, detail: e.message });
    }
  }
  return out;
}

/* ==== THE SERVICE-ROLE DOOR ============================================== */

/* The season as the database holds it: game_detail for names, kickoffs,
   statuses and scores -- the exact rows the board is drawn from -- joined to
   games for the provider id, where that column exists. */
async function loadSeason(db, schema, sport, season) {
  const enc = v => encodeURIComponent(String(v));
  const detail = await db.select('game_detail',
    `select=*&sport=eq.${enc(sport)}&season=eq.${enc(season)}&order=kickoff_at.asc`);
  const held = detail.map(S.gameFromDetail);
  const gcols = (schema && schema.games) || [];
  if (gcols.indexOf('external_ref') >= 0) {
    const refs = await db.select('games',
      `select=id,external_ref&sport_code=eq.${enc(sport)}&season=eq.${enc(season)}`);
    const by = new Map(refs.map(r => [String(r.id), r.external_ref]));
    held.forEach(g => { g.external_ref = by.has(String(g.game_id)) ? by.get(String(g.game_id)) : null; });
  }
  return held;
}

/* The current season per sport, off the same views the settler and
   collective_public read; null when they cannot be read, and the caller
   falls back to the public meta. */
async function loadSports(db) {
  const sp = await db.select('sports', 'select=code,name');
  let se = null;
  for (const rel of ['sport_seasons', 'seasons']) {
    try { se = await db.select(rel, 'select=sport_code,season,starts_on,ends_on'); break; }
    catch (_) { se = null; }
  }
  if (!se) return null;
  return S.seasonsFrom(sp, se, new Date().toISOString().slice(0, 10));
}

/* TEAMS. The code is derived exactly as collective_admin derives it, because
   the resolver matches on the stored code. */
const TEAM_CODE_MAX = 10;
function teamCode(name) {
  return String(name == null ? '' : name).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, TEAM_CODE_MAX);
}
async function loadRoster(db, sport) {
  const enc = encodeURIComponent(String(sport));
  const teams = await db.select('teams', `select=id,code,name&sport_code=eq.${enc}`);
  let aliases = [];
  try { aliases = await db.select('team_aliases', `select=alias,team_id&sport_code=eq.${enc}`); }
  catch (_) { aliases = []; }
  return { teams: teams || [], aliases: aliases || [] };
}
/* Which stored team a fixture's side is, given every spelling the provider
   knows for it. An alias or a stored full name that equals one of them is the
   team. A code match alone is accepted only for a row whose name IS its code
   -- a team loaded before full names were kept, about which nothing more can
   be known. A code match against a DIFFERENT full name is a collision, not a
   match: "Washington State" clips to WASHINGTON, and linking it to Washington
   would put the Cougars' games on the Huskies. */
function findTeam(roster, spellings, primary) {
  const all = (spellings || []).filter(Boolean);
  const name = primary != null ? primary : all[0];
  if (!name) return null;
  /* An alias is an operator's own statement that a spelling IS this team,
     so every spelling the provider offers may hit one. A stored NAME and a
     CODE are matched only on spellings of the team's name -- the location,
     the display name, a clipped form -- never on a mascot or an
     abbreviation: "IOWA" is Iowa State's abbreviation and Iowa's name, and
     "Cyclones" is nobody's. */
  const allKeys = all.map(S.teamKey).filter(Boolean);
  const own = all.filter(x => S.teamsAgree(name, x));
  if (!own.length) own.push(name);
  const keys = own.map(S.teamKey).filter(Boolean);
  const byId = new Map((roster.teams || []).map(t => [String(t.id), t]));
  for (const a of (roster.aliases || [])) {
    if (allKeys.indexOf(S.teamKey(a.alias)) >= 0 && byId.has(String(a.team_id))) return byId.get(String(a.team_id));
  }
  for (const t of (roster.teams || [])) {
    if (keys.indexOf(S.teamKey(t.name)) >= 0) return t;
  }
  const wantCode = teamCode(name);
  if (!wantCode) return null;
  for (const t of (roster.teams || [])) {
    if (String(t.code || '').toUpperCase() !== wantCode) continue;
    /* Literally the code, as a loader that kept no full name stored it
       (NORTHCAROL). A name stored in its own case ("Washington") is a full
       name, and a code that only clips to it is somebody else's. */
    const nameIsCode = !t.name || String(t.name) === String(t.code);
    if (nameIsCode && S.teamsAgree(t.code, name)) return t;
  }
  return null;
}
/* A code no team in the roster holds: the derived one, else the first free
   numeric variant -- the same shape a collision was already resolved to by
   hand (WASHINGTO2). */
function nextCode(roster, name) {
  const base = teamCode(name);
  const taken = new Set((roster.teams || []).map(t => String(t.code || '').toUpperCase()));
  if (base.length >= 2 && !taken.has(base)) return base;
  for (let n = 2; n < 10; n++) {
    const c = base.slice(0, TEAM_CODE_MAX - 1) + n;
    if (!taken.has(c)) return c;
  }
  return null;
}
/* Every team the missing fixtures name, resolved or created, so a game can
   reference it. Returns a map from S.teamKey(feed spelling) to the team id,
   and creates the full-name alias the resolver matches slates on. */
async function ensureTeams(db, schema, sport, rows, roster, commit) {
  const out = { ids: new Map(), created: 0, failed: [], toCreate: [] };
  const sides = [];
  rows.forEach(r => {
    sides.push({ name: r.home_team, names: (r.home_names || []).concat([r.home_team]) });
    sides.push({ name: r.away_team, names: (r.away_names || []).concat([r.away_team]) });
  });
  const seen = new Set();
  for (const s of sides) {
    const k = S.teamKey(s.name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const have = findTeam(roster, s.names, s.name);
    if (have) { out.ids.set(k, have.id); continue; }
    const code = nextCode(roster, s.name);
    if (!code) { out.failed.push({ name: s.name, message: 'no free team code' }); continue; }
    out.toCreate.push({ name: s.name, code });
    if (!commit) continue;
    try {
      const made = await db.insert('teams', [{ sport_code: sport, code, name: s.name }]);
      const id = made && made[0] && made[0].id;
      if (!id) { out.failed.push({ name: s.name, message: 'the insert returned no row' }); continue; }
      roster.teams.push({ id, code, name: s.name });
      out.ids.set(k, id);
      out.created++;
      if (String(s.name).toUpperCase() !== code && (schema.team_aliases || []).length) {
        try { await db.insert('team_aliases', [{ sport_code: sport, alias: s.name, team_id: id }]); }
        catch (e) { if (!/duplicate|already exists|23505/i.test(e.message)) out.failed.push({ name: s.name, message: 'team created, alias refused: ' + e.message.slice(0, 200) }); }
      }
    } catch (e) {
      out.failed.push({ name: s.name, message: e.message.slice(0, 300) });
    }
  }
  return out;
}
/* The rows collective.games takes, from the feed and the team ids. Only
   columns the table actually has are written; a table without team-id
   columns is a different shape and is refused rather than half-written. */
function gameRows(schema, sport, season, rows, ids) {
  const cols = (schema && schema.games) || [];
  const out = { rows: [], refused: [] };
  if (cols.indexOf('home_team_id') < 0 || cols.indexOf('away_team_id') < 0) {
    out.refused.push({ detail: `collective.games carries no home_team_id/away_team_id (saw: ${cols.join(', ') || 'nothing'})` });
    return out;
  }
  rows.forEach(r => {
    const h = ids.get(S.teamKey(r.home_team)), a = ids.get(S.teamKey(r.away_team));
    if (!h || !a) { out.refused.push({ label: `${r.away_team} @ ${r.home_team}`, detail: 'team not created' }); return; }
    const want = {
      sport_code: sport, season: Number(season), week: MCWeek.weekOf(r),
      kickoff_at: r.start_date, home_team_id: h, away_team_id: a,
      status: 'scheduled', external_ref: refOf(r),
    };
    const row = {};
    Object.keys(want).forEach(c => { if (cols.indexOf(c) >= 0 && want[c] !== null) row[c] = want[c]; });
    out.rows.push(row);
  });
  return out;
}
async function insertGames(db, schema, sport, season, rows, ids) {
  const built = gameRows(schema, sport, season, rows, ids);
  const out = { inserted: [], refused: built.refused };
  if (!built.rows.length) return out;
  try {
    const made = await db.insert('games', built.rows);
    out.inserted = made || [];
  } catch (e) {
    out.refused.push({ detail: e.message.slice(0, 400) });
  }
  return out;
}

/* ---- writing through collective_admin ------------------------------------ */

async function accessToken() {
  const direct = (process.env.COLLECTIVE_ADMIN_ACCESS_TOKEN || '').trim();
  if (direct) return direct;
  const refresh = (process.env.COLLECTIVE_ADMIN_REFRESH_TOKEN || '').trim();
  if (!refresh) {
    throw new Error('No admin credential. Set COLLECTIVE_ADMIN_REFRESH_TOKEN ' +
      '(preferred) or COLLECTIVE_ADMIN_ACCESS_TOKEN.');
  }
  const d = await fetchJson(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'apikey': ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  }).catch(e => {
    throw new Error(`refresh token rejected (${e.status || '?'}). Re-issue it from a ` +
      'signed-in admin session.');
  });
  if (!d.access_token) throw new Error('refresh succeeded but returned no access_token');
  if (d.refresh_token && d.refresh_token !== refresh) {
    console.error('[schedule] note: the refresh token rotated. Update the secret to keep this job alive.');
  }
  return d.access_token;
}

async function postTeams(sport, names, token) {
  return await fetchJson(`${API}/collective_admin/v1/admin/teams`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sport, teams: names }),
  });
}

async function postGames(sport, season, games, token) {
  return await fetchJson(`${API}/collective_admin/v1/admin/games`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sport, season: Number(season), games }),
  });
}

module.exports = {
  espnScoreboardUrl, espnAddress, espnWeek, collectiveWeekOf,
  alreadyHave, missingFrom, updatesFor, planWeek, teamsNeeded, gamePayload,
  refOf, refMatches, REF_PREFIX,
  statusFromFeed, settledAlready, kickoffMoved, drift, applyUpdates,
  loadSeason, loadSports, loadRoster, findTeam, nextCode, teamCode, ensureTeams, gameRows, insertGames,
  collectiveWeek, postTeams, postGames, accessToken,
  ESPN_GROUP, ESPN_PATH, ESPN_SEASON, UPDATE_COLS,
};

/* ---- the run -------------------------------------------------------------- */

function parseArgs(argv) {
  /* THREE weeks by default: the one being played, the one being posted for,
     and the one after it. Two was already thin -- a creator posts on Tuesday
     for a slate that is loaded on Wednesday -- and it became a real hole once
     Current started rolling forward the moment a week finished, because the
     first of the two weeks is then already history. */
  const a = { commit: false, verify: false, sport: null, season: null, week: null, weeks: 3 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--commit') a.commit = true;
    else if (v === '--verify') a.verify = true;
    else if (v === '--sport') a.sport = String(argv[++i] || '').toUpperCase();
    else if (v === '--season') a.season = Number(argv[++i]);
    else if (v === '--week') a.week = Number(argv[++i]);
    else if (v === '--weeks') a.weeks = Math.max(1, Number(argv[++i]) || 1);
  }
  return a;
}

async function meta() {
  return await fetchJson(`${API}/collective_public/v1/meta`);
}

/* The week the Collective considers current -- by the SAME rule the site
   resolves Current with, from collective/week.js, rather than a second
   calendar this tool would have to keep in step with it. Through the public
   API, one week per request, for a run that has no service role. */
async function currentWeek(sport, season, token) {
  const ask = w => fetchJson(
    `${API}/collective_public/v1/games?sport=${encodeURIComponent(sport)}` +
    `&season=${encodeURIComponent(season)}` + (w == null ? '' : `&week=${w}`),
    token ? { headers: { authorization: `Bearer ${token}` } } : {}).catch(() => null);
  const cal = ESPN_SEASON[sport];
  const r = await MCWeek.resolveCurrentSlate({
    fetchWeek: ask,
    /* the last week this tool can address at all: asking past it would be
       asking for a bucket no map names */
    maxWeek: cal ? Math.max.apply(null, Object.keys(cal.post).map(Number).concat([cal.regular])) : null,
  });
  return r.week == null ? 1 : r.week;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  /* --verify proves the SOURCE, and needs no credential to do it. It is what
     the workflow runs before it is trusted to write anything. */
  if (args.verify) {
    const season = args.season || new Date().getFullYear();
    let bad = 0;
    for (const sport of (args.sport ? [args.sport] : ['CFB', 'NFL'])) {
      const week = args.week || 1;
      try {
        const rows = await espnWeek(sport, season, week);
        log(`${sport} ${season} week ${week}: ESPN returned ${rows.length} game(s)`);
        if (!rows.length) { bad++; log(`  ${sport}: EMPTY -- the source answered but carried nothing`); }
        else log(`  e.g. ${rows[0].away_team} @ ${rows[0].home_team} ${rows[0].start_date}  w${rows[0].week}`);
      } catch (e) { bad++; log(`${sport}: SOURCE FAILED -- ${e.message}`); }
    }
    return bad ? 1 : 0;
  }

  /* THE DOOR. The service role reads the season exactly and writes
     everything; it is tried first because it is the credential this
     repository's jobs actually have. The admin token is the other door. A
     run with neither still reads what is public and reports. */
  let db = null, schema = null;
  const direct = S.directConfig(process.env);
  if (direct) {
    try {
      db = S.dbClient(direct);
      schema = await db.schema();
      log(`service role: collective.games has ${(schema.games || []).length} column(s)` +
        ((schema.games || []).indexOf('external_ref') >= 0 ? ', with external_ref' : ', no external_ref column') +
        '; reading and writing directly.');
    } catch (e) {
      db = null; schema = null;
      log(`the service credential could not read the schema (${e.message}).`);
    }
  }
  let token = null;
  if (!db) {
    try { token = await accessToken(); log('no service credential; loading through collective_admin with the admin token.'); }
    catch (e) {
      if (args.commit) { log(e.message); return 1; }
      log(`no credential (${e.message}) -- reading what is public and reporting only.`);
    }
  }

  let sports = null;
  if (db) {
    try { sports = await loadSports(db); }
    catch (e) { log(`sports/seasons not readable directly (${e.message}); using the public meta.`); sports = null; }
  }
  if (!sports) {
    const m = await meta().catch(() => null);
    sports = ((m && m.sports) || []).map(s => ({ code: s.code, season: s.season }));
  }
  const wanted = args.sport
    ? sports.filter(s => s.code === args.sport)
      .concat(sports.some(s => s.code === args.sport) ? [] : [{ code: args.sport, season: args.season }])
    : sports;
  if (!wanted.length) { log('no sports to sync'); return 0; }

  let addedGames = 0, addedTeams = 0, movedGames = 0, problems = 0;
  const now = Date.now();

  for (const sp of wanted) {
    const sport = sp.code;
    if (!ESPN_PATH[sport]) { log(`${sport}: no schedule source for this sport, skipping`); continue; }
    const season = args.season || sp.season || new Date().getFullYear();

    /* What the Collective holds, and which week is current. Directly: the
       whole season, so Current is the rule itself and not a scan. */
    let held = null, roster = null, start;
    if (db) {
      try {
        held = await loadSeason(db, schema, sport, season);
        roster = await loadRoster(db, sport);
      } catch (e) {
        log(`${sport} ${season}: the season could not be read directly (${e.message}); reading the public feed.`);
        held = null; roster = null;
      }
    }
    if (held) {
      const cur = MCWeek.resolveCurrentWeek(held, now);
      start = args.week || (cur == null ? 1 : cur);
      log(`${sport} ${season}: Collective holds ${held.length} game(s) over week(s) ` +
        `${MCWeek.weekNumbers(held).join(',') || '-'}; Current is week ${cur == null ? '- (none scheduled)' : cur}`);
    } else {
      start = args.week || await currentWeek(sport, season, token);
    }
    const weeks = args.week ? [args.week] : Array.from({ length: args.weeks }, (_, i) => start + i);

    for (const week of weeks) {
      if (!espnAddress(sport, week)) {
        log(`${sport} ${season} w${week}: no ESPN address for this round -- ` +
          'add it to ESPN_SEASON before expecting it to load.');
        continue;
      }
      let feed;
      try { feed = await espnWeek(sport, season, week); }
      catch (e) { log(`${sport} ${season} w${week}: source failed -- ${e.message}`); problems++; continue; }
      if (!feed.length) { log(`${sport} ${season} w${week}: source carried no games`); continue; }

      const scope = held || await collectiveWeek(sport, season, week, token).catch(() => []);
      const refs = !!(schema && (schema.games || []).indexOf('external_ref') >= 0);
      const plan = planWeek(scope, feed, week, { now, refs });
      const inBucket = held ? held.filter(g => MCWeek.weekOf(g) === Number(week)).length : scope.length;
      log(`${sport} ${season} w${week}: ESPN ${feed.length}, Collective ${inBucket}, ` +
        `missing ${plan.inserts.length}, changed ${plan.updates.length}, unchanged ${plan.unchanged}` +
        (plan.duplicates.length ? `, HELD TWICE ${plan.duplicates.length}` : '') +
        (plan.notInFeed.length ? `, not in the feed ${plan.notInFeed.length}` : ''));

      plan.updates.slice(0, 20).forEach(u => log(
        `  ~ ${u.feed.away_team} @ ${u.feed.home_team}  [${u.how}]  ` +
        Object.keys(u.patch).map(k => `${k}: ${u.game[k] == null ? '-' : u.game[k]} -> ${u.patch[k]}`).join(', ')));
      plan.inserts.slice(0, 20).forEach(r => log(`  + ${r.away_team} @ ${r.home_team}  ${r.start_date}  w${r.week}`));
      if (plan.inserts.length > 20) log(`  + and ${plan.inserts.length - 20} more`);
      plan.duplicates.slice(0, 10).forEach(d => log(
        `  = DUPLICATE ${d.game.away} @ ${d.game.home} (w${d.game.week}, ${d.game.game_id}) is the same fixture as ` +
        `${d.of.game_id} (w${d.of.week}); not deleted -- resolve it by hand`));
      plan.notInFeed.slice(0, 10).forEach(g => log(
        `  ? ${g.away} @ ${g.home} (w${g.week}, ${g.game_id}) is held but the feed does not carry it`));

      if (!args.commit) continue;

      if (plan.updates.length) {
        if (!db) {
          log('  changed: no service credential in this run (EDGD_SB_SERVICE / EDGD_SB_URL), ' +
            'so the changes above are reported and not written.');
        } else {
          try {
            const r = await applyUpdates(db, schema, plan.updates);
            movedGames += r.updated;
            log(`  changed: ${r.updated} updated, ${r.refused.length} refused`);
            r.refused.slice(0, 5).forEach(f => log(`    ! ${f.game_id}: ${f.detail}`));
            r.skipped.slice(0, 5).forEach(f => log(`    ! ${f.game_id}: no such column(s): ${f.columns.join(', ')}`));
            if (r.refused.length) problems++;
          } catch (e) { log(`  changed: ${e.message}`); problems++; }
        }
      }

      if (!plan.inserts.length) continue;

      if (db && held && roster) {
        /* Teams first: a game cannot reference a team the database has
           never been given. Then the games, with the provider's id, then a
           best-effort re-resolve so a slate quarantined for want of these
           games attaches now rather than on its next post. */
        const t = await ensureTeams(db, schema, sport, plan.inserts, roster, true);
        addedTeams += t.created;
        if (t.created || t.failed.length) log(`  teams: ${t.created} created, ${t.failed.length} refused`);
        t.failed.slice(0, 5).forEach(f => log(`    ! ${f.name}: ${f.message}`));
        const g = await insertGames(db, schema, sport, season, plan.inserts, t.ids);
        addedGames += g.inserted.length;
        log(`  games: ${g.inserted.length} loaded, ${g.refused.length} refused`);
        g.refused.slice(0, 5).forEach(f => log(`    ! ${f.label ? f.label + ': ' : ''}${f.detail}`));
        if (g.refused.length) problems++;
        /* the season in hand now holds them, so the next week's plan -- and
           a second run inside the same process -- cannot load them again */
        g.inserted.forEach(row => {
          const f = plan.inserts.find(x => refOf(x) && row.external_ref === refOf(x)) ||
            plan.inserts.find(x => x.start_date === row.kickoff_at) || null;
          held.push({ game_id: row.id, week: row.week, kickoff_at: row.kickoff_at, status: row.status || 'scheduled',
            home: f ? f.home_team : '', away: f ? f.away_team : '', result: null, external_ref: row.external_ref || null });
        });
        if (g.inserted.length) {
          try { const rr = await db.rpc('admin_reresolve', { p_sport: sport }); if (rr && rr.resolved) log(`  re-resolved ${rr.resolved} quarantined projection(s)`); }
          catch (e) { log(`  (admin_reresolve not run: ${e.message.slice(0, 120)})`); }
        }
        continue;
      }

      if (!token) { log('  games: no credential to load them with; reported only.'); continue; }
      const names = teamsNeeded(plan.inserts);
      if (names.length) {
        try {
          const r = await postTeams(sport, names, token);
          addedTeams += (r && r.created) || 0;
          log(`  teams: ${(r && r.created) || 0} created, ${((r && r.failed) || []).length} refused`);
          ((r && r.failed) || []).slice(0, 5).forEach(f => log(`    ! ${f.name}: ${f.message}`));
        } catch (e) {
          if (e.status === 404) {
            log('  teams: this backend has no POST /v1/admin/teams yet -- deploy the ' +
              'updated collective_admin, or games whose teams are unknown will be refused.');
          } else { log(`  teams: ${e.message}`); problems++; }
        }
      }
      try {
        const r = await postGames(sport, season, gamePayload(plan.inserts, week), token);
        addedGames += (r && r.upserted) || 0;
        log(`  games: ${(r && r.upserted) || 0} loaded, ${((r && r.failed) || []).length} refused`);
        ((r && r.failed) || []).slice(0, 5).forEach(f => log(`    ! ${JSON.stringify(f).slice(0, 160)}`));
      } catch (e) { log(`  games: ${e.message}`); problems++; }
    }
  }

  if (!args.commit) {
    log('Dry run. Nothing was written. Re-run with --commit.');
  } else {
    log(`Done: ${addedTeams} team(s) added, ${addedGames} game(s) added, ${movedGames} game(s) updated in place.`);
  }
  return problems ? 1 : 0;
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => {
    console.error(`[schedule] ${e.message}`);
    process.exit(1);
  });
}
