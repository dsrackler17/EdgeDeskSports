/* NBA 2026-27 configuration: the alignment derived from the committed schedules (not recalled),
   the clubs against every other NBA table in the repository, the 2026-27 schedule against the
   alignment and the NBA Cup, the facts and the registry status they produce (the Cup itself: nba_cup.test.ts). */
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { NBA_TEAMS, NBA_2026_27 } from '../src/sports/nba/config.ts';
import { rulesFor, NBA_2021 } from '../src/sports/nba/rules.ts';
import { sportRegistry, isVerified } from '../src/sports/registry.ts';

const require = createRequire(import.meta.url);
const D = require('../../nba/lib/data.js');
const T = kit('NBA 2026-27 configuration');
const byId: Record<string, any> = {}; NBA_TEAMS.forEach((t) => { byId[t.id] = t; });

/* 1 the clubs, against the engine's own tables */
{
  const names = require('../../nba/data/teams.json'), abbr = require('../../nba/data/team_abbr.json');
  T.eq('30 clubs, two conferences of 15, six divisions of 5', [NBA_TEAMS.length, NBA_TEAMS.filter((t) => t.conference === 'East').length, new Set(NBA_TEAMS.map((t) => t.division)).size,
    [...new Set(NBA_TEAMS.map((t) => t.division))].every((d) => NBA_TEAMS.filter((t) => t.division === d).length === 5)], [30, 15, 6, true]);
  T.chk('ids, abbreviations and names are nba/data/teams.json and team_abbr.json', NBA_TEAMS.every((t) => names[t.id] === t.name && abbr[t.id] === t.code) && Object.keys(names).length === 30);
  const core = require('../../nba/injury/core.js');
  T.chk('and the injury layer\'s team identity (nba/injury/core.js NBA_TEAMS)', core.NBA_TEAMS.length === 30 && core.NBA_TEAMS.every((r: any) => byId[r[0]] && byId[r[0]].code === r[1] && byId[r[0]].name === r[3]));
}

/* 2 the alignment, derived from the schedules: a division rival is the only opponent played four times in every
   season 2013-14..2018-19 and 2021-22..2022-23 (before the NBA Cup changed the counts); a conference rival three
   or four times; the other conference twice */
{
  const seasons = [2014, 2015, 2016, 2017, 2018, 2019, 2022, 2023];
  let inter: Record<string, Set<string> | null> = {}; const conf: Record<string, Set<string>> = {};
  for (const s of seasons) {
    const c: Record<string, number> = {};
    for (const g of D.games([s]).filter((x: any) => x.type === 'R' && x.scope === 'regular_season')) { const k = [g.home_id, g.away_id].sort().join('-'); c[k] = (c[k] || 0) + 1; }
    const four: Record<string, Set<string>> = {};
    for (const [k, n] of Object.entries(c)) {
      const [a, b] = k.split('-');
      if (n === 4) { (four[a] = four[a] || new Set()).add(b); (four[b] = four[b] || new Set()).add(a); }
      if (n >= 3) { (conf[a] = conf[a] || new Set()).add(b); (conf[b] = conf[b] || new Set()).add(a); }
      if (n !== 2 && n !== 3 && n !== 4) T.chk(s + ' ' + k + ': every pairing is played 2, 3 or 4 times', false, n);
    }
    for (const t of NBA_TEAMS) { const f = four[t.id] || new Set<string>(); inter[t.id] = inter[t.id] ? new Set([...inter[t.id]!].filter((x) => f.has(x))) : new Set(f); }
  }
  for (const t of NBA_TEAMS) {
    const derived = [...inter[t.id]!].map((x) => byId[x].code).sort(), cfg = NBA_TEAMS.filter((x) => x.division === t.division && x.id !== t.id).map((x) => x.code).sort();
    T.eq(t.code + ': the division rivals the schedules imply', derived, cfg);
    T.eq(t.code + ': the conference the schedules imply', [...conf[t.id]].map((x) => byId[x].code).sort(), NBA_TEAMS.filter((x) => x.conference === t.conference && x.id !== t.id).map((x) => x.code).sort());
  }
}

/* 3 the 2026-27 schedule as committed (the NBA build refreshes it; the NBA Cup-dependent games arrive in December):
   at most 1,230 regular-season games, 80-82 per club, only the Cup's two per club missing, consistent with the alignment */
{
  const g27 = D.games([2027]);
  const reg = g27.filter((x: any) => x.type === 'R' && x.scope === 'regular_season');
  const per: Record<string, number> = {}; for (const g of reg) { per[g.home_id] = (per[g.home_id] || 0) + 1; per[g.away_id] = (per[g.away_id] || 0) + 1; }
  T.chk('2026-27: at most 1,230 regular-season games, 80 to 82 per club (' + reg.length + ' on the schedule)', reg.length <= 1230 && reg.length >= 1200 && Object.keys(per).length === 30 && Object.values(per).every((n) => n >= 80 && n <= 82), per);
  T.chk('2026-27: every row has a known scope (the NBA Cup final is apart from the regular season)', g27.every((x: any) => ['regular_season', 'nba_cup_final', 'play_in', 'playoffs'].includes(x.scope)));
  const c: Record<string, number> = {}; for (const g of reg) { const k = [g.home_id, g.away_id].sort().join('-'); c[k] = (c[k] || 0) + 1; }
  let bad = 0;
  for (const a of NBA_TEAMS) for (const b of NBA_TEAMS) {
    if (a.id >= b.id) continue;
    const n = c[[a.id, b.id].sort().join('-')] || 0;
    if (a.conference === b.conference ? n < 3 : n < 2 || n > 3) bad++;
  }
  T.eq('2026-27: every pairing\'s count agrees with the alignment so far', bad, 0);
  for (const s of [2024, 2025, 2026]) {
    const r = D.games([s]).filter((x: any) => x.type === 'R' && x.scope === 'regular_season');
    T.eq(s + ' (an NBA Cup season): 1,230 regular-season games once the Cup games are on it, the final apart', [r.length, D.games([s]).filter((x: any) => x.scope === 'nba_cup_final').length], [1230, 1]);
  }
}

/* 4 the rules version and the facts */
{
  T.eq('2026-27 runs under NBA-2021 (play-in, six direct seeds, 2-2-1-1-1)', [rulesFor(2027).id, rulesFor(2027).play_in, rulesFor(2027).direct_seeds, rulesFor(2027).home_games.finals], [NBA_2021.id, true, 6, [1, 2, 5, 7]]);
  T.eq('the config names its rules version', NBA_2026_27.rules_version, 'NBA-2021');
  const facts = [NBA_2026_27.tiebreakers, NBA_2026_27.playoff_clubs_for_tiebreakers, NBA_2026_27.play_in, NBA_2026_27.playoff_format, NBA_2026_27.home_court, NBA_2026_27.nba_cup, NBA_2026_27.nba_cup_format];
  T.chk('every fact that moves a number names a source and how to verify it', facts.every((f) => f.affects_results && f.source.length > 40 && f.verify_by.length > 40));
  T.chk('all seven are VERIFIED, each with a named verifier and a date, from the source check run that read them', facts.every((f) => isVerified(f) && /run 39996632843/.test(f.verified_by || '') && f.verified_at === '2026-10-23'));
  T.chk('... and each cites the league\'s page it was read from (URL, capture, text sha256)', facts.every((f) => /web\.archive\.org\/web\/\d{14}id_\/https:\/\/(www|pr)\.nba\.com/.test(f.source) && /sha256 [0-9a-f]{64}/.test(f.source)));
  T.eq('the postseason schedule and the Cup-dependent schedule are Estimated inputs, not facts to verify', [NBA_2026_27.postseason_schedule.verification, NBA_2026_27.cup_dependent_schedule.verification], ['NOT_APPLICABLE', 'NOT_APPLICABLE']);
  T.chk('the Cup format quotes the league\'s tiebreakers, wild card, hosts and the non-advancing clubs\' formula', ['Head-to-head record in Group Play', 'Total points scored in Group Play', 'with the exception of the head-to-head', 'home arena of the higher-seeded team', 'otherwise scheduled to play each other three times'].every((q) => NBA_2026_27.nba_cup_format.source.includes(q)));
  const nba = sportRegistry().find((s) => s.key === 'nba')!;
  T.eq('the NBA is ACTIVE, with no blocker (the facts are verified; the Cup-dependent games are simulated)', [nba.status, nba.blockers], ['ACTIVE', []]);
  T.chk('its limitations name the NBA Cup\'s Estimated parts', nba.limitations.some((l) => /NBA Cup/.test(l) && /Estimated/.test(l)));
  T.chk('... and the reader has an NBA Cup tab', nba.tabs.includes('cup'));
  T.chk('the registry text carries no simulated number', !/probab|\d\.\d{3,}/.test(JSON.stringify(nba)));
  T.eq('drift is OFF; availability is the return-hazard plan', [NBA_2026_27.drift.mode, NBA_2026_27.availability.mode], ['off', 'return_hazards']);
}

process.exit(T.done());
