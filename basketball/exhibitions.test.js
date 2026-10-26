#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Exhibition games for the college basketball forecasts (basketball/exhibitions.js):
   who is who, which listings are priced, and when they start.

     node basketball/exhibitions.test.js

   Schedules and dataset rows are SYNTHETIC, written to a temporary directory
   in the collector's own layout; the real schools' pages the readers were
   written against are tested in tools/collegiate/collegiate.test.js. No
   network, no database.
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./ncaam_forecast/tests/_kit').kit('college basketball exhibitions');
const EX = require('./exhibitions');

/* ------------------------------------------------------------------ times */
const at = (d, t, l) => new Date(EX.startOf(d, t, l).ms).toISOString();
T.eq('a local time in the state the listing names (Connecticut, daylight time)', at('2026-10-27', '7 p.m.', 'Hartford, Conn.'), '2026-10-27T23:00:00.000Z');
T.eq('...in the Pacific zone', at('2026-10-28', '6 p.m.', 'Spokane, Wash.'), '2026-10-29T01:00:00.000Z');
T.eq('a zone the listing writes wins ("6:30 p.m. CT")', at('2026-10-29', '6:30 p.m. CT', 'Lawrence, Kan.'), '2026-10-29T23:30:00.000Z');
T.eq('standard time after the first Sunday of November', at('2026-11-02', '7 PM', 'Durham, N.C.'), '2026-11-03T00:00:00.000Z');
T.chk('a time that does not read is noon local and flagged approximate', EX.startOf('2026-11-01', 'TBA', 'Durham, N.C.').approx && at('2026-11-01', 'TBA', 'Durham, N.C.') === '2026-11-01T17:00:00.000Z');
T.chk('a location with no state is US Eastern and flagged approximate', EX.startOf('2026-10-28', '7 p.m.', 'Gampel Pavilion').approx && at('2026-10-28', '7 p.m.', 'Gampel Pavilion') === '2026-10-28T23:00:00.000Z');
T.eq('clock: "Noon", "7:30 PM", "19:00", "TBA"', [EX.clockOf('Noon'), EX.clockOf('7:30 PM'), EX.clockOf('19:00'), EX.clockOf('TBA')], [[12, 0], [19, 30], [19, 0], null]);
T.eq('a school\'s own labels come off a name', [EX.bareName('#12/13 Arkansas (Exh.)'), EX.bareName('Louisville (Exhibition)'), EX.bareName('Mount St. Mary\'s (Md.) - Exhibition'), EX.bareName('Westmont College (Calif.) (E')],
  ['Arkansas', 'Louisville', 'Mount St. Mary\'s (Md.)', 'Westmont College (Calif.)']);
T.eq('...as the schools write them (real listings)', ['Upper Iowa (Ex.)', 'Rochester Christian (ex)', 'Cal State Monterey Bay (exhib.)', 'Exhibition Cal State Monterey Bay', 'Mercyhurst (EXH)', 'Navy - Exh.', 'Spring Hill College (Ala.)'].map(EX.bareName),
  ['Upper Iowa', 'Rochester Christian', 'Cal State Monterey Bay', 'Cal State Monterey Bay', 'Mercyhurst', 'Navy', 'Spring Hill College (Ala.)']);
T.chk('"St." and "State" are one name', EX.normName('Pittsburg St.') === EX.normName('Pittsburg State'));

/* ------------------------------------------------------------------ a synthetic league */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cbbex-'));
const SPORT = EX.SPORT.ncaam;
/* the dataset: last season's finals for ESPN teams 1 (Home U), 2 (Road State), 3 (Third Tech) and 4, this season's schedule */
const rows = [];
let gid = 1000;
const final = (season, day, home, away, hs, as) => rows.push({ game_id: String(gid++), season, status: 'FINAL', day, start_utc: day + 'T23:00:00Z', start_ms: Date.parse(day + 'T23:00:00Z'), home_id: home, away_id: away, hs, as, home_d1: 1, away_d1: 1, neutral: 0 });
const sched = (season, day, home, away) => rows.push({ game_id: String(gid++), season, status: 'SCHEDULED', day, start_utc: day + 'T23:00:00Z', start_ms: Date.parse(day + 'T23:00:00Z'), home_id: home, away_id: away, home_d1: 1, away_d1: 1, neutral: 0 });
const days = ['2025-11-04', '2025-11-08', '2025-11-12', '2025-11-16', '2025-11-20', '2025-11-24'];
days.forEach((d, i) => { final(2026, d, '1', '3', 70 + i, 60 + i); final(2026, d, '2', '4', 80 + i, 75 - i); });
sched(2027, '2026-11-05', '1', '2');
/* the schools' schedules: last season's finals (the identity), this season's exhibitions */
const write = (season, school, host, games) => { const d = path.join(TMP, 'schedules', SPORT, String(season)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, school + '.json'), JSON.stringify({ school, host, sport: SPORT, season, games })); };
write(2026, 'home-u', 'homeu.edu', days.map((d, i) => ({ date: d, site: 'H', status: 'final', us: 70 + i, them: 60 + i })));
write(2026, 'road-st', 'roadst.edu', days.map((d, i) => ({ date: d, site: 'H', status: 'final', us: 80 + i, them: 75 - i })));
write(2026, 'few-games', 'few.edu', days.slice(0, 3).map((d, i) => ({ date: d, site: 'A', status: 'final', us: 60 + i, them: 70 + i })));
const ex = (date, time, site, opponent, host, o) => Object.assign({ date, time, site, opponent, opponent_host: host, status: 'scheduled', exhibition: true, location: 'Home City, Ohio' }, o || {});
write(2027, 'home-u', 'homeu.edu', [
  ex('2026-10-27', '7 p.m.', 'H', 'Road State', 'roadst.edu'),                       /* D-I vs D-I, listed by both */
  ex('2026-10-29', '7 p.m.', 'H', 'Division Two College (Exh.)', 'd2.edu'),           /* an NCAA Division II school */
  ex('2026-10-30', '7 p.m.', 'H', 'Prairie NAIA (Exh.)', 'naia.edu'),                 /* a website the registry does not know */
  ex('2026-10-31', '1 p.m.', 'H', 'Blue-White Scrimmage', 'homeu.edu'),               /* intrasquad: its own website */
  ex('2026-11-01', '1 p.m.', 'H', 'Red/White Showcase', null),                        /* no school at all */
  ex('2026-11-01', '5 p.m.', 'A', 'Division Two (Exhibition)', null),                 /* by name, away */
  ex('2026-10-20', '7 p.m.', 'H', 'Earlier Opponent', 'd2.edu', { status: 'final', us: 90, them: 50 }),
  ex('2026-11-05', '7 p.m.', 'H', 'Road State', 'roadst.edu'),                       /* the day of a counted game */
  ex('2026-12-20', '7 p.m.', 'H', 'Outside the window', 'd2.edu'),
  ex('2026-11-02', 'TBA', 'H', 'Road St. (Exh.)', 'roadstathletics.com'),             /* a website the registry does not know, a registry name; no time */
  ex('2026-11-03', '7 p.m.', 'H', 'Moved Up (EXH)', 'movedup.edu'),                   /* a Division II school in the registry, Division I on ESPN */
  { date: '2026-11-10', time: '7 p.m.', site: 'H', opponent: 'Third Tech', status: 'scheduled' },  /* a counted game, not an exhibition */
]);
write(2027, 'road-st', 'roadst.edu', [ex('2026-10-27', '7 p.m.', 'A', 'Home U', 'homeu.edu', { location: 'Home City, Ohio' }), ex('2026-11-02', '6 p.m.', 'A', 'Home U', 'homeu.edu'),
  ex('2026-11-04', '7 p.m.', 'H', 'Third Tech (Ex.)', 'thirdtech.edu'),                /* a Division I school the collector does not read */
  ex('2026-10-30', '7 p.m.', 'H', 'Lost U', 'lostu.edu')]);                             /* ...and one ESPN has no team named for */
write(2027, 'few-games', 'few.edu', [ex('2026-10-28', '7 p.m.', 'H', 'Home U', 'homeu.edu')]);
const schools = [
  { id: 'home-u', name: 'Home U', host: 'homeu.edu', division: 1 }, { id: 'road-st', name: 'Road St.', host: 'roadst.edu', division: 1 },
  { id: 'few-games', name: 'Few Games', host: 'few.edu', division: 1 }, { id: 'd2', name: 'Division Two', full_name: 'Division Two College', nickname: 'Owls', host: 'd2.edu', division: 2 },
  { id: 'third-tech', name: 'Third Tech', nickname: 'Engineers', host: 'thirdtech.edu', division: 1 }, { id: 'lost-u', name: 'Lost U', nickname: 'Ghosts', host: 'lostu.edu', division: 1 },
  { id: 'moved-up', name: 'Moved Up', nickname: 'Lakers', host: 'movedup.edu', division: 2 },
];
/* the dataset's teams.json: ESPN names each team for its school and its nickname */
const teams = { 1: { name: 'Home U Bears' }, 2: { name: 'Road State Rams' }, 3: { name: 'Third Tech Engineers' }, 4: { name: 'Moved Up Lakers' }, 9: { name: 'Division Two Owls' } };
const o = { season: 2027, fromMs: Date.parse('2026-10-26T00:00:00Z'), toMs: Date.parse('2026-11-09T05:00:00Z'), d1: new Set(['1', '2', '3', '4']), teams, dataDir: TMP, schools };

/* ------------------------------------------------------------------ who is who */
const L = EX.learnTeams([{ school: 'home-u', games: JSON.parse(fs.readFileSync(path.join(TMP, 'schedules', SPORT, '2026', 'home-u.json'))).games },
  { school: 'road-st', games: JSON.parse(fs.readFileSync(path.join(TMP, 'schedules', SPORT, '2026', 'road-st.json'))).games },
  { school: 'few-games', games: JSON.parse(fs.readFileSync(path.join(TMP, 'schedules', SPORT, '2026', 'few-games.json'))).games }], rows);
T.eq('a school is the ESPN team with its results (date and score)', [L.teams.get('home-u').id, L.teams.get('road-st').id], ['1', '2']);
T.chk('too few matching finals: unmatched, with the reason', !L.teams.has('few-games') && /only 3 of its finals matched|no ESPN team/.test((L.unmatched.find((u) => u.school === 'few-games') || {}).why));
{
  const twin = EX.learnTeams([{ school: 'a', games: days.map((d, i) => ({ date: d, status: 'final', us: 70 + i, them: 60 + i })) }, { school: 'b', games: days.map((d, i) => ({ date: d, status: 'final', us: 70 + i, them: 60 + i })) }], rows);
  T.chk('one ESPN team, one school: two schools with the same results are neither\'s', !twin.teams.size && twin.unmatched.length === 2);
  const wrong = EX.learnTeams([{ school: 'c', games: days.map((d, i) => ({ date: d, status: 'final', us: 71 + i, them: 60 + i })) }], rows);
  T.chk('a score off by one point matches no one', !wrong.teams.size);
  const exhOnly = EX.learnTeams([{ school: 'd', games: days.map((d, i) => ({ date: d, status: 'final', us: 70 + i, them: 60 + i, exhibition: true })) }], rows);
  T.chk('an exhibition result never identifies a school', !exhOnly.teams.size);
}

/* ------------------------------------------------------------------ which listings are priced */
const R = EX.exhibitions('ncaam', rows, o);
const by = (date) => R.games.filter((g) => g.day === date);
const why = (date) => R.skipped.filter((s) => s.date === date).map((s) => s.why);
T.eq('the schools read and matched', [R.schools_read, R.schools_matched], [3, 2]);
T.chk('two Division I schools listing one exhibition: priced once, at the home school, both rated', by('2026-10-27').length === 1 && by('2026-10-27')[0].home_id === '1' && by('2026-10-27')[0].away_id === '2'
  && by('2026-10-27')[0].home_d1 === 1 && by('2026-10-27')[0].away_d1 === 1 && by('2026-10-27')[0].neutral === 0);
T.chk('...starting at the listed local time', by('2026-10-27')[0].start_utc === '2026-10-27T23:00:00Z' && !by('2026-10-27')[0].start_approx);
const d2 = by('2026-10-29')[0];
T.chk('an NCAA Division II opponent: priced in the non-Division I regime, named as the school lists it', d2 && d2.home_id === '1' && d2.away_d1 === 0 && /^x-/.test(d2.away_id) && d2.away_name === 'Division Two College');
const naia = by('2026-10-30')[0];
T.chk('a website the registry does not know (an NAIA school): non-Division I, named as the school lists it', naia && naia.away_d1 === 0 && naia.away_name === 'Prairie NAIA');
T.chk('an intrasquad game (the school\'s own website) is not priced', !by('2026-10-31').length && why('2026-10-31').includes('an intrasquad game'));
T.chk('a listing that reads as no school is not priced', why('2026-11-01').includes('the opponent reads as no school'));
const away = by('2026-11-01')[0];
T.chk('an opponent found by its registry name, away: the opponent is home', away && away.away_id === '1' && away.home_name === 'Division Two' && away.home_d1 === 0);
T.chk('a played exhibition is not priced', !by('2026-10-20').length);
T.chk('an exhibition the day of a counted game is not priced (the dataset has the game)', !by('2026-11-05').length && why('2026-11-05').includes('a counted game the dataset holds that day'));
T.chk('outside the window: neither priced nor reported', !by('2026-12-20').length && !why('2026-12-20').length);
T.chk('a game the school counts is never an exhibition', !by('2026-11-10').length);
T.chk('a school not matched to its ESPN team: its exhibitions are not priced, with the reason', !by('2026-10-28').length && why('2026-10-28').includes('the school is not matched to an ESPN team'));
T.chk('every priced game is flagged, has a numeric id and the dataset\'s shape', R.games.every((g) => g.exhibition && g.event === 'exhibition' && /^9\d{17}$/.test(g.game_id) && g.status === 'SCHEDULED' && g.season === 2027 && Number.isFinite(g.start_ms)));
T.chk('game ids are stable across runs', JSON.stringify(EX.exhibitions('ncaam', rows, o).games.map((g) => g.game_id)) === JSON.stringify(R.games.map((g) => g.game_id)));
T.chk('a game whose school\'s ESPN team is not Division I this season is not priced', !EX.exhibitions('ncaam', rows, Object.assign({}, o, { d1: new Set(['2', '3', '4']) })).games.some((g) => g.home_id === '1' || g.away_id === '1'));
T.eq('no schedules held: nothing, and no error', EX.exhibitions('ncaaw', rows, o).games, []);
const moved = by('2026-11-02');
T.chk('a website the registry does not know but a registry name (a school that moved its site): that school, priced once', moved.length === 1 && moved[0].home_id === '1' && moved[0].away_id === '2' && moved[0].away_d1 === 1);
T.chk('...from the listing whose start reads whole (the other school\'s "6 p.m.", not "TBA")', moved[0].source.school === 'road-st' && !moved[0].start_approx && moved[0].start_utc === '2026-11-02T23:00:00Z');
const tt = by('2026-11-04')[0];
T.chk('a Division I school the collector does not read: the ESPN team named for it and its nickname', tt && tt.away_id === '3' && tt.away_d1 === 1 && tt.away_name === null);
T.chk('a Division I school ESPN has no team named for: not priced, with the reason', !by('2026-10-30').some((g) => g.home_id === '2') && why('2026-10-30').includes('a Division I opponent not matched to an ESPN team'));
const up = by('2026-11-03')[0];
T.chk('a Division II school in the registry whose name and nickname are a Division I team\'s: that team (it moved up)', up && up.away_id === '4' && up.away_d1 === 1);
T.chk('...only while the team is Division I this season', EX.exhibitions('ncaam', rows, Object.assign({}, o, { d1: new Set(['1', '2', '3']) })).games.some((g) => g.day === '2026-11-03' && g.away_id === 'x-moved-up' && g.away_d1 === 0));
T.chk('a non-Division I school named as no Division I team stays non-Division I (ESPN team 9 is not Division I)', d2.away_id === 'x-d2' && d2.away_d1 === 0);
T.chk('a name two Division I teams share is neither\'s', EX.espnIndex({ a: { name: 'Twin Owls' }, b: { name: 'Twin Owls' } }, new Set(['a', 'b'])).get('twin owls') === null);

/* ------------------------------------------------------------------ real pages (probe rounds 11 and 12)
   Eleven schools' own 2025-26 and 2026-27 basketball schedules, as the collector reads them, against the committed
   datasets: each school is its own ESPN team, men's and women's */
{
  const zlib = require('zlib');
  const SC = require('../collegiate/schedules');
  const FIX = path.join(__dirname, '..', 'collegiate', 'probe', 'fixtures');
  const WANT = { 'goduke.com': '150', 'kuathletics.com': '2305', 'uconnhuskies.com': '41', 'msuspartans.com': '127', 'gozags.com': '2250', 'fightingillini.com': '356', 'villanova.com': '222', 'gomason.com': '2244',
    'bradleybraves.com': '71', 'purduesports.com': '2509', 'gostanford.com': '24' };
  for (const [L, sport] of [['ncaam', 'mens-basketball'], ['ncaaw', 'womens-basketball']]) {
    const DS = require('./' + L + '_forecast/dataset');
    const games = DS.load([2026]);
    const schedules = Object.keys(WANT).map((host) => {
      const fs2 = fs.existsSync(path.join(FIX, host)) ? fs.readdirSync(path.join(FIX, host)) : [];
      const f = fs2.find((x) => x.includes(sport.replace(/-/g, '_') + '_schedule') && /2025_26/.test(x) && (sport === 'womens-basketball' || !/womens/.test(x)));
      const x = f ? SC.parseSchedule(zlib.gunzipSync(fs.readFileSync(path.join(FIX, host, f))).toString('utf8'), sport, host) : null;
      return { school: host, games: x ? x.games : [] };
    });
    const R = EX.learnTeams(schedules, games);
    const got = Object.fromEntries([...R.teams].map(([k, v]) => [k, v.id]));
    T.eq(L + ': every probed school is its own ESPN team, from last season\'s results', got, WANT);
    T.chk(L + ': ...on nearly all of its finals', [...R.teams.values()].every((v) => v.matched >= 0.9 * v.finals && v.matched >= 25));
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(T.done());
