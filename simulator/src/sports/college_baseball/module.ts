/* ===========================================================================
   THE ROAD TO OMAHA — one simulated 2027 college baseball season, from the
   ratings of the as-of date to a champion (road.ts: the season's move to
   Selection Monday, the committee proxy, the NCAA tournament priced by the
   served model, sim.ts).

   Each run draws on three streams of its own: the season's move
   (STREAM.drift), the committee proxy (STREAM.committee) and the
   tournament (STREAM.postseason: the strength draws and every game).
   Outcomes per Division I team, every one through the committee proxy and
   so Estimated: the conference's automatic bid, making the field, hosting a
   regional, a national seed, winning a regional (the super regionals),
   reaching Omaha, the final, the title. Sum rules after every run: one
   automatic bid per conference that holds one; 64 in the field, 16 hosts,
   8 national seeds, 16 regional winners, 8 in Omaha, 2 finalists, 1
   champion.
   =========================================================================== */
import type { SimModule, EntityDef, OutcomeDef, SumRule, RunMarks } from '../../core/engine.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import { RoadSim } from './road.ts';
import { usePricing } from './model.ts';
import type { CbaseRoadData } from './inputs.ts';

export const OUTCOMES: OutcomeDef[] = [
  { key: 'win_title', label: 'Win the national title', category: 'title', provenance: 'Estimated' },
  { key: 'reach_final', label: 'Reach the final (CWS finals)', category: 'round', provenance: 'Estimated' },
  { key: 'reach_omaha', label: 'Reach Omaha (College World Series)', category: 'round', provenance: 'Estimated' },
  { key: 'win_regional', label: 'Win a regional', category: 'round', provenance: 'Estimated' },
  { key: 'national_seed', label: 'A national seed (top 8)', category: 'seed', provenance: 'Estimated' },
  { key: 'host_regional', label: 'Host a regional (top 16)', category: 'seed', provenance: 'Estimated' },
  { key: 'make_field', label: 'Make the NCAA tournament', category: 'playoffs', provenance: 'Estimated' },
  { key: 'auto_bid', label: 'Win the conference\'s automatic bid', category: 'conference', provenance: 'Estimated' }
];

export function cbaseModule(d: CbaseRoadData, opt: { seed: bigint }): SimModule {
  const S = d.snapshot;
  const entities: EntityDef[] = d.teams.map((id) => ({ id, name: S.teams[id].name, groups: { conference: S.teams[id].conf } }));
  const E = new Map(entities.map((e, i) => [e.id, i]));
  const O = new Map(OUTCOMES.map((o, i) => [o.key, i]));
  const aq = new Set(d.aq_conferences);
  const confs = [...new Set(entities.map((e) => e.groups.conference))];
  if (entities.length < 64) throw new Error('college baseball: ' + entities.length + ' teams cannot fill a 64-team field');
  usePricing(d.model.dist, d.model.constants);
  const sim = new RoadSim(S, d.teams, aq, d.params, d.home_park);
  const sumRules: SumRule[] = [
    { outcome: 'auto_bid', by: 'conference', perGroup: 1, skip: confs.filter((c) => !aq.has(c)) },
    { outcome: 'make_field', by: 'league', perGroup: 64 },
    { outcome: 'host_regional', by: 'league', perGroup: 16 },
    { outcome: 'national_seed', by: 'league', perGroup: 8 },
    { outcome: 'win_regional', by: 'league', perGroup: 16 },
    { outcome: 'reach_omaha', by: 'league', perGroup: 8 },
    { outcome: 'reach_final', by: 'league', perGroup: 2 },
    { outcome: 'win_title', by: 'league', perGroup: 1 }
  ];
  const o = (k: string) => O.get(k)!;
  const oA = o('auto_bid'), oF = o('make_field'), oH = o('host_regional'), oN = o('national_seed'), oR = o('win_regional'), oO = o('reach_omaha'), oFi = o('reach_final'), oT = o('win_title');
  const idx = (id: string) => E.get(id)!;
  return {
    sport: 'college_baseball', competition: d.competition, season: String(d.season),
    entities, outcomes: OUTCOMES, sumRules, valueBins: 0,
    runOne(run: number, marks: RunMarks): void {
      const r = sim.run(streamFor(opt.seed, run, STREAM.drift), streamFor(opt.seed, run, STREAM.committee), streamFor(opt.seed, run, STREAM.postseason));
      for (const id of r.auto) marks.mark(idx(id), oA);
      for (const id of r.field) marks.mark(idx(id), oF);
      for (const id of r.hosts) marks.mark(idx(id), oH);
      for (const id of r.national) marks.mark(idx(id), oN);
      for (const id of r.regional) marks.mark(idx(id), oR);
      for (const id of r.omaha) marks.mark(idx(id), oO);
      for (const id of r.finalists) marks.mark(idx(id), oFi);
      marks.mark(idx(r.champion), oT);
      if (marks.tracing) marks.trace({ ev: 'season', hosts: r.hosts.map((id) => S.teams[id].name), omaha: r.omaha.map((id) => S.teams[id].name), champion: S.teams[r.champion].name });
    }
  };
}
