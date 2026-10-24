/* ===========================================================================
   Generate supabase/ncaaw_forecast_registry.sql: the NCAAW pregame forecast
   (NCAAW-FORECAST) registered EXPERIMENTAL / T3 BEFORE any prospective
   evaluation, with the same live-column-adapting SQL as the men's registration
   (build_ncaam_registry_sql.ts) and the NFL simulator's (build_registry_sql.ts).
   No women's tournament simulation is registered: none is built.
     node simulator/src/research/build_ncaaw_registry_sql.ts           (writes)
     node simulator/src/research/build_ncaaw_registry_sql.ts --check   (exit 1 if stale)
   The weekly operational champion (basketball/ncaaw_forecast/registry) never
   changes this row: research status moves only through a validation report.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { generate, type RegistryTarget } from './build_registry_sql.ts';
import { REPO } from '../sports/nfl/model_adapter.ts';

const OUT = path.join(REPO, 'supabase', 'ncaaw_forecast_registry.sql');
const TARGET: RegistryTarget = { sport: 'NCAAW', sportKey: 'basketball_wncaab', configTable: 'public.ncaaw_fc_config', requires: 'supabase/simulator.sql and supabase/ncaaw_forecast.sql',
  generator: 'simulator/src/research/build_ncaaw_registry_sql.ts', src: path.join(REPO, 'basketball', 'ncaaw_forecast', 'research', 'registration_forecast.json'), family: 'game_forecast',
  configPrefix: 'forecast_', registration: 'basketball/ncaaw_forecast/research/registration_forecast.json', configNote: 'research_models key of the NCAAW pregame forecast',
  header: 'ncaaw_forecast_registry.sql — register the NCAAW pregame forecast' };

export function generateNcaaw(): string { return generate(TARGET); }

const sql = generateNcaaw();
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== sql) { console.error('supabase/ncaaw_forecast_registry.sql is stale: run node simulator/src/research/build_ncaaw_registry_sql.ts'); process.exit(1); }
  console.log('supabase/ncaaw_forecast_registry.sql is current');
} else { fs.writeFileSync(OUT, sql); console.log('wrote supabase/ncaaw_forecast_registry.sql'); }
