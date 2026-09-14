#!/usr/bin/env node
/* ============================================================================
   EdgeDesk Model Collective — SETTLE FINISHED GAMES, AUTOMATICALLY.

   A game ended and the board still showed it as pending, because settling was
   a person opening collective/admin.html and typing two scores into a row.
   That is fine for one game and hopeless for a Saturday: nothing grades, no
   record moves, and every creator's wall sits stale until somebody has time.

   This is that same settle, run on a schedule. It does exactly what the admin
   screen does and nothing more:

     1. ask the Collective which of its own past games have no result yet
        (GET collective_public /v1/games)
     2. look the final up in the SAME public, keyless feeds the rest of this
        repo already trusts — nflverse for NFL, cfbfastR for college
     3. offer the Collective's OWN captured closing line as the grading
        number (GET collective_odds /v1/<league>/closing/<game_id>), exactly
        as the admin screen's "Use captured close" button does -- and when
        that route cannot name the game, find its row on the odds board for
        the week and read the same stored close off that (see
        closesFromBoard: the Collective's schedule cuts team names to ten
        characters and the per-game route joins on that stored string, which
        is why a whole college season settled with close_source null)
     4. POST collective_admin /v1/admin/results

   --backfill-closes is the same close recovery run on its own, over the
   committed settlement record rather than over this week's games: it fills
   only the closes that are null, touches no score, team, week or kickoff,
   keeps settled_at, and is a no-op on a second run.

   THE RULES IT WILL NOT BREAK

   - A score is never invented, adjusted or inferred. If the feed does not
     carry a completed game with two integer scores, the game is skipped and
     said out loud. A wrong final grades every model on it, permanently.
   - A closing line is never invented either. If the Collective captured no
     close, the line fields are sent null: the game still settles on the
     score, and the record is graded against nothing this script made up.
   - Nothing is written without --commit. The default run reports what it
     WOULD settle, which is how you check a matcher you cannot see.
   - Only games already past kickoff and not yet settled are touched — plus
     a game settled 0-0, which is a results form posted with nothing typed
     in it rather than a settlement (no football game ends 0-0), and is the
     one result this will write over, with the real final. It never
     re-settles anything else, never overwrites, never deletes.

   HOW IT RUNS — three doors, tried in this order

     1. THE DATABASE ITSELF (preferred; how GitHub runs this by itself)
          EDGD_SB_SERVICE   the service-role key   (secrets.SB_SERVICE_ROLE)
          EDGD_SB_URL       the project URL        (secrets.SB_URL)
        The same credential and the same names the games workflows already
        use. The run reads the schedule off the game_detail view, writes the
        score and the close onto collective.games, and grades every counting
        projection on the game by the published rule, all over PostgREST —
        the door every edge function uses — with no edge function in the
        path and no token lifted out of a browser session. It reads the
        table shapes off the database first and writes only the columns
        that exist; anything it expected and did not find is named in the
        report as a schema gap, never guessed at.

     2. THE ADMIN FUNCTION (fallback)
          COLLECTIVE_ADMIN_REFRESH_TOKEN  a Supabase refresh token for an
                                          allowlisted admin account
          COLLECTIVE_ADMIN_ACCESS_TOKEN   a short-lived access token
        POST collective_admin /v1/admin/results, exactly as the admin screen
        does. Only used when no service credential is present.

     3. THE COMMITTED RECORD (always, with --record <dir>)
        Whatever the run settled, and every game the Collective already
        holds a real final for, is written to <dir>/<SPORT>_<season>.json —
        final score, the Collective's captured close, which feeds agreed —
        and the workflow commits it. collective/index.html reads that file
        from its own origin, so the site grades every finished game from the
        Collective's own settlement whether or not any function was deployed,
        reachable or written to. No credential is needed for this door.

     SUPABASE_ANON_KEY               optional; the public key the site ships

   Usage
     node tools/collective/settle_finals.js                 # dry run, all sports
     node tools/collective/settle_finals.js --commit        # actually settle
     node tools/collective/settle_finals.js --sport CFB --season 2026
     node tools/collective/settle_finals.js --json          # machine readable
     node tools/collective/settle_finals.js --commit --record collective/settled

   Exit  0 = ran, nothing failed   2 = one or more settles were rejected
         1 = could not run at all (no auth, no network, no games endpoint)
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const API = (process.env.COLLECTIVE_API || 'https://iattxbkbufslbauoumga.supabase.co/functions/v1').replace(/\/$/, '');
const SB_URL = process.env.EDGEDESK_SUPABASE_URL || 'https://iattxbkbufslbauoumga.supabase.co';
/* The same public-safe anon key collective/index.html already ships to every
   browser. Supabase's auth endpoint wants an apikey header even when the real
   credential is the refresh token. */
const ANON = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';

const URL_NFL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const URL_CFB = y => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${y}.csv`;

/* Which public feed carries finals for which Collective sport code. A sport
   missing here is reported and skipped -- never guessed at from another
   sport's schedule, which is how a college game gets an NFL score. */
const FEED = { NFL: 'nfl', CFB: 'cfb', 'CFB-P4': 'cfb', NCAAF: 'cfb' };
/* The odds feed's own league keys, matching collective_odds_ingest. */
const ODDS_LEAGUE = { NFL: 'nfl', CFB: 'ncaaf', 'CFB-P4': 'ncaaf', NCAAF: 'ncaaf' };

/* ---- pure helpers, all exported so the suite can drive them offline ----- */

/* The canonical team key. Deliberately the SAME rule as teamKey() in
   collective/index.html and normKey() in football/cfb_p4/engine.js: fold
   accents rather than strip them, so "San José State" and "San Jose State"
   are one team instead of two that can never match. */
function teamKey(s) {
  if (s == null) return '';
  let t = String(s).trim().toLowerCase();
  try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
  return t.replace(/[^a-z0-9]+/g, '');
}

/* The Collective's schedule stores team names cut to ten characters, so
   "North Carolina" comes back as "NORTHCAROL" and can never equal the feed's
   full spelling. Compare on the shorter of the two, with a floor of six
   characters so a truncation match cannot be a coincidence -- and only ever
   as a PREFIX, so "NORTHCAROL" matches "North Carolina" and not "North
   Carolina State", which shares nine of those characters but diverges after. */
function teamsAgree(a, b) {
  const x = teamKey(a), y = teamKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const n = Math.min(x.length, y.length);
  if (x.slice(0, n) !== y.slice(0, n)) return false;
  /* Six characters of agreement is the bar for spelled-out NAMES, where a
     shorter overlap is a coincidence ("Miami" and "Michigan" share nothing,
     but "North Caro..." and "North Texas" would on a looser rule). */
  if (n >= 6) return true;
  /* CODES are the other case, and they need their own rule: nflverse spells
     the Rams "LA" while the Collective's schedule says "LAR", so a Rams game
     matched nothing at all and would never have settled. This is the same
     collision the slate uploader hits between a file's team column and its
     pick column, and it takes the same answer: a short code may latch onto
     another CODE (four characters is the longest any of these sources use),
     never onto a spelled-out name. "LAR" still refuses "LAC", and "NE" still
     refuses "NO" — neither is a prefix of the other. */
  return n >= 2 && x.length <= 4 && y.length <= 4;
}

/* A feed row carries every spelling its source knows for a team -- ESPN alone
   gives location, displayName, shortDisplayName and abbreviation for the same
   school ("TCU", "TCU Horned Frogs", "Horned Frogs", "TCU"). The Collective
   stores exactly one, truncated. Agreeing on ANY of them is what makes the
   join work across sources that each spell teams their own way. */
function namesOf(row, side) {
  const list = row[side + '_names'];
  return (Array.isArray(list) && list.length ? list : [row[side + '_team']])
    .filter(Boolean);
}
function teamsAgreeAny(mine, candidates) {
  return (candidates || []).some(c => teamsAgree(mine, c));
}

/* Both sides, in one call, so a row is only ever matched as a GAME. Matching
   a single team is how a slate lands on the wrong game when a team plays
   twice in a window. */
function gameMatches(collectiveGame, feedRow) {
  return teamsAgreeAny(collectiveGame.home, namesOf(feedRow, 'home')) &&
         teamsAgreeAny(collectiveGame.away, namesOf(feedRow, 'away'));
}

function ymd(v) {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/* Kickoffs are stored in UTC and the feeds publish a local date, so a night
   game is legitimately one calendar day apart between the two. One day of
   slack either way, and no more: two days would let a Thursday game claim a
   Saturday rematch's score. */
function datesAgree(isoA, isoB, slackDays = 1) {
  const a = ymd(isoA), b = ymd(isoB);
  if (!a || !b) return false;
  const diff = Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z'));
  return diff <= slackDays * 86400000;
}

function isFinalScore(v) {
  if (v === null || v === undefined || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 200;
}
/* Two zeros are never a final. A feed row that is "completed" at 0-0 is a
   postponed or canceled game, or a placeholder the source never filled, and
   settling it graded every model on the game against a score nobody
   scored. The same rule the Collective's own pages read results by. */
function isPlaceholderResult(r) {
  if (!r || r.home_score === null || r.home_score === undefined ||
      r.away_score === null || r.away_score === undefined) return false;
  return Number(r.home_score) === 0 && Number(r.away_score) === 0;
}

/* Every distinct team the feed knows, by key. Built once per feed so the
   ambiguity check below costs nothing per game. */
function feedTeamKeys(feedRows) {
  const set = new Set();
  (feedRows || []).forEach(r => {
    namesOf(r, 'home').forEach(n => set.add(teamKey(n)));
    namesOf(r, 'away').forEach(n => set.add(teamKey(n)));
  });
  set.delete('');
  return set;
}

/* Does this ten-character name denote more than one school in the feed?
 *
 * The Collective's schedule cuts team names to ten characters, so "North
 * Carolina" arrives as "NORTHCAROL" -- and against the real cfbfastR feed
 * that string is also the truncation of North Carolina Central and North
 * Carolina A&T. "WASHINGTON" is both a whole name and the truncation of
 * Washington State. So a truncated name, ON ITS OWN, is frequently
 * ambiguous, and refusing every one of them would skip most of a Saturday.
 *
 * It is not used to refuse. It is used to LABEL: a game matched through a
 * truncation whose name could mean several schools is settled on the pair,
 * as below, and reported so a human can audit it. Refusing happens on the
 * pair, where the evidence actually is. */
function truncationIsAmbiguous(name, keys) {
  const k = teamKey(name);
  if (!k) return true;
  let n = 0;
  for (const other of keys) {
    if (other === k) { n++; }
    else if (k.length >= 6 && other.length > k.length && other.slice(0, k.length) === k) { n++; }
    else if (other.length >= 6 && k.length > other.length && k.slice(0, other.length) === other) { n++; }
    if (n > 1) return true;
  }
  return false;
}

/* THE decision, made on the GAME rather than on either team -- the same rule
 * this repo already had to learn once for Washington vs Washington State.
 *
 * An exact match on BOTH sides is tried first and wins outright: it involves
 * no guessing at a truncation at all. Only when nothing matches exactly is a
 * truncated match considered, and either way the row must be unique for the
 * date. Two rows that both look like this game means the matcher does not
 * know which, and settling on a coin flip grades every model on the game
 * against a score that may belong to a different one.
 */
function findFinal(game, feedRows, keys) {
  const dated = (feedRows || []).filter(r => datesAgree(game.kickoff_at, r.start_date));
  const eqAny = (mine, cands) => {
    const k = teamKey(mine);
    return !!k && (cands || []).some(c => teamKey(c) === k);
  };
  const exact = dated.filter(r =>
    eqAny(game.home, namesOf(r, 'home')) && eqAny(game.away, namesOf(r, 'away')));
  const loose = dated.filter(r => gameMatches(game, r));

  let row = null, how = 'exact';
  if (exact.length === 1) { row = exact[0]; }
  else if (exact.length > 1) {
    return { ok: false, reason: 'ambiguous_feed_rows', candidates: exact.length };
  } else if (loose.length === 1) { row = loose[0]; how = 'truncated'; }
  else {
    return { ok: false, reason: loose.length === 0 ? 'no_feed_row' : 'ambiguous_feed_rows', candidates: loose.length };
  }

  if (!row.completed) return { ok: false, reason: 'not_final_in_feed' };
  if (!isFinalScore(row.home_points) || !isFinalScore(row.away_points)) {
    return { ok: false, reason: 'feed_row_has_no_score' };
  }
  if (Number(row.home_points) === 0 && Number(row.away_points) === 0) {
    return { ok: false, reason: 'zero_zero_placeholder' };
  }
  /* Named, not hidden -- but only where a confusion was actually POSSIBLE.
     Flagging every truncated name that could denote several schools flags
     39% of a real season, which is noise nobody reads. A join is worth a
     human's attention when one of the OTHER schools the name could mean was
     also playing that day: that is the near miss. */
  const teamKeys = keys || feedTeamKeys(feedRows);
  const sameDayKeys = new Set();
  dated.forEach(r => {
    namesOf(r, 'home').forEach(n => sameDayKeys.add(teamKey(n)));
    namesOf(r, 'away').forEach(n => sameDayKeys.add(teamKey(n)));
  });
  const rival = (mine, matched) => {
    const k = teamKey(mine), mk = teamKey(matched);
    if (!k || k === mk) return false;      /* exact -- no truncation was guessed */
    for (const other of sameDayKeys) {
      /* Another school the SAME stored string could equally have denoted,
         playing the same day. That is the only shape in which this join
         could have picked the wrong one. */
      if (other !== mk && other.length >= k.length && other.slice(0, k.length) === k) return true;
    }
    return false;
  };
  const review = how === 'truncated' &&
    (rival(game.home, row.home_team) || rival(game.away, row.away_team));
  return {
    ok: true,
    home_score: Number(row.home_points), away_score: Number(row.away_points),
    matched_by: how, needs_review: !!review,
    joined: `${game.away} @ ${game.home}  ->  ${row.away_team} @ ${row.home_team}`,
    source_row: row,
  };
}

/* The body the admin screen posts, built from the same pieces. A close the
   Collective never captured is sent as null -- the API's own shape for "there
   is no number here" -- and never as the model's guess or the feed's. */
function settleBody(game, final, close) {
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
  return {
    game_id: game.game_id,
    home_score: final.home_score,
    away_score: final.away_score,
    closing_spread: close ? num(close.closing_spread) : null,
    closing_total: close ? num(close.closing_total) : null,
    closing_home_ml_prob: close ? num(close.closing_home_ml_prob) : null,
  };
}

/* ---- CSV, the same minimal reader the rest of the repo uses ------------- */
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h).trim());
  return rows.slice(1)
    .filter(r => r.some(c => String(c).trim() !== ''))
    .map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
}

/* ---- the two feeds, normalised to one row shape ------------------------- */
const TRUEISH = v => String(v).trim().toUpperCase() === 'TRUE' || String(v).trim() === '1';

function normNfl(r) {
  return {
    start_date: r.gameday || r.game_date || '',
    home_team: r.home_team, away_team: r.away_team,
    home_points: r.home_score, away_points: r.away_score,
    /* nflverse marks a played game by carrying both scores; there is no
       completed flag, and an unplayed row has them empty. */
    completed: isFinalScore(r.home_score) && isFinalScore(r.away_score),
    season: r.season, week: r.week, source: 'nflverse',
  };
}
function normCfb(r) {
  return {
    start_date: r.start_date || '',
    home_team: r.home_team, away_team: r.away_team,
    home_points: r.home_points, away_points: r.away_points,
    completed: TRUEISH(r.completed),
    season: r.season, week: r.week, source: 'cfbfastR',
  };
}

/* ESPN's public scoreboard: the LIVE source, and the only one of these that
   carries a game minutes after it ends.
 *
 * The season CSVs below are how this repo already reads football, and they
 * are excellent for a finished week and useless for a finished GAME:
 * cfbfastR had published no 2026 file at all while the 2026 college season
 * was under way, so a board waiting on it would never have graded a single
 * Saturday. nflverse carries 2026 but fills scores on its own cadence.
 *
 * ESPN is keyless, public, per-day, and already trusted elsewhere in this
 * repo (football/rosters/fetch_rosters.js reads the same API for rosters).
 * A search engine would be the wrong instrument here: no stable contract, no
 * completed flag, and a score parsed out of rendered HTML is exactly the kind
 * of number that must never grade a model's record.
 *
 * Every spelling ESPN knows is carried through, because the Collective stores
 * one truncated name and the join has to survive that. */
/* ESPN's own word on whether a game was played to the end. Only the
   `completed` flag counts. State "post" used to be accepted as
   corroboration, but a postponed or canceled game also sits in state
   "post" — the date is behind us, the game just never happened — with
   completed:false and both scores "0", so reading the state settled a game
   that was never played, 0-0. A status that says the game was not played
   is refused by name as well, whatever the flag. */
function espnCompleted(st) {
  if (!st || st.completed !== true) return false;
  return !/POSTPONED|CANCEL|SUSPEND|FORFEIT/i.test(String(st.name || ''));
}
function normEspn(ev) {
  const comp = (ev && ev.competitions && ev.competitions[0]) || {};
  const st = (comp.status && comp.status.type) || {};
  const sideOf = ha => (comp.competitors || []).find(c => c.homeAway === ha) || {};
  const home = sideOf('home'), away = sideOf('away');
  const names = c => {
    const t = c.team || {};
    return [t.location, t.displayName, t.shortDisplayName, t.abbreviation, t.name,
            t.nickname, t.slug].filter(Boolean).map(String);
  };
  const score = c => (c.score === undefined || c.score === null || c.score === '')
    ? '' : String(c.score);
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)))
    ? null : Number(v);
  return {
    start_date: ev.date || comp.date || '',
    home_team: (home.team && (home.team.location || home.team.displayName)) || '',
    away_team: (away.team && (away.team.location || away.team.displayName)) || '',
    home_names: names(home), away_names: names(away),
    home_points: score(home), away_points: score(away),
    /* ESPN says so itself, and only the flag counts: see espnCompleted.
       Nothing is inferred from the clock or the score. */
    completed: espnCompleted(st),
    espn_status: st.name || st.description || '',
    /* THE PROVIDER'S OWN IDENTITY AND ADDRESS FOR THIS FIXTURE.

       The id is stable across a kickoff moving, a network changing and a
       postponement, which is exactly what matching on two team names and a
       date is not. Nothing keys on it yet -- the Collective's own game ids
       are what its projections hang off, and those never move -- but a
       schedule sync that has it can tell "this fixture moved" from "this is
       a different fixture", and that is the difference between updating a
       game and duplicating it.

       The week and season type are the AUTHORITATIVE schedule address: what
       ESPN itself calls this game's week. Every week number the Collective
       stores comes from here, so no part of this repository ever has to
       compute one from a date -- which is the only way Week 0, a Tuesday
       game in November, a conference championship and a playoff round can
       all be right. Absent on some payload shapes, hence null rather than a
       guess; the caller falls back to the bucket it asked for. */
    espn_id: ev && ev.id != null ? String(ev.id) : null,
    espn_week: num(ev && ev.week && ev.week.number),
    espn_season_type: num((ev && ev.season && ev.season.type) ||
      (comp.season && comp.season.type)),
    source: 'espn',
  };
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return await res.text();
}

/* ---- the source chain -------------------------------------------------- */
/* Tried in order, and it heals itself: a source that is unreachable, that has
   not published the season, or that simply does not carry this game is
   skipped and the next one answers. cfbfastR publishing no 2026 file is not
   an outage to wait out -- it is a Tuesday, and the board still has to grade.

   Every source that DOES carry the game is kept, because two sources that
   disagree about a final is the one case where settling would be worse than
   waiting. */
const ESPN_PATH = { nfl: 'football/nfl', cfb: 'football/college-football' };
function espnUrl(kind, yyyymmdd) {
  const groups = kind === 'cfb' ? '&groups=80' : '';
  return `https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[kind]}/scoreboard` +
    `?dates=${yyyymmdd}&limit=400${groups}`;
}
function compactDate(iso) { return ymd(iso).replace(/-/g, ''); }

const CACHE = new Map();
async function cached(key, fn) {
  if (CACHE.has(key)) return CACHE.get(key);
  const v = await fn();
  CACHE.set(key, v);
  return v;
}

/* ESPN, one call per calendar day the slate actually touches -- a Saturday
   board asks for one day, not a season. Failures are returned, never thrown:
   a dead source must not take the run down with it. */
async function espnRows(kind, dates, notes) {
  const out = [];
  for (const d of dates) {
    if (!d) continue;
    try {
      const txt = await cached(`espn:${kind}:${d}`, () => fetchText(espnUrl(kind, d)));
      const j = JSON.parse(txt);
      const rows = (j.events || []).map(normEspn);
      out.push(...rows);
      notes.push({ source: 'espn', date: d, events: rows.length,
        completed: rows.filter(r => r.completed).length });
    } catch (e) {
      notes.push({ source: 'espn', date: d, error: String(e.message).slice(0, 140) });
    }
  }
  return out;
}

async function csvRows(kind, season, notes) {
  try {
    if (kind === 'nfl') {
      const rows = parseCsv(await cached('nfl:all', () => fetchText(URL_NFL)))
        .filter(r => String(r.season) === String(season)).map(normNfl);
      notes.push({ source: 'nflverse', season, rows: rows.length,
        completed: rows.filter(r => r.completed).length });
      return rows;
    }
    const rows = parseCsv(await cached(`cfb:${season}`, () => fetchText(URL_CFB(season)))).map(normCfb);
    notes.push({ source: 'cfbfastR', season, rows: rows.length,
      completed: rows.filter(r => r.completed).length });
    return rows;
  } catch (e) {
    notes.push({ source: kind === 'nfl' ? 'nflverse' : 'cfbfastR', season,
      error: String(e.message).slice(0, 140) });
    return [];
  }
}

/* The repo's own mirror, the same fallback football/health/daily_check.js
   already uses when cfbfastR has not published a season. Read-only anon key,
   RLS select only -- the identical public key the site ships. */
async function mirrorRows(kind, season, notes) {
  if (kind !== 'cfb') return [];
  try {
    const url = `${SB_URL}/rest/v1/games?select=start_date,completed,home_team,home_points,` +
      `away_team,away_points,season,week&season=eq.${encodeURIComponent(season)}&limit=2000`;
    const res = await fetch(url, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()).map(r => ({
      start_date: r.start_date, home_team: r.home_team, away_team: r.away_team,
      home_points: r.home_points, away_points: r.away_points,
      completed: !!r.completed, season: r.season, week: r.week, source: 'cfb.games mirror',
    }));
    notes.push({ source: 'cfb.games mirror', season, rows: rows.length,
      completed: rows.filter(r => r.completed).length });
    return rows;
  } catch (e) {
    notes.push({ source: 'cfb.games mirror', season, error: String(e.message).slice(0, 140) });
    return [];
  }
}

/* Every source that answered, in preference order. */
async function allSources(kind, season, dates, notes) {
  const espn = await espnRows(kind, dates, notes);
  const csv = await csvRows(kind, season, notes);
  const mirror = (espn.length || csv.length) ? [] : await mirrorRows(kind, season, notes);
  return [
    { name: 'espn', rows: espn },
    { name: kind === 'nfl' ? 'nflverse' : 'cfbfastR', rows: csv },
    { name: 'cfb.games mirror', rows: mirror },
  ].filter(s => s.rows.length);
}

/* One game, every source that has it. Agreement is required, not assumed:
   the first source to answer does NOT get the last word when a second one
   contradicts it, because a contested final grades every model on the game
   against a number two feeds could not agree on. */
function findAcrossSources(game, sources) {
  const found = [];
  for (const src of sources) {
    const f = findFinal(game, src.rows);
    if (f.ok) found.push({ ...f, source: src.name });
    else found.push({ ok: false, reason: f.reason, source: src.name });
  }
  const hits = found.filter(f => f.ok);
  if (!hits.length) {
    const why = found.map(f => `${f.source}:${f.reason}`).join(', ');
    return { ok: false, reason: 'no_source_has_a_final', detail: why };
  }
  const disagree = hits.some(h =>
    h.home_score !== hits[0].home_score || h.away_score !== hits[0].away_score);
  if (disagree) {
    return { ok: false, reason: 'sources_disagree',
      detail: hits.map(h => `${h.source} ${h.away_score}-${h.home_score}`).join(' vs ') };
  }
  /* Prefer the exact-matched, most corroborated answer for its metadata. */
  const best = hits.find(h => h.matched_by === 'exact') || hits[0];
  return { ...best, agreed_by: hits.map(h => h.source), sources_checked: found.length };
}

/* ---- the Collective's own API ------------------------------------------ */

/* A refresh token outlives a run and rotates itself; an access token is a
   convenience for a manual invocation. Neither is ever logged. */
async function accessToken() {
  const direct = (process.env.COLLECTIVE_ADMIN_ACCESS_TOKEN || '').trim();
  if (direct) return direct;
  const refresh = (process.env.COLLECTIVE_ADMIN_REFRESH_TOKEN || '').trim();
  if (!refresh) {
    throw new Error('No admin credential. Set COLLECTIVE_ADMIN_REFRESH_TOKEN ' +
      '(preferred) or COLLECTIVE_ADMIN_ACCESS_TOKEN.');
  }
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'apikey': ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`refresh token rejected (${res.status}). Re-issue it from a ` +
      `signed-in admin session. ${body.slice(0, 200)}`);
  }
  const d = JSON.parse(body);
  if (!d.access_token) throw new Error('refresh succeeded but returned no access_token');
  /* A rotated refresh token is printed for the operator to store; the ACCESS
     token never is. */
  if (d.refresh_token && d.refresh_token !== refresh) {
    console.error('[settle] note: the refresh token rotated. Update the secret to keep this job alive.');
  }
  return d.access_token;
}

async function apiGet(fn, path, token) {
  const res = await fetch(`${API}/${fn}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error.message; } catch (_) {}
    const e = new Error(`GET ${fn}${path} -> ${res.status}: ${String(msg).slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

async function postResults(results, token) {
  const res = await fetch(`${API}/collective_admin/v1/admin/results`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ results }),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error.message; } catch (_) {}
    const e = new Error(`POST /v1/admin/results -> ${res.status}: ${String(msg).slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return text ? JSON.parse(text) : {};
}

/* The Collective's own captured close, strictly a prefill -- the same call
   the admin screen's "Use captured close" button makes. Any failure here
   returns null and the game still settles on its score: an odds outage must
   never be the reason a finished game stays ungraded. */
async function capturedClose(sport, gameId, token) {
  const league = ODDS_LEAGUE[String(sport).toUpperCase()];
  if (!league) return null;
  try {
    const d = await apiGet('collective_odds', `/v1/${league}/closing/${encodeURIComponent(gameId)}`, token);
    return (d && d.available) ? d : null;
  } catch (_) { return null; }
}

/* ---- THE CLOSE THE PER-GAME ROUTE CANNOT NAME ---------------------------
 *
 * /v1/<league>/closing/<collective_game_id> answers for a game the odds feed
 * has been LINKED to. On the 2026 college season it answered for none of
 * them: the committed record carries a captured close on 15 of 15 NFL games
 * and 0 of 104 CFB games, and every one of those CFB entries went through
 * this same call. NFL team names are two- and three-letter codes that pass
 * through unchanged; the Collective's schedule cuts college names to TEN
 * CHARACTERS, so "Mississippi" is stored as MISSISSIPP and "West Virginia"
 * as WESTVIRGIN, and any join on the stored string misses. 61 of the 142
 * team names in that record are exactly ten characters long.
 *
 * The number is not missing. It is on the odds BOARD, under the feed's own
 * spelling, in the same `closing` object the market page prints under
 * "Close". So the board is asked for the week and the game is found in it by
 * the same rule this file already uses for the finals feed (teamsAgree: a
 * prefix with a six-character floor), on the PAIR and the kickoff day, and
 * only when exactly one row fits.
 *
 * What this changes is which row is read. What is read off it is unchanged:
 * `closing`, written after kickoff, and never `consensus` or any current
 * price. A board with no stored close for a game yields nothing, and the
 * game stays ungraded against the spread exactly as before. */
async function oddsBoard(sport, season, week, token) {
  const league = ODDS_LEAGUE[String(sport).toUpperCase()];
  if (!league) return null;
  const q = [`books=0`, `limit=200`];
  if (week !== null && week !== undefined && week !== '') q.push(`week=${encodeURIComponent(week)}`);
  if (season) q.push(`season=${encodeURIComponent(season)}`);
  try {
    const d = await apiGet('collective_odds', `/v1/${league}/odds?${q.join('&')}`, token);
    return (d && Array.isArray(d.games)) ? d.games : null;
  } catch (_) { return null; }
}

/* The stored close off one board row, in the shape capturedClose() returns
   so both sources reach recordEntry() through the same door. */
function closeFromBoardRow(row) {
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
  const c = (row && row.closing) || {};
  const sp = c['spread:home'];
  const tot = c['total'] || c['total:over'];
  const spread = sp ? num(sp.line) : null;
  if (spread === null) return null;
  return {
    closing_spread: spread,
    closing_total: tot ? num(tot.line) : null,
    closing_home_ml_prob: null,
  };
}

/* One board row for one Collective game, decided on the PAIR and the day.
   Exact on both sides wins outright; a truncated match is taken only when it
   is the ONLY row that fits. Two candidates is not a match: a closing line
   taken on a coin flip puts a win or a loss on a record from another game. */
function findBoardRow(game, rows) {
  const dated = (rows || []).filter(r => {
    const t = r && (r.commence_time || r.kickoff_at || r.start_time);
    return (!t || !game.kickoff_at) ? true : datesAgree(game.kickoff_at, t, 1);
  });
  const hk = teamKey(game.home), ak = teamKey(game.away);
  const exact = dated.filter(r => teamKey(r.home) === hk && teamKey(r.away) === ak);
  if (exact.length) return exact.length === 1 ? { row: exact[0], matched_by: 'exact' } : null;
  /* ONE SIDE MUST STILL MATCH EXACTLY. A prefix rule allowed to guess at both
     teams at once can land a whole game on the wrong row -- "GEORGIA @ MIAMI"
     fits "Georgia Tech @ Miami (OH)" on both sides. Pinning one side to an
     exact name makes that impossible: the exactly-matched team would have to
     be playing twice that day. On the committed 2026 college record 8 of 104
     games have both names at the ten-character boundary, and those 8 are
     still reachable by the per-game route, which joins on the id. A close
     this refuses is a game reported as ungraded, which is true and visible;
     a close it got wrong would be a win or a loss on another game's number. */
  const loose = dated.filter(r => {
    const he = teamKey(r.home) === hk, ae = teamKey(r.away) === ak;
    if (!he && !ae) return false;
    return (he || teamsAgree(game.home, r.home)) && (ae || teamsAgree(game.away, r.away));
  });
  return loose.length === 1 ? { row: loose[0], matched_by: 'truncated' } : null;
}

/* Every game in `games` that still wants a close, given one off the board,
   one board request per week rather than one per game. Mutates nothing:
   returns game_id -> {close, matched_by}. */
async function closesFromBoard(sport, season, games, token, log) {
  const want = (games || []).filter(g => g && g.kickoff_at);
  if (!want.length) return {};
  const byWeek = new Map();
  want.forEach(g => {
    const k = (g.week === null || g.week === undefined) ? '' : String(g.week);
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(g);
  });
  const out = {};
  for (const [wk, list] of byWeek) {
    const rows = await oddsBoard(sport, season, wk, token);
    if (!rows || !rows.length) {
      if (log) log(`    [close] ${sport} ${season} week ${wk || '(all)'}: the odds board answered with no games`);
      continue;
    }
    let got = 0, trunc = 0;
    list.forEach(g => {
      const hit = findBoardRow(g, rows);
      if (!hit) return;
      const close = closeFromBoardRow(hit.row);
      if (!close) return;
      out[String(g.game_id)] = { close, matched_by: hit.matched_by };
      got++;
      if (hit.matched_by === 'truncated') trunc++;
    });
    if (log) log(`    [close] ${sport} ${season} week ${wk || '(all)'}: ` +
      `${got} of ${list.length} game(s) recovered a captured close from the board` +
      (trunc ? ` (${trunc} matched through a truncated team name)` : ''));
  }
  return out;
}

/* ---- the database itself ------------------------------------------------
   THE JOB RUNS ITSELF. Settling used to mean POSTing to collective_admin: an
   edge function deployed from a dashboard, outside this repository, behind
   a refresh token lifted out of a browser session — and when that token was
   never set, the hourly job exited 0 having settled nothing, for weeks. With
   the service role the repository already holds for its other jobs, this
   talks to the database directly over PostgREST, the same door every edge
   function goes through, and does the grading here, by the published rule,
   where the suite can see it.

   Nothing about the tables is assumed. The run reads the OpenAPI listing
   PostgREST serves for the collective schema and writes only the columns
   that are actually there. */
const DIRECT_GAME_COLS = ['home_score', 'away_score', 'closing_spread', 'closing_total',
  'closing_home_ml_prob', 'status'];
const DIRECT_PROJ_READ = ['id', 'model_id', 'game_id', 'pick_side', 'projected_spread',
  'projected_total', 'proj_home_score', 'proj_away_score', 'home_win_prob', 'is_late',
  'is_graded_candidate', 'data_origin', 'resolution_status', 'received_at',
  'pick_result', 'margin_error', 'brier'];
const DIRECT_GRADE_COLS = ['pick_result', 'margin_error', 'brier'];

function directConfig(env) {
  env = env || process.env;
  const key = String(env.EDGD_SB_SERVICE || '').trim();
  const url = String(env.EDGD_SB_URL || env.EDGEDESK_SUPABASE_URL || SB_URL || '').trim().replace(/\/$/, '');
  if (!key || !url) return null;
  return { url, key };
}

/* table -> [column, ...] from the OpenAPI document PostgREST serves at
   /rest/v1/ for the schema named in Accept-Profile. */
function columnsFrom(openapi) {
  const defs = (openapi && openapi.definitions) || {};
  const out = {};
  Object.keys(defs).forEach(t => {
    out[t] = Object.keys((defs[t] && defs[t].properties) || {});
  });
  return out;
}

function dbClient(cfg, fetchImpl) {
  const f = fetchImpl || ((...a) => fetch(...a));
  const H = extra => Object.assign({ apikey: cfg.key, authorization: `Bearer ${cfg.key}` }, extra || {});
  async function body(res, what) {
    const t = await res.text();
    if (!res.ok) throw new Error(`${what} -> ${res.status}: ${String(t).slice(0, 300)}`);
    return t;
  }
  return {
    async schema() {
      const res = await f(`${cfg.url}/rest/v1/`, { headers: H({ 'accept-profile': 'collective' }) });
      return columnsFrom(JSON.parse(await body(res, 'GET /rest/v1/ (schema)')));
    },
    async select(rel, query) {
      const res = await f(`${cfg.url}/rest/v1/${rel}?${query}`, { headers: H({ 'accept-profile': 'collective' }) });
      const t = await body(res, `GET ${rel}`);
      return t ? JSON.parse(t) : [];
    },
    async patch(rel, query, patch) {
      const res = await f(`${cfg.url}/rest/v1/${rel}?${query}`, {
        method: 'PATCH',
        headers: H({ 'content-profile': 'collective', 'content-type': 'application/json',
          prefer: 'return=representation' }),
        body: JSON.stringify(patch),
      });
      const t = await body(res, `PATCH ${rel}?${query}`);
      return t ? JSON.parse(t) : [];
    },
    /* New rows. The representation comes back so a caller has the ids the
       database minted -- a game cannot be reported, let alone linked to,
       without its own id. */
    async insert(rel, rows) {
      const res = await f(`${cfg.url}/rest/v1/${rel}`, {
        method: 'POST',
        headers: H({ 'content-profile': 'collective', 'content-type': 'application/json',
          prefer: 'return=representation' }),
        body: JSON.stringify(rows),
      });
      const t = await body(res, `POST ${rel}`);
      return t ? JSON.parse(t) : [];
    },
    /* Insert-or-update on one conflict column: the shape a settlement takes
       when scores live in their own table keyed by game. Running it twice
       writes the same row twice, which is the point. */
    async upsert(rel, rows, onConflict) {
      const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
      const res = await f(`${cfg.url}/rest/v1/${rel}${q}`, {
        method: 'POST',
        headers: H({ 'content-profile': 'collective', 'content-type': 'application/json',
          prefer: 'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify(rows),
      });
      const t = await body(res, `POST ${rel}${q} (upsert)`);
      return t ? JSON.parse(t) : [];
    },
    /* A routine in the collective schema, called the way PostgREST exposes
       it. Best-effort callers catch; the routine's own answer comes back. */
    async rpc(fn, args) {
      const res = await f(`${cfg.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: H({ 'content-profile': 'collective', 'accept-profile': 'collective',
          'content-type': 'application/json' }),
        body: JSON.stringify(args || {}),
      });
      const t = await body(res, `RPC ${fn}`);
      return t ? JSON.parse(t) : null;
    },
  };
}

/* game_detail is the view every read of the board goes through. Its rows
   become the exact shape collective_public /v1/games serves, so the matcher
   is fed the same thing whichever door the run came in by. */
function gameFromDetail(r) {
  const hasScore = r.home_score !== null && r.home_score !== undefined;
  const settled = r.status === 'final' || hasScore;
  return {
    game_id: r.game_id, label: r.label || `${r.away} @ ${r.home}`, home: r.home, away: r.away,
    kickoff_at: r.kickoff_at, status: r.status, week: r.week, season: r.season,
    result: settled && hasScore
      ? { home_score: r.home_score, away_score: r.away_score,
          closing_spread: r.closing_spread === undefined ? null : r.closing_spread,
          closing_total: r.closing_total === undefined ? null : r.closing_total }
      : null,
  };
}

/* The current season per sport, read off the same views collective_public
   builds /v1/meta from: in season when today sits inside starts_on..ends_on,
   else the latest season the Collective holds for the sport. */
function seasonsFrom(sports, seasons, today) {
  return (sports || []).map(s => {
    const mine = (seasons || []).filter(x => x.sport_code === s.code);
    const live = mine.find(x => x.starts_on <= today && today <= x.ends_on);
    const latest = mine.slice().sort((a, b) => Number(b.season) - Number(a.season))[0];
    const pick = live || latest;
    return { code: s.code, season: pick ? Number(pick.season) : null };
  }).filter(s => s.season !== null);
}

/* THE PUBLISHED RULE, the same three numbers collective/index.html computes
   (atsResult, projectedMargin, the Brier line) — stated here once more
   because this file runs where the page does not, and pinned by the suite
   against the page's own fixtures.

     ATS     the side the creator NAMED, against the Collective's captured
             close: margin + close above zero is the home side covering,
             below it the road side, exactly zero a push. No pick side, or
             no close, is no ATS result — a side is never inferred here.
     Margin  |projected home margin - actual home margin|: projected scores
             when supplied, else the home-stated spread with its sign turned.
     Brier   (p_home - outcome)^2. A tie has no winner and no score. */
function gradeProjection(row, final, closingSpread) {
  const margin = Number(final.home_score) - Number(final.away_score);
  const out = { pick_result: null, margin_error: null, brier: null };
  const side = String(row.pick_side || '').trim().toLowerCase();
  const close = (closingSpread === null || closingSpread === undefined ||
    !Number.isFinite(Number(closingSpread))) ? null : Number(closingSpread);
  if ((side === 'home' || side === 'away') && close !== null) {
    const covers = margin + close;
    out.pick_result = covers === 0 ? 'push' : (((side === 'home') === (covers > 0)) ? 'win' : 'loss');
  }
  let pm = null;
  if (row.proj_home_score != null && row.proj_away_score != null) {
    const d = Number(row.proj_home_score) - Number(row.proj_away_score);
    if (Number.isFinite(d)) pm = d;
  }
  if (pm === null && row.projected_spread != null) {
    const sp = Number(row.projected_spread);
    if (Number.isFinite(sp)) pm = -sp;
  }
  if (pm !== null) out.margin_error = Math.round(Math.abs(pm - margin) * 100) / 100;
  if (row.home_win_prob != null && margin !== 0) {
    const p = Number(row.home_win_prob);
    if (Number.isFinite(p) && p >= 0 && p <= 1) {
      const y = margin > 0 ? 1 : 0;
      out.brier = Math.round((p - y) * (p - y) * 10000) / 10000;
    }
  }
  return out;
}

/* Which rows on a game are graded: live, resolved, not late, and the one
   counting row per model — is_graded_candidate where the lock rule has been
   installed (supabase/lock_rule.sql), else the newest pre-lock row per
   model. A column the table does not carry is not a filter. */
function countingRows(rows) {
  const live = (rows || []).filter(r => {
    if (r.data_origin != null && String(r.data_origin) !== 'live') return false;
    if (r.resolution_status != null && String(r.resolution_status) !== 'resolved') return false;
    if (r.is_late) return false;
    return true;
  });
  const flagged = live.some(r => r.is_graded_candidate !== undefined && r.is_graded_candidate !== null);
  if (flagged) return live.filter(r => !!r.is_graded_candidate);
  const newest = {};
  live.forEach(r => {
    const k = String(r.model_id);
    const t = Date.parse(r.received_at || 0) || 0;
    if (!newest[k] || t >= newest[k].t) newest[k] = { t, r };
  });
  return Object.keys(newest).map(k => newest[k].r);
}

const enc = v => encodeURIComponent(String(v));

/* One game, settled and graded in the database. Returns what it did and
   what it could not do; throws only when the score itself could not be
   written, because a game with no score has nothing to grade. */
async function settleDirect(db, schema, game, final, close) {
  const gcols = schema.games || [], pcols = schema.projections || [];
  const gaps = [];
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
  const want = {
    home_score: final.home_score, away_score: final.away_score,
    closing_spread: close ? num(close.closing_spread) : null,
    closing_total: close ? num(close.closing_total) : null,
    closing_home_ml_prob: close ? num(close.closing_home_ml_prob) : null,
    status: 'final',
  };
  /* WHERE THE SCORE LIVES. On the games row when it carries score columns;
     otherwise in game_results, one row per game keyed by game_id, which is
     the shape the deployed database actually has: collective.games is
     (id, sport_code, season, week, kickoff_at, home_team_id, away_team_id,
     status, external_ref, created_at) and game_detail joins the score in
     from game_results. This path used to know only the first shape, so on
     the real database it threw "carries no home_score/away_score column"
     for every finished game, every hour, and Week 1 of the 2026 college
     season stood unsettled in the database with 58 agreed finals in hand:
     status never became final, the server's settled count stayed at 0, and
     the whole record lived in the committed JSON file alone. */
  const rcols = schema.game_results || [];
  const onGames = gcols.indexOf('home_score') >= 0 && gcols.indexOf('away_score') >= 0;
  const onResults = !onGames && rcols.indexOf('home_score') >= 0 && rcols.indexOf('away_score') >= 0;
  if (!onGames && !onResults) {
    throw new Error(`collective.games carries no home_score/away_score column (saw: ${gcols.join(', ') || 'nothing'})` +
      ` and collective.game_results carries none either (saw: ${rcols.join(', ') || 'nothing'})`);
  }
  /* a close the row already holds is never blanked by a run that found none */
  const had = game.result || {};
  const keepHeldClose = p => {
    ['closing_spread', 'closing_total', 'closing_home_ml_prob'].forEach(c => {
      if (c in p && p[c] === null && had[c] !== null && had[c] !== undefined) delete p[c];
    });
  };
  let patch = {};
  if (onGames) {
    DIRECT_GAME_COLS.forEach(c => { if (gcols.indexOf(c) >= 0) patch[c] = want[c]; else gaps.push('games.' + c); });
    keepHeldClose(patch);
    const rows = await db.patch('games', `id=eq.${enc(game.game_id)}`, patch);
    if (!rows.length) throw new Error(`no collective.games row has id ${game.game_id}`);
  } else {
    /* The result row, inserted or updated on game_id. Only the columns sent
       are written, so a close left out here (because the row already holds
       one and this run found none) stays exactly as it was. */
    const row = { game_id: game.game_id };
    ['home_score', 'away_score', 'closing_spread', 'closing_total', 'closing_home_ml_prob'].forEach(c => {
      if (rcols.indexOf(c) >= 0) row[c] = want[c]; else gaps.push('game_results.' + c);
    });
    keepHeldClose(row);
    const rows = await db.upsert('game_results', [row], 'game_id');
    if (!rows.length) throw new Error(`collective.game_results took no row for ${game.game_id}`);
    patch = Object.assign({}, row);
    delete patch.game_id;
    /* The games row still carries the status the board, the settle sweep
       and the current-week rule all read. A game with a score and no
       "final" would be settled and still counted as football left to play
       for the length of the in-play window. */
    if (gcols.indexOf('status') >= 0) {
      const g = await db.patch('games', `id=eq.${enc(game.game_id)}`, { status: 'final' });
      if (!g.length) throw new Error(`no collective.games row has id ${game.game_id}`);
      patch.status = 'final';
    } else {
      gaps.push('games.status');
    }
  }

  const readCols = DIRECT_PROJ_READ.filter(c => pcols.indexOf(c) >= 0);
  const gradeCols = DIRECT_GRADE_COLS.filter(c => pcols.indexOf(c) >= 0);
  DIRECT_GRADE_COLS.forEach(c => { if (pcols.indexOf(c) < 0) gaps.push('projections.' + c); });
  const out = { game_written: true, graded: 0, candidates: 0, refused: [], gaps, patch };
  if (!gradeCols.length || readCols.indexOf('id') < 0 || readCols.indexOf('game_id') < 0) return out;

  const all = await db.select('projections', `select=${readCols.join(',')}&game_id=eq.${enc(game.game_id)}`);
  const closeSpread = 'closing_spread' in patch ? patch.closing_spread : num(had.closing_spread);
  const rowsToGrade = countingRows(all);
  out.candidates = rowsToGrade.length;
  for (const r of rowsToGrade) {
    const gr = gradeProjection(r, final, closeSpread);
    const p = {};
    gradeCols.forEach(c => { p[c] = gr[c]; });
    try {
      await db.patch('projections', `id=eq.${enc(r.id)}`, p);
      out.graded++;
    } catch (e) {
      out.refused.push({ projection_id: r.id, detail: e.message });
    }
  }
  return out;
}

/* ---- the committed record ----------------------------------------------
   <dir>/<SPORT>_<season>.json: every finished game of the season the
   Collective holds a real final for, plus every game this run settled, with
   the final score and the Collective's captured close. collective/index.html
   reads it from its own origin. It is rewritten only when a game's facts
   change, so an hourly run that found nothing new commits nothing. */
const RECORD_SCHEMA = 'edgedesk_collective_settled_v1';
const RECORD_RULE = 'Each game is graded on the final score against the Collective\'s own captured closing line. ' +
  'A score comes only from a public feed that carries the game as completed with two integer scores, ' +
  'agreed by every feed that carries it; 0-0 is never a final. A missing close is null, never invented.';

function recordPath(dir, sport, season) {
  return path.join(dir, `${String(sport).toUpperCase()}_${season}.json`);
}
function loadRecord(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (r && r.games && typeof r.games === 'object') ? r : null;
  } catch (_) { return null; }
}
function sortedObject(o) {
  const out = {};
  Object.keys(o).sort().forEach(k => { out[k] = o[k]; });
  return out;
}
function recordEntry(game, final, close, sources) {
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
  return {
    game_id: String(game.game_id),
    label: game.label, home: game.home, away: game.away,
    week: game.week == null ? null : Number(game.week),
    kickoff_at: game.kickoff_at,
    home_score: Number(final.home_score), away_score: Number(final.away_score),
    score_source: sources || 'collective',
    closing_spread: close ? num(close.closing_spread) : null,
    closing_total: close ? num(close.closing_total) : null,
    closing_home_ml_prob: close ? num(close.closing_home_ml_prob) : null,
    /* Named only when there is actually a number to name. A `close` object
       whose every field is null is an ATTEMPT, not a close, and stamping it
       `collective` put a provenance label on an absence -- which reads, to
       anything auditing the file, as "the Collective's close for this game
       is nothing" rather than "this game has no close yet". */
    close_source: (close && num(close.closing_spread) !== null)
      ? (close.source || 'collective') : null,
  };
}
/* Merge entries into the previous record. settled_at is the first time the
   record saw the game and is kept; every other field is the newest fact.
   Returns changed:false, and the previous record untouched, when nothing
   about any game moved — a timestamp-only diff is not a change. */
/* The line fields, which are the ones a run can legitimately arrive without.
   A score is either agreed or the game is not settled at all; a close is a
   separate fetch against a separate service and comes back empty on a bad
   minute. */
const CLOSE_FIELDS = ['closing_spread', 'closing_total', 'closing_home_ml_prob'];

function mergeRecord(prev, sport, season, entries, nowIso) {
  const games = Object.assign({}, (prev && prev.games) || {});
  let changed = false;
  (entries || []).forEach(e => {
    const id = String(e.game_id);
    const old = games[id] || null;
    const next = Object.assign({}, e);
    delete next.game_id;
    next.settled_at = (old && old.settled_at) || nowIso;
    /* A CLOSE THE RECORD ALREADY HOLDS IS NEVER BLANKED BY A RUN THAT FOUND
       NONE. settleDirect() has always had this rule for the database row and
       the record did not, so one odds outage on an hourly job could erase a
       captured closing line out of the committed file -- and with it every
       against-the-spread result graded on it, for good, because the next run
       reads the file it just emptied. Losing a number nobody can re-derive
       is not a smaller failure than never having it. */
    if (old) {
      const hadClose = CLOSE_FIELDS.some(k => old[k] !== null && old[k] !== undefined);
      const hasClose = CLOSE_FIELDS.some(k => next[k] !== null && next[k] !== undefined);
      if (hadClose && !hasClose) {
        CLOSE_FIELDS.forEach(k => { next[k] = old[k] === undefined ? null : old[k]; });
        next.close_source = old.close_source === undefined ? null : old.close_source;
      }
    }
    if (isPlaceholderResult(next)) return;         /* never carried, whatever wrote it */
    const same = old && JSON.stringify(sortedObject(old)) === JSON.stringify(sortedObject(next));
    if (same) return;
    games[id] = sortedObject(next);
    changed = true;
  });
  if (!changed && prev && prev.schema === RECORD_SCHEMA) return { record: prev, changed: false };
  return {
    changed: true,
    record: {
      schema: RECORD_SCHEMA, sport: String(sport).toUpperCase(), season: Number(season),
      generated_at: nowIso, rule: RECORD_RULE,
      games: sortedObject(games),
    },
  };
}
function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 1) + '\n');
}

/* ---- THE HISTORICAL REPAIR ----------------------------------------------
 *
 * `--backfill-closes` reads a committed record, finds every finished game in
 * it that carries no captured closing line, and asks for one -- the per-game
 * route first, then the odds board by week with the truncation-tolerant join.
 * It is the same two sources, the same rule and the same numbers as a normal
 * run; it exists because a record written before that join existed is full
 * of nulls that nothing else will ever go back for.
 *
 * SAFE AND IDEMPOTENT BY CONSTRUCTION:
 *   - it only ever fills a null. A close already on file is never asked
 *     about, never overwritten and never blanked (mergeRecord enforces the
 *     last of those for every writer, not just this one).
 *   - it never touches a score, a team, a week or a kickoff.
 *   - settled_at -- when the record first saw the game -- is carried
 *     through mergeRecord untouched, so the audit trail survives the repair.
 *     close_source names which of the two routes answered, per game, so the
 *     repair is legible in the file afterwards rather than indistinguishable
 *     from the original write.
 *   - running it twice is a no-op: the second pass finds nothing null to
 *     fill and mergeRecord reports changed:false, so nothing is rewritten.
 *   - a source that answers with nothing leaves the game exactly as it was.
 *     A missing close stays missing; it is never invented, never taken from
 *     a current price, and never taken from a second game that merely looks
 *     like this one.
 *
 * The two fetchers are injected so the suite can drive the whole repair
 * offline against a record file it wrote itself. */
async function backfillCloses(dir, sport, season, opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const file = recordPath(dir, sport, season);
  const rec = loadRecord(file);
  const out = { file, sport: String(sport).toUpperCase(), season: Number(season),
    games: 0, wanted: 0, recovered: 0, still_missing: 0, by_source: {},
    changed: false, ok: true, reason: null };
  if (!rec) { out.ok = false; out.reason = 'no_record_file'; return out; }
  const games = rec.games || {};
  const ids = Object.keys(games);
  out.games = ids.length;
  const want = ids
    .filter(id => games[id].closing_spread === null || games[id].closing_spread === undefined)
    .map(id => Object.assign({ game_id: id }, games[id]));
  out.wanted = want.length;
  if (!want.length) return out;

  const entries = [];
  const take = (g, close, source) => {
    const e = recordEntry(g, g, Object.assign({}, close, { source }), g.score_source);
    if (e.closing_spread === null) return false;
    entries.push(e);
    out.recovered++;
    out.by_source[source] = (out.by_source[source] || 0) + 1;
    return true;
  };

  let left = want;
  if (opts.perGame) {
    const still = [];
    for (const g of left) {
      let c = null;
      try { c = await opts.perGame(g.game_id); } catch (_) { c = null; }
      if (!(c && c.closing_spread !== null && c.closing_spread !== undefined && take(g, c, 'collective_odds'))) {
        still.push(g);
      }
    }
    left = still;
  }
  if (left.length && opts.board) {
    const byWeek = new Map();
    left.forEach(g => {
      const k = (g.week === null || g.week === undefined) ? '' : String(g.week);
      if (!byWeek.has(k)) byWeek.set(k, []);
      byWeek.get(k).push(g);
    });
    const still = [];
    for (const [wk, list] of byWeek) {
      let rows = null;
      try { rows = await opts.board(wk); } catch (_) { rows = null; }
      if (!rows || !rows.length) { list.forEach(g => still.push(g)); continue; }
      list.forEach(g => {
        const hit = findBoardRow(g, rows);
        const close = hit ? closeFromBoardRow(hit.row) : null;
        if (!close || !take(g, close, 'collective_odds_board')) still.push(g);
      });
    }
    left = still;
  }
  out.still_missing = left.length;
  if (entries.length) {
    const merged = mergeRecord(rec, sport, season, entries, new Date().toISOString());
    out.changed = merged.changed;
    if (merged.changed && !opts.dryRun) writeRecord(file, merged.record);
    out.record = merged.record;
  }
  log(`  backfill ${file}: ${out.wanted} game(s) wanted a close, ${out.recovered} recovered` +
    (Object.keys(out.by_source).length ? ` (${Object.entries(out.by_source).map(([k, v]) => `${v} ${k}`).join(', ')})` : '') +
    `, ${out.still_missing} still missing${out.changed ? ', file updated' : ', file unchanged'}`);
  return out;
}

/* ---- the run ------------------------------------------------------------ */

function parseArgs(argv) {
  const a = { commit: false, json: false, verify: false, sport: null, season: null, limit: 200,
    record: null, backfillCloses: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--commit') a.commit = true;
    else if (v === '--verify') a.verify = true;
    else if (v === '--json') a.json = true;
    else if (v === '--sport') a.sport = argv[++i];
    else if (v === '--season') a.season = Number(argv[++i]);
    else if (v === '--limit') a.limit = Number(argv[++i]);
    else if (v === '--record') a.record = argv[++i];
    /* the historical repair: fill the closes a record was written without,
       from the same two sources a normal run uses, and change nothing else */
    else if (v === '--backfill-closes') a.backfillCloses = true;
  }
  return a;
}

/* Which games are this script's business: past kickoff, and not already
   settled — or settled 0-0, which is not a settlement (see
   isPlaceholderResult) and is written over with the real final. Every
   condition comes from the Collective itself, never from a clock this
   script keeps. */
function needsSettling(games, nowMs) {
  return (games || []).filter(g =>
    (!g.result || isPlaceholderResult(g.result)) &&
    g.kickoff_at && Date.parse(g.kickoff_at) < nowMs &&
    g.status !== 'postponed' && g.status !== 'canceled');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.json ? () => {} : (...m) => console.log(...m);
  const report = { checked: 0, settled: 0, graded: 0, skipped: [], failed: [], sources: [],
                   mode: null, schema_gaps: [], record: [], closes: [],
                   dry_run: !args.commit, verify_only: args.verify };

  /* --verify proves the SOURCES, and needs no credential to do it: the
     game list and whether a game has a result are public. That is the
     point -- you can confirm the feeds are live and the matcher agrees
     before you hand this job a key to anything. */
  /* ---- the historical repair, before anything else --------------------
     Reads the committed records and fills only the closes that are null. It
     settles nothing, writes no database row and touches no score, so it
     asks for no credential and -- given --sport and --season -- for no
     schedule either: the record files name their own games. That matters,
     because the one environment where this repair is most needed is one
     where only some of the estate is reachable, and a mode that dies on
     /v1/meta before it has read a single file is a repair nobody can run. */
  if (args.backfillCloses) {
    if (!args.record) throw new Error('--backfill-closes needs --record <dir> to know which files to repair.');
    report.mode = 'backfill-closes';
    let bfSports = (args.sport && args.season)
      ? [{ code: args.sport.toUpperCase(), season: args.season }]
      : null;
    if (!bfSports) {
      const meta = await apiGet('collective_public', '/v1/meta', null);
      bfSports = (meta.sports || []).map(sp => ({ code: sp.code, season: args.season || sp.season }))
        .filter(sp => !args.sport || sp.code.toUpperCase() === args.sport.toUpperCase());
    }
    log('Backfilling captured closing lines into the committed settlement record.');
    log('Only null closes are filled. No score, team, week or kickoff is touched, and a close already on file is left exactly as it is.\n');
    for (const sp of bfSports) {
      const r = await backfillCloses(args.record, sp.code, sp.season, {
        log,
        dryRun: !args.commit,
        perGame: id => capturedClose(sp.code, id, null),
        board: wk => oddsBoard(sp.code, sp.season, wk, null),
      });
      report.closes.push(r);
      if (!r.ok) log(`  ${sp.code} ${sp.season}: ${r.reason}`);
    }
    const stuck = report.closes.reduce((n, r) => n + (r.still_missing || 0), 0);
    const got = report.closes.reduce((n, r) => n + (r.recovered || 0), 0);
    log(`\n${got} captured closing line(s) recovered; ${stuck} finished game(s) still carry none.`);
    if (!args.commit) log('Dry run: nothing was written. Re-run with --commit to write the repaired record.');
    if (args.json) console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  let token = null, db = null, schema = null;
  if (args.verify) {
    report.mode = 'verify';
  } else {
    const direct = directConfig();
    if (direct) {
      try {
        db = dbClient(direct);
        schema = await db.schema();
        report.mode = 'direct';
        log(`[db] service role: collective.games has ${(schema.games || []).length} column(s), ` +
          `collective.projections ${(schema.projections || []).length}; settling and grading directly.`);
      } catch (e) {
        log(`[db] the service credential could not read the schema: ${e.message}`);
        db = null;
      }
    }
    if (!db) {
      try {
        token = await accessToken();
        report.mode = 'admin';
        log('[auth] no service credential; settling through collective_admin with the admin token.');
      } catch (e) {
        if (!args.record) throw e;
        report.mode = 'record-only';
        log(`[auth] ${e.message}`);
        log('No database credential in this run. The settlement record is still written; the database is not.');
      }
    }
  }

  /* The current season per sport: off the database in direct mode, else
     off the public meta. */
  let sports = null;
  if (db) {
    try {
      const [sp, se] = await Promise.all([
        db.select('sports', 'select=code,name'),
        db.select('seasons', 'select=sport_code,season,starts_on,ends_on'),
      ]);
      sports = seasonsFrom(sp, se, new Date().toISOString().slice(0, 10));
    } catch (e) {
      log(`[db] sports/seasons views not readable (${e.message}); using the public meta.`);
      sports = null;
    }
  }
  if (!sports) {
    const meta = await apiGet('collective_public', '/v1/meta', null);
    sports = (meta.sports || []).map(s => ({ code: s.code, season: s.season }));
  }
  if (args.sport) sports = sports.filter(s => s.code.toUpperCase() === args.sport.toUpperCase());
  if (args.season) sports = sports.map(s => ({ ...s, season: args.season }));
  if (!sports.length) throw new Error(`No sport to settle${args.sport ? ` matching "${args.sport}"` : ''}.`);

  const batch = [];
  const held = {};      /* sport -> every game of the season, as the Collective holds it */
  for (const sp of sports) {
    const kind = FEED[String(sp.code).toUpperCase()];
    if (!kind) {
      report.skipped.push({ sport: sp.code, reason: 'no_finals_feed_for_sport' });
      log(`- ${sp.code}: no finals feed is wired for this sport; skipped rather than guessed at.`);
      continue;
    }
    let games = null;
    if (db) {
      try {
        games = (await db.select('game_detail',
          `select=*&sport=eq.${enc(sp.code)}&season=eq.${enc(sp.season)}&order=kickoff_at.asc`)).map(gameFromDetail);
      } catch (e) {
        log(`  [db] game_detail not readable (${e.message}); reading the public games feed.`);
        games = null;
      }
    }
    if (!games) {
      const d = await apiGet('collective_public',
        `/v1/games?sport=${encodeURIComponent(sp.code)}&season=${encodeURIComponent(sp.season)}`, token);
      games = d.games || [];
    }
    held[sp.code] = games;
    const need = needsSettling(games, Date.now());
    const nPlaceholder = need.filter(g => isPlaceholderResult(g.result)).length;
    log(`- ${sp.code} ${sp.season}: ${need.length - nPlaceholder} finished game(s) with no result yet` +
      (nPlaceholder ? `, ${nPlaceholder} settled 0-0 (a placeholder, not a final: settled again with the real score)` : ''));
    if (!need.length) continue;

    /* Only the days this slate actually touches -- a Saturday board asks
       ESPN for one day, not a season. */
    const dates = [...new Set(need.flatMap(g => {
      const d = compactDate(g.kickoff_at);
      if (!d) return [];
      const t = Date.parse(ymd(g.kickoff_at) + 'T00:00:00Z');
      return [compactDate(new Date(t - 86400000).toISOString()), d,
              compactDate(new Date(t + 86400000).toISOString())];
    }))].filter(Boolean);

    const notes = [];
    const sources = await allSources(kind, sp.season, dates, notes);
    report.sources.push({ sport: sp.code, season: sp.season, tried: notes,
      answered: sources.map(s2 => `${s2.name} (${s2.rows.length} rows)`) });
    notes.forEach(n => log(`    [${n.source}${n.date ? ' ' + n.date : ''}] ` +
      (n.error ? `unavailable: ${n.error}` : `${n.rows ?? n.events} rows, ${n.completed} completed`)));
    if (!sources.length) {
      report.failed.push({ sport: sp.code, reason: 'no_source_answered' });
      log(`  ! ${sp.code}: no finals source answered. Nothing settled, nothing guessed.`);
      continue;
    }

    for (const g of need.slice(0, args.limit)) {
      report.checked++;
      const fin = findAcrossSources(g, sources);
      if (!fin.ok) {
        report.skipped.push({ game_id: g.game_id, label: g.label, reason: fin.reason, detail: fin.detail });
        log(`  · ${g.label}: ${fin.reason}${fin.detail ? ' — ' + fin.detail : ''}`);
        continue;
      }
      const close = args.verify ? null : await capturedClose(sp.code, g.game_id, token);
      const body = settleBody(g, fin, close);
      batch.push({ sport: sp.code, season: sp.season, game: g, label: g.label, body, meta: fin,
        close: close ? { ...close, source: 'collective_odds' } : null });
      log(`  ✓ ${g.label}: ${fin.away_score}-${fin.home_score}` +
        `  [${fin.agreed_by.join('+')}${fin.matched_by === 'truncated' ? ', name truncated' : ''}]` +
        (isPlaceholderResult(g.result) ? '  (replacing a 0-0 placeholder)' : '') +
        (fin.needs_review ? '  ⚠ REVIEW: ' + fin.joined : '') +
        (close ? '' : '  (no captured close — settling on the score alone)'));
    }
  }

  /* ---- the close, before anything is settled on it ---------------------
     A game settles with whatever close is in hand, and the close is what
     turns a settled game into an against-the-spread result -- in the
     database row and in every projection graded against it, not only in the
     committed record. So the games this run is about to settle that still
     have none are looked for on the board FIRST, one request per week, and
     the close travels into settleBody with them. Settle a season without
     this and the ATS grades have to be backfilled afterwards, one game at a
     time, against rows that have already been written. */
  if (!args.verify) {
    const bySport = new Map();
    batch.filter(b => !b.close).forEach(b => {
      const k = `${b.sport}|${b.season}`;
      if (!bySport.has(k)) bySport.set(k, []);
      bySport.get(k).push(b);
    });
    for (const [k, items] of bySport) {
      const [code, season] = k.split('|');
      const found = await closesFromBoard(code, Number(season), items.map(b => b.game), token, log);
      items.forEach(b => {
        const hit = found[String(b.game.game_id)];
        if (!hit) return;
        b.close = { ...hit.close, source: 'collective_odds_board' };
        b.body = settleBody(b.game, b.meta, b.close);
      });
      const got = items.filter(b => b.close).length;
      if (got) log(`  ${code}: ${got} of ${items.length} game(s) about to settle gained a captured close from the board`);
    }
  }

  if (args.verify) {
    log(`\nVerify: ${report.checked} game(s) checked, ${batch.length} have an agreed final, ` +
      `${report.skipped.length} do not. Nothing was written and no credential was used to settle.`);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    return report.failed.length ? 2 : 0;
  }

  if (!batch.length) {
    log(batch.length === 0 && report.checked === 0
      ? '\nNothing to settle.' : '\nNothing matched a final.');
  } else if (!args.commit) {
    log(`\nDry run: ${batch.length} game(s) would settle. Nothing was written. Re-run with --commit.`);
  } else if (db) {
    for (const item of batch) {
      try {
        const r = await settleDirect(db, schema, item.game, item.meta, item.close);
        report.settled++;
        report.graded += r.graded;
        r.gaps.forEach(gp => { if (report.schema_gaps.indexOf(gp) < 0) report.schema_gaps.push(gp); });
        log(`  settled ${item.label} — graded ${r.graded} of ${r.candidates} counting projection(s)` +
          (r.refused.length ? `; ${r.refused.length} grade write(s) refused` : ''));
        if (r.refused.length) {
          /* the score stands and the site grades from it; a grade the
             database would not take is still a failure of this job */
          report.failed.push({ game_id: item.body.game_id, label: item.label,
            reason: 'grade_write_refused', detail: r.refused[0].detail, refused: r.refused.length });
          log(`    ! ${r.refused[0].detail}`);
        }
      } catch (e) {
        report.failed.push({ game_id: item.body.game_id, label: item.label, detail: e.message });
        log(`  ! ${item.label}: ${e.message}`);
      }
    }
    if (report.schema_gaps.length) {
      log(`\n  schema gaps (expected, not found, not written): ${report.schema_gaps.join(', ')}`);
    }
    log(`\nSettled ${report.settled} of ${batch.length} directly; ${report.graded} projection(s) graded.`);
  } else if (token) {
    for (const item of batch) {
      try {
        const r = await postResults([item.body], token);
        report.settled++;
        log(`  settled ${item.label} — graded ${r.graded ?? 0} projection(s)`);
      } catch (e) {
        report.failed.push({ game_id: item.body.game_id, label: item.label, detail: e.message });
        log(`  ! ${item.label}: ${e.message}`);
      }
    }
    log(`\nSettled ${report.settled} of ${batch.length}.`);
  } else {
    log(`\n${batch.length} game(s) have an agreed final and no credential to write them with; ` +
      'they go into the settlement record only.');
  }

  /* ---- the record: written whenever asked for, credential or not -------- */
  if (args.record) {
    const nowIso = new Date().toISOString();
    for (const sp of sports) {
      const games = held[sp.code];
      if (!games) continue;
      const entries = [];
      const settledNow = {};
      const byId = new Map();     /* game_id -> the game behind its entry */
      const push = (g, final, close, sources) => {
        const e = recordEntry(g, final, close, sources);
        entries.push(e);
        byId.set(String(g.game_id), { game: g, entry: e });
      };
      batch.filter(b => b.sport === sp.code).forEach(b => {
        settledNow[String(b.game.game_id)] = 1;
        push(b.game, b.meta, b.close, b.meta.agreed_by.join('+'));
      });
      /* every game the Collective already holds a real final for */
      for (const g of games) {
        if (settledNow[String(g.game_id)] || !g.result || isPlaceholderResult(g.result)) continue;
        if (!isFinalScore(g.result.home_score) || !isFinalScore(g.result.away_score)) continue;
        push(g, g.result, { closing_spread: g.result.closing_spread, closing_total: g.result.closing_total,
          closing_home_ml_prob: null, source: 'collective' }, 'collective');
      }

      /* ---- ONE close-recovery pass over EVERY entry that still wants one --
         It used to run only over the games this run did NOT settle, and to
         need a `result` already on the server to reach them at all. For a
         sport with no write credential that is every game twice over: each
         run re-settles the whole season off the public feed, so every game
         is in `settledNow` and none of them has a server `result`, and the
         close pass skipped all of them on both counts. The 104 CFB games in
         the committed record, every one of them with close_source null, are
         what that looks like from outside. A close is a separate fetch from
         a score and can arrive later than one, so it is asked for on every
         run, for every game that has not got one yet, whoever settled it. */
      const wantClose = [];
      byId.forEach(v => {
        if (v.entry.closing_spread === null || v.entry.closing_spread === undefined) wantClose.push(v);
      });
      if (wantClose.length && !args.verify) {
        /* the per-game route first: it is the exact one, joined by id on the
           server, and it costs one request per game so it is capped. A game
           this run already settled was asked by name at settle time and
           answered nothing, so asking again in the same run is 104 requests
           for the same silence. */
        let askedClose = 0;
        for (const v of wantClose) {
          if (settledNow[String(v.game.game_id)]) continue;
          if (askedClose >= 60) break;
          askedClose++;
          const c = await capturedClose(sp.code, v.game.game_id, token);
          if (c && c.closing_spread !== null && c.closing_spread !== undefined) {
            Object.assign(v.entry, recordEntry(v.game, v.entry, { ...c, source: 'collective_odds' }, v.entry.score_source));
          }
        }
        /* then the board, by week, for whatever it could not name: one
           request per week rather than one per game, and the join that makes
           a truncated college name reach the row that holds its close */
        const still = wantClose.filter(v =>
          v.entry.closing_spread === null || v.entry.closing_spread === undefined);
        if (still.length) {
          const found = await closesFromBoard(sp.code, sp.season, still.map(v => v.game), token, log);
          let n = 0;
          still.forEach(v => {
            const hit = found[String(v.game.game_id)];
            if (!hit) return;
            Object.assign(v.entry, recordEntry(v.game, v.entry,
              { ...hit.close, source: 'collective_odds_board' }, v.entry.score_source));
            n++;
          });
          if (n) log(`  ${sp.code}: ${n} captured closing line(s) recovered from the odds board`);
        }
        const left = wantClose.filter(v =>
          v.entry.closing_spread === null || v.entry.closing_spread === undefined).length;
        report.closes.push({ sport: sp.code, season: sp.season,
          wanted: wantClose.length, recovered: wantClose.length - left, still_missing: left });
        if (left) log(`  ${sp.code}: ${left} finished game(s) still carry no captured close ` +
          '(they are graded on their score alone and have no against-the-spread result)');
      }
      const file = recordPath(args.record, sp.code, sp.season);
      const merged = mergeRecord(loadRecord(file), sp.code, sp.season, entries, nowIso);
      if (merged.changed) writeRecord(file, merged.record);
      const n = Object.keys(merged.record.games).length;
      report.record.push({ sport: sp.code, season: sp.season, file, games: n, changed: merged.changed });
      log(`  record ${file}: ${n} settled game(s)${merged.changed ? ', updated' : ', unchanged'}`);
    }
  }

  report.would_settle = batch.map(b => ({ label: b.label, ...b.body }));
  if (args.json) console.log(JSON.stringify(report, null, 2));
  return report.failed.length ? 2 : 0;
}

module.exports = {
  oddsBoard, closeFromBoardRow, findBoardRow, closesFromBoard, backfillCloses, CLOSE_FIELDS,
  teamKey, teamsAgree, teamsAgreeAny, namesOf, gameMatches, datesAgree, ymd, isFinalScore,
  isPlaceholderResult, espnCompleted,
  findFinal, findAcrossSources, settleBody, needsSettling, parseCsv,
  normNfl, normCfb, normEspn, espnUrl, compactDate, parseArgs,
  feedTeamKeys, truncationIsAmbiguous,
  directConfig, columnsFrom, dbClient, gameFromDetail, seasonsFrom, gradeProjection,
  countingRows, settleDirect,
  recordPath, loadRecord, recordEntry, mergeRecord, writeRecord, RECORD_SCHEMA,
  FEED, ODDS_LEAGUE,
};

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    console.error(`[settle] ${e.message}`);
    process.exit(1);
  });
}
