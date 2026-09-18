#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL STATS IMPORTER

   Reads box scores for games already in cbb.games and turns them into player
   lines. The season archive is then folded out of those lines by SQL, so
   nothing here computes a rate — this file's whole job is to turn a labelled
   array of strings into typed, honest columns.

   Split the same way as ingest.js: everything above module.exports is pure and
   unit-tested without a network, and the network half only runs as a CLI.

   FOUR THINGS THIS FILE KNOWS THAT THE SOURCE DOES NOT SAY OUT LOUD
   (all four read off live payloads, not assumed):

   1. THE GROUP NAMES ARE UNRELIABLE. In games that actually carry athletes,
      each statistics group's `name` comes back undefined; in games whose
      groups are empty, it is spelled "batting" and "pitching". Keying off the
      name would therefore work perfectly on every game with no data in it and
      fail on every game with data. So the kind of line is decided from the
      LABELS.

   2. THE BROWSER USER AGENT IS NOT OPTIONAL. /scoreboard and /teams answer
      without one. /summary returns an Akamai deny page without one, and 44KB
      of JSON with one. That cost two wrong diagnoses to find, so it is stated
      here rather than left as a mysterious header.

   3. "6.2" IS 20 OUTS. See toOuts. This is the whole reason the schema stores
      outs and not innings.

   4. THE RATE COLUMNS ARE SEASON-TO-DATE. AVG/OBP/SLG on a batting line and
      ERA on a pitching line are the player's season figures as of that game,
      not that game's rates. They are carried under names that say so and are
      never treated as game statistics.
   =========================================================================== */
'use strict';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';

/* ESPN's public endpoints split on this. Not decoration — see note 2 above. */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/* ── innings ──────────────────────────────────────────────────────────────
   Baseball writes partial innings in thirds after the point: 6.1 is six and
   one out, 6.2 is six and two. There is no 6.3. Anything else in that
   position is a payload this code does not understand, and guessing is worse
   than refusing. */
function toOuts(ip) {
  if (ip === null || ip === undefined || ip === '') return null;
  const s = String(ip).trim();
  const m = /^(\d+)(?:\.(\d))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] === undefined ? 0 : Number(m[2]);
  if (frac > 2) return null;   /* .3 is not a third of an inning; it is a bug */
  return whole * 3 + frac;
}

/* The inverse, for display only. Never used in arithmetic. */
function outsToIp(outs) {
  if (outs === null || outs === undefined) return null;
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

const num = (v) => {
  if (v === null || v === undefined || v === '' || v === '-' || v === '--') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* A rate written ".296" parses fine as a number; one written "-" does not and
   must stay null rather than become zero. */
const rate = (v) => {
  const n = num(v);
  return n === null ? null : n;
};

/* "109-71" is pitches thrown and strikes thrown. "1-3" is hits and at-bats. */
function splitPair(v) {
  if (v === null || v === undefined) return [null, null];
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}

/* ── which kind of line is this? ──────────────────────────────────────────
   Decided from the labels, for the reason in note 1. Batting carries AB and
   RBI; pitching carries IP and ER. A group matching neither is not guessed at. */
function lineTypeOf(labels) {
  const L = (labels || []).map((x) => String(x).toUpperCase());
  const hasAll = (...want) => want.every((w) => L.indexOf(w) >= 0);
  if (hasAll('AB', 'RBI')) return 'batting';
  if (hasAll('IP', 'ER')) return 'pitching';
  return null;
}

/* Map a labelled row to columns by LABEL, never by position. ESPN has been
   stable about label order, but a dataset that breaks silently when a column
   is inserted is a dataset that will break silently. */
function byLabel(labels, stats) {
  const out = {};
  (labels || []).forEach((lab, i) => { out[String(lab).toUpperCase()] = stats ? stats[i] : undefined; });
  return out;
}

/* Some athlete display names arrive with a position spliced into them, e.g.
   "Nicholas - P Finarelli". Stripping that is cosmetic, but a name is how a
   reader finds a player, and a search for "Finarelli" should find him. */
function cleanName(name) {
  if (!name) return null;
  return String(name).replace(/\s+-\s+[A-Z]{1,3}\s+/, ' ').replace(/\s{2,}/g, ' ').trim() || null;
}

/* ── one player's line in one game ───────────────────────────────────────── */
function shapeLine(ctx, lineType, labels, entry) {
  const ath = entry.athlete || {};
  const id = ath.id !== undefined && ath.id !== null ? String(ath.id) : null;
  if (!id) return null;                      /* an unnamed line cannot be keyed */
  const name = cleanName(ath.displayName || ath.fullName || ath.shortName);
  if (!name) return null;
  const v = byLabel(labels, entry.stats);

  const row = {
    game_id: ctx.game_id,
    athlete_id: id,
    line_type: lineType,
    season: ctx.season,
    game_date: ctx.game_date,
    team_id: ctx.team_id,
    team_name: ctx.team_name,
    opponent_team_id: ctx.opponent_team_id,
    athlete_name: name,
    position: (entry.position && (entry.position.abbreviation || entry.position.name))
      || (ath.position && (ath.position.abbreviation || ath.position.name)) || null,
    jersey: ath.jersey !== undefined && ath.jersey !== null ? String(ath.jersey) : null,
    starter: entry.starter === undefined ? null : !!entry.starter,
    ab: null, runs: null, hits: null, rbi: null, hr: null, bb: null, so: null,
    pitches_seen: null, stolen_bases: null,
    outs: null, p_hits: null, p_runs: null, earned_runs: null,
    p_bb: null, p_so: null, p_hr: null, pitch_count: null, strikes: null,
    season_avg_at_game: null, season_obp_at_game: null,
    season_slg_at_game: null, season_era_at_game: null,
    source: 'espn_summary',
  };

  if (lineType === 'batting') {
    row.ab = num(v.AB);
    row.runs = num(v.R);
    row.hits = num(v.H);
    row.rbi = num(v.RBI);
    row.hr = num(v.HR);
    row.bb = num(v.BB);
    row.so = num(v.K !== undefined ? v.K : v.SO);
    row.pitches_seen = num(v['#P']);
    /* "1-3" in the H-AB column is a redundant encoding of H and AB. Used only
       to fill a gap, never to override the explicit columns, because if the two
       ever disagree the explicit ones are the ones the labels promised. */
    if (row.hits === null || row.ab === null) {
      const [h, ab] = splitPair(v['H-AB']);
      if (row.hits === null) row.hits = h;
      if (row.ab === null) row.ab = ab;
    }
    row.season_avg_at_game = rate(v.AVG);
    row.season_obp_at_game = rate(v.OBP);
    row.season_slg_at_game = rate(v.SLG);
  } else {
    row.outs = toOuts(v.IP);
    row.p_hits = num(v.H);
    row.p_runs = num(v.R);
    row.earned_runs = num(v.ER);
    row.p_bb = num(v.BB);
    row.p_so = num(v.K !== undefined ? v.K : v.SO);
    row.p_hr = num(v.HR);
    const [pc, st] = splitPair(v['PC-ST']);
    row.pitch_count = pc !== null ? pc : num(v.PC);
    row.strikes = st;
    row.season_era_at_game = rate(v.ERA);
  }
  return row;
}

/* ── the whole box score of one game ─────────────────────────────────────── */
function shapeBoxScore(summary, game) {
  if (!summary || !game) return { lines: [], had_players: false };
  const bs = summary.boxscore || (summary.gamepackageJSON && summary.gamepackageJSON.boxscore) || {};
  const sides = bs.players || [];
  const lines = [];
  let had = false;

  /* Which club is the opponent depends on which side we are reading. */
  const other = (teamId) => {
    if (!teamId) return null;
    if (String(teamId) === String(game.home_team_id)) return game.away_team_id || null;
    if (String(teamId) === String(game.away_team_id)) return game.home_team_id || null;
    return null;
  };

  for (const side of sides) {
    const team = side.team || {};
    const teamId = team.id !== undefined && team.id !== null ? String(team.id) : null;
    const ctx = {
      game_id: String(game.game_id),
      season: game.season,
      game_date: game.game_date,
      team_id: teamId,
      team_name: team.displayName || team.name || team.abbreviation || game.home_name,
      opponent_team_id: other(teamId),
    };
    for (const group of (side.statistics || [])) {
      const lineType = lineTypeOf(group.labels);
      if (!lineType) continue;
      for (const entry of (group.athletes || [])) {
        const row = shapeLine(ctx, lineType, group.labels, entry);
        if (row) { lines.push(row); had = true; }
      }
    }
  }

  /* Stolen bases live only in the rosters branch (see the schema's TRAP 3), so
     they are merged onto the batting lines already built rather than creating
     new ones. A player who appears only in rosters and not in the box score
     has no line to attach to, and inventing one would invent at-bats. */
  const sbById = new Map();
  for (const r of (summary.rosters || [])) {
    for (const p of (r.roster || [])) {
      const id = p.athlete && p.athlete.id !== undefined ? String(p.athlete.id) : null;
      if (!id) continue;
      for (const st of (p.stats || [])) {
        const key = String(st.name || st.abbreviation || '').toLowerCase();
        if (key === 'stolenbases' || key === 'sb') {
          const n = num(st.value !== undefined ? st.value : st.displayValue);
          if (n !== null) sbById.set(id, n);
        }
      }
    }
  }
  for (const row of lines) {
    if (row.line_type === 'batting' && sbById.has(row.athlete_id)) {
      row.stolen_bases = sbById.get(row.athlete_id);
    }
  }

  return { lines, had_players: had };
}

/* A line that cannot be true is a mapping error, and it is better to drop the
   game and say so than to promote numbers that are individually plausible.
   The promote gate refuses these too; catching them here names the game. */
function implausible(row) {
  if (row.line_type === 'batting') {
    if (row.ab !== null && row.hits !== null && row.hits > row.ab) return 'hits exceed at-bats';
    if (row.ab !== null && row.ab < 0) return 'negative at-bats';
  } else {
    if (row.outs !== null && row.outs < 0) return 'negative outs';
    if (row.earned_runs !== null && row.p_runs !== null && row.earned_runs > row.p_runs) {
      return 'earned runs exceed runs';
    }
  }
  return null;
}

module.exports = {
  ESPN, BROWSER_UA,
  toOuts, outsToIp, num, rate, splitPair, lineTypeOf, byLabel, cleanName,
  shapeLine, shapeBoxScore, implausible,
};

/* ── the network half ───────────────────────────────────────────────────── */
if (require.main === module) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const has = (n) => argv.indexOf(n) >= 0;

  async function getSummary(eventId, tries = 3) {
    for (let i = 0; i < tries; i++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 25000);
      try {
        const r = await fetch(`${ESPN}/summary?event=${eventId}`, {
          signal: ctl.signal,
          headers: { accept: 'application/json', 'user-agent': BROWSER_UA },
        });
        const body = await r.text();
        clearTimeout(t);
        if (r.status === 200) { try { return JSON.parse(body); } catch (_) { return null; } }
        /* a 403 here means the UA was dropped, which is a bug, not a throttle */
        if (r.status === 403 && i === tries - 1) {
          console.log(`[cbb-stats] 403 on event ${eventId} — the browser UA is missing or refused`);
        }
      } catch (_) { clearTimeout(t); }
      await sleep(800 * (i + 1));
    }
    return null;
  }

  (async function main() {
    const season = Number(arg('--season', new Date().getFullYear()));
    const pace = Number(arg('--pace', 150));
    const limit = Number(arg('--limit', 0));       /* 0 = every completed game */
    const log = (...a) => console.log('[cbb-stats]', ...a);

    if (!has('--check') && !has('--commit')) {
      console.log('Nothing to do. Pass --check (fetch and validate, write nothing) or --commit.');
      process.exit(0);
    }

    /* The games this reads are the ones the game log already has. That is the
       point: the stats archive can never contain a game the log does not, and
       the ORPHAN_GAME refusal in the promote enforces the same thing in SQL. */
    const { createDb } = require('./db');
    const db = createDb();
    const games = await db.completedGames(season, limit);
    log(`${games.length} completed games in the ${season} log`);
    if (!games.length) {
      console.log(`FAIL | cbb stats | the ${season} game log has no completed games to read`);
      process.exit(1);
    }

    const lines = [];
    let withPlayers = 0, without = 0, failed = 0, dropped = 0;
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const s = await getSummary(g.game_id);
      if (!s) { failed++; if (pace) await sleep(pace); continue; }
      const { lines: rows, had_players } = shapeBoxScore(s, g);
      const bad = rows.map(implausible).filter(Boolean);
      if (bad.length) {
        /* name the game rather than silently keeping a bad mapping */
        log(`dropping game ${g.game_id}: ${bad[0]} (${bad.length} of ${rows.length} lines)`);
        dropped++;
      } else if (had_players) {
        withPlayers++;
        for (const r of rows) lines.push(r);
      } else {
        without++;
      }
      if ((i + 1) % 250 === 0) {
        log(`${i + 1}/${games.length} read, ${lines.length} lines so far`);
      }
      if (pace) await sleep(pace);
    }

    const cov = games.length ? (withPlayers / games.length) : 0;
    log(`${withPlayers} games with lines, ${without} without, ${failed} unreadable, `
      + `${dropped} dropped as implausible`);
    log(`${lines.length} player lines; coverage ${(cov * 100).toFixed(1)}% of completed games`);

    if (!lines.length) {
      console.log('FAIL | cbb stats | no player lines at all — nothing would be written');
      process.exit(1);
    }

    if (!has('--commit')) {
      const players = new Set(lines.map((r) => r.athlete_id)).size;
      console.log(`PASS | cbb stats | --check only, nothing written `
        + `(${lines.length} lines, ${players} players, ${withPlayers} games)`);
      process.exit(0);
    }

    const { stageAndPromoteStats } = require('./stage_stats');
    const importId = `cbb-stats-${season}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    const res = await stageAndPromoteStats(db, importId, {
      lines, season, allowShrink: has('--allow-shrink'),
      sourceNote: `espn summary box scores; ${withPlayers}/${games.length} completed games carried lines`,
    });
    if (!res.ok) {
      console.log(`FAIL | cbb stats | refused: ${JSON.stringify(res.refusals)}`);
      process.exit(1);
    }
    console.log(`PASS | cbb stats | promoted ${res.player_games} lines, `
      + `${res.player_seasons} player seasons, ${res.team_stat_seasons} club seasons`);
  })().catch((e) => {
    console.log(`FAIL | cbb stats | ${(e && e.stack) || e}`);
    process.exit(1);
  });
}
