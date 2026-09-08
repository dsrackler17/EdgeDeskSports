#!/usr/bin/env node
/* ===========================================================================
   Keep the Collective's schedule complete, by itself, every day.

   THE PROBLEM THIS EXISTS FOR

   A creator uploaded a correct thirty-game college slate and ten of it
   quarantined, every week, forever. Not because anything in the file was
   wrong -- because the backend's week had 49 games in it and the real week
   had 59. Ten fixtures had never been ingested, so ten rows had no game to
   attach to, and the only cure was a human noticing and loading them by hand.

   Every one of the ten was an FBS team hosting an opponent from outside the
   set the schedule feed carried. That is not an exotic case: it is most of
   week one, every year, in college football.

   So this closes the loop. It reads the real schedule from ESPN, compares it
   against what the Collective holds for the same sport, season and week, and
   loads whatever is missing -- teams first, because a game cannot reference a
   team the backend has never been given, then the games themselves.

   WHAT IT DOES TO A GAME IT ALREADY HAS

   Two columns, and no others: kickoff_at and status. A kickoff that moves is
   the most ordinary schedule change there is -- a Saturday game shifted to
   Friday night, a noon start moved to 3:30 for television -- and a stale one
   locks submissions at the wrong minute and sorts the slate wrong. So the
   fixture is updated IN PLACE, keeping its id and therefore every projection,
   captured price and snapshot already attached to it. It is never re-loaded,
   which is the only way a moved kickoff could become a second copy of the
   same game.

   WHAT IT WILL NOT DO

   It never deletes anything, and it never touches a settled game. A game with
   a final is history: no kickoff, no status, and -- because this code path
   does not name a score, a closing line or a grade anywhere -- nothing else
   either. A feed that changes its mind about a played game changes nothing
   here. UPDATE_COLS is the entire write set and the suite holds it.

   It writes nothing without --commit. The default run says what it would do.

   CREDENTIALS (the same ones settle_finals.js uses, deliberately)

     COLLECTIVE_ADMIN_REFRESH_TOKEN  a Supabase refresh token for an account
                                     on admin.user_ids. Preferred: it outlives
                                     a run and rotates itself.
     COLLECTIVE_ADMIN_ACCESS_TOKEN   a short-lived access token, for a manual
                                     invocation.

   USAGE

     node tools/collective/sync_schedule.js                 # dry run, says what is missing
     node tools/collective/sync_schedule.js --verify        # prove ESPN answers, no credential needed
     node tools/collective/sync_schedule.js --commit        # actually load
     node tools/collective/sync_schedule.js --sport CFB --season 2026 --week 1
     node tools/collective/sync_schedule.js --weeks 4       # this week and the next three

   It is SAFE TO RUN REPEATEDLY, and meant to be: a fixture already held is
   not offered again (alreadyHave knows the Collective clips its team names),
   and a fixture whose facts already agree produces no write. A day on which
   nothing changed costs one request per week looked at and writes nothing.
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
  /* Week 0 is a real college football week and ESPN carries it as season type
     2 week 0, the same as every other regular-season week. Nothing special is
     needed for it and nothing special may be invented for it. */
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
  return `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard` +
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
  return (d && d.games) || [];
}

/* Is this ESPN fixture already on the Collective's board?

   Both sides, by the settler's team matcher, which already understands that
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

function missingFrom(collectiveGames, feedRows) {
  return feedRows.filter(f => !collectiveGames.some(g => alreadyHave(g, f)));
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
   This job used to load missing games and REPORT everything else, on the
   principle that silently rewriting a row a creator's slate is attached to is
   how numbers end up on the wrong game. The principle is right and the blanket
   was too wide: a kickoff that moves is the single most common schedule change
   there is -- a Saturday game shifted to Friday night, a noon start moved to
   3:30 for television -- and leaving it stale means the board locks
   submissions at the wrong minute, orders the slate wrong, and calls a game
   live that has not started.

   So the sync updates a fixture in place, and the write set is EXACTLY these
   two columns. It cannot touch a score, a closing line or a grade, because it
   never names one: a settled week's facts are not reachable from this code
   path even if the feed changes its mind about them.

   Nothing settled is touched at all. A game with a final -- or one the
   Collective has marked final -- is history, and history does not move. */
const UPDATE_COLS = ['kickoff_at', 'status'];

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
   null. Only ever the two columns above. */
function drift(game, feed) {
  if (settledAlready(game)) return null;
  const patch = {};
  if (kickoffMoved(game.kickoff_at, feed.start_date)) patch.kickoff_at = feed.start_date;
  const st = statusFromFeed(feed);
  if (st && String(game.status || '').toLowerCase() !== st) patch.status = st;
  return Object.keys(patch).length ? patch : null;
}

/* Every game the Collective holds for this week that the feed now states
   differently. Paired with the feed row so a log line can say what moved. */
function updatesFor(collectiveGames, feedRows) {
  const out = [];
  (collectiveGames || []).forEach(g => {
    const feed = (feedRows || []).filter(f => alreadyHave(g, f))[0];
    if (!feed) return;
    const patch = drift(g, feed);
    if (patch) out.push({ game: g, feed, patch });
  });
  return out;
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
      out.updated++;
    } catch (e) {
      out.refused.push({ game_id: u.game.game_id, detail: e.message });
    }
  }
  return out;
}

/* ---- writing -------------------------------------------------------------- */

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
  alreadyHave, missingFrom, teamsNeeded, gamePayload,
  statusFromFeed, settledAlready, kickoffMoved, drift, updatesFor, applyUpdates,
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
   calendar this tool would have to keep in step with it.

   This mattered directly. The old copy of the rule lived here and had the
   same 36-hour-lookback defect the server did: one Monday night game kept it
   on the finished week, so a daily run that loads "this week and the next"
   was loading the week that was over and the week being played, and never the
   week after. The week a creator was about to post for was the one the sync
   was not looking at. */
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
        else log(`  e.g. ${rows[0].away_team} @ ${rows[0].home_team} ${rows[0].start_date}`);
      } catch (e) { bad++; log(`${sport}: SOURCE FAILED -- ${e.message}`); }
    }
    return bad ? 1 : 0;
  }

  let token = null;
  try { token = await accessToken(); }
  catch (e) {
    if (args.commit) { log(e.message); return 1; }
    log(`no admin credential (${e.message}) -- reading what is public and reporting only.`);
  }

  const m = await meta().catch(() => null);
  const sports = (m && m.sports) || [];
  const wanted = args.sport
    ? sports.filter(s => s.code === args.sport)
      .concat(sports.some(s => s.code === args.sport) ? [] : [{ code: args.sport, season: args.season }])
    : sports;
  if (!wanted.length) { log('no sports to sync'); return 0; }

  let addedGames = 0, addedTeams = 0, movedGames = 0, problems = 0;

  /* The door a MOVED fixture is written through: the service role this
     repository already holds for its other jobs, the same one settle_finals
     uses. Absent is not an error -- the run then reports what moved instead of
     writing it, which is exactly what this job did before it could update at
     all. The table shape is read once, here, and only columns that exist are
     ever written. */
  let db = null, schema = null;
  const direct = S.directConfig(process.env);
  if (direct && args.commit) {
    try {
      db = S.dbClient(direct);
      schema = await db.schema();
    } catch (e) {
      db = null; schema = null;
      log(`no direct database access (${e.message}) -- moved kickoffs will be reported, not written.`);
    }
  }

  for (const sp of wanted) {
    const sport = sp.code;
    if (!ESPN_PATH[sport]) { log(`${sport}: no schedule source for this sport, skipping`); continue; }
    const season = args.season || sp.season || new Date().getFullYear();
    const start = args.week || await currentWeek(sport, season, token);
    const weeks = args.week ? [args.week] :
      Array.from({ length: args.weeks }, (_, i) => start + i);

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

      const have = await collectiveWeek(sport, season, week, token).catch(() => []);
      const missing = missingFrom(have, feed);
      /* A fixture the Collective already holds that the feed now states
         differently: a kickoff moved for television, a game postponed, a game
         canceled. It is the SAME game -- same id, same projections, same
         captured prices -- so it is updated in place and never re-loaded. */
      const moved = updatesFor(have, feed);
      log(`${sport} ${season} w${week}: ESPN ${feed.length}, Collective ${have.length}, ` +
        `missing ${missing.length}, changed ${moved.length}`);

      moved.slice(0, 20).forEach(u => log(
        `  ~ ${u.feed.away_team} @ ${u.feed.home_team}  ` +
        Object.keys(u.patch).map(k => `${k}: ${u.game[k] == null ? '-' : u.game[k]} -> ${u.patch[k]}`).join(', ')));
      missing.slice(0, 20).forEach(r => log(`  + ${r.away_team} @ ${r.home_team}  ${r.start_date}  w${r.week}`));
      if (missing.length > 20) log(`  + and ${missing.length - 20} more`);

      if (!args.commit) continue;

      if (moved.length) {
        if (!db) {
          log('  changed: no service credential in this run (EDGD_SB_SERVICE / EDGD_SB_URL), ' +
            'so the changes above are reported and not written.');
        } else {
          try {
            const r = await applyUpdates(db, schema, moved);
            movedGames += r.updated;
            log(`  changed: ${r.updated} updated, ${r.refused.length} refused`);
            r.refused.slice(0, 5).forEach(f => log(`    ! ${f.game_id}: ${f.detail}`));
            r.skipped.slice(0, 5).forEach(f => log(`    ! ${f.game_id}: no such column(s): ${f.columns.join(', ')}`));
            if (r.refused.length) problems++;
          } catch (e) { log(`  changed: ${e.message}`); problems++; }
        }
      }

      if (!missing.length) continue;

      /* Teams first: a game cannot reference a team the backend has never
         been given, and a batch that skips this comes straight back as
         unknown_team_away with nothing loaded. */
      const names = teamsNeeded(missing);
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
        const r = await postGames(sport, season, gamePayload(missing, week), token);
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
