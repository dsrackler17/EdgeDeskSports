#!/usr/bin/env node
/* ===========================================================================
   THE MATCHUP METRICS ARTIFACT, AGAINST THE REAL BUILDS.

   Builds football/matchup/metrics.json from the committed rankings, profile,
   starter, coaching and injury artifacts and asserts that (1) nothing is
   computed — every number equals its source, (2) the metric records are the
   shape EDINTEL.matchupDrivers() pairs, (3) every block carries the source
   and its own generated time, and (4) the file stays small enough for an
   edge function to fetch per request.

   Run: node tools/football/matchup_metrics.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const B = require('./build_matchup_metrics.js');
const E = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const art = B.build({});
const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'current.json'), 'utf8'));
const rankTeams = Array.isArray(R.teams) ? R.teams : Object.values(R.teams);
chk('schema', art.schema === 'edgedesk_matchup_metrics_v1');
chk('every rated programme is carried', art.counts.fbs_teams === rankTeams.length, [art.counts.fbs_teams, rankTeams.length]);
chk('every source is declared with its state', ['rankings', 'profiles', 'starters_cfb', 'starters_nfl', 'coaching', 'nfl_injuries'].every((k) => art.sources[k] && typeof art.sources[k].ok === 'boolean'));
chk('the rankings source carries its generated time', !!art.sources.rankings.generated_at);
const size = JSON.stringify(art).length;
chk('the artifact is under 1.6 MB', size < 1.6 * 1024 * 1024, size);

const first = rankTeams[0];
const t = art.teams[first.key];
chk('a team is keyed the way the slate keys it', !!t && t.team === first.team);
chk('the rating is copied, not recomputed', t.rating.etsr === Math.round(first.etsr * 100) / 100, [t.rating.etsr, first.etsr]);
const srcUsed = first.performance.offense_detail.used[0], cpUsed = t.performance.offense_detail.used[0];
chk('a metric record keeps id, raw, adjusted, z, w, reliability and league', cpUsed.id === srcUsed.id && Math.abs(cpUsed.z - srcUsed.z) < 1e-4 && Math.abs(cpUsed.league - srcUsed.league) < 1e-4 && cpUsed.reliability != null);
chk('the rating block names its source and time', t.rating.source === 'football/rankings/current.json' && !!t.rating.as_of);

/* the kernel's driver builder reads it as it reads the rankings build */
const keys = Object.keys(art.teams).filter((k) => art.teams[k].performance && art.teams[k].performance.offense_detail.used.length);
const a = art.teams[keys[0]], b = art.teams[keys[1]];
const d = E.matchupDrivers({ attacker: a, defender: b, attacker_name: a.team, defender_name: b.team });
chk('matchupDrivers pairs metric records straight out of the artifact', d.drivers.length >= 1, d.missing);
chk('and each driver names both units with league context', d.drivers.every((x) => x.attacker_value && x.defender_value && /league/.test(x.statement)));
const dFull = E.matchupDrivers({ attacker: rankTeams.find((x) => x.key === keys[0]), defender: rankTeams.find((x) => x.key === keys[1]), attacker_name: a.team, defender_name: b.team });
chk('the drivers agree with the full rankings build', d.drivers.map((x) => x.id).join() === dFull.drivers.map((x) => x.id).join() && d.drivers.every((x, i) => Math.abs(x.advantage_z - dFull.drivers[i].advantage_z) < 0.01), [d.drivers.map((x) => x.id), dFull.drivers.map((x) => x.id)]);

/* profiles, starters, coaching */
const withProfile = Object.values(art.teams).find((x) => x.profile);
chk('a profile carries pace, pass rate and the garbage-time-free view', withProfile && withProfile.profile.plays_per_game != null && withProfile.profile.pass_rate != null && withProfile.profile.excluding_garbage_time);
chk('a profile names its source and time', withProfile && /profiles_/.test(withProfile.profile.source) && !!withProfile.profile.as_of);
chk('no profile is carried for a programme the rankings do not rate', Object.values(art.teams).every((x) => x.rating));
const withStarter = Object.values(art.teams).find((x) => x.starter);
chk('a starter carries status, confirmation and availability state', withStarter && withStarter.starter.status && typeof withStarter.starter.confirmed === 'boolean' && withStarter.starter.availability && withStarter.starter.availability.state);
chk('a starter is never marked confirmed from roster order', Object.values(art.teams).every((x) => !x.starter || x.starter.confirmed === false || x.starter.status === 'ANNOUNCED'));
const withCoach = Object.values(art.teams).find((x) => x.coaching);
chk('coaching carries the head coach and what is unknown', withCoach && withCoach.coaching.hc && Array.isArray(withCoach.coaching.unknown));

/* NFL */
chk('every NFL club is present', art.counts.nfl_clubs === 32, art.counts.nfl_clubs);
const nfl = Object.values(art.nfl.teams).find((x) => x.injuries && x.injuries.players.length);
chk('the official injury report is carried per club', nfl && nfl.injuries.official === true && nfl.injuries.players.every((p) => p.name));
/* A GAME STATUS IS NOT PUBLISHED EVERY DAY OF THE WEEK.
   Out / Doubtful / Questionable is assigned on the FINAL injury report,
   normally Friday; a Wednesday or Thursday report is practice participation
   only, with status null on almost every row. Demanding a status from one
   arbitrary club therefore failed mid-week on a feed that was behaving
   correctly — 4 of 32 clubs carried any status when this was written, 199 of
   207 rows were null, and the club the `find` lands on had none.

   The claim the desk actually needs is league-wide and does not move with the
   day of the week: every row is identified and carries a designation of some
   kind, and any status that IS published is one of the three real ones —
   never invented, and never a practice designation promoted into a game
   status. Both of those still fail loudly on a builder that breaks. */
const nflRows = Object.values(art.nfl.teams).flatMap((x) => (x.injuries ? x.injuries.players : []));
chk('every injury row is identified and carries a designation', nflRows.length > 0 && nflRows.every((p) => p.name && (p.status || p.practice)), nflRows.filter((p) => !(p.name && (p.status || p.practice))).slice(0, 3));
chk('a published game status is one of the three real ones, never a practice designation', nflRows.filter((p) => p.status).every((p) => /^(Out|Doubtful|Questionable)$/.test(String(p.status))), [...new Set(nflRows.filter((p) => p.status).map((p) => p.status))]);
chk('and counts out / doubtful / questionable', nfl && typeof nfl.injuries.out === 'number' && typeof nfl.injuries.questionable === 'number');
chk('and names its source and retrieval time', nfl && /nflverse/.test(nfl.injuries.source) && !!nfl.injuries.retrieved_at);
const nflStarter = Object.values(art.nfl.teams).find((x) => x.starter);
chk('an NFL starter carries its depth-chart status', nflStarter && nflStarter.starter.status === 'DEPTH_CHART' && nflStarter.starter.confirmed === false);
done();
