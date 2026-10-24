/* ===========================================================================
   COLLEGE BASEBALL — the frozen inputs of one Road to Omaha run.

   Built from the committed warehouse (college_baseball/data) and the
   committed research (simulator/data/college_baseball_road.json and
   college_baseball_backtest.json); nothing is fetched:
   - the served model replayed through every game in the warehouse
     (model.ts), and its ratings for the configured season: its preseason
     priors while the season has no game in the warehouse, else the ratings
     the morning after its last game, with the season's run-space
     calibration (fitted on the three seasons before);
   - the season's move left to Selection Monday (road.ts driftAt: the
     checkpoints measured by the backtest, interpolated by the days left to
     the first regional game) and the committee proxy (measured on every
     past field);
   - the conferences with an automatic bid (those in the last field), the
     Division I programs (the season's, else the last season's) and each
     one's home park (the last season it played at home).
   The snapshot's `data` is canonical and content-hashed (input_hash); `meta`
   records when and from what it was built.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { hashCanonical } from '../../core/canonical.ts';
import { replay, servedModel, servedConstants, d1Teams, W, LAST_SEASON, FIRST_SEASON, type Snapshot } from './model.ts';
import { homeParks } from './bracket.ts';
import { driftAt, type RoadParams, type DriftAt, type SelectParams } from './road.ts';
import { readOrNull, ROAD_FILE, BACKTEST_FILE, ROAD_SCHEMA, BACKTEST_SCHEMA } from './activation.ts';
import { CBASE_2027, type CbaseSeasonConfig } from './config.ts';

export const CBASE_INPUT_SCHEMA = 'edgedesk_sim_cbase_input_v1';

export interface CbaseRoadData {
  kind: 'road';
  sport: 'college_baseball';
  competition: string;
  season: number;
  /** the warehouse's last game of the season (null: the preseason) */
  last_game: string | null;
  as_of: string;
  days_to_regionals: number;
  phase: 'preseason' | 'in_season' | 'selected';
  snapshot: Snapshot;
  teams: string[];
  aq_conferences: string[];
  home_park: Record<string, string>;
  params: RoadParams;
  model: { version: string; tq: Record<string, number>; dist: { family: string; r: number }; constants: Record<string, unknown>; calibration: { a: number; b: number; n: number } | null; games_replayed: number; warehouse: { first: number; last: number } };
  model_health: any;
}
export interface CbaseSnapshot { schema: string; input_hash: string; data: CbaseRoadData; meta: { built_at: string; builder: string; source: string; replay_seconds: number } }

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/** what the reader's Model Health shows: the two backtests, compacted */
export function modelHealth(bt: any, road: any): any {
  if (!bt || bt.schema !== BACKTEST_SCHEMA || !road || road.schema !== ROAD_SCHEMA) return null;
  return {
    tournament: { seasons: bt.seasons, refused: bt.refused, windows: bt.windows, sims: bt.sims_per_tournament, regional: bt.regional_winner_log_loss, omaha: bt.omaha, champion: bt.champion, games: { n: bt.games.n, log_loss: bt.games.log_loss, vs_coin: bt.games.vs_coin, favourites: bt.games.favourites, by_round: Object.fromEntries(Object.entries(bt.games.by_round).map(([k, v]: any) => [k, { n: v.n, log_loss: v.log_loss }])) }, super_host_proxy: bt.super_host_proxy,
      per_season: bt.per_season.map((x: any) => ({ season: x.season, window: x.window, champion: x.champion, favourite: x.favourites[0] })) },
    road: { targets: road.targets, checkpoints: road.checkpoints, summary: road.summary, per_season: road.per_season.map((x: any) => ({ season: x.season, preseason: { champion: x.checkpoints.preseason.champion, favourite: x.checkpoints.preseason.favourites[0], top64_in_field: x.checkpoints.preseason.top64_in_field } })) },
    generated_at: { tournament: bt.generated_at, road: road.generated_at }
  };
}

function trimSnapshot(S: Snapshot, teams: string[], parks: Record<string, string>): Snapshot {
  const keep = new Set(teams.map((id) => parks[id]).filter(Boolean));
  const T: Snapshot['teams'] = {};
  for (const id of teams) { const t = S.teams[id]; T[id] = { id, name: t.name, conf: t.conf, off: r6(t.off), def: r6(t.def), sd_team: r6(t.sd_team), sd_conf: r6(t.sd_conf), info: r6(t.info) }; }
  const P: Record<string, number> = {}; for (const k of [...keep].sort()) if (S.parks[k] != null) P[k] = r6(S.parks[k]);
  return { season: S.season, date: S.date, mu: r6(S.mu), hb: r6(S.hb), hp: r6(S.hp), teams: T, parks: P, cal: S.cal };
}

export function buildCbaseSnapshot(o: { cfg?: CbaseSeasonConfig; nowMs?: number; log?: (s: string) => void } = {}): CbaseSnapshot {
  const cfg = o.cfg || CBASE_2027, log = o.log || (() => {});
  const season = cfg.season;
  const road = readOrNull(ROAD_FILE), bt = readOrNull(BACKTEST_FILE);
  if (!road || road.schema !== ROAD_SCHEMA || !road.next) throw new Error('college baseball: no committed season backtest (' + path.relative(process.cwd(), ROAD_FILE) + ')');
  const games = W.results(season, season);
  const last: string | null = games.length ? games[games.length - 1].date : null;
  const rp = last
    ? replay({ through: season, at: [{ season, date: '9999-12-30', teams: null, key: 'current' }] })
    : replay({ through: Math.min(LAST_SEASON, season - 1), preseason: season });
  const S0 = rp.snapshots.get(last ? 'current' : 'preseason:' + season);
  if (!S0) throw new Error('college baseball: the replay gave no ratings for ' + season);
  log('college baseball: served model ' + rp.version + ' replayed over ' + rp.rows.length + ' scored games in ' + rp.seconds.toFixed(1) + ' s' + (last ? '; ' + season + ' through ' + last : '; ' + season + ' preseason'));
  /* the preseason's as-of is the morning after the warehouse's last game: nothing changes until a game is added */
  const prior = W.results(Math.min(LAST_SEASON, season - 1), Math.min(LAST_SEASON, season - 1));
  const asOf = last ? addDays(last, 1) : addDays(prior.length ? prior[prior.length - 1].date : season - 1 + '-12-31', 1);
  const days = Math.round((Date.parse(cfg.regionals_start) - Date.parse(asOf)) / 864e5);
  const phase: CbaseRoadData['phase'] = !last ? 'preseason' : days <= 4 ? 'selected' : 'in_season';
  const parkSeason = last ? season : Math.min(LAST_SEASON, season - 1);
  const parks = homeParks(parkSeason, '9999-12-31');
  const teams = d1Teams(season).filter((id) => S0.teams[id]).sort();
  const home: Record<string, string> = {}; for (const id of teams) if (parks[id]) home[id] = parks[id];
  const drift = driftAt(road.next.drift as DriftAt[], Math.max(0, days), !last);
  const sm = servedModel();
  const data: CbaseRoadData = {
    kind: 'road', sport: 'college_baseball', competition: cfg.competition, season, last_game: last, as_of: asOf, days_to_regionals: days, phase,
    snapshot: trimSnapshot(S0, teams, home), teams, aq_conferences: (road.next.aq_conferences as string[]).slice(), home_park: home,
    params: { drift: Object.assign({}, drift, { seasons: drift.seasons.slice() }), select: road.next.select as SelectParams },
    model: { version: rp.version, tq: sm.tq, dist: sm.dist, constants: servedConstants(), calibration: S0.cal, games_replayed: rp.rows.length, warehouse: { first: FIRST_SEASON, last: games.length ? season : LAST_SEASON } },
    model_health: modelHealth(bt, road)
  };
  return { schema: CBASE_INPUT_SCHEMA, input_hash: hashCanonical(data), data, meta: { built_at: new Date(o.nowMs ?? Date.now()).toISOString(), builder: 'simulator/src/sports/college_baseball/inputs.ts', source: 'college_baseball/data (committed warehouse) + simulator/data/college_baseball_road.json', replay_seconds: rp.seconds } };
}

export function writeCbaseSnapshot(file: string, snap: CbaseSnapshot): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(snap)); }
export function readCbaseSnapshot(file: string): CbaseSnapshot {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as CbaseSnapshot;
  if (snap.schema !== CBASE_INPUT_SCHEMA) throw new Error('not a college baseball snapshot: ' + snap.schema);
  if (hashCanonical(snap.data) !== snap.input_hash) throw new Error('college baseball snapshot hash mismatch');
  return snap;
}
