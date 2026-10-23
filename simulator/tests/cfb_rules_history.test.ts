/* The conference procedures against the real 2024 and 2025 seasons: every
   conference's actual title-game pair, from the cfbfastR-data schedule feed
   (simulator/fixtures/cfb_history.json.gz), must be what its procedure picks
   from the final regular-season standings — unless the procedure reached a
   step naming an external ranking (SportSource, a computer composite, the CFP
   ranking) or a draw, which owned data cannot reproduce; then the actual pair
   must at least be among the teams still tied at that step.

   Eligibility as it stood then: the NCAA's two-year transition rule made
   Kennesaw State (2024) and Delaware and Missouri State (2025) ineligible for
   the Conference USA title game. The ACC's 2024-2025 procedure was replaced in
   2026 and is not replayed here (synthetic ACC-2026 cases are in
   cfb_rules_synthetic.test.ts). */
import { kit } from './_kit.ts';
import { seasonLeague } from './_cfb.ts';
import { ConfTable } from '../src/sports/cfb/rules.ts';
import { streamFor } from '../src/core/prng.ts';

const T = kit('CFB conference procedures vs the 2024-2025 title games');
const PROCS = { 'Big 12': 'B12-2024', 'Mid-American': 'MAC-2025', 'Sun Belt': 'SBC-DIV', SEC: 'SEC-2024', 'Big Ten': 'B1G-2024', 'Mountain West': 'MW-2024', 'American Athletic': 'AAC-2025', 'Conference USA': 'PROVISIONAL' };
const INELIGIBLE: Record<number, string[]> = { 2024: ['Kennesaw State'], 2025: ['Delaware', 'Missouri State'] };
let reproduced = 0, external = 0, checked = 0;
const log: string[] = [];
for (const season of [2024, 2025]) {
  const S = seasonLeague(season, PROCS, INELIGIBLE[season]);
  for (let ci = 0; ci < S.L.confs.length; ci++) {
    const c = S.L.confs[ci], actual = S.actual.get(c.name);
    if (!actual) continue;
    checked++;
    const ctx = { rng: streamFor(1n, 0, 4), diag: () => {}, flag: () => {}, trace: () => {} };
    const tab = new ConfTable(S.L, ci, S.R, ctx);
    const p = tab.participants();
    const got = p.seeds.map((t) => S.teams[t].name).sort();
    const berthBy = tab.decisions.filter((d) => d.purpose === 'berth').map((d) => d.step);
    const ext = berthBy.some((s) => s === 'metric' || s === 'draw');
    if (!ext) {
      T.eq(season + ' ' + c.name + ': the procedure picks the actual title-game pair (' + actual.join(' v ') + ')', got, actual);
      if (got.join() === actual.join()) reproduced++;
      log.push(season + ' ' + c.name.padEnd(18) + ' reproduced ' + actual.join(' v ') + (berthBy.length ? '  (tiebreak: ' + berthBy.join(', ') + ')' : ''));
    } else {
      external++;
      /* the external step decided among the teams still tied: the actual pair must come from the top of the standings */
      const top = new Set(tab.groups(c.members.filter((t) => S.teams[t].ccg_eligible)).slice(0, 3).flat().map((t) => S.teams[t].name));
      T.chk(season + ' ' + c.name + ': an external ranking decided a berth; the actual pair (' + actual.join(' v ') + ') is from the top of the standings', actual.every((a) => top.has(a)), { actual, top: [...top] });
      log.push(season + ' ' + c.name.padEnd(18) + ' external ranking needed (' + berthBy.join(', ') + '); actual ' + actual.join(' v ') + ', owned-data pick ' + got.join(' v '));
    }
  }
}
T.chk('every conference with a title game in 2024-2025 was checked (' + checked + ')', checked >= 14, checked);
T.chk('most pairs are reproduced from results alone (' + reproduced + ' of ' + checked + '; ' + external + ' needed an external ranking)', reproduced + external === checked && reproduced >= 8, { reproduced, external, checked });
process.exitCode = T.done(log.join('\n'));
