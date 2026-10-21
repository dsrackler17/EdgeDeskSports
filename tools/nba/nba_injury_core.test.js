#!/usr/bin/env node
/* ===========================================================================
   The NBA roster and injury layer's core (nba/injury/core.js), offline.

     time       Eastern wall clock <-> UTC across daylight time; the report's
                file names in both of the league's formats
     report     the official report's PDF layout read into rows: carried-down
                date / time / matchup / team, NOT YET SUBMITTED, a wrapped
                reason, a suffixed name, Available; nothing unread is dropped
     espn       the fallback statuses (Day-To-Day is UNKNOWN, never Questionable)
                and the roster, flat or grouped
     names      exact, initial, league-wide (a team mismatch), unmatched; never
                a nearest guess
     minutes    the scaling is PlayerModel.strength's own; the depth chart; the
                exact expectation over uncertain statuses sums to 240
     model      an unchanged healthy roster moves nothing; the adjustments add
                up exactly to the change; a game is WITHHELD (no number) when
                the report is missing, unfiled, unmatched or disagrees
     acceptance Hornets at Nets 2026-10-21 (real roster inputs): Ball and
                Bridges gone, White / Knueppel / Williams OUT, the spread moves
                at least six points toward Brooklyn from the baseline CHA -9.5
     registry   the model's numbers are the registered ones
     preseason  the ESPN preseason scoreboard and box score readers

   Run: node tools/nba/nba_injury_core.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const K = require(path.join(ROOT, 'nba', 'injury', 'core.js'));
const DIST = require(path.join(ROOT, 'nba', 'model', 'distribution.js'));
const DF = require(path.join(ROOT, 'nba', 'model', 'dist_fit.js'));
const { PlayerModel } = require(path.join(ROOT, 'nba', 'model', 'players.js'));
const PRE = require(path.join(ROOT, 'nba', 'tools', 'preseason.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-9 : e);

/* ---------------------------------------------------------------- time */
chk('teams: thirty, unique ESPN ids, abbreviations and tricodes', K.NBA_TEAMS.length === 30 && new Set(K.NBA_TEAMS.map((t) => t[0])).size === 30 && new Set(K.NBA_TEAMS.map((t) => t[1])).size === 30 && new Set(K.NBA_TEAMS.map((t) => t[2])).size === 30);
chk('teams: every spelling resolves (ESPN, tricode, name, old feeds)', K.nbaTeam('BKN').id === '17' && K.nbaTeam('NYK').id === '18' && K.nbaTeam('GSW').id === '9' && K.nbaTeam('Los Angeles Clippers').id === '12' && K.nbaTeam('UTA').abbr === 'UTAH' && K.nbaTeam('NJ').abbr === 'BKN' && K.nbaTeam('XYZ') === null);
chk('time: 5:30 PM Eastern on 2026-10-21 (daylight) is 21:30Z', K.nbaIso(K.nbaEtToUtc(2026, 10, 21, 17, 30)) === '2026-10-21T21:30:00Z');
chk('time: 5:30 PM Eastern on 2026-12-01 (standard) is 22:30Z', K.nbaIso(K.nbaEtToUtc(2026, 12, 1, 17, 30)) === '2026-12-01T22:30:00Z');
chk('time: 01:30Z on 2026-10-22 is the 21st in the East', K.nbaEtDate(Date.parse('2026-10-22T01:30:00Z')) === '2026-10-21');
chk('report name: the quarter-hour form', K.nbaIso(K.nbaReportTimeFromName('https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-21_05_30PM.pdf')) === '2026-10-21T21:30:00Z');
chk('report name: the on-the-hour form; 12 AM is midnight', K.nbaIso(K.nbaReportTimeFromName('Injury-Report_2026-10-21_01PM.pdf')) === '2026-10-21T17:00:00Z' && K.nbaIso(K.nbaReportTimeFromName('Injury-Report_2026-10-22_12AM.pdf')) === '2026-10-22T04:00:00Z');
const html = '<a href="https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-21_01_30PM.pdf">1:30</a> <a href=\'https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-21_05_30PM.pdf\'>5:30</a> <a href="/x/Injury-Report_2026-10-20_11AM.pdf">old</a> <a href="https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-21_05_30PM.pdf">dup</a>';
const links = K.nbaFindReportLinks(html, 'https://official.nba.com/');
chk('season page: every report link, deduplicated, newest first, relative links resolved', links.length === 3 && /05_30PM/.test(links[0].url) && /11AM/.test(links[2].url) && links[2].url.indexOf('https://official.nba.com/x/') === 0, links);
const cands = K.nbaReportCandidates(Date.parse('2026-10-21T21:40:00Z'), 1);
chk('candidates: newest quarter hour first, both file-name forms on the hour', /2026-10-21_05_30PM\.pdf$/.test(cands[0].url) && cands.some((c) => /2026-10-21_05PM\.pdf$/.test(c.url)) && cands.some((c) => /2026-10-21_05_00PM\.pdf$/.test(c.url)), cands.map((c) => c.url));
chk('season page url: 2026-27 in October, 2025-26 in March', K.nbaSeasonPageUrl(Date.parse('2026-10-21T12:00:00Z')).endsWith('nba-injury-report-2026-27-season/') && K.nbaSeasonPageUrl(Date.parse('2026-03-01T12:00:00Z')).endsWith('nba-injury-report-2025-26-season/'));

/* ---------------------------------------------------------------- the official report */
/* pdf.js text items in the league's layout: one item per printed cell */
const X = { date: 22, time: 88, matchup: 148, team: 206, player: 352, status: 498, reason: 572 };
function reportItems(title, rows) {
  const it = [], put = (s, x, y) => it.push({ str: s, transform: [1, 0, 0, 1, x, y] });
  let y = 560;
  put(title, 22, 585);
  ['Game Date', 'Game Time', 'Matchup', 'Team', 'Player Name', 'Current Status', 'Reason'].forEach((h, i) => put(h, Object.values(X)[i], y));
  for (const r of rows) {
    y -= 14;
    for (const k of Object.keys(X)) if (r[k]) put(r[k], X[k], y + (r.dy && r.dy[k] || 0));
    if (r.wrap) { y -= 10; put(r.wrap, X.reason, y); }
  }
  put('Page 1 of 1', 380, 20);
  return it.sort(() => 0);
}
const ROWS = [
  { date: '10/21/2026', time: '07:30 (ET)', matchup: 'CHA@BKN', team: 'Charlotte Hornets', player: 'White, Coby', status: 'Out', reason: 'Injury/Illness - Left Calf; Strain' },
  { player: 'Knueppel, Kon', status: 'Out', reason: 'Injury/Illness - Right Ankle;', wrap: 'Sprain' },
  { player: 'Williams, Grant', status: 'Out', reason: 'Injury/Illness - Right Knee; Injury Management' },
  { team: 'Brooklyn Nets', player: 'Porter Jr., Michael', status: 'Questionable', reason: 'Injury/Illness - Low Back; Soreness' },
  { player: 'Thomas, Cam', status: 'Available', reason: 'Injury/Illness - Left Hamstring; Strain' },
  { time: '08:00 (ET)', matchup: 'MIN@MIA', team: 'Miami Heat', player: 'NOT YET SUBMITTED' },
  { team: 'Minnesota Timberwolves', player: 'Edwards, Anthony', status: 'Probable', reason: 'Injury/Illness - Right Hip; Contusion' },
];
const lines = K.nbaLinesFromItems(reportItems('Injury Report: 10/21/26 05:30 PM', ROWS));
const R = K.nbaParseOfficialLines(lines, { url: 'https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-21_05_30PM.pdf' });
chk('report: published time read from the title (5:30 PM ET = 21:30Z)', R.published_ms === Date.parse('2026-10-21T21:30:00Z'), R.published_ms);
chk('report: the header row is recognised, nothing is unread', R.header_seen && R.unread.length === 0, R.unread);
chk('report: six player rows, date / time / matchup / team carried down', R.rows.length === 6 && R.rows.every((r) => r.game_date === '2026-10-21') && R.rows[1].matchup === 'CHA@BKN' && R.rows[1].team_id === '30' && R.rows[3].team_id === '17' && R.rows[5].matchup === 'MIN@MIA' && R.rows[5].team_id === '16' && R.rows[5].game_time_et === '08:00', R.rows);
chk('report: the five official statuses, the source word kept', R.rows.map((r) => r.status).join(',') === 'OUT,OUT,OUT,QUESTIONABLE,AVAILABLE,PROBABLE' && R.rows[3].source_status === 'Questionable');
chk('report: "Last, First" printed as "First Last", the suffix kept', R.rows[0].player_name === 'Coby White' && R.rows[3].player_name === 'Michael Porter Jr.');
chk('report: a wrapped reason joins its row', R.rows[1].reason === 'Injury/Illness - Right Ankle; Sprain', R.rows[1].reason);
chk('report: a team that has not filed is NOT YET SUBMITTED, not "no injuries"', R.not_submitted.length === 1 && R.not_submitted[0].team_id === '14' && R.not_submitted[0].matchup === 'MIN@MIA');
chk('report: every matchup on the report is listed (coverage), away and home', R.matchups.length === 2 && R.matchups[0].away_id === '30' && R.matchups[0].home_id === '17');
/* a vertically centred reason: its first line prints above the row */
const centred = K.nbaParseOfficialLines(['Injury Report: 10/21/26 05:30 PM', '10/21/2026 07:30 (ET) CHA@BKN Charlotte Hornets White, Coby Out Injury/Illness - Left Calf; Strain', 'Injury/Illness - Right', 'Knueppel, Kon Out', 'Ankle; Sprain', 'Williams, Grant Out Rest']);
chk('report: a reason printed around its row still joins it', centred.rows[1].reason === 'Injury/Illness - Right Ankle; Sprain' && centred.rows[2].reason === 'Rest' && centred.unread.length === 0, centred.rows);
const drift = K.nbaParseOfficialLines(['Injury Report: 10/21/26 05:30 PM', 'Something the parser has never seen Out of place 12 34 56 78 90 12 34 56 78 90 12 34 56 78 90 12 34 56 78 90 12 34 56 78 90 12 34 56 78 90 12 34 56 78 90 12 34 56 78 90']);
chk('report: a line that reads as nothing is UNREAD, returned, never guessed into a row', drift.rows.length === 0 && drift.unread.length === 1);
chk('report: with no title, the file name dates it', K.nbaParseOfficialLines(['10/21/2026 07:30 (ET) CHA@BKN Charlotte Hornets White, Coby Out Rest'], { url: 'Injury-Report_2026-10-21_05_30PM.pdf' }).published_ms === Date.parse('2026-10-21T21:30:00Z'));
const same1 = K.nbaReportContent(R), same2 = K.nbaReportContent({ rows: R.rows.slice().reverse(), not_submitted: R.not_submitted, matchups: R.matchups.slice().reverse() });
const changed = K.nbaReportContent({ rows: R.rows.map((r, i) => (i === 3 ? Object.assign({}, r, { status: 'OUT' }) : r)), not_submitted: R.not_submitted, matchups: R.matchups });
chk('dedupe: the same rows in another order are the same report; a changed status is not', same1 === same2 && same1 !== changed);

/* ---------------------------------------------------------------- ESPN */
const espnInj = { injuries: [
  { id: '30', displayName: 'Charlotte Hornets', injuries: [
    { status: 'Out', date: '2026-10-21T15:00Z', athlete: { displayName: 'Coby White', links: [{ href: 'https://www.espn.com/nba/player/_/id/4395651/coby-white' }] }, details: { type: 'Calf', side: 'Left', detail: 'Strain' } },
    { status: 'Day-To-Day', athlete: { displayName: 'Brandon Miller', id: '4433287' }, shortComment: 'Miller (ankle) is day-to-day.' }] },
  { id: '17', displayName: 'Brooklyn Nets', injuries: [{ status: 'Questionable', athlete: { displayName: 'Michael Porter Jr.' }, details: { location: 'Back' } }] }] };
const EI = K.nbaParseEspnInjuries(espnInj);
chk('espn: rows with team, id (from the link or the athlete), the source word kept', EI.rows.length === 3 && EI.rows[0].player_id === '4395651' && EI.rows[1].player_id === '4433287' && EI.rows[2].player_id === null && EI.rows[0].team_id === '30');
chk('espn: Out / Questionable map; Day-To-Day is UNKNOWN (no official equivalent), never Questionable', EI.rows[0].status === 'OUT' && EI.rows[1].status === 'UNKNOWN' && EI.rows[1].source_status === 'Day-To-Day' && EI.rows[2].status === 'QUESTIONABLE');
const flat = K.nbaParseEspnRoster({ athletes: [{ id: '2', displayName: 'B Two', position: { abbreviation: 'G' }, jersey: '3', status: { name: 'Active', type: 'active' } }, { id: '1', fullName: 'A One', status: { name: 'Two-Way' } }] }, '30');
const grouped = K.nbaParseEspnRoster({ athletes: [{ position: 'Guards', items: [{ id: '5', displayName: 'Five' }] }, { position: 'Forwards', items: [{ id: '4', displayName: 'Four', status: { name: 'Suspended' } }] }] }, 17);
chk('espn roster: flat list, sorted by id, statuses normalised', flat.players.length === 2 && flat.players[0].player_id === '1' && flat.players[0].roster_status === 'TWO_WAY' && flat.players[1].roster_status === 'ACTIVE' && flat.players[1].position === 'G');
chk('espn roster: grouped by position reads too', grouped.team_id === '17' && grouped.players.length === 2 && grouped.players.find((p) => p.player_id === '4').roster_status === 'SUSPENDED');

/* ---------------------------------------------------------------- names */
const idx = K.nbaNameIndex({ 30: [{ player_id: '1', player_name: 'Coby White' }, { player_id: '2', player_name: 'Kon Knueppel' }, { player_id: '3', player_name: 'Nic Claxton' }],
  17: [{ player_id: '7', player_name: 'Michael Porter Jr.' }, { player_id: '8', player_name: 'Day\'Ron Sharpe' }, { player_id: '9', player_name: 'Jalen Williams' }, { player_id: '10', player_name: 'Jaylin Williams' }],
  16: [{ player_id: '11', player_name: 'Naz Reid' }] });
chk('names: "Last, First" and diacritics and suffixes key the same', K.nbaNameKey('Porter Jr., Michael') === 'michael porter' && K.nbaNameKey('Šarić, Dario') === 'dario saric' && K.nbaNameKey("Sharpe, Day'Ron") === 'dayron sharpe');
chk('names: team exact', K.nbaMatchPlayer('White, Coby', '30', idx).player_id === '1' && K.nbaMatchPlayer('White, Coby', '30', idx).method === 'team_exact');
chk('names: an official spelling with a known alias', K.nbaMatchPlayer('Claxton, Nicolas', '30', idx).player_id === '3');
chk('names: surname and first initial, unique on the team', K.nbaMatchPlayer('Knueppel, Konrad', '30', idx).method === 'team_initial');
chk('names: two Williams with the same initial are not guessed', K.nbaMatchPlayer('Williams, Jay', '17', idx).player_id === null);
chk('names: found on another team is a mismatch, reported', K.nbaMatchPlayer('Reid, Naz', '30', idx).team_mismatch === true && K.nbaMatchPlayer('Reid, Naz', '30', idx).team_id === '16');
chk('names: nobody is UNMATCHED', K.nbaMatchPlayer('Nobody, Some', '30', idx).player_id === null && K.nbaMatchPlayer('Nobody, Some', '30', idx).method === 'unmatched');
const games = [{ game_id: 'g1', start_utc: '2026-10-21T23:30:00Z', home: { id: '17' }, away: { id: '30' } }, { game_id: 'g2', start_utc: '2026-10-23T23:00:00Z', home: { id: '30' }, away: { id: '1' } }];
chk('games: a report row finds its slate game by Eastern date and teams', K.nbaResolveGame(R.rows[0], games).game_id === 'g1' && K.nbaResolveGame(Object.assign({}, R.rows[0], { game_date: '2026-10-22' }), games) === null);
chk('games: a fallback row applies to the team\'s next game within 36 hours', K.nbaNextGame('30', games, Date.parse('2026-10-21T12:00:00Z'), 36).game_id === 'g1' && K.nbaNextGame('1', games, Date.parse('2026-10-21T12:00:00Z'), 36) === null);

/* ---------------------------------------------------------------- minutes */
const C = K.NBA_ROSTER_MODEL.minutes;
const pmod = new PlayerModel({});
const usual = { a: 36, b: 34, c: 31, d: 28, e: 26, f: 22, g: 18, h: 14, i: 9, j: 6, k: 41.5 };
for (const [pid, m] of Object.entries(usual)) pmod.pl.set(pid, { ewm: m, wsum: 1, team: 't', last_day: 1, starts: 0, games: 5 });
const ids = Object.keys(usual), st = pmod.strength(ids), mine = K.nbaScaleMinutes(ids.map((id) => ({ id, e: usual[id] })), C);
chk('minutes: the scaling is PlayerModel.strength\'s own (every player, to the hundredth of a minute)', st.minutes.every((x) => near(x.min, mine[x.pid], 1e-9)), [st.minutes.map((x) => x.min.toFixed(3)), ids.map((id) => mine[id].toFixed(3))]);
const rot = K.nbaRotationMinutes(ids.map((id) => ({ id, e: usual[id] })), C);
const sum = (o) => Object.values(o).reduce((a, v) => a + v, 0);
chk('minutes: the depth chart plays the top of the roster, 240 minutes, nobody over 40', near(sum(rot), 240, 0.5) && !('j' in rot) && Object.values(rot).every((v) => v <= 40 + 1e-9), rot);
const rotOut = K.nbaRotationMinutes(ids.filter((id) => id !== 'a').map((id) => ({ id, e: usual[id] })), C);
chk('minutes: a starter out opens minutes to the next man down', (rotOut.j || 0) > 0 && near(sum(rotOut), 240, 0.5));
const ex = K.nbaExpectedAllocation(ids.map((id) => ({ id, e: usual[id], p: id === 'b' ? 0.5 : id === 'c' ? 0 : 1 })), C);
chk('minutes: the expectation over a Questionable player is the average of his two worlds, and sums to 240', near(sum(ex), 240, 0.5) && ex.c === 0 && ex.b > 0 && ex.b < rot.b, ex);
chk('minutes: more uncertain players than registered is refused (null), never sampled', K.nbaExpectedAllocation(Array.from({ length: 13 }, (_, i) => ({ id: 'u' + i, e: 20, p: 0.5 })), C) === null);
chk('minutes: the preseason prior blends with the EWM and fades over ten games', near(K.nbaExpectedMinutes({ ewm_minutes: 20, games: 50, preseason_minutes: 30, preseason_games: 4, season_games: 0 }).e, 25) && near(K.nbaExpectedMinutes({ ewm_minutes: 20, games: 50, preseason_minutes: 30, preseason_games: 4, season_games: 10 }).e, 20) && K.nbaExpectedMinutes({ preseason_minutes: 18, preseason_games: 3, games: 0 }).e === 18 && K.nbaExpectedMinutes(null).e === 10);
chk('sd rule: the model\'s own (dist_fit.sdOf)', [0, 3.2, -7, 12, -15].every((mu) => near(K.nbaSdOf({ s0: 14.665, s1: -0.05 }, mu), DF.sdOf({ s0: 14.665, s1: -0.05 }, mu))));

/* ---------------------------------------------------------------- the model on a synthetic game */
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nba_injury_cha_bkn_2026-10-21.json'), 'utf8'));
const shape = FX.shape;
function synth() {
  const P = {}, ref = { home: [], away: [] }, ros = { home: [], away: [] };
  ['home', 'away'].forEach((k, s) => { for (let i = 0; i < 12; i++) { const id = k[0] + i, m = [34, 33, 31, 30, 28, 24, 20, 16, 12, 8, 6, 4][i]; P[id] = { name: k + ' ' + i, o: (i % 3) - 1 + s, d: 0.5 - (i % 2), known: true, ewm_minutes: m, games: 60, season_games: 20, team_id: s ? '30' : '17' }; ref[k].push({ id, name: P[id].name, minutes: m }); ros[k].push(id); } });
  return { game: { game_id: 'x', home: { id: '17', abbr: 'BKN' }, away: { id: '30', abbr: 'CHA' }, pace: 98, baseline: { mu_m: 2.4, mu_t: 225 }, neutral: { mu_m: 2.4, mu_t: 225 }, reference: ref }, shape, players: P, rosters: ros,
    roster_meta: { home: { capture_id: 1 }, away: { capture_id: 2 } }, statuses: { home: [], away: [] }, report: { id: 5, source: 'nba_official', published_at: '2026-10-21T21:30:00Z', on_report: true, not_submitted: {} }, team_of: {} };
}
const base = synth(), r0 = K.nbaRosterAdjust(base, DIST);
chk('model: an unchanged, healthy roster moves nothing (adjusted = baseline exactly)', r0.status === 'OK' && r0.delta.mu_m === 0 && r0.delta.mu_t === 0 && r0.adjusted.fair_spread_home === r0.baseline.fair_spread_home && r0.adjusted.p_home === r0.baseline.p_home, r0.delta);
const s1 = synth(); s1.statuses.away = [{ id: 11, player_id: 'a0', player_name: 'away 0', status: 'OUT', source_status: 'Out', match_method: 'team_exact' }, { id: 12, player_id: 'a2', player_name: 'away 2', status: 'QUESTIONABLE', source_status: 'Questionable', match_method: 'team_exact' }];
s1.rosters.home = s1.rosters.home.filter((id) => id !== 'h1');
const r1 = K.nbaRosterAdjust(s1, DIST);
const addsUp = (r) => near(r.adjustments.reduce((a, l) => a + (l.margin_home || 0), 0), r.delta.mu_m, 5e-4 * r.adjustments.length) && near(r.adjustments.reduce((a, l) => a + (l.total || 0), 0), r.delta.mu_t, 5e-4 * r.adjustments.length);
chk('model: the adjustments add up to the change in the expected margin and total (no hidden term)', r1.status === 'OK' && addsUp(r1), [r1.delta, r1.adjustments.map((l) => l.margin_home)]);
chk('model: every status line traces to its report row; every roster line to its capture', r1.adjustments.filter((l) => l.kind === 'status').every((l) => l.evidence.report_id === 5 && l.evidence.report_row_id) && r1.adjustments.filter((l) => l.kind === 'departed').every((l) => l.evidence.roster_capture_id === 1));
const s2 = synth(); Object.keys(s2.players).forEach((id) => { s2.players[id].o = 0; s2.players[id].d = 0; }); s2.players.a0.o = 3; s2.players.h1.o = 2;
s2.statuses.away = [{ id: 11, player_id: 'a0', player_name: 'away 0', status: 'OUT', source_status: 'Out', match_method: 'team_exact' }]; s2.rosters.home = s2.rosters.home.filter((id) => id !== 'h1');
const r2 = K.nbaRosterAdjust(s2, DIST);
chk('model: an OUT away starter (average replacements) moves the margin toward home; a departed home player moves it away', r2.adjustments.find((l) => l.player_id === 'a0').margin_home > 0 && r2.adjustments.find((l) => l.player_id === 'h1').margin_home < 0 && r2.roster_changes.home.departed.some((d) => d.player_id === 'h1') && r2.adjusted.p_home === r2.adjusted.p_home, r2.adjustments.map((l) => [l.player_id, l.margin_home]));
const w = (mut) => { const x = synth(); mut(x); return K.nbaRosterAdjust(x, DIST); };
const wNo = w((x) => { x.report = {}; }), wOff = w((x) => { x.report.on_report = false; }), wNs = w((x) => { x.report.not_submitted = { away: true }; });
const wUn = w((x) => { x.statuses.away = [{ id: 1, player_id: null, player_name: 'Some Body', status: 'OUT', match_method: 'unmatched' }]; });
const wMis = w((x) => { x.statuses.away = [{ id: 1, player_id: 'h3', player_name: 'home 3', status: 'OUT', match_method: 'league_exact', team_mismatch: true }]; });
const wRos = w((x) => { x.rosters.away = []; });
chk('withheld: no report, not on the report, not submitted, unmatched OUT, roster disagreement, no roster — each with no number and a reason', [wNo, wOff, wNs, wUn, wMis, wRos].every((r) => r.status === 'WITHHELD' && r.adjusted === null && r.delta === null && r.reasons.length > 0), [wNo, wOff, wNs, wUn, wMis, wRos].map((r) => r.reasons));
chk('withheld: the roster facts still stand (they are observations)', wNs.roster_changes.home && Array.isArray(wNs.roster_changes.home.departed));
chk('withheld: an unmatched AVAILABLE row does not withhold (it moves nothing)', w((x) => { x.statuses.away = [{ id: 1, player_id: null, player_name: 'Some Body', status: 'AVAILABLE' }]; }).status === 'OK');
const wSane = w((x) => { x.players.h0.o = 400; x.statuses.home = [{ id: 1, player_id: 'h0', player_name: 'home 0', status: 'OUT', match_method: 'team_exact' }]; });
chk('model: an unchanged player moves nothing however large his impact (only minutes changes count)', w((x) => { x.players.h0.o = 400; }).delta.mu_m === 0);
chk('sanity: an adjustment beyond the registered bound is withheld, not published', wSane.status === 'WITHHELD' && /sanity/.test(wSane.reasons.join(' ')), wSane.reasons);

/* ---------------------------------------------------------------- acceptance: Hornets at Nets */
const lines2 = K.nbaLinesFromItems(reportItems('Injury Report: 10/21/26 05:30 PM', ROWS.slice(0, 3)));
const rep = K.nbaParseOfficialLines(lines2, {});
const ix = K.nbaNameIndex({ 17: FX.rosters['17'].map((p) => ({ player_id: p.id, player_name: p.name })), 30: FX.rosters['30'].map((p) => ({ player_id: p.id, player_name: p.name })) });
const stat = rep.rows.map((r, i) => { const m = K.nbaMatchPlayer(r.player_name, r.team_id, ix); return Object.assign({ id: 100 + i, player_id: m.player_id, match_method: m.method, team_mismatch: !!m.team_mismatch }, r); });
const game = FX.game;
const covered = rep.matchups.some((m) => m.home_id === game.home.id && m.away_id === game.away.id);
const A = K.nbaRosterAdjust({ game, shape, players: FX.players, rosters: { home: FX.rosters['17'].map((p) => p.id), away: FX.rosters['30'].map((p) => p.id) },
  roster_meta: { home: { capture_id: 41, captured_at: FX.rosters_source.fetched_at, source: 'hoopr_rosters' }, away: { capture_id: 42, captured_at: FX.rosters_source.fetched_at, source: 'hoopr_rosters' } },
  statuses: { home: stat.filter((r) => r.team_id === '17'), away: stat.filter((r) => r.team_id === '30') },
  report: { id: 7, source: 'nba_official', published_at: K.nbaIso(rep.published_ms), on_report: covered, not_submitted: {} }, team_of: FX.team_of, slate_generated_at: FX.slate_generated_at }, DIST);
chk('acceptance: the three statuses read from the report layout and match Charlotte players', stat.length === 3 && stat.every((r) => r.status === 'OUT' && r.player_id && r.match_method === 'team_exact'), stat);
chk('acceptance: the baseline reprices exactly: Charlotte -9.5 (Brooklyn +9.5), Brooklyn 22.19%', A.baseline.fair_spread_home === 9.5 && A.baseline.p_home === game.baseline.p_home && A.baseline.expected.margin === game.baseline.expected.margin, A.baseline);
chk('acceptance: LaMelo Ball and Miles Bridges are no longer on Charlotte\'s roster', ['LaMelo Ball', 'Miles Bridges'].every((n) => A.roster_changes.away.departed.some((d) => d.player_name === n)) && A.adjustments.some((l) => l.kind === 'departed' && /LaMelo Ball no longer on CHA/.test(l.text)), A.roster_changes.away.departed);
chk('acceptance: Coby White, Kon Knueppel and Grant Williams are OUT, each a traceable line', ['Coby White', 'Kon Knueppel', 'Grant Williams'].every((n) => A.adjustments.some((l) => l.kind === 'status' && l.status === 'OUT' && l.player_name === n && l.evidence.report_id === 7 && new RegExp(n + ' OUT: −').test(l.text))));
chk('acceptance: the adjusted spread moves at least six points toward Brooklyn from -9.5', A.status === 'OK' && A.baseline.fair_spread_home - A.adjusted.fair_spread_home >= 6 && A.adjusted.p_home > A.baseline.p_home, { baseline: A.baseline.fair_spread_home, adjusted: A.adjusted && A.adjusted.fair_spread_home, p: A.adjusted && A.adjusted.p_home });
chk('acceptance: the lines add up to the change', addsUp(A), A.delta);
chk('acceptance: every line names a team and a size in points', A.adjustments.every((l) => /pts (BKN|CHA)/.test(l.text)));

/* ---------------------------------------------------------------- registry */
const REG = JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'research', 'roster_adjusted', 'registration.json'), 'utf8'));
const M = K.NBA_ROSTER_MODEL;
chk('registry: the core prices exactly the registered model (key, version, mapping, minutes, coefficient, bounds)', REG.model_key === M.key && REG.version === M.version && REG.status === 'EXPERIMENTAL'
  && JSON.stringify(REG.spec.play_probability) === JSON.stringify(M.play_probability) && JSON.stringify(REG.spec.minutes) === JSON.stringify(M.minutes) && REG.spec.rating_coefficient === M.rating_coefficient && JSON.stringify(REG.spec.sanity) === JSON.stringify(M.sanity) && JSON.stringify(REG.spec.impact) === JSON.stringify(M.impact));
chk('registry: promotion criteria and the forking-paths disclosure are registered before any result', Array.isArray(REG.promotion_criteria.criteria) && REG.promotion_criteria.criteria.length >= 3 && REG.forking_paths && Array.isArray(REG.forking_paths.candidates_tried) && REG.forking_paths.candidates_tried.length === 1 && REG.result === null);

/* ---------------------------------------------------------------- the validation report */
const EV = require(path.join(ROOT, 'nba', 'research', 'roster_adjusted', 'evaluate.js'));
const evGames = [], evLed = [], evSnaps = [];
for (let i = 0; i < 40; i++) {
  const day = 22 + (i % 8), start = '2026-10-' + day + 'T23:30:00Z', id = 'e' + i, margin = (i % 7) - 3, base = { m: margin + 6, t: 220 }, adj = { m: margin + 2, t: 221 };
  evGames.push({ game_id: id, start_utc: start, type: 'R', status: 'FINAL', hs: 110 + margin, as: 110 });
  evLed.push({ game_id: id, recorded_at: '2026-10-' + day + 'T12:00:00Z', exp_margin: base.m, exp_total: base.t, p_home: 0.6 });
  evSnaps.push({ game_id: id, computed_at: '2026-10-' + day + 'T22:00:00Z', status: i === 39 ? 'WITHHELD' : 'OK', reasons: i === 39 ? ['CHA has not submitted its injury report'] : [], report_source: i === 38 ? 'espn_injuries' : 'nba_official', adjusted: { expected: { margin: adj.m, total: adj.t }, p_home: 0.55 } });
  evSnaps.push({ game_id: id, computed_at: '2026-10-' + day + 'T23:45:00Z', status: 'OK', reasons: [], report_source: 'nba_official', adjusted: { expected: { margin: 99, total: 999 }, p_home: 0.99 } }); /* after tip: never read */
}
evGames.push({ game_id: 'pre', start_utc: '2026-10-21T23:30:00Z', type: 'R', status: 'FINAL', hs: 100, as: 99 });
const pu = EV.pairUp(evSnaps, evLed, evGames, ['2026-10-22', '2027-04-12']);
chk('report: pairs each holdout game\'s last pregame values; a snapshot after tip, a fallback-source one and a withheld one are not paired; 2026-10-21 is outside', pu.pairs.length === 38 && pu.coverage.holdout_games === 40 && pu.coverage.withheld === 1 && pu.coverage.fallback_only === 1 && pu.pairs.every((p) => p.adj.m !== 99), pu.coverage);
const bb1 = EV.blockBootstrap(pu.pairs.map((p) => ({ date: p.date, d: Math.abs(p.adj.m - p.margin) - Math.abs(p.base.m - p.margin) })), 500, 7);
const bb2 = EV.blockBootstrap(pu.pairs.map((p) => ({ date: p.date, d: Math.abs(p.adj.m - p.margin) - Math.abs(p.base.m - p.margin) })), 500, 7);
chk('report: the date-blocked bootstrap is reproducible (seeded) and blocks by date', JSON.stringify(bb1) === JSON.stringify(bb2) && bb1.dates === 8 && bb1.mean < 0);
const early = EV.evaluate(pu.pairs, pu.coverage, { now: Date.parse('2026-12-01T00:00:00Z') });
const late = EV.evaluate(pu.pairs, pu.coverage, { now: Date.parse('2027-05-01T00:00:00Z') });
chk('report: before the holdout ends nothing is decided (DESCRIPTIVE, passed null)', early.state === 'DESCRIPTIVE' && early.passed === null && /nothing is decided/.test(early.state_reason));
chk('report: after the holdout, below the minimum sample, still DESCRIPTIVE', late.state === 'DESCRIPTIVE' && late.passed === null && /minimum sample/.test(late.state_reason));
chk('report: the CLV criterion is not evaluable without captured NBA prices, and therefore not met', early.criteria.C3_CLV.evaluable === false && early.criteria.C3_CLV.met === false && early.criteria.C1_MARGIN_MAE.met === true);

/* ---------------------------------------------------------------- preseason */
const sb = { events: [{ id: '401', date: '2026-10-05T23:30Z', season: { type: 1 }, status: { type: { completed: true } }, competitions: [{ competitors: [{ homeAway: 'home', team: { id: '30' } }, { homeAway: 'away', team: { id: '17' } }] }] },
  { id: '402', date: '2026-10-06T23:30Z', season: { type: 1 }, status: { type: { completed: false } }, competitions: [{ competitors: [] }] }] };
const sg = PRE.parseScoreboard(sb);
chk('preseason: finished games only, with both teams', sg.length === 1 && sg[0].home_id === '30' && sg[0].away_id === '17');
const sum1 = { boxscore: { players: [
  { team: { id: '30' }, statistics: [{ keys: ['minutes', 'points'], labels: ['MIN', 'PTS'], athletes: [{ athlete: { id: '9', displayName: 'Nine' }, stats: ['27', '12'] }, { athlete: { id: '8', displayName: 'Eight' }, didNotPlay: true, stats: [] }] }] },
  { team: { id: '17' }, statistics: [{ labels: ['MIN', 'PTS'], athletes: [{ athlete: { id: '7', displayName: 'Seven' }, stats: ['31:30', '20'] }] }] }] } };
const ps = PRE.parseSummary(sum1);
chk('preseason: minutes by key or label, mm:ss read, a DNP is zero', ps.ok && ps.rows.find((r) => r.id === '9').minutes === 27 && ps.rows.find((r) => r.id === '7').minutes === 31.5 && ps.rows.find((r) => r.id === '8').minutes === 0);
chk('preseason: a box score with no minutes column does not read (never guessed)', PRE.parseSummary({ boxscore: { players: [{ team: { id: '1' }, statistics: [{ labels: ['PTS'], athletes: [] }] }] } }).ok === false);
const agg = PRE.aggregate([{ date: '2026-10-05', rows: ps.rows }, { date: '2026-10-07', rows: [{ id: '9', name: 'Nine', team_id: '30', minutes: 21 }] }]);
chk('preseason: games with minutes counted, mean minutes, last team', agg['9'].games === 2 && agg['9'].minutes_mean === 24 && !agg['8'] && agg['7'].team_id === '17');

/* ---------------------------------------------------------------- the deployed copy */
const INL = path.join(ROOT, 'tools', 'nba', 'inline_injury_core.js');
if (fs.existsSync(INL)) {
  const I = require(INL);
  chk('the edge function carries the core and the distribution verbatim (run node tools/nba/inline_injury_core.js)', I.current(), 'drift');
}

console.log('nba injury core: ' + pass + ' passed, ' + fail + ' failed');
for (const f of failures) console.log('FAIL ' + f.name + (f.detail !== undefined ? '\n     ' + JSON.stringify(f.detail).slice(0, 600) : ''));
process.exit(fail ? 1 : 0);
