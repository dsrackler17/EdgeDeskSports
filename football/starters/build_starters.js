#!/usr/bin/env node
/* ============================================================================
   BUILD THE STARTER CONTEXT — college football and the NFL, from public feeds.

   THE QUESTION THIS ANSWERS. "Who is starting at quarterback?" has five honest
   answers and the board was giving one of them: nothing. This job goes and
   gets the evidence that exists, resolves it to real players on the CURRENT
   season's roster, and writes a record per team that says which kind of answer
   it is.

   WHERE EACH KIND COMES FROM, AND WHAT IT CANNOT COME FROM

     PREVIOUS_GAME  cfbfastR-data player_stats (college) and nflverse
                    play-by-play (NFL). Both attribute every dropback to a
                    named athlete id, so "who took the first dropback of the
                    last game" is read, not inferred.
     DEPTH_CHART    nflverse depth charts (NFL, timestamped, refreshed daily).
                    College: ESPN's depth-chart endpoints, which currently
                    refuse this repository — the refusal is recorded per
                    source and the field falls through, it is not faked.
     EXPECTED       reputable reporting, through the availability collectors'
                    existing source tiers. Media evidence can reach EXPECTED
                    and no further.
     ANNOUNCED      an official team or conference source. College football
                    has no league-wide filing, and the source registry
                    (football/availability/sources.json) currently carries no
                    official availability URL for any programme, so this state
                    is REACHABLE and presently EMPTY for college. NFL game-day
                    inactives are the same shape and are not scraped here.
     COMPETITION    two players with comparable recent dropback share, or two
                    sources at the same tier naming different people.

   Availability rides alongside, never inside: football/availability/current.json
   for college and nflverse injuries for the NFL.

     node football/starters/build_starters.js [--season 2026]
          [--sport cfb|nfl|both] [--offline] [--check] [--quiet]
          [--budget-ms N] [--no-depth]

   --check writes nothing and exits non-zero if the build could not run.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const S = require(path.join(HERE, 'starters.js'));
const R = require(path.join(ROOT, 'football', 'data', 'recovery.js'));

const CFB = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main';
const NFLV = 'https://github.com/nflverse/nflverse-data/releases/download';
const SCHEMA = 'edgedesk_starters_v1';

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }

/* ONE START, TURNED INTO EVIDENCE.

   A game whose opening dropback went to somebody who then threw 18% of them
   is NOT a game with no starter evidence — it is a game with two names in it,
   and the first version of this builder dropped it on the floor and reported
   the team as UNKNOWN. Both names are emitted at the same tier, which is what
   makes the resolver return COMPETITION instead of silence. */
function usageEvidence(last, o) {
  if (!last) return [];
  const common = {
    kind: 'GAME_USAGE', team: o.team, season: o.season, week: last.week,
    source: o.source, source_url: o.source_url,
    published_at: last.kickoff || null, retrieved_at: o.retrieved_at
  };
  const where = (last.opponent ? ` vs ${last.opponent}` : '');
  if (last.starter) {
    return [Object.assign({}, common, {
      player_id: last.starter.player_id, player_name: last.starter.player_name,
      detail: `${last.starter.dropbacks} of ${last.dropbacks} dropbacks in week ${last.week}${where}; ${last.why}`
    })];
  }
  const out = [];
  if (last.opened) out.push(Object.assign({}, common, {
    player_id: last.opened.player_id, player_name: last.opened.player_name,
    detail: `opened week ${last.week}${where} but took only ${Math.round((last.opened.share || 0) * 100)}% of the dropbacks`
  }));
  if (last.leader && (!last.opened || last.leader.player_id !== last.opened.player_id)) out.push(Object.assign({}, common, {
    player_id: last.leader.player_id, player_name: last.leader.player_name,
    detail: `led week ${last.week}${where} with ${Math.round((last.leader.share || 0) * 100)}% of the dropbacks but did not open the game`
  }));
  return out;
}


/* THE OPENER WHO DID NOT FINISH. Read off the same dropback counts, reported
   as participation and never as an injury. */
function participationOf(last, url, source) {
  if (!last || !last.opened || !last.leader) return null;
  if (last.opened.player_id === last.leader.player_id) return null;
  return { player_id: last.opened.player_id, share: last.opened.share, week: last.week,
    replaced_by: last.leader.player_name || last.leader.player_id, band: 0.5,
    source: source, source_url: url };
}

const QUIET = !!arg('quiet', false);
const log = (...a) => { if (!QUIET) console.error(...a); };

/* ======================================================================= CFB */

/* The play feed's four dropback columns, collapsed to one attribution per
   play. A play carries at most one of them for the passer. */
function cfbDropbackRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const pid = R.NA(r.completion_player_id) || R.NA(r.incompletion_player_id)
      || R.NA(r.sack_taken_player_id) || R.NA(r.interception_thrown_player_id);
    if (!pid) continue;
    const name = R.NA(r.completion_player) || R.NA(r.incompletion_player)
      || R.NA(r.sack_taken_player) || R.NA(r.interception_thrown_player);
    out.push({
      team: r.team, team_key: S.normKey(r.team), game_id: r.game_id,
      season: R.NUM(r.season), week: R.NUM(r.week), opponent: r.opponent || null,
      player_id: String(pid), player_name: name,
      /* play_id sorts the game. The feed's ids are monotonic inside a game;
         where one is missing the row order is used, which is the same thing. */
      order: R.NUM(r.play_id) != null ? R.NUM(r.play_id) : i
    });
  }
  return out;
}

/* CAREER STARTS, COUNTED RATHER THAN ASSUMED.

   The engine's QB layer is defined on efficiency AND on career starts, and
   docs/football-data-sources.md is explicit that no feed this repository
   reads carries EPA for college football — so the efficiency half stays null
   and is not approximated from yards. The START COUNT, though, is simply the
   number of games a player opened, and the play feed publishes that. Counted
   per PLAYER rather than per team, because a transfer's starts belong to him.

   The metric is named for what it is: starts in the seasons this build read,
   not a career total, because the feed begins in 2014 and the build reads two
   seasons of it. */
function startsByPlayer(usageBySeason) {
  const out = {};
  Object.keys(usageBySeason).forEach(y => {
    (usageBySeason[y] || []).forEach(g => {
      const st = S.starterOfGame(g);
      g.players.forEach(p => {
        const e = out[p.player_id] || (out[p.player_id] = { starts: 0, dropbacks: 0, seasons: {} });
        e.dropbacks += p.dropbacks;
        e.seasons[y] = true;
      });
      if (st && st.starter) {
        const e = out[st.starter.player_id] || (out[st.starter.player_id] = { starts: 0, dropbacks: 0, seasons: {} });
        e.starts++;
      }
    });
  });
  Object.keys(out).forEach(k => { out[k].seasons_observed = Object.keys(out[k].seasons).length; delete out[k].seasons; });
  return out;
}

async function buildCfb(sess, season, opts) {
  const notes = [], sources = [];
  const offline = !!opts.offline;

  const ps = await sess.cached(`${CFB}/player_stats/csv/player_stats_${season}.csv`,
    `pstats_${season}.csv`, { season, min_bytes: 5000, force: false, timeout_ms: 120000, retries: offline ? 0 : 2 });
  sources.push({ field: 'dropback attribution', url: ps.url, ok: ps.ok, from: ps.from, status: ps.status, error: ps.error, retrieved_at: ps.retrieved_at });
  if (!ps.ok) {
    return { ok: false, why: `player_stats_${season}.csv could not be read (${ps.error || ps.status})`, sources, notes };
  }

  const rosterCsv = await sess.cached(`${CFB}/rosters/csv/cfb_rosters_${season}.csv`,
    `rosters_${season}.csv`, { season, min_bytes: 5000, timeout_ms: 120000, retries: offline ? 0 : 2 });
  sources.push({ field: 'roster identity', url: rosterCsv.url, ok: rosterCsv.ok, from: rosterCsv.from, status: rosterCsv.status, error: rosterCsv.error, retrieved_at: rosterCsv.retrieved_at });

  const sched = await sess.cached(`${CFB}/schedules/csv/cfb_schedules_${season}.csv`,
    `cfb_schedules_${season}.csv`, { season, min_bytes: 5000, timeout_ms: 120000, retries: offline ? 0 : 2 });
  sources.push({ field: 'schedule', url: sched.url, ok: sched.ok, from: sched.from, status: sched.status, error: sched.error, retrieved_at: sched.retrieved_at });

  const PS_COLS = ['game_id', 'season', 'week', 'team', 'opponent', 'play_id',
    'completion_player_id', 'completion_player', 'incompletion_player_id', 'incompletion_player',
    'sack_taken_player_id', 'sack_taken_player', 'interception_thrown_player_id', 'interception_thrown_player'];
  const plays = R.parseCsv(ps.text, { columns: PS_COLS });
  const usage = S.usageFromPlays(cfbDropbackRows(plays));

  /* prior seasons, for the start count. A completed season never changes, so
     these are permanent cache entries (football/data/feed_cache.js) and the
     download happens once. --history 0 skips them and the record says the
     start count covers one season. */
  const history = opts.history == null ? 1 : opts.history;
  const usageBySeason = { [season]: usage };
  const seasonsRead = [season];
  for (let y = season - 1; y >= season - history; y--) {
    const h = await sess.cached(`${CFB}/player_stats/csv/player_stats_${y}.csv`,
      `pstats_${y}.csv`, { season, min_bytes: 5000, timeout_ms: 300000, retries: offline ? 0 : 1 });
    sources.push({ field: `start count ${y}`, url: h.url, ok: h.ok, from: h.from, status: h.status, error: h.error, retrieved_at: h.retrieved_at });
    if (!h.ok) { notes.push(`player_stats_${y}.csv did not answer (${h.error || h.status}), so the start count covers ${seasonsRead.join(', ')} only`); continue; }
    usageBySeason[y] = S.usageFromPlays(cfbDropbackRows(R.parseCsv(h.text, { columns: PS_COLS })));
    seasonsRead.push(y);
  }
  const startCount = startsByPlayer(usageBySeason);
  notes.push(`start counts are games opened in ${seasonsRead.sort().join(' and ')} — not a career total, and named as such`);

  /* KICKOFF TIMES, so "the last game" is ordered by when it was played rather
     than by a week number that the postseason restarts. */
  const kickoff = {};
  if (sched.ok) {
    for (const g of R.parseCsv(sched.text, { columns: ['game_id', 'start_date', 'completed', 'home_team', 'away_team'] })) {
      if (g.game_id) kickoff[String(g.game_id)] = g.start_date || null;
    }
  }
  usage.forEach(u => { u.kickoff = kickoff[u.game_id] || null; });

  /* rosters, per team, for identity and for duplicate-name refusal, plus the
     league-wide id map that makes a transfer detectable */
  const rosterByTeam = {}, rosterTeamOfId = {};
  if (rosterCsv.ok) {
    for (const p of R.parseCsv(rosterCsv.text, { columns: ['athlete_id', 'first_name', 'last_name', 'team', 'position', 'jersey', 'season'] })) {
      const k = S.normKey(p.team); if (!k) continue;
      if (R.NUM(p.season) != null && R.NUM(p.season) !== season) continue;   /* season identity guard */
      (rosterByTeam[k] = rosterByTeam[k] || []).push({
        athlete_id: R.NA(p.athlete_id), name: ((p.first_name || '') + ' ' + (p.last_name || '')).trim(),
        position: p.position || null, jersey: p.jersey || null, team: p.team
      });
      if (R.NA(p.athlete_id)) rosterTeamOfId[String(p.athlete_id)] = k;
    }
  } else {
    notes.push('the cfbfastR roster file could not be read, so identities were resolved on the athlete id alone '
      + 'and a name-only source could not be confirmed against a roster');
  }

  /* availability: EdgeDesk's own college layer, keyed by ESPN team id */
  const av = readJson(path.join(ROOT, 'football', 'availability', 'current.json'), null);
  const availByTeam = {};
  let availChecked = false, availAsOf = null;
  if (av && av.teams) {
    availChecked = true; availAsOf = av.generated_at || null;
    for (const id of Object.keys(av.teams)) {
      const t = av.teams[id];
      const k = S.normKey(t.team_name || t.team_display);
      if (!k) continue;
      availByTeam[k] = (t.players || []).map(p => ({
        player_id: p.player_id || null, player_name: p.player_name || p.name || null,
        status: p.status || null, detail: p.injury_type || p.body_part || null,
        source: p.source_name || null, source_url: p.source_url || null,
        published_at: p.source_published_at || null, retrieved_at: p.observed_at || t.lastUpdated || availAsOf
      }));
    }
  } else {
    notes.push('football/availability/current.json was not readable, so no college availability evidence was joined');
  }

  /* the player layer's own QB room, for the quality attached to a resolved
     starter. It is READ here and never turned into a status. */
  const quality = {};
  const teamsDir = path.join(ROOT, 'football', 'players', 'teams');
  let qualityFiles = 0;
  if (fs.existsSync(teamsDir)) {
    for (const f of fs.readdirSync(teamsDir)) {
      if (!/\.json$/.test(f)) continue;
      const d = readJson(path.join(teamsDir, f), null);
      const g = d && d.units && d.units.groups && d.units.groups.QB;
      if (!d || !g) continue;
      qualityFiles++;
      quality[d.key || f.replace(/\.json$/, '')] = {
        rating: g.rating == null ? null : g.rating,
        confidence: g.confidence == null ? null : g.confidence,
        generated_at: d.generated_at || null,
        projected: (g.projected || []).map(p => ({ key: p.key, player_id: String(p.key || '').replace(/^a:/, ''),
          name: p.name, slot: p.slot, epir: p.epir, role: p.role, status: p.status, confidence: p.confidence }))
      };
    }
  }

  /* one record per team that has played, plus every team on the roster file */
  const byTeam = {};
  usage.forEach(u => { (byTeam[u.team_key] = byTeam[u.team_key] || { team: u.team, games: [] }).games.push(u); });

  const records = [];
  const currentWeek = usage.reduce((m, u) => Math.max(m, u.week || 0), 0);
  const retrievedAt = ps.retrieved_at || new Date().toISOString();

  for (const key of Object.keys(byTeam).sort()) {
    const t = byTeam[key];
    t.games.sort((a, b) => (String(a.kickoff || '') + a.week).localeCompare(String(b.kickoff || '') + b.week) || (a.week - b.week));
    const starts = t.games.map(g => S.starterOfGame(g)).filter(Boolean);
    const last = starts.length ? starts[starts.length - 1] : null;
    const recent = t.games.slice(-2);
    const comp = S.usageCompetition(recent);
    const idx = S.rosterIndex(rosterByTeam[key] || [], { team: t.team, team_key: key, global: rosterTeamOfId });

    const evidence = usageEvidence(last, {
      team: t.team, season: season, retrieved_at: retrievedAt,
      source: 'cfbfastR-data player_stats — play attribution',
      source_url: `${CFB}/player_stats/csv/player_stats_${season}.csv`
    });
    /* the player layer's QB1 is a PROJECTION, and enters as one: it can
       never resolve a starter on its own, it can only corroborate or
       contradict one, which is exactly what the tier-4 ceiling means. */
    const q = quality[key];
    const proj = q && q.projected && q.projected[0];
    if (proj && proj.player_id) {
      evidence.push({
        kind: 'PROJECTION', player_id: proj.player_id, player_name: proj.name,
        team: t.team, season: season, week: currentWeek,
        source: 'EdgeDesk player layer (EPIR) projected QB1',
        source_url: 'football/players/teams/' + key + '.json',
        published_at: q.generated_at, retrieved_at: q.generated_at,
        detail: 'projected slot 1 by rating x confidence, not by usage'
      });
    }

    const rec = S.resolveStarter({
      team: t.team, team_id: key, season: season, week: currentWeek + 1, position: 'QB',
      evidence: evidence, roster_index: idx,
      availability: availByTeam[key] || [], availability_checked: availChecked,
      availability_retrieved_at: availAsOf,
      participation: participationOf(last, `${CFB}/player_stats/csv/player_stats_${season}.csv`, 'cfbfastR-data player_stats'),
      usage_competition: comp, now: Date.now()
    });
    rec.history = starts.slice(-4).map(s => ({
      week: s.week, game_id: s.game_id, opponent: s.opponent, dropbacks: s.dropbacks,
      starter: s.starter ? { player_id: s.starter.player_id, player_name: s.starter.player_name, share: s.starter.share } : null,
      settled: s.settled, why: s.why
    }));
    rec.room = q ? { rating: q.rating, confidence: q.confidence, source: 'football/players', generated_at: q.generated_at,
      note: 'a research rating of the room, never a start announcement and never priced from here' } : null;
    if (rec.player_id && startCount[rec.player_id]) {
      const sc = startCount[rec.player_id];
      rec.experience = {
        starts: sc.starts, dropbacks: sc.dropbacks, seasons_observed: sc.seasons_observed,
        seasons_read: seasonsRead.slice().sort(),
        basis: 'games this player opened, counted from the play feed across the seasons this build read — '
          + 'a measured start count over a stated window, not a career total',
        source_url: `${CFB}/player_stats/csv/player_stats_${season}.csv`
      };
    } else if (rec.player_id) {
      rec.experience = { starts: 0, dropbacks: 0, seasons_observed: 0, seasons_read: seasonsRead.slice().sort(),
        basis: 'no attributed dropback in the seasons this build read — a first-year or first-appearance starter, '
          + 'which is a fact about the window, not a claim that he has never played' , source_url: null };
    }
    records.push(rec);
  }

  const missingTeams = Object.keys(rosterByTeam).filter(k => !byTeam[k]);
  if (missingTeams.length) notes.push(missingTeams.length + ' team(s) on the roster feed have no attributed dropback in '
    + season + ' yet, so no previous-game evidence exists for them');

  return {
    ok: true, sport: 'CFB', season, week: currentWeek, records,
    coverage: S.coverage(records), sources, notes,
    quality_files: qualityFiles,
    availability: { checked: availChecked, generated_at: availAsOf, teams_with_records: Object.keys(availByTeam).filter(k => (availByTeam[k] || []).length).length }
  };
}

/* ======================================================================= NFL */

async function buildNfl(sess, season, opts) {
  const notes = [], sources = [];
  const offline = !!opts.offline;

  const pbp = await sess.cached(`${NFLV}/pbp/play_by_play_${season}.csv`,
    `nfl_pbp_${season}.csv`, { season, min_bytes: 5000, timeout_ms: 180000, retries: offline ? 0 : 2 });
  sources.push({ field: 'dropback attribution', url: pbp.url, ok: pbp.ok, from: pbp.from, status: pbp.status, error: pbp.error, retrieved_at: pbp.retrieved_at });
  if (!pbp.ok) return { ok: false, why: `play_by_play_${season}.csv could not be read (${pbp.error || pbp.status})`, sources, notes };

  const roster = await sess.cached(`${NFLV}/rosters/roster_${season}.csv`,
    `nfl_roster_${season}.csv`, { season, min_bytes: 5000, timeout_ms: 120000, retries: offline ? 0 : 2 });
  sources.push({ field: 'roster identity', url: roster.url, ok: roster.ok, from: roster.from, status: roster.status, error: roster.error, retrieved_at: roster.retrieved_at });

  const inj = await sess.cached(`${NFLV}/injuries/injuries_${season}.csv`,
    `nfl_injuries_${season}.csv`, { season, min_bytes: 200, timeout_ms: 60000, retries: offline ? 0 : 2 });
  sources.push({ field: 'availability', url: inj.url, ok: inj.ok, from: inj.from, status: inj.status, error: inj.error, retrieved_at: inj.retrieved_at });

  /* THE DEPTH CHART IS BIG AND IT IS OPTIONAL. Fifty megabytes is a daily
     background job, not something an interactive question should wait for,
     so --no-depth builds everything else and says the field was skipped. */
  let depth = { ok: false, error: 'skipped by --no-depth' };
  if (!opts.noDepth) {
    depth = await sess.cached(`${NFLV}/depth_charts/depth_charts_${season}.csv`,
      `nfl_depth_${season}.csv`, { season, min_bytes: 5000, timeout_ms: 300000, retries: offline ? 0 : 1 });
    sources.push({ field: 'depth chart', url: depth.url, ok: depth.ok, from: depth.from, status: depth.status, error: depth.error, retrieved_at: depth.retrieved_at });
  } else {
    sources.push({ field: 'depth chart', url: `${NFLV}/depth_charts/depth_charts_${season}.csv`, ok: false, from: 'skipped', status: null, error: 'skipped by --no-depth', retrieved_at: null });
  }

  const plays = R.parseCsv(pbp.text, { columns: ['game_id', 'play_id', 'week', 'season', 'posteam', 'defteam', 'qb_dropback', 'passer_player_id', 'passer_player_name'] });
  const rows = [];
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    const pid = R.NA(p.passer_player_id);
    if (!pid) continue;
    if (R.NA(p.qb_dropback) != null && R.NUM(p.qb_dropback) === 0) continue;
    rows.push({ team: p.posteam, team_key: S.normKey(p.posteam), game_id: p.game_id,
      season: R.NUM(p.season), week: R.NUM(p.week), opponent: p.defteam || null,
      player_id: String(pid), player_name: R.NA(p.passer_player_name), order: R.NUM(p.play_id) != null ? R.NUM(p.play_id) : i });
  }
  const usage = S.usageFromPlays(rows);

  const rosterByTeam = {}, rosterTeamOfId = {};
  if (roster.ok) {
    for (const p of R.parseCsv(roster.text, { columns: ['gsis_id', 'full_name', 'team', 'position', 'jersey_number', 'season'] })) {
      const k = S.normKey(p.team); if (!k) continue;
      if (R.NUM(p.season) != null && R.NUM(p.season) !== season) continue;
      (rosterByTeam[k] = rosterByTeam[k] || []).push({ athlete_id: R.NA(p.gsis_id), name: p.full_name,
        position: p.position || null, jersey: p.jersey_number || null, team: p.team });
      if (R.NA(p.gsis_id)) rosterTeamOfId[String(p.gsis_id)] = k;
    }
  }

  /* latest depth-chart snapshot per team; the file carries every snapshot of
     the season, so "latest" is read, never assumed to be the last line. */
  const depthQb = {};
  let depthAsOf = null;
  if (depth.ok) {
    const dc = R.parseCsv(depth.text, { columns: ['dt', 'team', 'player_name', 'gsis_id', 'pos_abb', 'pos_rank', 'pos_slot'] });
    const latest = {};
    for (const d of dc) {
      if (String(d.pos_abb).toUpperCase() !== 'QB') continue;
      const k = S.normKey(d.team); if (!k) continue;
      if (!latest[k] || String(d.dt) > String(latest[k])) latest[k] = String(d.dt);
    }
    for (const d of dc) {
      if (String(d.pos_abb).toUpperCase() !== 'QB') continue;
      const k = S.normKey(d.team); if (!k || String(d.dt) !== latest[k]) continue;
      if (R.NUM(d.pos_rank) !== 1) continue;
      depthQb[k] = { player_id: R.NA(d.gsis_id), player_name: d.player_name, dt: d.dt };
      if (!depthAsOf || String(d.dt) > depthAsOf) depthAsOf = String(d.dt);
    }
  }

  const availByTeam = {};
  let availChecked = false, availAsOf = inj.retrieved_at || null;
  if (inj.ok) {
    availChecked = true;
    const irows = R.parseCsv(inj.text, { columns: ['season', 'team', 'week', 'gsis_id', 'full_name', 'position', 'report_status', 'practice_status', 'report_primary_injury', 'date_modified'] });
    let maxWeek = 0;
    irows.forEach(r => { const w = R.NUM(r.week); if (w != null && w > maxWeek) maxWeek = w; });
    for (const r of irows) {
      if (R.NUM(r.week) !== maxWeek) continue;
      const k = S.normKey(r.team); if (!k) continue;
      (availByTeam[k] = availByTeam[k] || []).push({
        player_id: R.NA(r.gsis_id), player_name: r.full_name,
        status: String(r.report_status || '').toUpperCase().replace(/\s+/g, '_') || 'UNKNOWN',
        detail: [R.NA(r.report_primary_injury), R.NA(r.practice_status)].filter(Boolean).join(' · ') || null,
        source: 'nflverse injuries (league injury report)',
        source_url: `${NFLV}/injuries/injuries_${season}.csv`,
        published_at: R.NA(r.date_modified), retrieved_at: inj.retrieved_at
      });
    }
    notes.push('NFL availability is the league injury report for week ' + maxWeek + '; a player with no row is UNKNOWN, not healthy');
  }

  const byTeam = {};
  usage.forEach(u => { (byTeam[u.team_key] = byTeam[u.team_key] || { team: u.team, games: [] }).games.push(u); });
  Object.keys(depthQb).forEach(k => { if (!byTeam[k]) byTeam[k] = { team: k.toUpperCase(), games: [] }; });

  const records = [];
  const currentWeek = usage.reduce((m, u) => Math.max(m, u.week || 0), 0);
  const retrievedAt = pbp.retrieved_at || new Date().toISOString();

  for (const key of Object.keys(byTeam).sort()) {
    const t = byTeam[key];
    t.games.sort((a, b) => (a.week || 0) - (b.week || 0));
    const starts = t.games.map(g => S.starterOfGame(g)).filter(Boolean);
    const last = starts.length ? starts[starts.length - 1] : null;
    const comp = S.usageCompetition(t.games.slice(-2));
    const idx = S.rosterIndex(rosterByTeam[key] || [], { team: t.team, team_key: key, global: rosterTeamOfId });

    const evidence = [];
    const d = depthQb[key];
    if (d && d.player_id) {
      evidence.push({ kind: 'DEPTH_CHART', player_id: d.player_id, player_name: d.player_name,
        team: t.team, season: season, week: currentWeek + 1,
        source: 'nflverse depth charts', source_url: `${NFLV}/depth_charts/depth_charts_${season}.csv`,
        published_at: d.dt, retrieved_at: depth.retrieved_at || retrievedAt,
        detail: 'QB1 on the published depth chart as of ' + d.dt });
    }
    usageEvidence(last, {
      team: t.team, season: season, retrieved_at: retrievedAt,
      source: 'nflverse play-by-play', source_url: `${NFLV}/pbp/play_by_play_${season}.csv`
    }).forEach(e => evidence.push(e));

    const rec = S.resolveStarter({
      team: t.team, team_id: key, season, week: currentWeek + 1, position: 'QB',
      evidence, roster_index: idx,
      availability: availByTeam[key] || [], availability_checked: availChecked,
      availability_retrieved_at: availAsOf,
      participation: participationOf(last, `${NFLV}/pbp/play_by_play_${season}.csv`, 'nflverse play-by-play'),
      usage_competition: comp, now: Date.now()
    });
    rec.history = starts.slice(-4).map(s => ({ week: s.week, game_id: s.game_id, opponent: s.opponent,
      dropbacks: s.dropbacks, starter: s.starter ? { player_id: s.starter.player_id, player_name: s.starter.player_name, share: s.starter.share } : null,
      settled: s.settled, why: s.why }));
    records.push(rec);
  }

  return { ok: true, sport: 'NFL', season, week: currentWeek, records,
    coverage: S.coverage(records), sources, notes,
    depth_chart: { available: depth.ok, as_of: depthAsOf, teams: Object.keys(depthQb).length },
    availability: { checked: availChecked, generated_at: availAsOf, teams_with_records: Object.keys(availByTeam).length } };
}

/* ====================================================================== main */

async function main() {
  const season = +(arg('season', defaultSeason()));
  const sport = String(arg('sport', 'both')).toLowerCase();
  const offline = !!arg('offline', false);
  const check = !!arg('check', false);
  const noDepth = !!arg('no-depth', false);
  const budgetMs = arg('budget-ms', null);

  const sess = R.session({ budget_ms: budgetMs ? +budgetMs : null, host_min_gap_ms: 150 });
  const out = { schema: SCHEMA, version: S.VERSION, season, generated_at: new Date().toISOString(), sports: {} };
  let failed = 0;

  if (sport === 'cfb' || sport === 'both') {
    const r = await buildCfb(sess, season, { offline, history: arg('history', null) == null ? 1 : +arg('history', 1) });
    out.sports.CFB = r;
    if (!r.ok) { failed++; log('[starters] CFB: ' + r.why); }
    else {
      log(`[starters] CFB ${season} wk${r.week}: ${r.records.length} teams · `
        + Object.keys(r.coverage.by_status).filter(k => r.coverage.by_status[k]).map(k => `${k} ${r.coverage.by_status[k]}`).join(' · '));
      writeSport(path.join(HERE, `cfb_${season}.json`), r, out, check);
    }
  }
  if (sport === 'nfl' || sport === 'both') {
    const r = await buildNfl(sess, season, { offline, noDepth });
    out.sports.NFL = r;
    if (!r.ok) { failed++; log('[starters] NFL: ' + r.why); }
    else {
      log(`[starters] NFL ${season} wk${r.week}: ${r.records.length} teams · `
        + Object.keys(r.coverage.by_status).filter(k => r.coverage.by_status[k]).map(k => `${k} ${r.coverage.by_status[k]}`).join(' · '));
      writeSport(path.join(HERE, `nfl_${season}.json`), r, out, check);
    }
  }

  out.retrieval = sess.report();
  const index = {
    schema: SCHEMA + '_index', version: S.VERSION, season, generated_at: out.generated_at,
    sports: {}, retrieval: out.retrieval
  };
  Object.keys(out.sports).forEach(k => {
    const r = out.sports[k];
    index.sports[k] = r.ok
      ? { ok: true, week: r.week, teams: r.records.length, coverage: r.coverage, sources: r.sources, notes: r.notes,
        file: `football/starters/${k.toLowerCase()}_${season}.json` }
      : { ok: false, why: r.why, sources: r.sources, notes: r.notes };
  });
  if (!check) fs.writeFileSync(path.join(HERE, 'current.json'), JSON.stringify(index, null, 1) + '\n');

  log(`[starters] retrieval: ${out.retrieval.requests} request(s), ${out.retrieval.ok} ok, ${out.retrieval.failed} failed, `
    + `${out.retrieval.from_cache} from cache, ${Math.round(out.retrieval.elapsed_ms / 100) / 10}s`);
  out.retrieval.failure_groups.forEach(g => log(`  ${g.systematic ? 'SYSTEMATIC' : 'incidental'}  ${g.signature} x${g.count}`));
  return failed ? 1 : 0;
}

function writeSport(file, r, out, check) {
  if (check) return;
  fs.writeFileSync(file, JSON.stringify({
    schema: SCHEMA, version: S.VERSION, sport: r.sport, season: r.season, week: r.week,
    generated_at: out.generated_at, coverage: r.coverage, sources: r.sources, notes: r.notes,
    availability: r.availability, depth_chart: r.depth_chart || null,
    teams: r.records.reduce((m, rec) => { m[rec.team_id] = rec; return m; }, {})
  }, null, 1) + '\n');
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('[starters] ' + ((e && e.stack) || e)); process.exit(2); });
}
module.exports = { buildCfb, buildNfl, cfbDropbackRows };
