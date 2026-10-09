#!/usr/bin/env node
'use strict';
/* ===========================================================================
   THE EDITORIAL MATCHUP PACKETS — football/content/packets.json
   docs/content-engine/GAMES_TO_WATCH.md

   One verified research packet per game of the current week, built before any
   article is written and reused by every template that features a game (the
   publisher's Five Games to Watch, EdgeDesk's own edition, previews and the
   newsletter). Built here, offline, because the measured pairings need the
   10 MB slate the browser never loads; the admin page and the Edge Function
   read the finished packets.

   Nothing is fetched. Every input is an artifact another pipeline already
   commits:
     football/cfb_terminal/games.json         projection, market, integrity
     football/fbs/slate.json + matchup/*      measured pairings (packet.js)
     football/personnel/current.json          official availability by game
     football/availability/reports.bundle     report URLs and publication times
     football/cfb_terminal/record.json        verified final scores
     collective/settled/CFB_2026.json         verified final scores
     football/fbs_epa/qb_epa_2026.json        quarterback game logs
     football/rankings/current.json           EdgeDesk ranks (context only)
     football/broadcasts/current.json         the broadcast listings
                                              (football/broadcasts/collect.js)

   Usage:
     node tools/content/build_packets.js            write the current week
     node tools/content/build_packets.js --week 6   a named week
     node tools/content/build_packets.js --check    build, print, write nothing
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const PK = require(path.join(ROOT, 'football', 'matchup', 'packet.js'));
const M = require(path.join(ROOT, 'lib', 'edgedesk_matchup.js'));
const B = require(path.join(ROOT, 'lib', 'edgedesk_broadcast.js'));
const SCHED = require(path.join(ROOT, 'lib', 'edgedesk_schedule.js'));

const OUT = path.join(ROOT, 'football', 'content', 'packets.json');
const SCHEMA = 'edgedesk_editorial_packets_v1';

function readJson(rel, fallback) {
  const f = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(f)) return fallback === undefined ? null : fallback;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fallback === undefined ? null : fallback; }
}

/* every input, read once */
function load(opts) {
  opts = opts || {};
  const season = opts.season || 2026;
  const terminal = opts.terminal || readJson('football/cfb_terminal/games.json');
  const rankings = opts.rankings || readJson('football/rankings/current.json');
  const profiles = opts.profiles || readJson(`football/matchup/profiles_${season}.json`);
  const qbEpa = opts.qb_epa || readJson(`football/fbs_epa/qb_epa_${season}.json`);
  return {
    season,
    terminal,
    rankings,
    profiles,
    personnel: opts.personnel || readJson('football/personnel/current.json'),
    reports: opts.reports || readJson('football/availability/reports.bundle.json'),
    record: opts.record || readJson('football/cfb_terminal/record.json'),
    settled: opts.settled || readJson(`collective/settled/CFB_${season}.json`),
    qb_epa: qbEpa,
    broadcasts: opts.broadcasts !== undefined ? opts.broadcasts : readJson('football/broadcasts/current.json'),
    context: opts.context || PK.loadContext({ season, rankings, profiles, fbs_epa: qbEpa })
  };
}

function rankingsByName(rk) {
  const by = {};
  if (rk && rk.teams) Object.keys(rk.teams).forEach((k) => {
    const t = rk.teams[k];
    if (t && t.team) by[t.team] = { key: k, team: t.team, rank: typeof t.rank === 'number' ? t.rank : null, conference: t.conference || null };
  });
  return { by_name: by, as_of: rk ? rk.data_as_of || rk.generated_at || null : null };
}

/* the report bundle entry for one team in one game */
function reportFor(bundle, gameId, team) {
  const rows = bundle && bundle.reports ? bundle.reports : [];
  const hits = rows.filter((r) => r && String(r.game_id) === String(gameId) && r.team === team && r.ok !== false);
  hits.sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0));
  return hits[0] || null;
}

/* which games: the feed's current week, FBS games only, not yet started */
function weekGames(art, opts) {
  const games = art.terminal && art.terminal.games ? Object.values(art.terminal.games) : [];
  const now = opts.now;
  let week = opts.week;
  if (week == null) {
    const upcoming = games.filter((g) => Date.parse(g.kickoff) > now).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    week = upcoming.length ? upcoming[0].week : null;
  }
  return { week, games: games.filter((g) => g.week === week && (!opts.ids || opts.ids.indexOf(String(g.game_id)) >= 0)) };
}

/* one game's packet */
function buildOne(art, T, shared, opts) {
  const gid = String(T.game_id);
  const now = opts.now;
  const fb = PK.build({ context: art.context, game_id: gid, now });
  const pg = art.personnel && art.personnel.games ? art.personnel.games[gid] || null : null;
  const home = T.game.home, away = T.game.away;
  const listing = art.broadcasts && art.broadcasts.listings ? art.broadcasts.listings[gid] || null : null;
  const owner = opts.owner && opts.owner[gid] ? opts.owner[gid] : null;
  const kt = SCHED.kickoffOf({ kickoff: T.kickoff, start_time_tbd: T.kickoff_tbd, kickoff_state: T.kickoff_state, kickoff_basis: T.kickoff_basis });
  const bc = B.verify(gid, listing, owner, { kickoff: T.kickoff, kickoff_verified: !!kt.verified });
  const packet = M.build({
    terminal: T, football: fb, personnel: pg,
    reports: { home: reportFor(art.reports, gid, home), away: reportFor(art.reports, gid, away) },
    finals: shared.finals, qb: shared.qb, rankings: shared.rankings, profiles: art.profiles ? art.profiles.teams : {},
    profiles_generated_at: art.profiles ? art.profiles.generated_at : null, league: shared.league, broadcast: bc, now
  });
  packet.broadcast_input = { listing, schedule_kickoff: T.kickoff, kickoff_verified: !!kt.verified, owner_applied: !!owner };
  if (opts.fixture) packet.fixture = opts.fixture;
  return packet;
}

function buildAll(opts) {
  opts = opts || {};
  const now = opts.now != null ? opts.now : Date.now();
  const art = opts.art || load(opts);
  const shared = {
    finals: M.finalsIndex(art.record ? art.record.rows : [], art.settled ? art.settled.games : []),
    qb: M.qbIndex(art.qb_epa),
    rankings: rankingsByName(art.rankings),
    league: M.leagueFromProfiles(art.profiles)
  };
  const wk = weekGames(art, { now, week: opts.week, ids: opts.ids });
  const packets = [], errors = [];
  wk.games.forEach((T) => {
    try { packets.push(buildOne(art, T, shared, { now, owner: opts.owner, fixture: opts.fixture })); }
    catch (e) { errors.push({ game_id: String(T.game_id), error: String(e && e.stack || e).split('\n').slice(0, 3).join(' | ') }); }
  });
  packets.sort((a, b) => Date.parse(a.schedule.kickoff || 0) - Date.parse(b.schedule.kickoff || 0) || a.game_id.localeCompare(b.game_id));
  const counts = {
    games: packets.length,
    gate_ok: packets.filter((p) => p.gate.ok).length,
    publishable: packets.filter((p) => p.gate.publishable).length,
    broadcast_confirmed: packets.filter((p) => p.broadcast.status === 'CONFIRMED').length,
    broadcast_held: packets.filter((p) => !p.broadcast.publishable).length
  };
  return {
    schema: SCHEMA, version: M.VERSION, generated_at: new Date(now).toISOString(), season: art.season, week: wk.week,
    fixture: opts.fixture || null,
    inputs: {
      terminal: art.terminal ? art.terminal.generated_at : null,
      profiles: art.profiles ? art.profiles.generated_at : null,
      personnel: art.personnel ? art.personnel.generated_at : null,
      qb_epa: art.qb_epa ? art.qb_epa.generated_at : null,
      broadcasts: art.broadcasts ? art.broadcasts.generated_at : null,
      rankings: shared.rankings.as_of
    },
    league: shared.league,
    counts, errors,
    rule: 'A packet is built from committed EdgeDesk artifacts only. A game is featured only when its packet passes the six-question reasoning gate with at least '
      + M.CONFIG.min_independent_facts + ' independent supporting facts; where to watch is printed only from a CONFIRMED, fresh broadcast record.',
    packets
  };
}

/* THE SAME BUILD from a frozen fixture (tools/content/fixtures): the inputs
   are the committed artifacts as they stood, so a regression stays a
   regression after the hourly files move on. opts: { now, owner, listings,
   fixture } — listings default to the fixture's own broadcast payload. */
function buildFromFixture(fx, opts) {
  opts = opts || {};
  const now = opts.now != null ? opts.now : Date.parse(fx.now);
  const listings = opts.listings || B.parseEspnScoreboard(fx.broadcast_fixture, fx.broadcast_fixture.retrieved_at, fx.broadcast_fixture.url);
  const art = { season: fx.season, profiles: fx.profiles, reports: { reports: fx.reports }, personnel: { games: fx.personnel } };
  const shared = { finals: M.finalsIndex(fx.record_rows, fx.settled), qb: fx.qb, rankings: rankingsByName(fx.rankings), league: fx.league };
  const packets = fx.game_ids.map((gid) => {
    const T = fx.terminal.games[gid];
    const fb = fx.football[gid];
    const home = T.game.home, away = T.game.away;
    const kt = SCHED.kickoffOf({ kickoff: T.kickoff, start_time_tbd: T.kickoff_tbd, kickoff_state: T.kickoff_state, kickoff_basis: T.kickoff_basis });
    const listing = listings[gid] || null, owner = opts.owner && opts.owner[gid] ? opts.owner[gid] : null;
    const bc = B.verify(gid, listing, owner, { kickoff: T.kickoff, kickoff_verified: !!kt.verified });
    const p = M.build({ terminal: T, football: fb, personnel: fx.personnel[gid], reports: { home: reportFor(art.reports, gid, home), away: reportFor(art.reports, gid, away) },
      finals: shared.finals, qb: shared.qb, rankings: shared.rankings, profiles: fx.profiles.teams, profiles_generated_at: fx.profiles.generated_at, league: shared.league, broadcast: bc, now });
    p.broadcast_input = { listing, schedule_kickoff: T.kickoff, kickoff_verified: !!kt.verified, owner_applied: !!owner };
    return p;
  });
  return { schema: SCHEMA, version: M.VERSION, generated_at: new Date(now).toISOString(), season: fx.season, week: fx.week,
    fixture: opts.fixture === undefined ? 'oct-10-2026-historical' : opts.fixture, league: shared.league,
    counts: { games: packets.length, gate_ok: packets.filter((p) => p.gate.ok).length }, errors: [], packets };
}

/* the published file drops the raw listing payloads it already summarised */
function compact(doc) {
  return JSON.parse(JSON.stringify(doc, (k, v) => (k === 'listing' && v && v.outlets ? { game_id: v.game_id, retrieved_at: v.retrieved_at, kickoff: v.kickoff, time_valid: v.time_valid, status: v.status, outlets: v.outlets, source: v.source } : v)));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const wi = args.indexOf('--week');
  const doc = buildAll({ week: wi >= 0 ? +args[wi + 1] : undefined });
  const out = compact(doc);
  if (args.indexOf('--check') >= 0) {
    console.log(JSON.stringify({ week: out.week, counts: out.counts, errors: out.errors }, null, 1));
    out.packets.forEach((p) => console.log((p.gate.ok ? 'OK  ' : 'NO  ') + p.identity.heading.padEnd(42) + ' facts=' + p.gate.independent_facts + ' bc=' + p.broadcast.status + (p.gate.ok ? '' : ' missing=' + p.gate.missing.map((m) => m.code).join(','))));
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
    console.log('football/content/packets.json — week ' + out.week + ': ' + out.counts.games + ' packets, ' + out.counts.gate_ok + ' pass the reasoning gate, '
      + out.counts.broadcast_confirmed + ' broadcasts confirmed' + (out.errors.length ? ', ' + out.errors.length + ' errors' : ''));
  }
}

module.exports = { load, buildAll, buildOne, buildFromFixture, compact, rankingsByName, reportFor, weekGames, SCHEMA, OUT };
