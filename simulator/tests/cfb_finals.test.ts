/* Late finals (simulator/src/sports/cfb/finals.ts) and the results.current gate.
   The ESPN payloads are CONSTRUCTED in ESPN's scoreboard shape (tools/slate/fixtures/espn_shapes.js);
   the case that prompted the check is the real one: the schedule feed of 2026-10-23 listed James
   Madison at App State (Oct. 22, 23:00 UTC) as unplayed after App State had won 34-31 in overtime.
   node simulator/tests/cfb_finals.test.ts */
import path from 'node:path';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { cfbFixture, clone } from './_cfb.ts';
import { REPO, type FeedGame } from '../src/sports/cfb/engine_adapter.ts';
import { overlayFinals, LAG_HOURS } from '../src/sports/cfb/finals.ts';
import { validateCfbInputs } from '../src/sports/cfb/validate.ts';

const require = createRequire(import.meta.url);
const X = require(path.join(REPO, 'tools', 'slate', 'fixtures', 'espn_shapes.js'));
const T = kit('CFB late finals');

const NOW = Date.parse('2026-10-23T19:55:00Z');
const row = (o: Partial<FeedGame> & { game_id: string; start_date: string; home: string; away: string; home_id: string | null; away_id: string | null }): FeedGame => ({
  season: 2026, week: 8, season_type: 'regular', kick: Date.parse(o.start_date), time_tbd: false, completed: false, neutral: false, conference_game: true, notes: null, venue_id: null,
  home_division: 'fbs', away_division: 'fbs', home_conference: 'Sun Belt', away_conference: 'Sun Belt', home_points: null, away_points: null, ...o });
const team = (id: string, name: string) => X.team(name.slice(0, 4).toUpperCase(), name, name, id);
const APP = team('2026', 'App State Mountaineers'), JMU = team('256', 'James Madison Dukes');
const ev = (id: string, date: string, home: any, away: any, hs: number | null, as: number | null, st: any, extra: any = {}) => X.event({ id, date, home, away, hs, as, status: st, ...extra });

/* one fake ESPN: { 'groups:day' -> events }, or a status code to answer */
function espn(boards: Record<string, any[] | number>) {
  const asked: string[] = [];
  const f = async (url: string) => {
    asked.push(url);
    const day = /dates=(\d{8})/.exec(url)![1], grp = /groups=(\d+)/.exec(url)![1];
    const b = boards[grp + ':' + day];
    if (typeof b === 'number') return new Response('{"error":"x"}', { status: b });
    return new Response(JSON.stringify({ events: b || [] }), { status: 200 });
  };
  return { f, asked };
}

{
  /* the real case: JMU at App State, Thursday night, settled from ESPN by event id and team ids */
  const rows = [row({ game_id: '401869845', start_date: '2026-10-22T23:00:00.000Z', home: 'App State', away: 'James Madison', home_id: '2026', away_id: '256' })];
  const E = espn({ '80:20261022': [ev('401869845', '2026-10-22T23:00Z', APP, JMU, 34, 31, X.status('final', { detail: 'Final/OT' }))] });
  const r = await overlayFinals(rows, { now: NOW, offline: false, fetch: E.f, retries: 1 });
  T.eq('JMU at App State is taken from ESPN as final, 31-34, in place for the replay', [rows[0].completed, rows[0].away_points, rows[0].home_points], [true, 31, 34]);
  T.eq('... recorded as applied, with ESPN\'s detail', r.overlay.applied, [{ game_id: '401869845', kickoff: '2026-10-22T23:00:00.000Z', home: 'App State', away: 'James Madison', home_points: 34, away_points: 31, detail: 'Final/OT' }]);
  T.eq('... nothing unresolved, and the read is recorded with its sha256', [r.overlay.unresolved.length, r.reads.length, r.reads[0].ok, /^[0-9a-f]{64}$/.test(r.reads[0].sha256)], [0, 1, true, true]);
  T.chk('... one request: the FBS scoreboard (group 80) for its US-Eastern day', E.asked.length === 1 && /groups=80/.test(E.asked[0]) && /dates=20261022/.test(E.asked[0]));
}
{
  /* a 10:30 PM Eastern kickoff is the next UTC day but ESPN files it under its Eastern day */
  const rows = [row({ game_id: '9', start_date: '2026-10-18T02:30:00.000Z', home: 'App State', away: 'James Madison', home_id: '2026', away_id: '256' })];
  const E = espn({ '80:20261017': [ev('9', '2026-10-18T02:30Z', APP, JMU, 20, 27, X.status('final'))] });
  await overlayFinals(rows, { now: NOW, offline: false, fetch: E.f, retries: 1 });
  T.chk('a late-night kickoff is read from its Eastern day (Oct. 17), not its UTC day', rows[0].completed && E.asked.length === 1 && /dates=20261017/.test(E.asked[0]));
}
{
  /* a neutral site where ESPN's home/away labels are the reverse of the feed's: scores follow the team ids */
  const rows = [row({ game_id: '10', start_date: '2026-10-17T16:00:00.000Z', home: 'James Madison', away: 'App State', home_id: '256', away_id: '2026', neutral: true })];
  const E = espn({ '80:20261017': [ev('10', '2026-10-17T16:00Z', APP, JMU, 17, 24, X.status('final'), { neutral: true })] });
  await overlayFinals(rows, { now: NOW, offline: false, fetch: E.f, retries: 1 });
  T.eq('neutral site, labels reversed: each score goes to its team by id (JMU 24, App State 17)', [rows[0].home_points, rows[0].away_points], [24, 17]);
}
{
  /* everything that must NOT be taken */
  const g = (id: string, start: string, o: Partial<FeedGame> = {}) => row({ game_id: id, start_date: start, home: 'App State', away: 'James Madison', home_id: '2026', away_id: '256', ...o });
  const rows = [
    g('20', '2026-10-21T23:00:00.000Z'),                                  // ESPN's team ids differ
    g('21', '2026-10-21T23:00:00.000Z'),                                  // ESPN final but tied
    g('22', '2026-10-21T23:00:00.000Z'),                                  // ESPN still in progress, long overdue
    g('23', '2026-10-21T23:00:00.000Z'),                                  // ESPN postponed
    g('24', '2026-10-23T17:00:00.000Z'),                                  // started under LAG_HOURS ago, live: neither
    g('25', '2026-10-24T16:00:00.000Z'),                                  // not started: never asked
    g('26', '2026-10-21T23:00:00.000Z', { completed: true, home_points: 3, away_points: 0 }), // already final in the feed
    g('27', '2026-10-21T23:00:00.000Z', { home_division: 'fcs', home: 'Wagner', home_id: '2681' }), // not on the FBS board: the FCS board has it
    g('28', '2026-10-21T23:00:00.000Z')                                   // on neither board
  ];
  const WAG = team('2681', 'Wagner Seahawks');
  const E = espn({
    '80:20261021': [ev('20', '2026-10-21T23:00Z', APP, team('99', 'Someone Else'), 30, 10, X.status('final')), ev('21', '2026-10-21T23:00Z', APP, JMU, 21, 21, X.status('final')),
      ev('22', '2026-10-21T23:00Z', APP, JMU, 14, 7, X.status('live')), ev('23', '2026-10-21T23:00Z', APP, JMU, null, null, X.status('postponed'))],
    '80:20261023': [ev('24', '2026-10-23T17:00Z', APP, JMU, 7, 0, X.status('live'))],
    '81:20261021': [ev('27', '2026-10-21T23:00Z', WAG, JMU, 3, 52, X.status('final'))]
  });
  const r = await overlayFinals(rows, { now: NOW, offline: false, fetch: E.f, retries: 1 });
  const un = new Map(r.overlay.unresolved.map((u) => [u.game_id, u.status]));
  T.eq('only the FCS-board final is taken (by its team ids)', r.overlay.applied.map((a) => [a.game_id, a.home_points, a.away_points]), [['27', 3, 52]]);
  T.chk('different team ids: never taken, unresolved, the ids named', /team ids/.test(un.get('20') || '') && !rows[0].completed);
  T.chk('a tied "final": never taken, unresolved', /unequal/.test(un.get('21') || '') && !rows[1].completed);
  T.chk('in progress long after kickoff: unresolved with ESPN\'s status', /LIVE/.test(un.get('22') || ''));
  T.eq('postponed: listed as not played, not unresolved, still unplayed', [r.overlay.not_played.map((x) => x.game_id), un.has('23'), rows[3].completed], [['23'], false, false]);
  T.eq('started under ' + LAG_HOURS + ' h ago and live: neither taken nor unresolved', [un.has('24'), rows[4].completed], [false, false]);
  T.chk('a game not yet started is never asked about, and a feed final is left alone', !E.asked.some((u) => /dates=20261024/.test(u)) && rows[6].home_points === 3 && !r.overlay.applied.some((a) => a.game_id === '26'));
  T.chk('on neither board: unresolved', /not on ESPN/.test(un.get('28') || ''));
  T.chk('the FCS board is read only for the day with a game the FBS board lacked', E.asked.filter((u) => /groups=81/.test(u)).length === 1 && E.asked.some((u) => /groups=81/.test(u) && /dates=20261021/.test(u)));
}
{
  /* ESPN unreachable: bounded retries, then every overdue game is unresolved (the gate holds publication) */
  const rows = [row({ game_id: '401869845', start_date: '2026-10-22T23:00:00.000Z', home: 'App State', away: 'James Madison', home_id: '2026', away_id: '256' })];
  const E = espn({ '80:20261022': 503, '81:20261022': 503 });
  const r = await overlayFinals(rows, { now: NOW, offline: false, fetch: E.f, retries: 2 });
  T.eq('a 503 is retried, bounded; the game stays unplayed and unresolved, saying the read failed', [E.asked.filter((u) => /groups=80/.test(u)).length, rows[0].completed, /read failed/.test(r.overlay.unresolved[0] && r.overlay.unresolved[0].status)], [2, false, true]);
  const E4 = espn({ '80:20261022': 404, '81:20261022': 404 });
  await overlayFinals([row({ game_id: '1', start_date: '2026-10-22T23:00:00.000Z', home: 'App State', away: 'James Madison', home_id: '2026', away_id: '256' })], { now: NOW, offline: false, fetch: E4.f, retries: 3 });
  T.eq('a 4xx is not retried', E4.asked.filter((u) => /groups=80/.test(u)).length, 1);
}
{
  /* a game with no kickoff time yet (dated midnight Eastern) is not overdue until its whole day has passed */
  const tbd = row({ game_id: '30', start_date: '2026-10-24T04:00:00.000Z', time_tbd: true, home: 'App State', away: 'James Madison', home_id: '2026', away_id: '256' });
  const satMorning = Date.parse('2026-10-24T10:17:00Z');
  const r = await overlayFinals([tbd], { now: satMorning, offline: false, fetch: espn({ '80:20261024': [ev('30', '2026-10-24T23:30Z', APP, JMU, null, null, X.status('pre'))] }).f, retries: 1 });
  T.eq('the nightly on the Saturday of a TBA game: looked up, not overdue', r.overlay.unresolved.length, 0);
  const r2 = await overlayFinals([clone(tbd)], { now: Date.parse('2026-10-25T11:00:00Z'), offline: false, fetch: espn({}).f, retries: 1 });
  T.eq('... a day later with no final anywhere: unresolved', r2.overlay.unresolved.map((u) => u.game_id), ['30']);
}
{
  /* offline: no request at all; the overdue games are listed, and the overlay says it did not check */
  const rows = [row({ game_id: '401869845', start_date: '2026-10-22T23:00:00.000Z', home: 'App State', away: 'James Madison', home_id: '2026', away_id: '256' })];
  const E = espn({});
  const r = await overlayFinals(rows, { now: NOW, offline: true, fetch: E.f });
  T.eq('an offline build asks nothing and marks the overlay unchecked', [E.asked.length, r.overlay.checked, r.overlay.unresolved.length], [0, false, 1]);
}

/* the gate */
{
  const snap = cfbFixture();
  const gate = (s: any) => validateCfbInputs(s).find((x) => x.id === 'results.current')!;
  const legacy = gate(snap);
  T.chk('the committed snapshot (built before this check, from the lagging feed) WARNS, naming JMU at App State as simulated though played, and blocks nothing',
    legacy.status === 'WARN' && legacy.blocks === 'none' && /James Madison @ App State/.test(legacy.detail) && /7 game/.test(legacy.detail));
  const s1 = clone(snap) as any;
  s1.data.results_overlay = { source: 'x', checked: true, lag_hours: 6, applied: [{ game_id: '401869845', kickoff: '2026-10-22T23:00:00.000Z', home: 'App State', away: 'James Madison', home_points: 34, away_points: 31, detail: 'Final/OT' }], not_played: [], unresolved: [] };
  const ok = gate(s1);
  T.chk('a checked snapshot with nothing unresolved passes and names the finals taken', ok.status === 'PASS' && ok.blocks === 'none' && /James Madison 31 @ App State 34/.test(ok.detail));
  s1.data.results_overlay.unresolved = [{ game_id: '1', kickoff: '2026-10-22T23:00:00.000Z', home: 'Memphis', away: 'East Carolina', status: 'ESPN read failed: 503' }];
  const bad = gate(s1);
  T.chk('a played game neither source settles holds PUBLICATION (the simulation still runs)', bad.status === 'FAIL' && bad.blocks === 'publication' && /East Carolina @ Memphis/.test(bad.detail));
}
process.exitCode = T.done();
