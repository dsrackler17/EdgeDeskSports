/* ===========================================================================
   Generate supabase/ncaam_forecast_registry.sql: the two NCAAM research models
   (NCAAM-FORECAST and SIM-NCAAM-TOURNAMENT) registered EXPERIMENTAL / T3
   BEFORE any prospective evaluation, with the same live-column-adapting SQL
   as the NFL simulator's registration (build_registry_sql.ts).
     node simulator/src/research/build_ncaam_registry_sql.ts           (writes)
     node simulator/src/research/build_ncaam_registry_sql.ts --check   (exit 1 if stale)
   The weekly operational champion (basketball/ncaam_forecast/registry) never
   changes these rows: research status moves only through a validation report.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { generate, type RegistryTarget } from './build_registry_sql.ts';
import { REPO } from '../sports/nfl/model_adapter.ts';

const OUT = path.join(REPO, 'supabase', 'ncaam_forecast_registry.sql');
const base = { sport: 'NCAAM', sportKey: 'basketball_ncaab', configTable: 'public.ncaam_fc_config', requires: 'supabase/simulator.sql and supabase/ncaam_forecast.sql', generator: 'simulator/src/research/build_ncaam_registry_sql.ts' };
const TARGETS: RegistryTarget[] = [
  Object.assign({}, base, { src: path.join(REPO, 'basketball', 'ncaam_forecast', 'research', 'registration_forecast.json'), family: 'game_forecast', configPrefix: 'forecast_',
    registration: 'basketball/ncaam_forecast/research/registration_forecast.json', configNote: 'research_models key of the NCAAM pregame forecast', header: 'ncaam_forecast_registry.sql (1/2) — register the NCAAM pregame forecast' }),
  Object.assign({}, base, { src: path.join(REPO, 'basketball', 'ncaam_forecast', 'research', 'registration_tournament.json'), family: 'tournament_simulator', configPrefix: 'tournament_',
    registration: 'basketball/ncaam_forecast/research/registration_tournament.json', configNote: 'research_models key of the NCAAM tournament simulation', header: 'ncaam_forecast_registry.sql (2/2) — register the NCAAM tournament simulation' }),
];

export function generateNcaam(): string { return TARGETS.map((t) => generate(t)).join('\n'); }

const sql = generateNcaam();
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== sql) { console.error('supabase/ncaam_forecast_registry.sql is stale: run node simulator/src/research/build_ncaam_registry_sql.ts'); process.exit(1); }
  console.log('supabase/ncaam_forecast_registry.sql is current');
} else { fs.writeFileSync(OUT, sql); console.log('wrote supabase/ncaam_forecast_registry.sql'); }
