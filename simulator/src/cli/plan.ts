/* ===========================================================================
   edgedesk-sim plan — the workflow's validated run list (.github/workflows/simulator.yml).

     SIM_EVENT=schedule node simulator/src/cli/plan.ts
     SIM_EVENT=workflow_dispatch SIM_SPORT=nfl SIM_SEASON=2026 SIM_RUNS=100000 SIM_SEED= SIM_PUBLISH=false node simulator/src/cli/plan.ts

   Prints {"include":[...]} for a job matrix. Every value a later step puts on
   a command line is checked here against a strict pattern, so nothing a
   person types into the Run workflow form reaches a shell unvalidated.
   Schedule: every sport in NIGHTLY (the NFL), at the production run
   count; an ACTIVE sport publishes, any other runs dry and its blockers are
   printed as warnings. Dispatch: the requested sport; publishing is refused
   up front for a sport that is not ACTIVE or for fewer than 100,000 runs.
   Exit 2 on any invalid input.
   =========================================================================== */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sportRegistry } from '../sports/registry.ts';
import { parseSeed } from '../core/prng.ts';
import { PRODUCTION_RUNS } from '../core/results.ts';
import { NFL_2026 } from '../sports/nfl/config.ts';
import { MLB_2026 } from '../sports/mlb/config.ts';

/** sports with a simulation module (simulator/src/sports/factory.ts) and their configured season */
export const RUNNABLE: Record<string, number> = { nfl: NFL_2026.season, mlb: MLB_2026.season };
/** the nightly schedule: MLB runs only when a person dispatches it (its live feed is checked by hand first:
    simulator/src/sports/mlb/config.ts live_inputs) */
export const NIGHTLY = ['nfl'];

export interface PlannedRun { sport: string; season: string; runs: string; seed: string; publish: boolean; status: string; blockers: string[] }

export function planRuns(event: string, inp: { sport?: string; season?: string; runs?: string; seed?: string; publish?: string }): PlannedRun[] {
  const reg = sportRegistry();
  if (event === 'schedule') {
    return NIGHTLY.map((k) => {
      const s = reg.find((r) => r.key === k)!;
      return { sport: k, season: String(RUNNABLE[k]), runs: String(PRODUCTION_RUNS), seed: '', publish: s.status === 'ACTIVE', status: s.status, blockers: s.blockers };
    });
  }
  if (event !== 'workflow_dispatch') throw new Error('unsupported event ' + event);
  const sport = (inp.sport || '').trim(), season = (inp.season || '').trim(), runs = (inp.runs || '').trim(), seed = (inp.seed || '').trim();
  const publish = (inp.publish || 'false').trim();
  const s = reg.find((r) => r.key === sport);
  if (!s) throw new Error('unknown sport "' + sport.slice(0, 20) + '"');
  if (!(sport in RUNNABLE)) throw new Error(s.label + ' has no simulation module (' + s.status + '): ' + s.blockers.join(' | '));
  if (!/^\d{4}$/.test(season) || Number(season) !== RUNNABLE[sport]) throw new Error('season must be ' + RUNNABLE[sport] + ' for ' + s.label + ' (the configured season)');
  if (!/^\d{1,8}$/.test(runs) || Number(runs) < 1000 || Number(runs) > 10000000) throw new Error('runs must be an integer from 1000 to 10000000');
  if (seed !== '') { if (!/^(\d{1,20}|0x[0-9a-fA-F]{1,16})$/.test(seed)) throw new Error('seed must be a decimal or 0x-hex unsigned 64-bit integer, or empty'); parseSeed(seed); }
  if (publish !== 'true' && publish !== 'false') throw new Error('publish must be true or false');
  if (publish === 'true' && s.status !== 'ACTIVE') throw new Error(s.label + ' is ' + s.status + ', so nothing can be published: ' + s.blockers.join(' | '));
  if (publish === 'true' && Number(runs) < PRODUCTION_RUNS) throw new Error('publication needs at least ' + PRODUCTION_RUNS + ' runs');
  return [{ sport, season, runs, seed, publish: publish === 'true', status: s.status, blockers: s.blockers }];
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const e = process.env;
    const include = planRuns(e.SIM_EVENT || '', { sport: e.SIM_SPORT, season: e.SIM_SEASON, runs: e.SIM_RUNS, seed: e.SIM_SEED, publish: e.SIM_PUBLISH });
    process.stdout.write(JSON.stringify({ include }) + '\n');
  } catch (err) {
    console.error('::error::' + (err as Error).message);
    process.exit(2);
  }
}
