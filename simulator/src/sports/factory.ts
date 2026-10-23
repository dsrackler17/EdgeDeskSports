/* sport key -> simulation module, from frozen snapshot data */
import type { SimModule } from '../core/engine.ts';
import { nflModule } from './nfl/module.ts';
import type { NflInputData } from './nfl/inputs.ts';
import { nhlModule } from './nhl/module.ts';
import type { NhlInputData } from './nhl/inputs.ts';
import { mlbModule } from './mlb/module.ts';
import type { MlbInputData } from './mlb/inputs.ts';
import { nbaModule } from './nba/module.ts';
import type { NbaInputData } from './nba/inputs.ts';
import { cfbModule } from './cfb/module.ts';
import type { CfbInputData } from './cfb/inputs.ts';
import { ncaamModule, type NcaamInputData } from './ncaam/module.ts';
import { wnbaModule } from './wnba/module.ts';
import type { WnbaInputData } from './wnba/inputs.ts';
import { ufcModule } from './ufc/module.ts';
import type { UfcInputData } from './ufc/inputs.ts';
import { golfModule } from './golf/module.ts';
import type { GolfInputData } from './golf/types.ts';

export function buildModule(sport: string, data: unknown, opt: { seed: bigint; sigma?: number }): SimModule {
  switch (sport) {
    case 'nfl': return nflModule(data as NflInputData, { seed: opt.seed, sigma: opt.sigma });
    case 'nhl': return nhlModule(data as NhlInputData, { seed: opt.seed, sigma: opt.sigma });
    case 'mlb': return mlbModule(data as MlbInputData, { seed: opt.seed, sigma: opt.sigma });
    case 'nba': return nbaModule(data as NbaInputData, { seed: opt.seed, sigma: opt.sigma });
    case 'cfb': return cfbModule(data as CfbInputData, { seed: opt.seed, tau: opt.sigma });
    /* sigma, when given, overrides every team's strength VARIANCE (the backtest's V = 0 arm) */
    case 'ncaam': return ncaamModule(data as NcaamInputData, { seed: opt.seed, strengthVariance: opt.sigma });
    /* sigma, when given, overrides the shared series offset tau (0 = independent games) */
    case 'wnba': return wnbaModule(data as WnbaInputData, { seed: opt.seed, tau: opt.sigma });
    case 'ufc': return ufcModule(data as UfcInputData, { seed: opt.seed });
    /* sigma, when given, overrides the scale of the per-tournament offsets (0 = skill without uncertainty: the backtest's baseline) */
    case 'golf': return golfModule(data as GolfInputData, { seed: opt.seed, scale: opt.sigma });
    default: throw new Error('no simulation module for sport ' + sport + ' (see simulator/src/sports/registry.ts for its status)');
  }
}
