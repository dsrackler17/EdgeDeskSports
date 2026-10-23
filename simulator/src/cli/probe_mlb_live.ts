/* ===========================================================================
   edgedesk-sim probe-mlb — read MLB's Stats API the way the live MLB
   snapshot does, on a real runner, and write NOTHING.

     node simulator/src/cli/probe_mlb_live.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]

   The live builder (src/sports/mlb/statsapi.ts) has never been run against
   the live API from the environment it was built in (statsapi.mlb.com is
   refused there). This probe is the check a pull request runs on a GitHub
   runner: one schedule window (default: the last 14 days) with the probable
   pitchers, parsed by parseSchedule(); the box score of the latest final
   game, read by boxscoreStarters(); and one Chadwick register file for the
   id crosswalk. Exit 0 with a summary; 1 if a response does not parse into
   the shape the builder relies on, or a source cannot be reached.
   =========================================================================== */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchedule, boxscoreStarters, crosswalk, STATSAPI } from '../sports/mlb/statsapi.ts';
import { teamsFor, MLB_2026 } from '../sports/mlb/config.ts';

async function get(u: string): Promise<string> {
  let last: unknown = null;
  for (let a = 0; a < 3; a++) {
    try { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u); return await r.text(); }
    catch (e) { last = e; await new Promise((res) => setTimeout(res, 1000 * (a + 1))); }
  }
  throw last;
}

export async function probe(from: string, to: string): Promise<string[]> {
  const out: string[] = [];
  const url = STATSAPI + 'schedule?sportId=1&gameType=R,F,D,L,W&hydrate=probablePitcher&startDate=' + from + '&endDate=' + to;
  const sched = parseSchedule(JSON.parse(await get(url)), teamsFor(MLB_2026.season));
  const fin = sched.games.filter((g) => g.status === 'final');
  out.push('schedule ' + from + '..' + to + ': ' + sched.games.length + ' games (' + fin.length + ' final, ' + sched.games.filter((g) => g.phase === 'postseason').length + ' postseason, ' + sched.games.filter((g) => g.game_no > 0).length + ' doubleheader games), ' + sched.dropped.cancelled.length + ' cancelled, ' + sched.dropped.duplicates + ' duplicate appearances, ' + sched.games.filter((g) => g.probable.home || g.probable.away).length + ' with an announced probable');
  if (fin.length) {
    const g = fin[fin.length - 1];
    const sp = boxscoreStarters(JSON.parse(await get(STATSAPI + 'game/' + g.pk + '/boxscore')));
    if (!sp.home || !sp.away) throw new Error('the box score of ' + g.id + ' names no starter');
    out.push('box score ' + g.id + ' (' + g.date + ' ' + g.away + ' @ ' + g.home + '): starters ' + sp.away.name + ' / ' + sp.home.name);
  }
  const xw = crosswalk([await get('https://raw.githubusercontent.com/chadwickbureau/register/master/data/people-a.csv')]);
  out.push('register people-a.csv: ' + Object.keys(xw).length + ' MLBAM ids with a Retrosheet id');
  return out;
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const to = arg('--to') || new Date().toISOString().slice(0, 10);
  const from = arg('--from') || new Date(Date.parse(to + 'T12:00:00Z') - 14 * 864e5).toISOString().slice(0, 10);
  if (![from, to].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) { console.error('dates are YYYY-MM-DD'); process.exit(2); }
  probe(from, to).then((lines) => { for (const l of lines) console.log(l); console.log('probe ok: nothing written'); })
    .catch((e) => { console.error('::error::MLB live probe failed: ' + String((e as Error).message || e)); process.exit(1); });
}
