#!/usr/bin/env node
/* ============================================================================
   THE FINAL-GAME DETECTOR — "is there football the board has not read yet?"

   WHY THIS EXISTS. The rankings build is expensive: four seasons of play
   tables, a player layer, an opponent-adjustment fixed point per metric. It is
   fine to run daily and it is not fine to run every twenty minutes on the
   chance that a game finished. This asks the cheap question first — one CSV,
   a few hundred kilobytes — so the scheduler can run OFTEN and rebuild ONLY
   when a game has actually gone final.

   HOW IT DECIDES, and why it is not a count. The published board records the
   exact set of FINAL games it stood on, as a digest (`data_freshness.
   completed_games_digest`). A count can hold still while the set changes: a
   result is corrected, a forfeit is reversed, a feed republishes a week. The
   digest cannot. So the comparison is identity, not arithmetic.

   AND IT ASKS BOTH FEEDS, because the schedule is not always the faster one.
   SMU beat Florida State 27-24 on 7 September 2026 and the schedule feed still
   said `completed=FALSE` the next day, while the ESPN box already carried both
   teams' lines. A detector that watched only the schedule would have let that
   game sit unread until the daily safety rebuild. The box is 137 KB for a
   season in progress, so asking it too is still cheap — and if it will not
   load, the check falls back to the box artifact the last build committed and
   says which it used.

   IT FAILS TOWARD REBUILDING. If the board cannot be read, if it carries no
   digest (an older build), if the feed will not load, or if anything is
   ambiguous, the answer is STALE and the rebuild runs. The expensive mistake
   is skipping a rebuild that was needed; running one that was not costs a few
   minutes of a runner.

     node football/rankings/refresh.js [--season 2026] [--cache DIR] [--quiet]
                                       [--max-age-hours 24] [--json]

   Exit 0  = a rebuild is needed (new FINAL games, or the board is too old, or
             the state could not be established).
   Exit 10 = nothing new; the scheduler may skip the rebuild.
   Exit 1  = the check itself could not run.

   In GitHub Actions it also writes `rebuild=true|false`, `reason=...` and the
   game counts to $GITHUB_OUTPUT, so the workflow gates on the verdict rather
   than re-deriving it.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const B = require('../players/build_players.js');
const BR = require('./build_rankings.js');
const BOX = require('../data/build_box.js');

const DIR = __dirname;
const CUR = path.join(DIR, 'current.json');
const HEALTH = path.join(DIR, 'health.json');
const BOX_DIR = path.join(DIR, '..', 'data', 'box');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const QUIET = !!arg('quiet', false);
const AS_JSON = !!arg('json', false);
function log(...a) { if (!QUIET && !AS_JSON) console.log(...a); }
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
const SEASON = +(arg('season', defaultSeason()));
const MAX_AGE_H = +(arg('max-age-hours', 24));

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }

/* THE GAMES THE BOX SAYS WERE PLAYED, in the shape reconcileFinality() wants.
   Live if it will load, the last committed artifact if it will not, and it
   says which — a detector that silently degraded would be worse than one that
   rebuilt too often. */
async function boxNow(season) {
  try {
    const got = await BOX.loadSeasonCsv(season);
    if (got && got.text) {
      const nl = got.text.indexOf('\n');
      const ix = B.headerIndex(got.text.slice(0, nl));
      if (ix.game_id != null && ix.team_id != null) {
        const team_games = {};
        let pos = nl + 1;
        while (pos < got.text.length) {
          let end = got.text.indexOf('\n', pos); if (end < 0) end = got.text.length;
          const line = got.text.charCodeAt(end - 1) === 13 ? got.text.slice(pos, end - 1) : got.text.slice(pos, end);
          pos = end + 1;
          if (!line) continue;
          const r = B.splitLine(line);
          if (!r[ix.game_id] || !r[ix.team_id]) continue;
          team_games[r[ix.game_id] + '|' + r[ix.team_id]] = 1;
        }
        return { team_games, source: 'live (' + got.format + ')' };
      }
    }
  } catch (_) { /* fall through to the committed artifact */ }
  const committed = readJson(path.join(BOX_DIR, season + '.json'));
  if (committed && committed.team_games) return { team_games: committed.team_games, source: 'the last committed box artifact' };
  return { team_games: null, source: 'unavailable' };
}

/* the set of FINAL games in the feeds right now, digested the same way the
   build digests the set it read */
function finalGames(sched) {
  const ids = [], byOrdinal = {};
  let latest = null;
  for (const g of sched.games) {
    if (!BR.isFinal(g)) continue;
    ids.push(String(g.game_id));
    const ord = BR.weekOrdinal(g.season_type, g.week);
    byOrdinal[ord] = (byOrdinal[ord] || 0) + 1;
    if (g.start_date && (latest == null || g.start_date > latest)) latest = g.start_date;
  }
  return {
    ids, count: ids.length, latest_kickoff: latest, by_week_ordinal: byOrdinal,
    digest: crypto.createHash('sha1').update(ids.slice().sort().join(',')).digest('hex').slice(0, 16)
  };
}

async function check(opts) {
  opts = opts || {};
  const sched = opts.schedule || await B.loadSchedule(SEASON);
  /* THE SAME FINALITY RULE THE BUILD USES. Without this the detector's digest
     could never match a board that counted a box-confirmed game, and every
     check would say "rebuild" for ever. */
  const box = opts.box !== undefined ? opts.box : await boxNow(SEASON);
  const rec = BR.reconcileFinality(sched, box && box.team_games ? { team_games: box.team_games } : null);
  const now = finalGames(sched);
  const cur = opts.current !== undefined ? opts.current : readJson(CUR);
  const health = opts.health !== undefined ? opts.health : readJson(HEALTH);

  const out = {
    season: SEASON,
    feed: { final_games: now.count, latest_kickoff: now.latest_kickoff, digest: now.digest,
      box_source: (box && box.source) || 'unavailable',
      confirmed_by_box_alone: rec.confirmed_by_box.length,
      box_only_games: rec.confirmed_by_box.map(g => g.game_id) },
    board: null, rebuild: true, reason: null, new_games: null,
    last_build: (health && health.last_rankings_build) || (cur && cur.generated_at) || null
  };

  if (!cur) { out.reason = 'no published rankings artifact on disk, so there is nothing to compare against and the board has to be built'; return out; }
  const fresh = cur.data_freshness || {};
  out.board = { season: cur.season, week_label: cur.week_label, week_ordinal: cur.week_ordinal,
    final_games: fresh.completed_games == null ? null : fresh.completed_games,
    digest: fresh.completed_games_digest || null,
    generated_at: cur.generated_at || null };

  if (cur.season !== SEASON) {
    out.reason = `the published board is season ${cur.season} and this check is season ${SEASON} — a season boundary always rebuilds`;
    return out;
  }
  if (!fresh.completed_games_digest) {
    out.reason = 'the published board carries no completed-game digest (it predates this check), so whether it is current cannot be established and the safe answer is to rebuild';
    return out;
  }
  if (fresh.completed_games_digest !== now.digest) {
    const delta = now.count - (fresh.completed_games || 0);
    out.new_games = delta;
    out.reason = delta > 0
      ? `${delta} game(s) have gone FINAL since the board was built (${fresh.completed_games} -> ${now.count})`
      : `the set of FINAL games has changed without growing (${fresh.completed_games} -> ${now.count}) — a result was corrected, reversed or republished, which moves ratings exactly as a new game does`;
    return out;
  }

  /* the same football. Rebuild anyway if the board has gone stale on the
     clock: the SAFETY REBUILD exists so a broken feed shows up as a build that
     ran and found nothing, rather than as a board nobody has looked at. */
  const at = out.last_build ? Date.parse(out.last_build) : NaN;
  const ageH = isFinite(at) ? (Date.now() - at) / 3600000 : null;
  out.age_hours = ageH == null ? null : Math.round(ageH * 10) / 10;
  if (ageH == null) {
    out.reason = 'no readable build timestamp, so the age of the board cannot be established and the safe answer is to rebuild';
    return out;
  }
  if (ageH > MAX_AGE_H) {
    out.reason = `no new FINAL games, but the last successful build was ${Math.round(ageH)}h ago, past the ${MAX_AGE_H}h safety bound`;
    return out;
  }
  out.rebuild = false;
  out.new_games = 0;
  out.reason = `no new FINAL games (${now.count} on file, digest ${now.digest}) and the board was built ${Math.round(ageH)}h ago`;
  return out;
}

async function main() {
  let res;
  try { res = await check(); }
  catch (e) {
    console.error('REFRESH CHECK FAILED: ' + (e && e.message || e));
    return 1;
  }
  if (AS_JSON) console.log(JSON.stringify(res, null, 1));
  else {
    log(`EdgeDesk rankings refresh check — season ${res.season}`);
    log(`  feed:  ${res.feed.final_games} FINAL games, latest kickoff ${res.feed.latest_kickoff || '—'}, digest ${res.feed.digest}`);
    log(`  box:   ${res.feed.box_source}` + (res.feed.confirmed_by_box_alone
      ? `, and it alone confirms ${res.feed.confirmed_by_box_alone} game(s): ${res.feed.box_only_games.join(', ')}` : ''));
    log(`  board: ${res.board ? (res.board.final_games + ' FINAL games, digest ' + res.board.digest + ', ' + res.board.week_label) : 'none published'}`);
    log(`  last successful build: ${res.last_build || '—'}${res.age_hours != null ? ` (${res.age_hours}h ago)` : ''}`);
    log(`  verdict: ${res.rebuild ? 'REBUILD' : 'UP TO DATE'} — ${res.reason}`);
  }
  const gh = process.env.GITHUB_OUTPUT;
  if (gh) {
    try {
      fs.appendFileSync(gh, `rebuild=${res.rebuild}\n`
        + `reason=${String(res.reason).replace(/[\r\n]+/g, ' ')}\n`
        + `final_games=${res.feed.final_games}\n`
        + `new_games=${res.new_games == null ? '' : res.new_games}\n`
        + `digest=${res.feed.digest}\n`);
    } catch (_) {}
  }
  return res.rebuild ? 0 : 10;
}

module.exports = { check, finalGames, boxNow, main };
if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('REFRESH CHECK FAILED:', e && e.stack || e); process.exit(1); });
}
