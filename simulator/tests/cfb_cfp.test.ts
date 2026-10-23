/* The CFP field, seeds and bracket (cfp.ts) for each season's rules:
   - the REAL 2024 and 2025 final rankings (simulator/data/cfb_cfp_rankings_history.json)
     and conference champions (the schedule feed) reproduce the real brackets, checked
     against the playoff games in the feed (first-round hosts and pairings, the
     quarterfinal pairings);
   - SYNTHETIC 2026 cases for every clause of the 2026 protocol;
   - every bracket path, first round on campus, neutral from the quarterfinals, no reseeding. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kit } from './_kit.ts';
import { history, isCcgRow } from './_cfb.ts';
import { CFP_RULES, selectField, playBracket, cfpRulesFor } from '../src/sports/cfb/cfp.ts';
import { seasonFrame, conferenceChampions } from '../src/research/cfb_committee.ts';
import { loadCfbEngine } from '../src/sports/cfb/engine_adapter.ts';

const T = kit('CFB CFP field, seeds and bracket');
const HIST = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cfb_cfp_rankings_history.json'), 'utf8'));
const E = loadCfbEngine().E;

T.eq('rules by season', [cfpRulesFor(2024).id, cfpRulesFor(2025).id, cfpRulesFor(2026).id, cfpRulesFor(2027).id], ['CFP-2024', 'CFP-2025', 'CFP-2026', 'CFP-2026']);
T.throws('no 12-team format before 2024', () => cfpRulesFor(2023), /no 12-team/);

/* ---------------------------------------------------- the real 2024 and 2025 brackets */
const EXPECT: Record<number, string[]> = {
  2024: ['Oregon', 'Georgia', 'Boise State', 'Arizona State', 'Texas', 'Penn State', 'Notre Dame', 'Ohio State', 'Tennessee', 'Indiana', 'SMU', 'Clemson'],
  2025: ['Indiana', 'Ohio State', 'Georgia', 'Texas Tech', 'Oregon', 'Ole Miss', 'Texas A&M', 'Oklahoma', 'Alabama', 'Miami', 'Tulane', 'James Madison']
};
for (const season of [2024, 2025]) {
  /* the ranking order over every FBS team: the committee's 25, then the rest (their order beyond 25 never matters here) */
  const f = seasonFrame(season, 7, {}, HIST.seasons[season].ranking, HIST.seasons[season].final_column);
  const order = f.order.concat(f.teams.map((_, i) => i).filter((i) => !f.order.includes(i)));
  const feed = history().filter((g) => g.season === season);
  const confOf = new Map<string, string>();
  for (const g of feed) { if (g.home_division === 'fbs') confOf.set(g.home, g.home_conference || 'FBS Independents'); if (g.away_division === 'fbs') confOf.set(g.away, g.away_conference || 'FBS Independents'); }
  const champs = conferenceChampions(feed.filter((g) => isCcgRow(g) || g.season_type === 'regular'), confOf);
  const champMap = new Map<string, number>();
  for (const c of champs) champMap.set(confOf.get(c)!, f.teams.indexOf(c));
  const field = selectField(cfpRulesFor(season), { order, conference: (t) => confOf.get(f.teams[t])!, champions: champMap, notreDame: f.teams.indexOf('Notre Dame') });
  const seeds = field.seeds.map((t) => f.teams[t]);
  T.eq(season + ': the real final ranking and champions give the real 12 seeds under ' + cfpRulesFor(season).id, seeds, EXPECT[season]);
  /* the feed's playoff games hold the bracket to its structure */
  const cfp = feed.filter((g) => /college football playoff/i.test(g.notes || ''));
  const fr = cfp.filter((g) => /first round/i.test(g.notes || ''));
  const seedOf = (n: string) => seeds.indexOf(n) + 1;
  T.chk(season + ': every first-round game in the feed is seed k hosting seed 17-k on its campus', fr.length === 4 && fr.every((g) => !g.neutral && seedOf(g.home) >= 5 && seedOf(g.home) <= 8 && seedOf(g.home) + seedOf(g.away) === 17),
    fr.map((g) => [g.home, seedOf(g.home), g.away, seedOf(g.away), g.neutral]));
  const qf = cfp.filter((g) => /quarterfinal/i.test(g.notes || ''));
  const frWinner = new Map(fr.map((g) => [seedOf(g.home), (g.home_points as number) > (g.away_points as number) ? g.home : g.away]));
  T.chk(season + ': every quarterfinal is a bye seed k (1-4) against the winner of seeds 9-k / 8+k at a neutral site', qf.length === 4 && qf.every((g) => {
    const top = [g.home, g.away].find((n) => seedOf(n) <= 4)!, other = [g.home, g.away].find((n) => n !== top)!;
    return g.neutral && frWinner.get(9 - seedOf(top)) === other;
  }), qf.map((g) => [g.home, seedOf(g.home), g.away, seedOf(g.away)]));
  const br = playBracket(field.seeds, (h, a) => {
    const g = cfp.find((x) => new Set([x.home, x.away]).has(f.teams[h]) && new Set([x.home, x.away]).has(f.teams[a]));
    if (!g) throw new Error(season + ': the bracket asks for a game the feed does not have: ' + f.teams[h] + ' v ' + f.teams[a]);
    const w = (g.home_points as number) > (g.away_points as number) ? g.home : g.away;
    return { winner: f.teams.indexOf(w), observed: true };
  });
  const title = cfp.find((g) => /national championship/i.test(g.notes || ''))!;
  T.eq(season + ': replaying the feed\'s results through the bracket reaches the real national champion', f.teams[br.champion], (title.home_points as number) > (title.away_points as number) ? title.home : title.away);
  T.chk(season + ': every simulated pairing exists in the feed (11 games, all observed)', br.games.length === 11 && br.games.every((g) => g.observed));
}

/* ---------------------------------------------------- SYNTHETIC 2026 clauses */
const R26 = CFP_RULES['CFP-2026'];
const conf = (labels: string[]) => (t: number) => labels[t];
/* 30 teams ranked in index order 0..29 */
function field26(labels: string[], champs: Record<string, number>, nd = -1, order?: number[]) {
  return selectField(R26, { order: order || labels.map((_, i) => i), conference: conf(labels), champions: new Map(Object.entries(champs)), notreDame: nd });
}
{
  const L: string[] = Array.from({ length: 30 }, (_, i) => (i < 20 ? 'SEC' : i < 25 ? 'Big Ten' : 'Sun Belt'));
  L[6] = 'Mountain West'; L[15] = 'Mid-American'; L[11] = 'ACC'; L[17] = 'Big 12';
  /* champions: SEC 0, Big Ten 21, ACC 11, Big 12 17; Mountain West's best team is #7 (index 6) and is NOT its champion (the champion is index 15? no: MAC) */
  const f = field26(L, { SEC: 0, 'Big Ten': 21, ACC: 11, 'Big 12': 17, 'Mountain West': 6, 'Mid-American': 15 });
  T.chk('2026: the four highest-ranked teams are seeds 1-4 whatever their conference titles (0, 1, 2, 3)', f.seeds.slice(0, 4).join() === '0,1,2,3', f.seeds);
  T.chk('2026: the Big Ten champion ranked 22nd is in, as is the Big 12 champion ranked 18th', f.seeds.includes(21) && f.seeds.includes(17));
  T.eq('2026: automatic qualifiers ranked outside the top 12 go to the bottom, in rank order (18th then 22nd)', f.seeds.slice(10), [17, 21]);
  T.chk('2026: the ACC champion ranked 12th stays in rank order inside the field', f.seeds.indexOf(11) === 9, f.seeds);
  /* five automatic qualifiers (0, 21, 11, 17 and the Mountain West's 7th-ranked team), seven at-large: the next seven by rank */
  T.eq('2026: the whole field and seed order', f.seeds, [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 17, 21]);
}
{
  /* the highest-ranked team of the American/CUSA/MAC/MW/Pac-12/Sun Belt gets the bid, champion or not */
  const L = Array.from({ length: 30 }, () => 'SEC');
  L[20] = 'American Athletic'; L[24] = 'American Athletic'; L[26] = 'Sun Belt';
  const f = field26(L, { SEC: 0, 'American Athletic': 24, 'Sun Belt': 26 });
  T.chk('2026: the bid goes to the highest-ranked team of those conferences (21st, not its 25th-ranked champion)', f.seeds.includes(20) && !f.seeds.includes(24) && !f.seeds.includes(26), f.seeds);
  T.eq('2026: that team is seeded 12th (outside the top 12)', f.seeds[11], 20);
  T.chk('2026: the reason is recorded', /highest-ranked team of/.test(f.reason.get(20) || ''), f.reason.get(20));
}
{
  /* Notre Dame: in when ranked in the top 12, even when automatic qualifiers outside the top 12 push the at-large line up */
  const L = Array.from({ length: 30 }, () => 'SEC');
  L[11] = 'FBS Independents'; L[18] = 'ACC'; L[19] = 'Big Ten'; L[20] = 'Big 12'; L[21] = 'Mountain West';
  const f = field26(L, { SEC: 0, ACC: 18, 'Big Ten': 19, 'Big 12': 20 }, 11);
  T.chk('2026: Notre Dame ranked 12th is in although four automatic qualifiers ranked 19-22 take places', f.seeds.includes(11), f.seeds);
  /* six automatic qualifiers (SEC 0, Notre Dame 11, ACC 18, Big Ten 19, Big 12 20, the Mountain West's 21): six at-large, ranks 2-7 */
  T.eq('2026: ... so the 7th-ranked team is the last at-large', f.seeds, [0, 1, 2, 3, 4, 5, 6, 11, 18, 19, 20, 21]);
  const g = field26(L, { SEC: 0, ACC: 18, 'Big Ten': 19, 'Big 12': 20 }, 12);
  T.chk('2026: Notre Dame ranked 13th gets no guarantee (an at-large place only if the line reaches it)', !g.seeds.includes(12), g.seeds);
}
{
  const L = Array.from({ length: 30 }, () => 'SEC');
  T.throws('2026: a field that cannot be filled is an error, never a short bracket', () => selectField(R26, { order: [0, 1, 2], conference: conf(L), champions: new Map(), notreDame: -1 }), /could not fill/);
}
/* 2024 rule: byes to the four highest-ranked CONFERENCE CHAMPIONS (Boise State 9th, Arizona State 12th) */
{
  const L = Array.from({ length: 30 }, () => 'SEC'); L[8] = 'Mountain West'; L[11] = 'Big 12'; L[2] = 'Big Ten'; L[15] = 'ACC';
  const f = selectField(CFP_RULES['CFP-2024'], { order: L.map((_, i) => i), conference: conf(L), champions: new Map([['SEC', 0], ['Big Ten', 2], ['Mountain West', 8], ['Big 12', 11], ['ACC', 15]]), notreDame: -1 });
  T.eq('2024 rules: the four highest-ranked champions are seeds 1-4', f.seeds.slice(0, 4), [0, 2, 8, 11]);
  const g = selectField(CFP_RULES['CFP-2025'], { order: L.map((_, i) => i), conference: conf(L), champions: new Map([['SEC', 0], ['Big Ten', 2], ['Mountain West', 8], ['Big 12', 11], ['ACC', 15]]), notreDame: -1 });
  T.eq('2025 rules: the four highest-ranked teams are seeds 1-4', g.seeds.slice(0, 4), [0, 1, 2, 3]);
}

/* ---------------------------------------------------- every bracket path */
{
  const seeds = Array.from({ length: 12 }, (_, i) => i + 1);    // team id = seed
  const seen: Array<[string, number, number, boolean]> = [];
  const fav = playBracket(seeds, (h, a, neutral, round, slot) => { seen.push([slot, h, a, neutral]); return { winner: Math.min(h, a), observed: false }; });
  T.eq('chalk: first round 8v9, 7v10, 6v11, 5v12 at the higher seed (not neutral)', seen.slice(0, 4), [['8v9', 8, 9, false], ['7v10', 7, 10, false], ['6v11', 6, 11, false], ['5v12', 5, 12, false]]);
  T.eq('chalk: quarterfinals 1v8, 2v7, 3v6, 4v5 at neutral sites', seen.slice(4, 8).map((x) => [x[1], x[2], x[3]]), [[1, 8, true], [2, 7, true], [3, 6, true], [4, 5, true]]);
  T.eq('chalk: semifinals 1v4 and 2v3, final 1v2', seen.slice(8).map((x) => [x[1], x[2]]), [[1, 4], [2, 3], [1, 2]]);
  T.eq('chalk: the reached sets', [fav.reached_qf.slice().sort((a, b) => a - b), fav.reached_sf, fav.reached_final, fav.champion], [[1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4], [1, 2], 1]);
  const seen2: Array<[string, number, number]> = [];
  const up = playBracket(seeds, (h, a, _n, _r, slot) => { seen2.push([slot, h, a]); return { winner: Math.max(h, a), observed: false }; });
  T.eq('upsets: no reseeding — 12 meets 4, 9 meets 1, and the semifinal pairs the 1/8/9 path with the 4/5/12 path', seen2.slice(4).map((x) => [x[1], x[2]]), [[1, 9], [2, 10], [3, 11], [4, 12], [9, 12], [10, 11], [11, 12]]);
  T.eq('upsets: champion 12', up.champion, 12);
  T.throws('a winner that did not play is refused', () => playBracket(seeds, (h) => ({ winner: h === 8 ? 99 : h, observed: false })), /not a participant/);
}
process.exitCode = T.done();
