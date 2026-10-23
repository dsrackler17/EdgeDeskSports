/* ===========================================================================
   edgedesk-sim alert — record a job failure in public.sim_alerts.

     node simulator/src/cli/alert.ts --severity FAILURE --code sim.run_failed --sport nfl --message "..."

   Best effort, after the failure has already been printed as ::error:: in
   the job log: without SB_URL / SB_SERVICE_ROLE (a dry run, a fork) it says
   so and exits 0, so a missing alert channel never hides the original
   failure's exit code. Exit 2 only for bad arguments.
   =========================================================================== */
import { postgrestDb } from '../publish/db.ts';

const a = process.argv.slice(2), get = (k: string) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] != null && !a[i + 1].startsWith('--') ? a[i + 1] : null; };
const p = { severity: get('--severity'), code: get('--code'), sport: get('--sport'), message: get('--message'), run_id: get('--run-id'), detail: { source: 'github-actions', run_url: process.env.SIM_RUN_URL || null } };
const bad: string[] = [];
if (!['FAILURE', 'DEGRADED', 'WARNING', 'INFO'].includes(p.severity || '')) bad.push('--severity FAILURE|DEGRADED|WARNING|INFO');
if (!/^[a-z0-9_.]{3,64}$/.test(p.code || '')) bad.push('--code [a-z0-9_.]{3,64}');
if (!p.message || p.message.length > 2000) bad.push('--message (1-2000 characters)');
if (p.sport != null && !/^[a-z_]{2,32}$/.test(p.sport)) bad.push('--sport [a-z_]');
if (p.run_id != null && !/^[0-9a-f-]{36}$/.test(p.run_id)) bad.push('--run-id uuid');
if (bad.length) { console.error('error: ' + bad.join('; ')); process.exit(2); }
if (!process.env.SB_URL || !process.env.SB_SERVICE_ROLE) { console.log('alert not recorded (no database credentials in this job): ' + p.severity + ' ' + p.code); process.exit(0); }
try {
  const id = await postgrestDb().rpc('sim_alert', { p });
  console.log('alert recorded: sim_alerts.id ' + id);
} catch (e) {
  console.log('::warning::the alert could not be recorded: ' + String((e as Error).message).slice(0, 300));
}
