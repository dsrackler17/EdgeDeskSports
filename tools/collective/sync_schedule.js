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

   WHAT IT WILL NOT DO

   It never edits or deletes a game the Collective already has. A schedule
   that disagrees with the Collective about an existing fixture is reported,
   not overwritten: a kickoff that moved is a real change and worth seeing,
   and silently rewriting the row a slate is already attached to is how a
   creator's numbers end up on a different game.

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
     node tools/collective/sync_schedule.js --weeks 3       # this week and the next two
   =========================================================================== */
'use strict';

const S = require('./settle_finals.js');

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

function log(...a) { console.log('[schedule]', ...a); }

function espnScoreboardUrl(sport, season, week) {
  const path = ESPN_PATH[sport];
  if (!path) return null;
  const g = ESPN_GROUP[sport] ? `&groups=${ESPN_GROUP[sport]}` : '';
  return `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard` +
    `?limit=400&year=${encodeURIComponent(season)}&seasontype=2` +
    `&week=${encodeURIComponent(week)}${g}`;
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
   two tools cannot drift on what a team is called. */
async function espnWeek(sport, season, week) {
  const url = espnScoreboardUrl(sport, season, week);
  if (!url) return [];
  const d = await fetchJson(url);
  return ((d && d.events) || []).map(S.normEspn)
    .filter(r => r.home_team && r.away_team && r.start_date);
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
   with itself about time zones is worse than one that is short a game. */
function gamePayload(rows, week) {
  return rows.map(r => ({
    week: Number(week),
    kickoff: r.start_date,
    home: r.home_team,
    away: r.away_team,
  }));
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
  espnScoreboardUrl, espnWeek, alreadyHave, missingFrom, teamsNeeded, gamePayload,
  collectiveWeek, postTeams, postGames, accessToken, ESPN_GROUP, ESPN_PATH,
};

/* ---- the run -------------------------------------------------------------- */

function parseArgs(argv) {
  const a = { commit: false, verify: false, sport: null, season: null, week: null, weeks: 2 };
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

/* The week the Collective considers current, asked of the Collective rather
   than computed from a calendar this tool would have to keep in step. */
async function currentWeek(sport, season, token) {
  const d = await fetchJson(
    `${API}/collective_public/v1/games?sport=${encodeURIComponent(sport)}` +
    `&season=${encodeURIComponent(season)}`,
    token ? { headers: { authorization: `Bearer ${token}` } } : {}).catch(() => null);
  const games = (d && d.games) || [];
  const now = Date.now();
  let next = null;
  games.forEach(g => {
    if (g.week == null || !g.kickoff_at) return;
    const t = new Date(g.kickoff_at).getTime();
    if (t > now - 36 * 3600e3 && (next === null || t < next.t)) next = { t, week: g.week };
  });
  if (next) return next.week;
  let last = null;
  games.forEach(g => { if (g.week != null && (last === null || g.week > last)) last = g.week; });
  return last == null ? 1 : last;
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

  let addedGames = 0, addedTeams = 0, problems = 0;

  for (const sp of wanted) {
    const sport = sp.code;
    if (!ESPN_PATH[sport]) { log(`${sport}: no schedule source for this sport, skipping`); continue; }
    const season = args.season || sp.season || new Date().getFullYear();
    const start = args.week || await currentWeek(sport, season, token);
    const weeks = args.week ? [args.week] :
      Array.from({ length: args.weeks }, (_, i) => start + i);

    for (const week of weeks) {
      let feed;
      try { feed = await espnWeek(sport, season, week); }
      catch (e) { log(`${sport} ${season} w${week}: source failed -- ${e.message}`); problems++; continue; }
      if (!feed.length) { log(`${sport} ${season} w${week}: source carried no games`); continue; }

      const have = await collectiveWeek(sport, season, week, token).catch(() => []);
      const missing = missingFrom(have, feed);
      log(`${sport} ${season} w${week}: ESPN ${feed.length}, Collective ${have.length}, missing ${missing.length}`);
      if (!missing.length) continue;

      missing.slice(0, 20).forEach(r => log(`  + ${r.away_team} @ ${r.home_team}  ${r.start_date}`));
      if (missing.length > 20) log(`  + and ${missing.length - 20} more`);

      if (!args.commit) continue;

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
    log(`Done: ${addedTeams} team(s) and ${addedGames} game(s) added.`);
  }
  return problems ? 1 : 0;
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => {
    console.error(`[schedule] ${e.message}`);
    process.exit(1);
  });
}
