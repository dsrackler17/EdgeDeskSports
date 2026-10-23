/* sport key -> simulation module, from frozen snapshot data */
import type { SimModule } from '../core/engine.ts';
import { nflModule } from './nfl/module.ts';
import type { NflInputData } from './nfl/inputs.ts';
import { nbaModule } from './nba/module.ts';
import type { NbaInputData } from './nba/inputs.ts';
import { nhlModule } from './nhl/module.ts';
import type { NhlInputData } from './nhl/inputs.ts';
import { mlbModule } from './mlb/module.ts';
import type { MlbInputData } from './mlb/inputs.ts';

export function buildModule(sport: string, data: unknown, opt: { seed: bigint; sigma?: number }): SimModule {
  switch (sport) {
    case 'nfl': return nflModule(data as NflInputData, { seed: opt.seed, sigma: opt.sigma });
    case 'nba': return nbaModule(data as NbaInputData, { seed: opt.seed, sigma: opt.sigma });
    case 'nhl': return nhlModule(data as NhlInputData, { seed: opt.seed, sigma: opt.sigma });
    case 'mlb': return mlbModule(data as MlbInputData, { seed: opt.seed, sigma: opt.sigma });
    default: throw new Error('no simulation module for sport ' + sport + ' (see simulator/src/sports/registry.ts for its status)');
  }
}
