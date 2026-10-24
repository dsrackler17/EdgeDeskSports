/* A synthetic college baseball season for the tests (college_baseball_sim.test.ts, college_baseball_ui.test.ts,
   ui.e2e.ts): 120 programs in twelve conferences (ten with an automatic bid, an independent group and programs
   with no conference), ratings spread like Division I's, the committed research's parameters and Model Health, and
   the served pricing constants. Fast (no warehouse replay); the real snapshot is built once in the sim suite. */
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../src/sports/college_baseball/model.ts';
import { modelHealth, CBASE_INPUT_SCHEMA, type CbaseRoadData, type CbaseSnapshot } from '../src/sports/college_baseball/inputs.ts';
import { readOrNull, ROAD_FILE, BACKTEST_FILE } from '../src/sports/college_baseball/activation.ts';
import { driftAt } from '../src/sports/college_baseball/road.ts';
import { hashCanonical } from '../src/core/canonical.ts';
import { streamFor } from '../src/core/prng.ts';

export const CONFS = ['SEC', 'ACC', 'Big 12', 'Big Ten', 'Sun Belt', 'American', 'CUSA', 'Big West', 'WCC', 'SWAC', 'DI Independent', 'none_D1'];
export function syntheticData(o: { phase?: CbaseRoadData['phase']; lastGame?: string | null; names?: (i: number) => string } = {}): CbaseRoadData {
  const r = streamFor(7n, 1, 1);
  const g = () => { let u = r.nextDouble(); while (u <= 0) u = r.nextDouble(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r.nextDouble()); };
  const teams: string[] = []; const T: Record<string, any> = {};
  const confLevel = CONFS.map((_, i) => 0.35 - 0.07 * i);
  for (let i = 0; i < 120; i++) {
    const c = i % CONFS.length, id = 't' + String(i).padStart(3, '0');
    const net = confLevel[c] + 0.25 * g();
    teams.push(id);
    T[id] = { id, name: o.names ? o.names(i) : 'Team ' + i, conf: CONFS[c], off: net / 2 + 0.05 * g(), def: net / 2, sd_team: 0.17, sd_conf: CONFS[c].startsWith('none_') ? 0 : 0.07, info: 0 };
  }
  const road = readOrNull(ROAD_FILE), bt = readOrNull(BACKTEST_FILE);
  const constants = JSON.parse(fs.readFileSync(path.join(REPO, 'college_baseball', 'params', 'constants.json'), 'utf8'));
  const phase = o.phase || 'preseason';
  return {
    kind: 'road', sport: 'college_baseball', competition: 'road-to-omaha', season: 2027, last_game: o.lastGame ?? null, as_of: o.lastGame ? o.lastGame : '2026-06-23', days_to_regionals: phase === 'selected' ? 3 : 346, phase,
    snapshot: { season: 2027, date: '2027-01-01', mu: Math.log(6), hb: 0.04, hp: 0.04, teams: T, parks: { 'h:1': 0.05 }, cal: { a: 0.08, b: 1.08, n: 25000 } },
    teams, aq_conferences: CONFS.slice(0, 10), home_park: { t000: 'h:1' },
    params: { drift: driftAt(road.next.drift, 346, true), select: road.next.select },
    model: { version: '1.0.0', tq: { sigma_team: 0.12 }, dist: { family: 'nb', r: 3.256 }, constants, calibration: { a: 0.08, b: 1.08, n: 25000 }, games_replayed: 95356, warehouse: { first: 2012, last: 2026 } },
    model_health: modelHealth(bt, road)
  };
}
export function syntheticSnapshot(o: Parameters<typeof syntheticData>[0] = {}): CbaseSnapshot {
  const data = syntheticData(o);
  return { schema: CBASE_INPUT_SCHEMA, input_hash: hashCanonical(data), data, meta: { built_at: '2026-10-24T00:00:00.000Z', builder: 'simulator/tests/_college_baseball_fixture.ts', source: 'synthetic', replay_seconds: 0 } };
}
