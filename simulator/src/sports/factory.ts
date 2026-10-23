/* sport key -> simulation module, from frozen snapshot data */
import type { SimModule } from '../core/engine.ts';
import { nflModule } from './nfl/module.ts';
import type { NflInputData } from './nfl/inputs.ts';
import { mlbModule } from './mlb/module.ts';
import type { MlbInputData } from './mlb/inputs.ts';

export function buildModule(sport: string, data: unknown, opt: { seed: bigint; sigma?: number }): SimModule {
  switch (sport) {
    case 'nfl': return nflModule(data as NflInputData, { seed: opt.seed, sigma: opt.sigma });
    case 'mlb': return mlbModule(data as MlbInputData, { seed: opt.seed, sigma: opt.sigma });
    default: throw new Error('no simulation module for sport ' + sport + ' (see simulator/src/sports/registry.ts for its status)');
  }
}
