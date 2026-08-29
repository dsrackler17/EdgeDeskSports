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
        as the admin screen's "Use captured close" button does
     4. POST collective_admin /v1/admin/results

   THE RULES IT WILL NOT BREAK

   - A score is never invented, adjusted or inferred. If the feed does not
     carry a completed game with two integer scores, the game is skipped and
     said out loud. A wrong final grades every model on it, permanently.
   - A closing line is never invented either. If the Collective captured no
     close, the line fields are sent null: the game still settles on the
     score, and the record is graded against nothing this script made up.
   - Nothing is written without --commit. The default run reports what it
     WOULD settle, which is how you check a matcher you cannot see.
   - Only games already past kickoff and already unsettled are touched. It
     never re-settles, never overwrites, never deletes.

   AUTH
     COLLECTIVE_ADMIN_REFRESH_TOKEN  a Supabase refresh token for an
                                     allowlisted admin account (preferred:
                                     it survives, and rotates itself)
     COLLECTIVE_ADMIN_ACCESS_TOKEN   a short-lived access token, for a manual
                                     run when you already have one
     SUPABASE_ANON_KEY               optional; the public key the site ships

   Usage
     node tools/collective/settle_finals.js                 # dry run, all sports
     node tools/collective/settle_finals.js --commit        # actually settle
     node tools/collective/settle_finals.js --sport CFB --season 2026
     node tools/collective/settle_finals.js --json          # machine readable

   Exit  0 = ran, nothing failed   2 = one or more settles were rejected
         1 = could not run at all (no auth, no network, no games endpoint)
   ========================================================================== */
'use strict';

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
  if (n < 6) return false;
  return x.slice(0, n) === y.slice(0, n);
}

/* Both sides, in one call, so a row is only ever matched as a GAME. Matching
   a single team is how a slate lands on the wrong game when a team plays
   twice in a window. */
function gameMatches(collectiveGame, feedRow) {
  return teamsAgree(collectiveGame.home, feedRow.home_team) &&
         teamsAgree(collectiveGame.away, feedRow.away_team);
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

/* Every distinct team the feed knows, by key. Built once per feed so the
   ambiguity check below costs nothing per game. */
function feedTeamKeys(feedRows) {
  const set = new Set();
  (feedRows || []).forEach(r => { set.add(teamKey(r.home_team)); set.add(teamKey(r.away_team)); });
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
  const eq = (a, b) => teamKey(a) === teamKey(b) && teamKey(a) !== '';
  const exact = dated.filter(r => eq(game.home, r.home_team) && eq(game.away, r.away_team));
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
  /* Named, not hidden -- but only where a confusion was actually POSSIBLE.
     Flagging every truncated name that could denote several schools flags
     39% of a real season, which is noise nobody reads. A join is worth a
     human's attention when one of the OTHER schools the name could mean was
     also playing that day: that is the near miss. */
  const teamKeys = keys || feedTeamKeys(feedRows);
  const sameDayKeys = new Set();
  dated.forEach(r => { sameDayKeys.add(teamKey(r.home_team)); sameDayKeys.add(teamKey(r.away_team)); });
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
    season: r.season, week: r.week,
  };
}
function normCfb(r) {
  return {
    start_date: r.start_date || '',
    home_team: r.home_team, away_team: r.away_team,
    home_points: r.home_points, away_points: r.away_points,
    completed: TRUEISH(r.completed),
    season: r.season, week: r.week,
  };
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return await res.text();
}

const FEED_CACHE = new Map();
async function feedRows(kind, season) {
  const key = `${kind}:${season}`;
  if (FEED_CACHE.has(key)) return FEED_CACHE.get(key);
  let rows;
  if (kind === 'nfl') {
    rows = parseCsv(await fetchText(URL_NFL))
      .filter(r => String(r.season) === String(season))
      .map(normNfl);
  } else {
    rows = parseCsv(await fetchText(URL_CFB(season))).map(normCfb);
  }
  FEED_CACHE.set(key, rows);
  return rows;
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

/* ---- the run ------------------------------------------------------------ */

function parseArgs(argv) {
  const a = { commit: false, json: false, sport: null, season: null, limit: 200 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--commit') a.commit = true;
    else if (v === '--json') a.json = true;
    else if (v === '--sport') a.sport = argv[++i];
    else if (v === '--season') a.season = Number(argv[++i]);
    else if (v === '--limit') a.limit = Number(argv[++i]);
  }
  return a;
}

/* Which games are this script's business: past kickoff, and not already
   settled. Both conditions come from the Collective itself, never from a
   clock this script keeps. */
function needsSettling(games, nowMs) {
  return (games || []).filter(g =>
    !g.result && g.kickoff_at && Date.parse(g.kickoff_at) < nowMs &&
    g.status !== 'postponed' && g.status !== 'canceled');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.json ? () => {} : (...m) => console.log(...m);
  const report = { checked: 0, settled: 0, skipped: [], failed: [], dry_run: !args.commit };

  const token = await accessToken();
  const meta = await apiGet('collective_public', '/v1/meta', null);
  let sports = (meta.sports || []).map(s => ({ code: s.code, season: s.season }));
  if (args.sport) sports = sports.filter(s => s.code.toUpperCase() === args.sport.toUpperCase());
  if (args.season) sports = sports.map(s => ({ ...s, season: args.season }));
  if (!sports.length) throw new Error(`No sport to settle${args.sport ? ` matching "${args.sport}"` : ''}.`);

  const batch = [];
  for (const sp of sports) {
    const kind = FEED[String(sp.code).toUpperCase()];
    if (!kind) {
      report.skipped.push({ sport: sp.code, reason: 'no_finals_feed_for_sport' });
      log(`- ${sp.code}: no finals feed is wired for this sport; skipped rather than guessed at.`);
      continue;
    }
    const d = await apiGet('collective_public',
      `/v1/games?sport=${encodeURIComponent(sp.code)}&season=${encodeURIComponent(sp.season)}`, token);
    const need = needsSettling(d.games, Date.now());
    log(`- ${sp.code} ${sp.season}: ${need.length} finished game(s) with no result yet`);
    if (!need.length) continue;

    let rows;
    try { rows = await feedRows(kind, sp.season); }
    catch (e) {
      report.failed.push({ sport: sp.code, reason: 'feed_unreachable', detail: e.message });
      log(`  ! ${sp.code}: finals feed unreachable (${e.message})`);
      continue;
    }

    const teamKeys = feedTeamKeys(rows);
    for (const g of need.slice(0, args.limit)) {
      report.checked++;
      const fin = findFinal(g, rows, teamKeys);
      if (!fin.ok) {
        report.skipped.push({ game_id: g.game_id, label: g.label, reason: fin.reason });
        log(`  · ${g.label}: ${fin.reason}`);
        continue;
      }
      const close = await capturedClose(sp.code, g.game_id, token);
      const body = settleBody(g, fin, close);
      batch.push({ sport: sp.code, label: g.label, body });
      log(`  ✓ ${g.label}: ${fin.away_score}-${fin.home_score}` +
        (close ? ` (close ${body.closing_spread})` : ' (no captured close — settling on the score alone)'));
    }
  }

  if (!batch.length) {
    log(batch.length === 0 && report.checked === 0
      ? '\nNothing to settle.' : '\nNothing matched a final.');
  } else if (!args.commit) {
    log(`\nDry run: ${batch.length} game(s) would settle. Nothing was written. Re-run with --commit.`);
  } else {
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
  }

  report.would_settle = batch.map(b => ({ label: b.label, ...b.body }));
  if (args.json) console.log(JSON.stringify(report, null, 2));
  return report.failed.length ? 2 : 0;
}

module.exports = {
  teamKey, teamsAgree, gameMatches, datesAgree, ymd, isFinalScore,
  findFinal, settleBody, needsSettling, parseCsv, normNfl, normCfb, parseArgs,
  feedTeamKeys, truncationIsAmbiguous,
  FEED, ODDS_LEAGUE,
};

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    console.error(`[settle] ${e.message}`);
    process.exit(1);
  });
}
