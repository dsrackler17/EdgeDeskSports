/* The NFL rules engine against REAL history (simulator/fixtures/nfl_history.json.gz,
   nflverse/nfldata): for every season 2002-2025 the standings, strength of
   victory and schedule, every division rank and every playoff seed are
   recomputed from the game results alone and compared with the published
   values; the wild card pairings and the reseeded divisional round are
   compared with the postseason games actually played.
   node simulator/tests/nfl_rules_history.test.ts */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { kit } from './_kit.ts';
import { League, Standings, seedConferences, rulesFor, type NflTeam, type NflGame } from '../src/sports/nfl/rules.ts';
import { streamFor, STREAM } from '../src/core/prng.ts';

const T = kit('NFL rules vs history 2002-2025');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'nfl_history.json.gz'))).toString('utf8'));

interface FxTeam { code: string; conference: 'AFC' | 'NFC'; division: string; wins: number; losses: number; ties: number; scored: number; allowed: number; sov: number; sos: number; div_rank: number; seed: number | null }

const stepUse: Record<string, number> = {};
let coinTosses = 0, unsupported = 0, seasonsChecked = 0;
const sovConventions: Record<string, string> = {};
for (const season of Object.keys(FX.seasons).sort()) {
  const y = +season, S = FX.seasons[season];
  const rules = rulesFor(y);
  const fxTeams: FxTeam[] = S.teams;
  const teams: NflTeam[] = fxTeams.map((t) => ({ code: t.code, name: t.code, conference: t.conference, division: t.division }));
  const idx: Record<string, number> = {}; teams.forEach((t, i) => { idx[t.code] = i; });
  const games: NflGame[] = S.regular.map((g: [string, number, string, string, number, number]) => {
    if (idx[g[2]] == null || idx[g[3]] == null) throw new Error(season + ': unknown club in ' + g[0]);
    return { game_id: g[0], week: g[1], home: idx[g[2]], away: idx[g[3]], done: true, home_score: g[4], away_score: g[5], home_td: null, away_td: null };
  });
  const L = new League(teams, games);
  const margin = new Int16Array(games.map((g) => (g.home_score as number) - (g.away_score as number)));
  const home = new Int16Array(games.map((g) => g.home_score as number)), away = new Int16Array(games.map((g) => g.away_score as number));
  const flags: string[] = [];
  const ctx = {
    rng: streamFor(BigInt(y), 0, STREAM.coin),
    diag(k: string) { stepUse[k] = (stepUse[k] || 0) + 1; if (k.endsWith('coin_toss')) coinTosses++; },
    flag(k: string) { flags.push(k); if (k === 'tiebreak_unsupported_input') unsupported++; },
    trace() {}
  };
  const st = new Standings(L, { margin, points: () => ({ home, away }) }, ctx);
  /* the record, the points and the strength measures */
  const recBad = fxTeams.filter((t, i) => st.w2[i] !== 2 * t.wins + t.ties || st.gp[i] !== t.wins + t.losses + t.ties);
  T.chk(season + ': every record matches', recBad.length === 0, recBad.map((t) => t.code));
  const P = st.pointsTotals()!;
  T.chk(season + ': points scored and allowed match', fxTeams.every((t, i) => P.pf[i] === t.scored && P.pa[i] === t.allowed));
  /* strength of victory / schedule. The engine follows the rule text: a tie is
     half a win, and "combined" is the aggregate record (sum of wins over sum of
     games). An independent reference of exactly that is computed here from the
     raw results. nflverse's published figures use one of three conventions,
     season by season (ties as half or as zero; aggregate, or an average of
     opponents' percentages in 2022, the one season with unequal game counts):
     the published value must match one of them, and which one is reported. */
  const W2: number[] = new Array(32).fill(0), GP: number[] = new Array(32).fill(0), W0: number[] = new Array(32).fill(0);
  games.forEach((g) => { const d = (g.home_score as number) - (g.away_score as number); GP[g.home]++; GP[g.away]++;
    if (d > 0) { W2[g.home] += 2; W0[g.home]++; } else if (d < 0) { W2[g.away] += 2; W0[g.away]++; } else { W2[g.home]++; W2[g.away]++; } });
  const conv = (t: number, kind: 'half_agg' | 'zero_agg' | 'half_avg') => {
    let sn = 0, sd = 0, vn = 0, vd = 0; const sp: number[] = [], vp: number[] = [];
    games.forEach((g) => {
      const o = g.home === t ? g.away : g.away === t ? g.home : -1; if (o < 0) return;
      const n = kind === 'zero_agg' ? W0[o] : W2[o] / 2, d = GP[o];
      sn += n; sd += d; sp.push(n / d);
      const won = (g.home === t && (g.home_score as number) > (g.away_score as number)) || (g.away === t && (g.away_score as number) > (g.home_score as number));
      if (won) { vn += n; vd += d; vp.push(n / d); }
    });
    if (kind === 'half_avg') return { sos: sp.reduce((a, b) => a + b, 0) / sp.length, sov: vp.length ? vp.reduce((a, b) => a + b, 0) / vp.length : 0 };
    return { sos: sn / sd, sov: vd ? vn / vd : 0 };
  };
  const offRule = teams.filter((_, i) => { const r = conv(i, 'half_agg'); return Math.abs(r.sov - st.sov(i)) > 1e-12 || Math.abs(r.sos - st.sos(i)) > 1e-12; });
  T.chk(season + ': SOV and SOS equal the rule text (ties half, combined record), independently computed', offRule.length === 0, offRule.map((t) => t.code));
  const used = (['half_agg', 'zero_agg', 'half_avg'] as const).filter((k) => fxTeams.every((t, i) => { const r = conv(i, k); return Math.abs(r.sov - t.sov) <= 6e-7 && Math.abs(r.sos - t.sos) <= 6e-7; }));
  T.chk(season + ': nflverse\'s published SOV/SOS match one stated convention', used.length > 0, used);
  sovConventions[season] = used.join('|');
  /* division ranks and seeds */
  const seeds = seedConferences(st, rules);
  const dBad = fxTeams.filter((t, i) => st.divRankPos[i] + 1 !== t.div_rank);
  T.chk(season + ': every division rank matches', dBad.length === 0, dBad.map((t) => [t.code, t.div_rank, st.divRankPos[idx[t.code]] + 1]));
  const seedOf: Record<string, number> = {};
  seeds.forEach((c) => c.seeds.forEach((t, k) => { seedOf[teams[t].code] = k + 1; }));
  const sdBad = fxTeams.filter((t) => (t.seed || null) !== (seedOf[t.code] || null));
  T.chk(season + ': every playoff seed matches', sdBad.length === 0, sdBad.map((t) => [t.code, t.seed, seedOf[t.code]]));
  T.chk(season + ': ' + rules.playoff_clubs_per_conference + ' seeds per conference', seeds.every((c) => c.seeds.length === rules.playoff_clubs_per_conference));
  /* the postseason actually played: wild card pairings by seed, home = better seed (neutral SB aside) */
  const post = S.postseason as Array<[string, string, string, string, number, number, string]>;
  const wc = post.filter((g) => g[1] === 'WC');
  const pairsOk = wc.every((g) => {
    const h = seedOf[g[2]], a = seedOf[g[3]];
    return h != null && a != null && h < a && rules.wild_card_pairs.some(([x, z]) => x === h && z === a);
  });
  T.chk(season + ': the wild card games played are the seeded pairings, at the better seed', pairsOk && wc.length === 2 * rules.wild_card_pairs.length, wc.map((g) => [g[2], seedOf[g[2]], g[3], seedOf[g[3]]]));
  /* the divisional round is reseeded: the top seed hosts the lowest seed left */
  const div = post.filter((g) => g[1] === 'DIV');
  const winnerOf = (g: [string, string, string, string, number, number, string]) => (g[4] > g[5] ? g[2] : g[3]);
  for (const conf of ['AFC', 'NFC']) {
    const inConf = (c: string) => fxTeams.find((t) => t.code === c)!.conference === conf;
    const alive = seeds[conf === 'AFC' ? 0 : 1].seeds.slice(0, rules.byes_per_conference).map((t) => teams[t].code)
      .concat(wc.filter((g) => inConf(g[2])).map(winnerOf)).sort((a, b) => seedOf[a] - seedOf[b]);
    const top = div.find((g) => inConf(g[2]) && g[2] === alive[0]);
    T.chk(season + ' ' + conf + ': the best remaining seed hosted the lowest remaining seed', !!top && top[3] === alive[3], { alive, top });
  }
  seasonsChecked++;
}
T.eq('every season 2002-2025 was checked', seasonsChecked, 24);
T.chk('no historical tie needed an input the engine lacks', unsupported === 0, unsupported);
const deep = Object.keys(stepUse).filter((k) => /combined_rank|net_points|net_touchdowns|coin_toss/.test(k));
process.exit(T.done('tiebreak steps used across 24 seasons: ' + JSON.stringify(stepUse) + (deep.length ? ' | deep steps: ' + deep.join(', ') : '') + ' | coin tosses: ' + coinTosses + ' | nflverse SOV/SOS convention by season: ' + JSON.stringify(sovConventions)));
