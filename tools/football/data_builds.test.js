#!/usr/bin/env node
/* ===========================================================================
   THE HAND-BUILT AND COPIED DATA SETS: the NFL stadium table is verified by
   what the repo can check and refused otherwise; the injury archive counts
   the official report and nothing else; the opener ledger records the first
   number the desk saw and never backfills; a desk note needs a receipt.

   Run: node tools/football/data_builds.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const V = require(path.join(ROOT, 'tools', 'football', 'verify_nfl_stadiums.js'));
const I = require(path.join(ROOT, 'tools', 'football', 'build_injury_archive.js'));
const A = require(path.join(ROOT, 'tools', 'football', 'build_lines_archive.js'));
const N = require(path.join(ROOT, 'tools', 'football', 'add_note.js'));
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() { failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300))); console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed'); process.exit(fail === 0 ? 0 : 1); }

/* ---- the stadium table ----------------------------------------------------- */
const register = { venues: { a: { name: 'Lambeau Field', lat: 44.5013, lon: -88.0622 }, b: { name: 'Soldier Field', lat: 41.8623, lon: -87.6167 } } };
const games = []; for (let i = 0; i < 6; i++) { games.push({ season: 2024, ctx: { stadium: 'Lambeau Field', roof: 'outdoors', surface: 'grass' } }); games.push({ season: 2024, ctx: { stadium: 'Soldier Field', roof: 'outdoors', surface: 'grass' } }); } games.push({ season: 2025, ctx: { stadium: 'Croke Park', roof: 'dome', surface: 'matrixturf' } });
const table = { stadiums: [
  { name: 'Lambeau Field', aliases: [], club: 'GB', state: 'WI', lat: 44.5013, lon: -88.0622, roof: 'outdoors', surface: 'grass', tz_name: 'America/Chicago' },
  { name: 'Soldier Field', aliases: [], club: 'CHI', state: 'IL', lat: 41.90, lon: -87.65, roof: 'outdoors', surface: 'a_turf', tz_name: 'America/Chicago' },
  { name: 'Nowhere Field', aliases: ['Lambeau Field'], club: 'XX', state: 'WI', lat: 30.0, lon: -88.0, roof: 'outdoors', surface: 'grass', tz_name: 'America/Chicago' },
  { name: 'Croke Park', aliases: [], club: null, state: null, lat: 53.3607, lon: -6.2511, roof: 'outdoors', surface: 'grass', tz_name: 'Europe/Dublin', international: true },
] };
const v = V.verify(table, register, games);
const by = {}; v.verdicts.forEach((r) => { by[r.name] = r; });
chk('a row that matches the register within 2 km, the feed and its state is VERIFIED with an independent coordinate check', by['Lambeau Field'].verdict === 'VERIFIED' && by['Lambeau Field'].independent_coordinate_check === true, by['Lambeau Field']);
chk('a row 4 km from the register and disagreeing with the feed surface is REFUSED with both reasons', by['Soldier Field'].verdict === 'REFUSED' && by['Soldier Field'].checks.filter((c) => c.ok === false).map((c) => c.check).sort().join(',') === 'register_distance_km,surface_vs_feed', by['Soldier Field'].checks);
chk('a duplicate name and a coordinate outside the state are refused', by['Nowhere Field'].verdict === 'REFUSED' && by['Nowhere Field'].checks.some((c) => c.check === 'unique_name' && c.ok === false) && by['Nowhere Field'].checks.some((c) => c.check === 'inside_state' && c.ok === false));
chk('one game in the feed is not evidence about a roof: the check is left open, not failed', by['Croke Park'].verdict === 'VERIFIED' && by['Croke Park'].checks.some((c) => c.check === 'roof_vs_feed' && c.ok === null && /one row is not evidence/.test(c.detail)));
chk('the basis says a stadium without an independent coordinate is verified on the other checks only', /other checks only/.test(v.basis));
const onDisk = path.join(ROOT, 'football', 'venues', 'nfl_stadiums.verification.json');
if (fs.existsSync(onDisk)) { const j = JSON.parse(fs.readFileSync(onDisk, 'utf8')); chk('the committed table has no refused row and at least five independent coordinate checks', j.refused === 0 && j.with_independent_coordinate_check >= 5, { refused: j.refused, independent: j.with_independent_coordinate_check }); }

/* ---- the injury archive ---------------------------------------------------- */
const HEAD = 'season,game_type,team,week,gsis_id,position,full_name,first_name,last_name,report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,practice_secondary_injury,practice_status,date_modified';
const row = (team, wk, pos, name, status, practice, at) => ['2023', 'REG', team, wk, 'id', pos, name, '', '', 'Knee', '', status, 'Knee', '', practice, at].join(',');
const csv = [HEAD, row('BUF', 1, 'T', 'Spencer Brown', 'Out', 'Did Not Participate In Practice', '2023-09-08T18:00:00Z'), row('BUF', 1, 'G', 'Connor McGovern', 'Doubtful', 'Limited', '2023-09-08T18:10:00Z'), row('BUF', 1, 'QB', 'Josh Allen', 'Questionable', 'Full', '2023-09-08T18:20:00Z'), row('BUF', 1, 'WR', 'Khalil Shakir', '', 'Full Participation in Practice', '2023-09-08T18:30:00Z'), row('DET', 1, 'QB', 'Jared Goff', 'Out', 'Did Not Participate', '2023-09-08T19:00:00Z'), row('DET', 2, 'CB', 'Some Corner', 'Out', '', '2023-09-15T19:00:00Z')].join('\n');
const inj = I.build({ 2023: csv }, { now: '2026-09-16T00:00:00Z' });
const buf = inj.seasons['2023'].teams.BUF['1'];
chk('a team-week counts Out, Doubtful and Questionable by group and names the linemen out', buf.out === 1 && buf.doubtful === 1 && buf.questionable === 1 && buf.groups.OL.out === 1 && buf.groups.OL.doubtful === 1 && buf.groups.QB.questionable === 1 && buf.ol_out.length === 2 && /Spencer Brown \(T, Out\)/.test(buf.ol_out[0]), buf);
chk('a practice-only line with no game status is not an availability record', !buf.groups.WR && inj.counts.status_rows === 5);
chk('a quarterback out is named, and the as_of is the latest modification on the report', inj.seasons['2023'].teams.DET['1'].qb_out[0] === 'Jared Goff (Out)' && buf.as_of === '2023-09-08T18:20:00Z');
chk('the archive says it is not a projection input', /not a projection input/.test(inj.note) && inj.source.basis.indexOf('practice-only') > 0);

/* ---- the opener ledger ----------------------------------------------------- */
const art = { games: [
  { id: 'g_future', season: 2026, week: 3, home: 'BUF', away: 'DET', date: '2026-09-21', margin: null, close: { home_line: -4.5, total: 47.5, home_moneyline: -200, away_moneyline: 170 } },
  { id: 'g_done', season: 2026, week: 2, home: 'KC', away: 'LAC', date: '2026-09-14', margin: 7, close: { home_line: -3, total: 44, home_moneyline: -150, away_moneyline: 130 } } ], counts: {} };
let ledger = A.updateOpeners(null, art, '2026-09-16T12:00:00Z');
chk('an upcoming game gets an opener; a game first seen with its result does not', ledger.games.g_future && ledger.games.g_future.open.home_line === -4.5 && !ledger.games.g_done, Object.keys(ledger.games));
art.games[0].close.home_line = -6; ledger = A.updateOpeners(ledger, art, '2026-09-18T12:00:00Z');
chk('a later number is a move; the opener is unchanged', ledger.games.g_future.open.home_line === -4.5 && ledger.games.g_future.latest.home_line === -6 && ledger.games.g_future.moves === 1);
art.games[0].margin = 10; ledger = A.updateOpeners(ledger, art, '2026-09-22T12:00:00Z');
chk('when the result posts the last number before it becomes the close and the entry freezes', ledger.games.g_future.closed === true && ledger.games.g_future.close.home_line === -6 && ledger.counts.closed === 1);
const applied = A.applyOpeners({ games: [{ id: 'g_future', close: { home_line: -6 } }], counts: {} }, ledger);
chk('the archive carries the opener from the ledger with its source', applied.games[0].open.home_line === -4.5 && /opener ledger/.test(applied.games[0].open.source) && applied.counts.with_opener === 1);
chk('the ledger note says nothing is backfilled', /no opener/.test(ledger.note));

/* ---- the venue lookup --------------------------------------------------------- */
const NV = require(path.join(ROOT, 'tools', 'football', 'nfl_venues.js'));
const tmpTable = path.join(ROOT, 'football', 'venues', 'nfl_stadiums.json');
const byAlias = NV.venueFor({ stadium: 'New Era Field' }, { table: tmpTable, reload: true });
chk('an old stadium name resolves through its aliases to the current venue', byAlias && byAlias.name === 'Highmark Stadium' && byAlias.matched_by === 'stadium name' && byAlias.lat > 42 && byAlias.verification === 'VERIFIED', byAlias);
chk('a club resolves to its home venue, and a shared stadium answers for both tenants', NV.venueFor({ club: 'LA' }).name === 'SoFi Stadium' && NV.venueFor({ club: 'NYG' }).name === 'MetLife Stadium' && NV.venueFor({ club: 'nyj' }).matched_by === 'home club');
chk('a dome reads dome, an unknown stadium falls back to the club, and an unknown club is null', NV.venueFor({ stadium: 'Ford Field' }).dome === true && NV.venueFor({ stadium: 'Somewhere Else', club: 'GB' }).name === 'Lambeau Field' && NV.venueFor({ stadium: 'Somewhere Else', club: 'ZZZ' }) === null);
chk('every returned venue names its hand-entered source and verification', /hand-entered/.test(NV.venueFor({ club: 'KC' }).source) && NV.venueFor({ club: 'KC' }).verification === 'VERIFIED');
const S = require(path.join(ROOT, 'tools', 'football', 'build_nfl_slate.js'));
const wanted = S.nflForecastWanted([{ game_id: '2026_03_DET_BUF', kickoff: '2026-09-21T17:00:00Z', venue: 'Highmark Stadium', home_code: 'BUF' }, { game_id: 'x', kickoff: null, venue: 'Lambeau Field', home_code: 'GB' }]);
chk('the forecast request carries the verified venue for a game with a kickoff and skips one without', wanted.length === 1 && wanted[0].venue.lat === 42.7738 && wanted[0].game_id === '2026_03_DET_BUF', wanted);

/* ---- the manual availability import ------------------------------------------ */
const IMP = require(path.join(ROOT, 'football', 'availability', 'import_corrections.js'));
const nowI = Date.parse('2026-09-17T12:00:00Z');
const imp = IMP.importRows([
  { kind: 'AVAILABILITY', team: 'Texas Tech', player: 'A Player', position: 'WR', status: 'OUT', game_id: '401856811', kickoff: '2026-09-20T19:00:00Z', source_name: 'Big 12 availability report', source_url: 'https://big12sports.com/report', published_at: '2026-09-17T02:00:00Z', by: 'operator' },
  { kind: 'AVAILABILITY', team: 'Texas Tech', player: 'B Player', status: 'OUT', game_id: '401856811', kickoff: '2026-09-20T19:00:00Z', source_name: 'heard it', published_at: '2026-09-17T02:00:00Z', by: 'operator' },
  { kind: 'STARTER', team: 'Texas Tech', player: 'C Quarterback', position: 'QB', confirmed: 'true', game_id: '401856811', kickoff: '2026-09-20T19:00:00Z', source_name: 'Texas Tech Athletics', source_url: 'https://texastech.com/news', published_at: '2026-09-17T09:00:00Z', by: 'operator' },
  { kind: 'AVAILABILITY', note: 'example row - delete before importing' } ], nowI);
chk('a complete row is accepted, a row without a url is refused with its reason, and the template example is refused', imp.accepted.length === 2 && imp.refused.length === 2 && imp.refused.some((r) => r.row === 2 && r.reasons.join(' ').length > 0) && imp.refused.some((r) => /template/.test(r.reasons[0])), { accepted: imp.accepted.map((a) => a.player), refused: imp.refused });
chk('an accepted entry carries the recorder and the recording time', imp.accepted.every((a) => a.recorded_by === 'operator' && a.recorded_at === '2026-09-17T12:00:00.000Z'));

/* ---- the CFB archive with openers ---------------------------------------------- */
const LH = 'id,game_id,season,game_desc,date_time,market_type,abbr,lines,odds,opening_lines,opening_odds,book,season_type,week,home_team_id,away_team_id';
const lrow = (gid, mt, ab, lines, open, book, hid, aid) => ['1', gid, '2025.0', 'X@Y', '2025-08-30', mt, ab, lines, '', open, '', book, 'regular', '1', hid, aid].join(',');
const LINES = [LH,
  lrow('g1', 'spread', 'CLEM', '-5.5', '-3.5', 'Bovada', '228', '99'), lrow('g1', 'spread', 'LSU', '5.5', '3.5', 'Bovada', '228', '99'), lrow('g1', 'spread', 'CLEM', '-5', '-3', 'DK', '228', '99'), lrow('g1', 'spread', 'CLEM', '-5', '-3', 'DK', '228', '99'),
  lrow('g1', 'total', 'over', '55.5', '57.5', 'Bovada', '228', '99'), lrow('g1', 'total', 'under', '55.5', '57.5', 'Bovada', '228', '99'),
  lrow('g2', 'spread', 'ZZQ', '-7', '-6', 'Bovada', '5', '6'), lrow('g2', 'spread', 'QQZ', '7', '6', 'Bovada', '5', '6'), lrow('g3', 'spread', 'ZZQ', '-3', '', 'Bovada', '9', '5') ].join('\n');
const SH = 'game_id,season,week,season_type,start_date,start_time_tbd,completed,neutral_site,conference_game,attendance,venue_id,venue,home_id,home_team,home_division,home_conference,home_points,home_post_win_prob,home_pregame_elo,home_postgame_elo,away_id,away_team,away_division,away_conference,away_points,away_post_win_prob,away_pregame_elo,away_postgame_elo';
const srow = (gid, hid, home, hp, helo, aid, away, ap, aelo, neutral) => [gid, '2025', '1', 'regular', '2025-08-30T23:30:00.000Z', 'FALSE', 'TRUE', neutral, 'FALSE', 'NA', '1', 'V', hid, home, 'fbs', 'ACC', hp, '0.5', helo, helo, aid, away, 'fbs', 'SEC', ap, '0.5', aelo, aelo].join(',');
const SCHED = [SH, srow('g1', '228', 'Clemson', '10', '1704', '99', 'LSU', '17', '1718', 'FALSE'), srow('g2', '5', 'Alpha', '30', '1600', '6', 'Beta', '20', '1500', 'TRUE'), srow('g3', '9', 'Gamma', '21', '1550', '5', 'Alpha', '24', '1600', 'FALSE')].join('\n');
const TEAMS = 'team_id,abbreviation\n228,CLEM\n99,LSU\n';
const cfb = A.buildCfb({ lines: LINES, teams: TEAMS, schedules: { 2025: SCHED } }, { now: '2026-09-16T00:00:00Z' });
const g1 = cfb.games.find((g) => g.id === 'g1');
chk('a game\'s opener and close are medians across books, home-relative, with duplicates dropped', g1 && g1.open.home_line === -3.5 && g1.close.home_line === -5.5 && g1.open.total === 57.5 && g1.close.total === 55.5 && g1.close.books === 3 && cfb.counts.duplicates_dropped === 1, g1);
chk('the schedule supplies the result, the margin, the pregame Elo and the neutral flag', g1.margin === -7 && g1.points === 27 && g1.ctx.home_pregame_elo === 1704 && g1.neutral === false && cfb.games.find((g) => g.id === 'g2').neutral === true);
chk('an abbreviation absent from the teams file resolves by the games it appears in (ZZQ is team 5 in both g2 and g3)', cfb.games.find((g) => g.id === 'g2').close.home_line === -7 && cfb.games.find((g) => g.id === 'g3').close.home_line === 3, cfb.games.map((g) => [g.id, g.close.home_line]));
chk('a game with a close but no opener keeps a null opener', cfb.games.find((g) => g.id === 'g3').open.home_line === null && cfb.counts.with_open === 2);
chk('the openers artifact is the last season, compact, keyed by game id', A.cfbOpeners(cfb).games.g1.open.home_line === -3.5 && A.cfbOpeners(cfb).counts.games === 3);

/* ---- the movement validation --------------------------------------------------- */
const M = require(path.join(ROOT, 'tools', 'football', 'validate_movement.js'));
const mrows = []; let ms = 11;
const mr = () => { ms = (ms * 9301 + 49297) % 233280; return ms / 233280; };
for (let s = 2006; s <= 2025; s++) for (let i = 0; i < 300; i++) { const elo = (mr() - 0.5) * 400; const home = i % 4 ? 1 : 0; const trueMargin = elo / 25 + 2.5 * home; const open = -Math.round((trueMargin + (mr() - 0.5) * 8) * 2) / 2; const noise = (mr() + mr() + mr() - 1.5) * 20; const toward = -trueMargin - open; const close = open + (mr() < 0.7 ? Math.sign(toward) * Math.min(Math.abs(toward), 1 + mr() * 2) : (mr() - 0.5) * 2); mrows.push({ id: s + '_' + i, season: s, week: 1, open, close: Math.round(close * 2) / 2, margin: Math.round(trueMargin + noise), elo_diff: elo, home, move: Math.round((Math.round(close * 2) / 2 - open) * 100) / 100 }); }
const msc = M.score(mrows, { first_holdout: 2011, later_from: 2019 });
chk('a planted 70% move toward the Elo rating is read as VALIDATED at some threshold', msc.tier === 'VALIDATED' && msc.required_gap_points != null && msc.toward_rating_by_gap[String(msc.required_gap_points)].toward_rate > 0.6, { tier: msc.tier, edge: msc.required_gap_points, t: msc.toward_rating_by_gap['2'] });
chk('the rating fit recovers the planted scale (about 0.04 points per Elo point and a home field near 2.5)', Math.abs(msc.latest.rating.points_per_elo - 0.04) < 0.01 && Math.abs(msc.latest.rating.home_field - 2.5) < 1.5, msc.latest);
chk('open-vs-close is stated per threshold and the note says a tendency is not a result', msc.open_vs_close_by_gap['2'] && msc.open_vs_close_by_gap['2'].cover_at_open != null && /number|move/.test(msc.tier_basis));
const coin = mrows.map((r) => Object.assign({}, r, { close: r.open + (Math.round(((r.id.length % 2) ? 0.5 : -0.5) * 2) / 2), move: (r.id.length % 2) ? 0.5 : -0.5 }));
chk('a coin-flip move is RESEARCH', M.score(coin, { first_holdout: 2011, later_from: 2019 }).tier === 'RESEARCH');
chk('the committed CFB movement validation carries a tier, its basis and the open-vs-close table', (function () { const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'movement_cfb.json'), 'utf8')); return /LEAN|VALIDATED|RESEARCH/.test(j.result.tier) && j.result.tier_basis && j.result.open_vs_close_by_gap && j.frame.rating_is; })());

/* ---- the learning loop ---------------------------------------------------------- */
const LL = require(path.join(ROOT, 'tools', 'intelligence', 'learning_loop.js'));
const llRows = [{ packet_id: 'p1', sport: 'americanfootball_nfl', game_id: 'n1', model_version: 'v1', label: 'PRICE DEPENDENT', pricing_tier: 'LEAN', quoted_status: 'LEAN_PLAY', quoted_side: 'home', quoted_selection: 'Home', quoted_line: -4.5, model_home_line: -9, fair_home_line: -5.6 }, { packet_id: 'p2', sport: 'americanfootball_ncaaf', game_id: 'c1', model_version: 'v1', label: 'PASS', pricing_tier: 'RESEARCH', quoted_status: 'CONDITIONAL', quoted_side: 'away', quoted_selection: 'Away', quoted_line: 6.5, model_home_line: -3, fair_home_line: -6 }];
const llArch = { nfl: { counts: { games: 1, with_opener: 1 }, games: [{ id: 'n1', close: { home_line: -6, total: 44 }, margin: 10, open: { home_line: -4, seen_at: '2026-09-15T00:00:00Z' } }] }, cfb: { counts: { games: 1, with_open: 0 }, games: [{ id: 'c1', close: { home_line: -6, total: 50 }, margin: 3, open: { home_line: null } }] } };
const card = LL.build(llRows, llArch, { pricing_nfl: { markets: { spread: { tier: 'LEAN' }, total: { tier: 'RESEARCH' }, moneyline: { tier: 'RESEARCH' } } }, movement_cfb: { result: { tier: 'LEAN', required_gap_points: 2, tier_basis: 'x' } } }, { now: '2026-09-16T00:00:00Z', rows_status: 'FILE' });
chk('the scorecard grades each quote against its close (home -4.5 that closed -6 gained 1.5; away +6.5 that closed +6 gained 0.5) and the result', card.clv.groups.all.with_close === 2 && card.clv.groups.all.mean_clv_points === 1 && card.clv.groups.all.wins === 2, card.clv.groups.all);
chk('open-to-close toward the fair line is counted where an opener exists', card.clv.groups.all.with_opener === 1 && card.clv.groups.all.moved_toward_fair_rate === 1, card.clv.groups.all);
chk('the postmortem, the tiers by market and the movement tier ride on the card, and the note refuses to promote', card.postmortem.counts.graded === 2 && card.tiers.pricing.nfl.spread === 'LEAN' && card.tiers.movement.cfb.tier === 'LEAN' && /promotes/.test(card.note) && card.by_model_version.v1.packets === 2);
chk('without database access the card says so instead of pretending', LL.build([], llArch, {}, { rows_status: 'NO_DATABASE_ACCESS', rows_detail: 'no env' }).inputs.rows_status === 'NO_DATABASE_ACCESS');

/* ---- desk notes ------------------------------------------------------------- */
const now = Date.parse('2026-09-16T12:00:00Z');
const bad = N.validate({ sport: 'nfl', team: 'BUF', kind: 'starting_qb', text: 'Josh Allen starts', source: 'Bills' }, now);
chk('a note without a url, a publication time or a recorder is refused with every reason', bad.ok === false && bad.reasons.length === 3 && bad.reasons.some((r) => /url/.test(r)) && bad.reasons.some((r) => /published_at/.test(r)) && bad.reasons.some((r) => /recorded/.test(r)), bad.reasons);
const good = N.validate({ sport: 'nfl', team: 'buf', kind: 'starting_qb', text: 'Josh Allen confirmed to start by the club', source: 'Buffalo Bills', url: 'https://www.buffalobills.com/news/x', published_at: '2026-09-16T10:00:00Z', by: 'D. Rackler' }, now);
chk('a complete note is recorded with a seven-day expiry and an OFFICIAL_SITE source kind for a club domain', good.ok && good.note.team === 'BUF' && good.note.expires_at === '2026-09-23T10:00:00.000Z' && good.note.source_kind === 'OFFICIAL_SITE', good);
chk('an unknown kind is refused', N.validate({ sport: 'cfb', team: 'X', kind: 'vibes', text: 'they look good', source: 'a', url: 'https://a.com/b', published_at: '2026-09-16T10:00:00Z', by: 'me' }, now).ok === false);
chk('a note published in the future is refused', N.validate({ sport: 'cfb', team: 'X', kind: 'weather', text: 'wind forecast 25 mph', source: 'NWS', url: 'https://weather.gov/x', published_at: '2026-09-20T10:00:00Z', by: 'me' }, now).ok === false);
done();
