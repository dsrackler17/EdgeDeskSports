/* MLB configuration: the alignment against the game logs, the season formats, the 2026 facts and their
   verification status, the registry (MLB BLOCKED until a person verifies them), the Estimated postseason
   calendar against the 2025 Retrosheet calendar it was taken from, and the study files the snapshots read. */
import fs from 'node:fs';
import path from 'node:path';
import { kit } from './_kit.ts';
import { MLB_2026, teamsFor, formatFor, DIVISIONS } from '../src/sports/mlb/config.ts';
import { historyConfig } from '../src/sports/mlb/inputs.ts';
import { loadRegularSeason, loadPostseason, dayOf, REPO } from '../src/sports/mlb/history.ts';
import { sportRegistry, isVerified } from '../src/sports/registry.ts';

const K = kit('MLB configuration and registry');

/* the alignment, re-derived from the logs: each club's four most frequent opponents are its division rivals */
for (let s = 2012; s <= 2025; s++) {
  const teams = teamsFor(s); const div: Record<string, string> = {}; teams.forEach((t) => { div[t.code] = t.division; });
  const n: Record<string, Record<string, number>> = {};
  for (const g of loadRegularSeason(s).games) { (n[g.home] = n[g.home] || {})[g.away] = (n[g.home][g.away] || 0) + 1; (n[g.away] = n[g.away] || {})[g.home] = (n[g.away][g.home] || 0) + 1; }
  const bad = teams.filter((t) => { const want = teams.filter((x) => x.division === t.division && x.code !== t.code).map((x) => x.code).sort(); const top = Object.entries(n[t.code]).sort((a, b) => b[1] - a[1]).slice(0, want.length).map(([c]) => c).sort(); return top.join() !== want.join(); });
  K.eq(s + ': every club\'s most frequent opponents are exactly its configured division rivals' + (s === 2012 ? ' (2012: Houston in a six-club NL Central, a four-club AL West)' : ''), bad.map((t) => t.code), []);
}
K.eq('six divisions of five clubs', DIVISIONS.map((d) => teamsFor(2026).filter((t) => t.division === d).length), [5, 5, 5, 5, 5, 5]);
K.eq('formats by season', [2012, 2013, 2019, 2021, 2022, 2026].map((s) => formatFor(s).id + ':' + formatFor(s).playoff_clubs_per_league), ['MLB-2012:5', 'MLB-2012:5', 'MLB-2012:5', 'MLB-2012:5', 'MLB-2022:6', 'MLB-2022:6']);
K.eq('World Series home field: All-Star Game league 2012-2016, the better record from 2017', [2016, 2017].map((s) => formatFor(s).ws_home.rule), ['all_star_game', 'better_record']);

/* the 2026 facts: every one that moves a number is UNVERIFIED with a verify_by, nothing claims VERIFIED */
const facts = ['alignment', 'format', 'tiebreakers', 'world_series_home', 'extra_innings', 'live_inputs'] as const;
K.chk('2026 facts: each affects results, is UNVERIFIED, names what to check, and has no verifier', facts.every((k) => { const f = MLB_2026[k] as any; return f.affects_results && f.verification === 'UNVERIFIED' && f.verify_by.length > 20 && f.verified_by === null && f.verified_at === null && !isVerified(f); }));
K.eq('the postseason calendar is an Estimated input, not a fact to verify', MLB_2026.postseason_calendar.verification, 'NOT_APPLICABLE');
K.eq('bullpen, lineups, drift and availability are OFF', [MLB_2026.bullpen.mode, MLB_2026.lineups.mode, MLB_2026.drift.mode, MLB_2026.availability.mode], ['off', 'off', 'off', 'off']);
{
  const h = historyConfig(2025);
  K.chk('a history replay\'s config marks the season\'s rules as replayed history (NOT_APPLICABLE), never VERIFIED', ['alignment', 'format', 'tiebreakers', 'world_series_home', 'extra_innings'].every((k) => (h as any)[k].verification === 'NOT_APPLICABLE') && h.season === 2025);
}
/* the registry */
{
  const reg = sportRegistry(); const mlb = reg.find((s) => s.key === 'mlb')!; const nfl = reg.find((s) => s.key === 'nfl')!;
  K.eq('MLB is BLOCKED (implemented; the 2026 facts await verification)', mlb.status, 'BLOCKED');
  K.eq('one blocker per unverified 2026 fact', mlb.blockers.length, facts.length);
  K.chk('each MLB blocker names MLB\'s official source and what to check', mlb.blockers.every((b) => b.includes('MLB\'s official source')));
  K.chk('the NFL\'s blockers still read as before', nfl.blockers.every((b) => b.includes('the NFL\'s official source')));
  K.chk('MLB\'s limitations say bullpen fatigue is not modelled and that starters are Projected', mlb.limitations.some((l) => /Bullpen usage and fatigue are NOT modelled/.test(l)) && mlb.limitations.some((l) => /Projected/.test(l)));
  const t = { ...MLB_2026 } as any;
  for (const k of facts) t[k] = { ...t[k], verification: 'VERIFIED' };
  K.chk('VERIFIED without verified_by and verified_at does not count', facts.every((k) => !isVerified(t[k])));
}
/* the Estimated postseason calendar is the 2025 calendar, as offsets from the last regular-season date */
{
  const last = dayOf(loadRegularSeason(2025).games.slice(-1)[0].date);
  const post = loadPostseason().games.filter((g) => g.season === 2025);
  const off = (r: string, lg: string | null) => { const by = new Map<number, number>(); for (const g of post.filter((x) => x.round === r && (lg == null || x.home_league === lg))) by.set(g.series_game, dayOf(g.date) - last); return [...by.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]); };
  const c = MLB_2026.postseason_calendar.value;
  K.eq('Wild Card Series offsets', off('WC', null), c.WC);
  K.eq('Division Series offsets, AL and NL', [off('DS', 'AL'), off('DS', 'NL')], [c.DS.AL, c.DS.NL]);
  K.eq('LCS offsets: the ALCS went 7 (all seven dates), the NLCS 4 (the template carries the scheduled 5-7)', [off('LCS', 'AL'), off('LCS', 'NL'), c.LCS.NL.slice(0, 4)], [c.LCS.AL, c.LCS.NL.slice(0, 4), off('LCS', 'NL')]);
  K.eq('World Series offsets (seven games in 2025)', off('WS', null), c.WS);
}
/* the study files the snapshots read */
{
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(REPO, 'simulator', 'data', f), 'utf8'));
  const rot = read('mlb_rotation_study.json'), str = read('mlb_strength_uncertainty.json'), gm = read('mlb_game_model_study.json');
  K.eq('study schemas', [rot.schema, str.schema, gm.schema], ['edgedesk_sim_mlb_rotation_study_v1', 'edgedesk_sim_mlb_strength_uncertainty_v1', 'edgedesk_sim_mlb_game_model_study_v1']);
  const P = rot.simulator_parameters;
  K.chk('rotation parameters: probabilities in [0,1), a non-increasing survival curve, min rest 5', P.min_rest_days === 5 && Object.values(P.p_spot).every((x: any) => x >= 0 && x < 1) && P.survival.every((v: number, i: number) => v <= 1 && (i === 0 || v <= P.survival[i - 1])));
  K.chk('the rotation study\'s postseason rule is the one rotation.ts implements', rot.postseason.chosen_rule === 'quality4');
  K.chk('the strength study was run on the current rotation study (its sha256)', str.inputs.rotation_study_sha256 === (await import('../src/core/canonical.ts')).sha256Hex(fs.readFileSync(path.join(REPO, 'simulator', 'data', 'mlb_rotation_study.json'))));
  K.chk('every stage has a calibrated sigma_team with an interval', Object.values(str.sigma_team_by_stage).every((x: any) => typeof x.sigma_team === 'number' && x.ci95[0] <= x.sigma_team && x.sigma_team <= x.ci95[1]));
  K.chk('every study was run on the served model version', [str.served_model.version, gm.served_model.version].every((v) => v === JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'model-loop', 'mlb', 'versions.json'), 'utf8')).current));
}
process.exit(K.done());
