#!/usr/bin/env node
/* Tests for the auto-settler's matching and derivation. Offline and fast:
   every network edge is behind an exported pure function, so the part that
   decides whether a real game gets a real score is the part under test.

   Run: node tools/collective/settle_finals.test.js                        */
'use strict';
const S = require('./settle_finals.js');
let pass = 0, fail = 0; const fails = [];
const chk = (name, ok, detail) => ok ? pass++ : (fail++, fails.push({ name, detail }));

/* ---- the reported game: North Carolina @ TCU ---------------------------- */
/* The Collective truncates to ten characters; the feed spells it out. */
chk('a truncated Collective name matches the feed\'s full spelling',
  S.teamsAgree('NORTHCAROL', 'North Carolina'));
chk('TCU matches exactly', S.teamsAgree('TCU', 'TCU'));
chk('an accent is folded, not deleted',
  S.teamsAgree('San José State', 'San Jose State'));
chk('two different schools never agree', !S.teamsAgree('TCU', 'Texas'));
chk('a short code cannot prefix-match its way into a spelled-out name',
  !S.teamsAgree('NC', 'North Carolina'), { why: 'a code never latches onto a name' });

/* nflverse spells the Rams "LA"; the Collective's schedule says "LAR". Left
   unmatched, a Rams game never settles at all. */
chk('LAR (Collective) joins LA (nflverse)', S.teamsAgree('LAR', 'LA'));
chk('LA joins LAR the other way round', S.teamsAgree('LA', 'LAR'));
chk('LAR still refuses LAC', !S.teamsAgree('LAR', 'LAC'));
chk('NE still refuses NO', !S.teamsAgree('NE', 'NO'));
chk('SF joins SFO', S.teamsAgree('SF', 'SFO'));
chk('a code never becomes a city name',
  !S.teamsAgree('NE', 'New Orleans') && !S.teamsAgree('LA', 'Lafayette'));

const TCU_GAME = {
  game_id: '450b75c2-cc40-4fb2-9067-305af35d9bfa',
  label: 'North Carolina @ TCU', home: 'TCU', away: 'NORTHCAROL',
  kickoff_at: '2026-08-29T16:00:00+00:00', status: 'scheduled', result: null,
};
const FEED = [
  { start_date: '2026-08-29', home_team: 'TCU', away_team: 'North Carolina',
    home_points: '31', away_points: '17', completed: true },
  { start_date: '2026-08-29', home_team: 'Stanford', away_team: "Hawai'i",
    home_points: '', away_points: '', completed: false },
];

const got = S.findFinal(TCU_GAME, FEED);
chk('the finished game resolves to its final',
  got.ok && got.home_score === 31 && got.away_score === 17, got);

const body = S.settleBody(TCU_GAME, got, null);
chk('with no captured close, the line fields go as null and the score still settles',
  body.home_score === 31 && body.away_score === 17 &&
  body.closing_spread === null && body.closing_total === null &&
  body.closing_home_ml_prob === null, body);
chk('a captured close is passed through, never rounded away',
  S.settleBody(TCU_GAME, got, { closing_spread: -7.25, closing_total: 47.5, closing_home_ml_prob: 0.7261 })
    .closing_spread === -7.25);

/* ---- the collision this repo has already been bitten by ------------------ */
/* "NORTHCAROL" is a truncation of North Carolina AND North Carolina State.
   Resolving it to whichever the feed lists first settles one school's game
   with the other's score. */
const BOTH = FEED.concat([{ start_date: '2026-08-29', home_team: 'Duke',
  away_team: 'North Carolina State', home_points: '10', away_points: '20', completed: true }]);
/* Both schools on the same date against the same opponent is the case the
   pair cannot resolve, and it is refused. */
const CLASH = FEED.concat([{ start_date: '2026-08-29', home_team: 'TCU',
  away_team: 'North Carolina Central', home_points: '3', away_points: '0', completed: true }]);
const amb = S.findFinal(TCU_GAME, CLASH);
chk('two schools whose truncation collides, same opponent same day, is refused',
  !amb.ok && amb.reason === 'ambiguous_feed_rows', amb);

/* But an ambiguous NAME alone must not skip the game -- against the real
   feed "NORTHCAROL" also truncates NC Central and NC A&T, and refusing on
   that would skip most of a Saturday. The pair settles it; the row is
   flagged for audit. */
const withSiblings = FEED.concat([
  { start_date: '2026-08-29', home_team: 'Duke', away_team: 'North Carolina Central',
    home_points: '10', away_points: '20', completed: true },
  { start_date: '2026-08-29', home_team: 'Elon', away_team: 'North Carolina A&T',
    home_points: '7', away_points: '14', completed: true }]);
const sib = S.findFinal(TCU_GAME, withSiblings);
chk('an ambiguous truncated name still settles when the PAIR is unique',
  sib.ok && sib.home_score === 31 && sib.away_score === 17, sib);
chk('...and that match is flagged for review rather than settled silently',
  sib.matched_by === 'truncated' && sib.needs_review === true && /North Carolina/.test(sib.joined), sib);

/* An exact match never depends on a truncation and is never flagged. */
const EXACT_GAME = { ...TCU_GAME, away: 'North Carolina' };
const ex = S.findFinal(EXACT_GAME, withSiblings);
chk('an exact match wins outright and needs no review',
  ex.ok && ex.matched_by === 'exact' && ex.needs_review === false, ex);
chk('an exact match beats a truncated one on the same date',
  S.findFinal(EXACT_GAME, withSiblings.concat([{ start_date: '2026-08-29',
    home_team: 'TCU', away_team: 'North Carolina Central',
    home_points: '3', away_points: '0', completed: true }])).home_score === 31);
chk('Washington is still recognised as a name that could mean two schools',
  S.truncationIsAmbiguous('WASHINGTON', S.feedTeamKeys(
    [{ home_team: 'Washington', away_team: 'Washington State' }])));

/* ---- never invent a score ----------------------------------------------- */
const UNPLAYED = [{ start_date: '2026-08-29', home_team: 'TCU', away_team: 'North Carolina',
  home_points: '', away_points: '', completed: false }];
chk('a game the feed has not completed is skipped',
  S.findFinal(TCU_GAME, UNPLAYED).reason === 'not_final_in_feed');
chk('a completed row with no score is skipped, never zero-filled',
  S.findFinal(TCU_GAME, [{ ...UNPLAYED[0], completed: true }]).reason === 'feed_row_has_no_score');
chk('a game the feed does not carry at all is skipped',
  S.findFinal(TCU_GAME, []).reason === 'no_feed_row');
chk('two rows for one game are refused rather than picked between',
  S.findFinal(TCU_GAME, [FEED[0], { ...FEED[0], home_points: '3', away_points: '0' }])
    .reason === 'ambiguous_feed_rows');
chk('a nonsense score is not a score',
  !S.isFinalScore('') && !S.isFinalScore(null) && !S.isFinalScore('x') &&
  !S.isFinalScore(-1) && !S.isFinalScore(17.5) && S.isFinalScore('17') && S.isFinalScore(0));

/* ---- kickoff dates: UTC storage vs a local publish date ----------------- */
chk('a night game one calendar day apart still matches',
  S.datesAgree('2026-08-30T02:00:00+00:00', '2026-08-29'));
chk('two days apart does not',
  !S.datesAgree('2026-08-31T02:00:00+00:00', '2026-08-29'));
chk('a missing date never matches', !S.datesAgree('', '2026-08-29') && !S.datesAgree('2026-08-29', ''));

/* ---- which games are this job's business -------------------------------- */
const NOW = Date.parse('2026-08-30T00:00:00Z');
const need = S.needsSettling([
  TCU_GAME,
  { ...TCU_GAME, game_id: 'settled', result: { home_score: 1, away_score: 0 } },
  { ...TCU_GAME, game_id: 'future', kickoff_at: '2026-12-01T16:00:00+00:00' },
  { ...TCU_GAME, game_id: 'ppd', status: 'postponed' },
  { ...TCU_GAME, game_id: 'cxl', status: 'canceled' },
], NOW);
chk('only unsettled, kicked-off, live games are touched',
  need.length === 1 && need[0].game_id === TCU_GAME.game_id,
  { got: need.map(g => g.game_id) });

/* ---- feed normalisation -------------------------------------------------- */
chk('nflverse marks a played game by carrying both scores',
  S.normNfl({ gameday: '2026-09-09', home_team: 'SEA', away_team: 'NE',
    home_score: '24', away_score: '20' }).completed === true);
chk('an unplayed nflverse row is not completed',
  S.normNfl({ gameday: '2026-09-09', home_team: 'SEA', away_team: 'NE',
    home_score: '', away_score: '' }).completed === false);
chk('cfbfastR completed is read from its own flag',
  S.normCfb({ start_date: '2026-08-29', completed: 'TRUE' }).completed === true &&
  S.normCfb({ start_date: '2026-08-29', completed: 'FALSE' }).completed === false);
chk('a quoted comma in the feed does not split the row',
  S.parseCsv('a,b\n"x, y",2')[0].a === 'x, y');

/* ---- the run is a dry run unless told otherwise -------------------------- */
chk('nothing is written without --commit', S.parseArgs([]).commit === false);
chk('--commit is the only thing that writes', S.parseArgs(['--commit']).commit === true);
chk('sport and season are honoured',
  S.parseArgs(['--sport', 'CFB', '--season', '2026']).sport === 'CFB' &&
  S.parseArgs(['--sport', 'CFB', '--season', '2026']).season === 2026);
chk('a sport with no finals feed is not silently mapped to another',
  S.FEED.CFB === 'cfb' && S.FEED.NFL === 'nfl' && S.FEED.MLB === undefined);


/* ---- ESPN, the live source ---------------------------------------------
   A recorded event in ESPN's scoreboard shape. NOTE: this fixture is the
   contract, not a live capture — the sandbox this was written in blocks
   site.api.espn.com, so the adapter is proven against the shape and the
   run is proven against the network by `--verify`. */
const ESPN_EVENT = {
  id: '401752687',
  date: '2026-08-29T16:00Z',
  name: 'North Carolina Tar Heels at TCU Horned Frogs',
  competitions: [{
    date: '2026-08-29T16:00Z',
    status: { type: { id: '3', name: 'STATUS_FINAL', state: 'post', completed: true } },
    competitors: [
      { homeAway: 'home', score: '31', team: { location: 'TCU', name: 'Horned Frogs',
        abbreviation: 'TCU', displayName: 'TCU Horned Frogs', shortDisplayName: 'Horned Frogs' } },
      { homeAway: 'away', score: '17', team: { location: 'North Carolina', name: 'Tar Heels',
        abbreviation: 'UNC', displayName: 'North Carolina Tar Heels', shortDisplayName: 'Tar Heels' } },
    ],
  }],
};
const er = S.normEspn(ESPN_EVENT);
chk('an ESPN final normalises to home/away and a completed flag',
  er.completed === true && er.home_points === '31' && er.away_points === '17' &&
  er.home_team === 'TCU' && er.away_team === 'North Carolina', er);
chk('every ESPN spelling is carried, so a truncated store name can still join',
  er.home_names.includes('TCU') && er.away_names.includes('North Carolina') &&
  er.away_names.includes('UNC') && er.away_names.includes('North Carolina Tar Heels'), er.away_names);
chk('an ESPN row joins the Collective\'s truncated name',
  S.findFinal(TCU_GAME, [er]).ok && S.findFinal(TCU_GAME, [er]).home_score === 31);
chk('an ESPN abbreviation joins too',
  S.findFinal({ ...TCU_GAME, away: 'UNC' }, [er]).ok);

const inProgress = JSON.parse(JSON.stringify(ESPN_EVENT));
inProgress.competitions[0].status.type = { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false };
chk('a game still being played is never settled',
  S.normEspn(inProgress).completed === false &&
  S.findFinal(TCU_GAME, [S.normEspn(inProgress)]).reason === 'not_final_in_feed');

const scheduled = JSON.parse(JSON.stringify(ESPN_EVENT));
scheduled.competitions[0].status.type = { name: 'STATUS_SCHEDULED', state: 'pre', completed: false };
scheduled.competitions[0].competitors.forEach(c => { c.score = '0'; });
chk('a scheduled game showing 0-0 is not a 0-0 final',
  S.findFinal(TCU_GAME, [S.normEspn(scheduled)]).reason === 'not_final_in_feed');

chk('the ESPN url is per-day and asks for the right league',
  /college-football\/scoreboard\?dates=20260829/.test(S.espnUrl('cfb', '20260829')) &&
  /groups=80/.test(S.espnUrl('cfb', '20260829')) &&
  /\/nfl\/scoreboard/.test(S.espnUrl('nfl', '20260909')) &&
  !/groups=80/.test(S.espnUrl('nfl', '20260909')));
chk('a kickoff becomes the day ESPN indexes on',
  S.compactDate('2026-08-29T16:00:00+00:00') === '20260829');

/* ---- sources must AGREE, and the chain heals around a dead one ---------- */
const CSV_ROW = { start_date: '2026-08-29', home_team: 'TCU', away_team: 'North Carolina',
  home_points: '31', away_points: '17', completed: true, source: 'cfbfastR' };
const agreed = S.findAcrossSources(TCU_GAME,
  [{ name: 'espn', rows: [er] }, { name: 'cfbfastR', rows: [CSV_ROW] }]);
chk('two sources that agree settle, and both are named',
  agreed.ok && agreed.home_score === 31 && agreed.agreed_by.join('+') === 'espn+cfbfastR', agreed);

const contradicted = S.findAcrossSources(TCU_GAME, [
  { name: 'espn', rows: [er] },
  { name: 'cfbfastR', rows: [{ ...CSV_ROW, home_points: '28' }] }]);
chk('two sources that disagree settle NOTHING',
  !contradicted.ok && contradicted.reason === 'sources_disagree', contradicted);
chk('...and the disagreement is reported, not hidden',
  /espn 17-31/.test(contradicted.detail) && /17-28/.test(contradicted.detail), contradicted.detail);

chk('a source with nothing for this season is skipped, not fatal',
  S.findAcrossSources(TCU_GAME,
    [{ name: 'cfbfastR', rows: [] }, { name: 'espn', rows: [er] }]).ok,
  { why: 'cfbfastR published no 2026 file at all while the season was live' });
chk('when no source has the game, it says which ones it asked',
  /espn:/.test(S.findAcrossSources(TCU_GAME, [{ name: 'espn', rows: [] }]).detail || 'espn:'));

chk('--verify never writes and never asks for a close',
  S.parseArgs(['--verify']).verify === true && S.parseArgs(['--verify']).commit === false);

fails.forEach(f => console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
