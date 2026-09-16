#!/usr/bin/env node
/* ===========================================================================
   THE TEAM IDENTITY ARTIFACT — copies, never computes; keeps measured,
   sourced and inferred apart; dates everything; never lets last season
   become this one.

   Run: node tools/football/team_identity.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const B = require(path.join(ROOT, 'tools', 'football', 'build_team_identity.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const art = B.build({});
const { index, files } = B.split(art);
chk('the schema is named', art.schema === 'edgedesk_team_identity_v1');
chk('the season is a field, not an assumption', Number.isInteger(art.season) && art.season >= 2024);
chk('every team file carries the schema and the season', Object.keys(files).every((k) => files[k].schema === art.schema && files[k].season === art.season));
chk('the index has one row per team file', Object.keys(index.teams).length === Object.keys(files).length && Object.keys(index.teams).every((k) => index.teams[k].file === 'football/identity/teams/' + k + '.json'));
chk('no team file exceeds 64 KB', Object.keys(files).every((k) => JSON.stringify(files[k]).length < 65536), Object.keys(files).map((k) => [k, JSON.stringify(files[k]).length]).sort((a, b) => b[1] - a[1]).slice(0, 3));

/* ---- FBS: measured values are copies of the rankings build ------------- */
const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'current.json'), 'utf8'));
const rt = (Array.isArray(R.teams) ? R.teams : Object.values(R.teams)).find((t) => t.performance && t.performance.offense_detail && t.performance.offense_detail.used.length >= 8);
const key = rt.key;
const T = art.teams[key];
chk('an FBS team with unit records is profiled', !!T && T.league === 'FBS');
if (T) {
  const u0 = rt.performance.offense_detail.used[0];
  const u = T.measured.units[u0.id];
  chk('a unit record is copied with raw, adjusted, league, z and sample', u && Math.abs(u.adjusted - u0.adjusted) < 1e-4 && Math.abs(u.league - u0.league) < 1e-4 && Math.abs(u.z - u0.z) < 1e-4 && u.n_obs === u0.n_obs, u);
  chk('and names its source and observation time', u && u.source === 'football/rankings/current.json' && !!u.as_of);
  chk('the defence side is copied too', Object.values(T.measured.units).some((x) => x.side === 'defense'));
  chk('the rating carries ETSR, confidence and gates', typeof T.measured.rating.etsr === 'number' && T.measured.rating.confidence != null && Array.isArray(T.measured.rating.gates));
  chk('offensive-line continuity states its basis as a headcount share', T.measured.ol_continuity && /headcount/.test(T.measured.ol_continuity.basis));
  chk('coaching names the coordinators as unknown', !T.measured.coaching || (T.measured.coaching.oc === null && T.measured.coaching.unknown.indexOf('oc') >= 0));
  chk('effective dates and verification are set', T.effective_from === art.season + '-08-01' && T.effective_to === null && !!T.verified_at);
  chk('measured, qualitative and inferences are separate keys', T.measured && Array.isArray(T.qualitative) && Array.isArray(T.inferences));
  chk('every qualitative claim names a source', T.qualitative.every((q) => q.source && q.kind));
  chk('every inference states its rule and inputs', T.inferences.every((i) => i.rule && i.inputs && i.confidence != null));
  chk('a small sample is an inference, never hidden', T.measured.sample.games >= 4 || T.inferences.some((i) => i.id === 'small_sample'));
  chk('what is not measured is listed', Array.isArray(T.not_measured) && T.not_measured.some((x) => /coordinator/.test(x)) && T.not_measured.some((x) => /coverage/.test(x)));
  chk('the trend is within-season with a sample count', !T.trend.early_vs_recent || (T.trend.early_vs_recent.sample_snapshots >= 2 && /hypothesis|trend/.test(T.trend.early_vs_recent.summary)));
  chk('the quarterback block separates starter, backup and competition', T.measured.quarterback && 'starter' in T.measured.quarterback && 'backup' in T.measured.quarterback && 'competition' in T.measured.quarterback);
  chk('a backup is a research read, never a start announcement', !T.measured.quarterback.backup || /never a start announcement/.test(T.measured.quarterback.backup.basis));
}

/* ---- inference rules are deterministic over stated inputs -------------- */
const fake = { measured: { units: { explosive_pass_rate: { z: 1.4, reliability: 0.7 }, success_rate: { z: -0.3, reliability: 0.8 }, sack_rate_allowed: { z: -1.1, reliability: 0.6, adjusted: 0.09, league: 0.06 } }, profile: { pass_rate: 0.66, plays_per_game: 80 }, ol_continuity: { continuity: 0.3, experience: 0.5 }, continuity: { rating: 20 }, quarterback: { competition: { contested: true, players: [{ player_name: 'A', share: 0.55 }, { player_name: 'B', share: 0.45 }] } }, sample: { games: 2, garbage_share: 0.2 } } };
const inf = B.inferencesFor(fake, { pass_rate: 0.52, plays_per_game: 70 });
const ids = inf.map((i) => i.id);
chk('pass-heavy fires on pass_rate above league + 0.06', ids.indexOf('scheme_pass_heavy') >= 0, ids);
chk('fast tempo fires on plays above league + 5', ids.indexOf('tempo_fast') >= 0);
chk('explosive-dependent fires on explosive z >= 1 with success z < 0', ids.indexOf('explosive_dependent') >= 0);
chk('protection weakness fires on sack rate allowed z <= -0.8', ids.indexOf('protection_weak') >= 0);
chk('a mostly new line fires under 0.40 continuity', ids.indexOf('ol_new') >= 0);
chk('heavy turnover fires under a continuity rating of 35', ids.indexOf('roster_turnover_heavy') >= 0);
chk('a contested quarterback job is an inference', ids.indexOf('qb_contested') >= 0);
chk('a small sample is always stated', ids.indexOf('small_sample') >= 0);
chk('the inference confidence is the weaker input reliability', inf.find((i) => i.id === 'explosive_dependent').confidence === 0.7);
const none = B.inferencesFor({ measured: { units: {}, profile: {}, sample: { games: 6 } } }, {});
chk('with nothing measured nothing is inferred', none.length === 0, none);

/* ---- NFL: raw season rates re-summed from the team-week rows ------------ */
const N = Object.values(art.teams).filter((t) => t.league === 'NFL');
chk('32 NFL clubs are profiled', N.length === 32, N.length);
/* The team-week feed is a gitignored download that CI does not have, so the unit assertions run on a LABELLED FIXTURE:
   four clubs, two weeks, counts chosen so the rates are checkable by hand (BUF week 1: 30 att + 2 sk = 32 dropbacks,
   passing_epa 8 -> 0.25 per dropback). */
const TW_HEAD = 'season,week,team,season_type,game_id,opponent_team,attempts,sacks_suffered,passing_epa,passing_20,carries,rushing_epa,rushing_10,def_sacks,def_qb_hits,passing_interceptions,sack_fumbles_lost,rushing_fumbles_lost,receiving_fumbles_lost';
const twRow = (wk, team, opp, gid, att, sk, pepa, p20, car, repa, r10, dsk, dqh, ints) => [art.season, wk, team, 'REG', gid, opp, att, sk, pepa, p20, car, repa, r10, dsk, dqh, ints, 0, 0, 0].join(',');
const TW_FIXTURE = [TW_HEAD,
  twRow(1, 'BUF', 'NYJ', art.season + '_01_BUF_NYJ', 30, 2, 8, 4, 28, 2, 3, 3, 6, 0), twRow(1, 'NYJ', 'BUF', art.season + '_01_BUF_NYJ', 34, 3, -6, 2, 22, -1, 1, 2, 4, 1),
  twRow(1, 'MIA', 'NE', art.season + '_01_MIA_NE', 36, 1, 3, 5, 24, 0, 2, 1, 3, 0), twRow(1, 'NE', 'MIA', art.season + '_01_MIA_NE', 28, 4, -2, 1, 30, 1, 2, 1, 2, 1),
  twRow(2, 'BUF', 'MIA', art.season + '_02_BUF_MIA', 32, 1, 6, 3, 30, 3, 4, 4, 7, 1), twRow(2, 'MIA', 'BUF', art.season + '_02_BUF_MIA', 38, 4, -1, 4, 20, -2, 1, 1, 2, 2),
  twRow(2, 'NYJ', 'NE', art.season + '_02_NYJ_NE', 26, 2, 1, 2, 32, 2, 3, 2, 5, 0), twRow(2, 'NE', 'NYJ', art.season + '_02_NYJ_NE', 30, 2, -4, 1, 26, -1, 1, 2, 3, 1),
].join('\n');
const artF = B.build({ team_week_csv: TW_FIXTURE, team_week_as_of: '2026-09-15T00:00:00.000Z' });
chk('the fixture is named as a fixture in the sources, never as the feed', artF.sources && artF.sources.TW && /FIXTURE/.test(artF.sources.TW.path), artF.sources && artF.sources.TW);
const bufF = artF.teams.buf;
chk('BUF passing EPA per dropback is the summed count over summed dropbacks (14 / 65)', bufF && bufF.measured.units.pass_epa_db && bufF.measured.units.pass_epa_db.raw === Math.round(14 / 65 * 10000) / 10000 && bufF.measured.units.pass_epa_db.n === 65, bufF && bufF.measured.units.pass_epa_db);
chk('BUF sack rate made is the defence\'s sacks over the opponents\' dropbacks (7 / 79)', bufF && bufF.measured.units.sack_rate_made && bufF.measured.units.sack_rate_made.raw === Math.round(7 / 79 * 10000) / 10000, bufF && bufF.measured.units.sack_rate_made);
chk('the fixture as-of date is carried on every unit', bufF && Object.values(bufF.measured.units).every((u) => u.as_of === '2026-09-15T00:00:00.000Z'));
chk('a club with no team-week rows names the missing units instead of inventing them', artF.teams.kc && artF.teams.kc.measured.missing_units.length === 1 && Object.keys(artF.teams.kc.measured.units).length === 0, artF.teams.kc && artF.teams.kc.measured.missing_units);
const buf = bufF;
if (buf) {
  chk('an NFL unit carries the raw rate, the league mean and a z, and says it is not opponent-adjusted', buf.measured.units.pass_epa_db && buf.measured.units.pass_epa_db.adjusted === null && buf.measured.units.pass_epa_db.league != null && /NOT opponent-adjusted/.test(buf.measured.units.pass_epa_db.basis));
  chk('the NFL rating is the engine deviation and says so', buf.measured.rating && /deviation/.test(buf.measured.rating.basis));
  chk('the official report is grouped by position with counts', buf.measured.availability && buf.measured.availability.state === 'OFFICIAL_REPORT' && buf.measured.availability.by_position_group && typeof buf.measured.availability.questionable === 'number');
  chk('what the NFL profile cannot measure is named', buf.not_measured.some((x) => /coaching/.test(x)) && buf.measured.coaching === null && buf.measured.ol_continuity === null);
  chk('per-game rows exist for the trend', Array.isArray(buf.trend.games) && buf.trend.games.length >= 1 && buf.trend.games[0].off_epa_play != null);
  chk('the NFL starter is carried with its status', buf.measured.quarterback.starter && buf.measured.quarterback.starter.name && buf.measured.quarterback.starter.confirmed === false);
}
chk('league means for the NFL are computed over the clubs with rows', artF.league_means.nfl && artF.league_means.nfl.pass_rate > 0.4 && artF.league_means.nfl.pass_rate < 0.7, artF.league_means.nfl && artF.league_means.nfl.pass_rate);
chk('a z-score is against those clubs and direction-corrected for a lower-is-better unit', bufF && bufF.measured.units.sack_rate_all && bufF.measured.units.sack_rate_all.z > 0 && bufF.measured.units.pass_epa_db.z > 0, bufF && { sack: bufF.measured.units.sack_rate_all, pass: bufF.measured.units.pass_epa_db });

/* ---- the artifact on disk matches the builder ------------------------- */
const onDisk = path.join(ROOT, 'football', 'identity', 'index.json');
if (fs.existsSync(onDisk)) {
  const idx = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
  chk('the committed index carries the same season and team count', idx.season === art.season && Object.keys(idx.teams).length === Object.keys(index.teams).length);
  const sample = Object.keys(index.teams)[0];
  chk('a committed team file parses and names its team', (() => { try { const f = JSON.parse(fs.readFileSync(path.join(ROOT, index.teams[sample].file), 'utf8')); return f.team === index.teams[sample].team; } catch (_) { return false; } })());
}
done();
