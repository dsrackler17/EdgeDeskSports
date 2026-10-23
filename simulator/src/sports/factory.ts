/* sport key -> simulation module, from frozen snapshot data */
import type { SimModule } from '../core/engine.ts';
import { nflModule } from './nfl/module.ts';
import type { NflInputData } from './nfl/inputs.ts';
import { ncaamModule, type NcaamInputData } from './ncaam/module.ts';

export function buildModule(sport: string, data: unknown, opt: { seed: bigint; sigma?: number }): SimModule {
  switch (sport) {
    case 'nfl': return nflModule(data as NflInputData, { seed: opt.seed, sigma: opt.sigma });
    /* sigma, when given, overrides every team's strength VARIANCE (the backtest's V = 0 arm) */
    case 'ncaam': return ncaamModule(data as NcaamInputData, { seed: opt.seed, strengthVariance: opt.sigma });
    default: throw new Error('no simulation module for sport ' + sport + ' (see simulator/src/sports/registry.ts for its status)');
  }
}
