/* The live MLB feed's grammar, on MLB's own REAL 2024 responses (datapack/quant_v1/data/mlb/raw):
   doubleheaders, postponements and their new dates, suspended games resumed later, cancellations, the
   postseason series numbering, box-score starters, the id crosswalk — and the rules engine run on MLB's own
   2024 data must reproduce MLB's own 2024 postseason (an independent source from the Retrosheet history). */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { kit } from './_kit.ts';
import { parseSchedule, boxscoreStarters, crosswalk } from '../src/sports/mlb/statsapi.ts';
import { teamsFor, formatFor } from '../src/sports/mlb/config.ts';
import { Season, Standings, qualify, playPostseason } from '../src/sports/mlb/rules.ts';
import { REPO, dayOf } from '../src/sports/mlb/history.ts';

const K = kit('MLB Stats API parsing (REAL 2024 responses)');
const RAW = path.join(REPO, 'datapack', 'quant_v1', 'data', 'mlb', 'raw');
const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, 'schedule_2024.json.gz'))).toString('utf8'));
const teams = teamsFor(2024);
const p = parseSchedule(json, teams);
const reg = p.games.filter((g) => g.phase === 'regular'), post = p.games.filter((g) => g.phase === 'postseason');

/* the club table against MLB's own ids and names */
{
  const names = new Map<number, string>();
  for (const d of json.dates) for (const g of d.games) if (g.gameType === 'R') for (const s of ['home', 'away']) names.set(g.teams[s].team.id, g.teams[s].team.name);
  K.eq('MLB\'s 2024 regular season has exactly the 30 configured team ids', [...names.keys()].sort((a, b) => a - b), teams.map((t) => t.statsapi_id).sort((a, b) => a - b));
  const off = teams.filter((t) => names.get(t.statsapi_id) !== t.name && !(t.code === 'OAK' && names.get(t.statsapi_id) === 'Oakland Athletics'));
  K.eq('every configured name is MLB\'s (the Athletics were "Oakland Athletics" in 2024)', off.map((t) => t.code + ':' + names.get(t.statsapi_id)), []);
}
/* one record per game */
{
  K.eq('2,430 scheduled regular-season games; one cancelled (CLE-HOU 2024-09-29, never played) dropped: 2,429 kept', [reg.length, p.dropped.cancelled], [2429, [746577]]);
  K.eq('every kept regular-season game is final (the 2024 season is over)', reg.every((g) => g.status === 'final'), true);
  K.eq('39 duplicate appearances folded (postponed games shown on their old date, suspended games on both days)', p.dropped.duplicates, 39);
  const per: Record<string, number> = {}; for (const g of reg) { per[g.home] = (per[g.home] || 0) + 1; per[g.away] = (per[g.away] || 0) + 1; }
  K.chk('every club 162 games except Cleveland and Houston (161: the cancelled game)', teams.every((t) => per[t.code] === (t.code === 'CLE' || t.code === 'HOU' ? 161 : 162)), per);
  const byPk = new Map(p.games.map((g) => [g.id, g]));
  K.eq('a postponed game is kept once, on its new date (746816: postponed 2024-04-03, played 2024-06-27)', [byPk.get('mlb:746816')!.date, byPk.get('mlb:746816')!.status], ['2024-06-27', 'final']);
  K.eq('a suspended game resumed later is kept once, on the date it began (745180 2024-05-21, resumed 05-22; 746942 06-26, resumed 08-26)', [byPk.get('mlb:745180')!.date, byPk.get('mlb:746942')!.date], ['2024-05-21', '2024-06-26']);
  K.chk('no game is left without a date', p.games.every((g) => !g.date_estimated));
}
/* doubleheaders */
{
  const dh = reg.filter((g) => g.game_no > 0);
  const byDay = new Map<string, number[]>(); for (const g of dh) { const k = g.home + g.away + g.date; byDay.set(k, (byDay.get(k) || []).concat(g.game_no)); }
  const pairs = [...byDay.values()].filter((v) => v.length === 2), singles = [...byDay.entries()].filter(([, v]) => v.length === 1);
  K.chk('doubleheaders: each pair on one date is numbered 1 and 2, never two games with one number', dh.length > 50 && pairs.every((v) => v.slice().sort().join() === '1,2') && [...byDay.values()].every((v) => v.length <= 2), { games: dh.length });
  K.eq('MLB\'s own data keeps a doubleheader\'s number when its other game moved (ATL-CIN 2024-07-24: game 2 postponed again): kept as is', singles.map(([k, v]) => k + ':' + v.join()), ['ATLCIN2024-07-24:1']);
  const nyn = p.games.filter((g) => g.id === 'mlb:745844' || g.id === 'mlb:745843').map((g) => [g.date, g.game_no]);
  K.eq('the rescheduled Tigers-Mets doubleheader of 2024-04-04 (two rainouts): game 1 then game 2 on the makeup date', nyn.sort(), [['2024-04-04', 1], ['2024-04-04', 2]]);
}
/* the postseason as MLB's own feed numbers it */
{
  const n = (r: string) => post.filter((g) => g.round === r).length;
  K.eq('postseason games by round: Wild Card 9, Division Series 18, LCS 11, World Series 5', [n('WC'), n('DS'), n('LCS'), n('WS')], [9, 18, 11, 5]);
  K.chk('every postseason game has a series game number', post.every((g) => Number.isInteger(g.series_game) && (g.series_game as number) >= 1 && (g.series_game as number) <= 7));
}
/* MLB's own 2024 data through the rules engine: the seeds, the bracket, every postseason game's host */
{
  const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const S = new Season(teams, reg.map((g) => ({ home: ix[g.home], away: ix[g.away], day: dayOf(g.date), game_no: g.game_no })));
  const st = new Standings(S, Int8Array.from(reg.map((g) => ((g.home_score as number) > (g.away_score as number) ? 1 : -1))), { rng: null });
  const seeds = qualify(st, formatFor(2024));
  K.eq('2024 seeds from MLB\'s own results: AL NYA CLE HOU BAL KCA DET; NL LAN PHI MIL SDN ATL NYN (the ATL/NYN/ARI three-club tie included)',
    seeds.map((L) => L.seeds.map((t) => teams[t].code).join(' ')), ['NYA CLE HOU BAL KCA DET', 'LAN PHI MIL SDN ATL NYN']);
  const used = new Set<string>(); const problems: string[] = [];
  playPostseason(st, formatFor(2024), seeds, (spec, k, home, away) => {
    const g = post.find((x) => x.round === spec.round && x.series_game === k && [x.home, x.away].sort().join() === [teams[home].code, teams[away].code].sort().join());
    if (!g) { problems.push(spec.id + ' game ' + k + ' not played'); return home; }
    used.add(g.id); if (g.home !== teams[home].code) problems.push(spec.id + ' game ' + k + ' host ' + g.home);
    return (g.home_score as number) > (g.away_score as number) ? ix[g.home] : ix[g.away];
  });
  K.eq('every 2024 postseason game in MLB\'s feed is a game of the engine\'s bracket, at the engine\'s host', [problems, used.size], [[], post.length]);
}
/* box-score starters */
{
  const files = fs.readdirSync(RAW).filter((f) => f.startsWith('feed_'));
  let ok = 0, probableAgrees = 0;
  for (const f of files) {
    const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, f))).toString('utf8'));
    const sp = boxscoreStarters(feed.liveData.boxscore);
    const gs = (side: 'home' | 'away', id: number | undefined) => id != null && feed.liveData.boxscore.teams[side].players['ID' + id].stats.pitching.gamesStarted === 1;
    if (sp.home && sp.away && gs('home', sp.home.id) && gs('away', sp.away.id)) ok++;
    const pp = feed.gameData.probablePitchers || {};
    if (pp.home && pp.away && sp.home && sp.away && pp.home.id === sp.home.id && pp.away.id === sp.away.id) probableAgrees++;
  }
  K.eq('the first pitcher a box score lists is the one credited with the start (all ' + files.length + ' real 2024 feeds)', ok, files.length);
  K.chk('and the announced probables match the actual starters in most of them (late changes happen)', probableAgrees >= files.length - 3, probableAgrees);
  K.eq('a box score without pitchers yields no starter (never a guess)', boxscoreStarters({ teams: { home: { pitchers: [] }, away: {} } }), { home: null, away: null });
}
/* the crosswalk (SYNTHETIC register rows, the register's real header) */
{
  const head = 'key_person,key_uuid,key_mlbam,key_retro,key_bbref,key_bbref_minors,key_fangraphs';
  const x = crosswalk([head + '\na6c4d634,u,669022,gorem001,gorema01,,22201\n000007d9,u,472542,,,garcia001ado,\n', head + '\nzz,u,669923,kirbg001,,,\n']);
  K.eq('MLBAM id to Retrosheet id; rows without a Retrosheet id are left out', x, { 669022: 'gorem001', 669923: 'kirbg001' });
  K.throws('a file without the id columns is refused', () => crosswalk(['a,b\n1,2']), /key_mlbam/);
}
/* a schedule grammar the 2024 response does not contain (SYNTHETIC): a postponed game with no new date, a postseason placeholder */
{
  const syn = { dates: [{ games: [
    { gamePk: 1, gameType: 'R', officialDate: '2026-09-01', gameDate: '2026-09-01T23:00:00Z', doubleHeader: 'N', gameNumber: 1, status: { codedGameState: 'D', detailedState: 'Postponed', abstractGameState: 'Final' }, teams: { home: { team: { id: 147 } }, away: { team: { id: 111 } } } },
    { gamePk: 2, gameType: 'W', officialDate: '2026-10-30', gameDate: '2026-10-30T23:00:00Z', doubleHeader: 'N', gameNumber: 1, seriesGameNumber: 1, status: { codedGameState: 'S', detailedState: 'Scheduled', abstractGameState: 'Preview' }, teams: { home: { team: { id: 0, name: 'TBD' } }, away: { team: { id: 0 } } } },
    { gamePk: 3, gameType: 'S', officialDate: '2026-03-01', status: { codedGameState: 'F' }, teams: { home: { team: { id: 147 } }, away: { team: { id: 111 } } } },
    { gamePk: 4, gameType: 'R', officialDate: '2026-09-02', gameDate: '2026-09-02T23:00:00Z', doubleHeader: 'N', gameNumber: 1, status: { codedGameState: 'S', detailedState: 'Scheduled', abstractGameState: 'Preview' },
      teams: { home: { team: { id: 147 }, probablePitcher: { id: 669022, fullName: 'MacKenzie Gore' } }, away: { team: { id: 111 } } } }
  ] }] };
  syn.dates[0].games.push(
    { gamePk: 5, gameType: 'R', officialDate: '2026-09-03', gameDate: '2026-09-03T23:05:00Z', doubleHeader: 'N', gameNumber: 1, status: { codedGameState: 'T', detailedState: 'Suspended: Rain', abstractGameState: 'Live' }, teams: { home: { team: { id: 147 } }, away: { team: { id: 111 } } } } as any,
    { gamePk: 5, gameType: 'R', officialDate: '2026-09-03', gameDate: '2026-09-04T17:05:00Z', resumedFromDate: '2026-09-03', doubleHeader: 'N', gameNumber: 1, status: { codedGameState: 'S', detailedState: 'Scheduled', abstractGameState: 'Preview' }, teams: { home: { team: { id: 147 } }, away: { team: { id: 111 } } } } as any);
  const q = parseSchedule(syn, teamsFor(2026));
  K.eq('a suspended game still to be resumed is one scheduled game, on its resumption day (not its original officialDate)', q.games.filter((g) => g.id === 'mlb:5').map((g) => [g.status, g.date]), [['scheduled', '2026-09-04']]);
  K.eq('a postponed game with no new date is kept, scheduled, its date estimated', q.games.filter((g) => g.id === 'mlb:1').map((g) => [g.status, g.date_estimated]), [['scheduled', true]]);
  K.chk('a postseason placeholder without its clubs is skipped; spring training ignored', !q.games.some((g) => g.id === 'mlb:2' || g.id === 'mlb:3') && q.dropped.other_types === 1);
  K.eq('an announced probable pitcher is read for a scheduled game', q.games.find((g) => g.id === 'mlb:4')!.probable.home, { id: 669022, name: 'MacKenzie Gore' });
  K.throws('an unknown club in a regular-season game is refused', () => parseSchedule({ dates: [{ games: [{ gamePk: 9, gameType: 'R', status: { codedGameState: 'S' }, teams: { home: { team: { id: 999 } }, away: { team: { id: 111 } } } }] }] }, teamsFor(2026)), /unknown club/);
}
process.exit(K.done());
