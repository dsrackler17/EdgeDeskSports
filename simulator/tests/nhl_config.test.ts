/* The NHL 2026-27 configuration against the data: the alignment re-derived
   from the schedule itself, the club identities, the history alignments, the
   served model reproduced against the published slate, and the facts that
   block publication.  node simulator/tests/nhl_config.test.ts */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { nhlFixture } from './_fixture.ts';
import { NHL_TEAMS_2027, NHL_2027, nhlAlignment } from '../src/sports/nhl/config.ts';
import { isVerified } from '../src/sports/registry.ts';
import { REPO } from '../src/sports/nfl/model_adapter.ts';
import { hockeyWalkforward, dayNum } from '../src/sports/nhl/history.ts';

const require = createRequire(import.meta.url);
const T = kit('NHL 2026-27 configuration');
const D = nhlFixture().data;

/* ---- 1 the alignment, from how often each pair meets ---- */
{
  const n = new Map<string, number>();
  for (const g of D.games) { const k = [g.home, g.away].sort().join('-'); n.set(k, (n.get(k) || 0) + 1); }
  const codes = NHL_TEAMS_2027.map((t) => t.code);
  /* divisions = connected components of pairs that meet four times; conferences = of pairs that meet at least three */
  const comps = (min: number) => {
    const parent: Record<string, string> = {}; codes.forEach((c) => { parent[c] = c; });
    const find = (x: string): string => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const [k, v] of n) if (v >= min) { const [a, b] = k.split('-'); parent[find(a)] = find(b); }
    const g: Record<string, string[]> = {}; codes.forEach((c) => { (g[find(c)] = g[find(c)] || []).push(c); });
    return Object.values(g).map((x) => x.sort().join(' ')).sort();
  };
  const cfgDiv = Object.values(NHL_TEAMS_2027.reduce((a, t) => { (a[t.division] = a[t.division] || []).push(t.code); return a; }, {} as Record<string, string[]>)).map((x) => x.sort().join(' ')).sort();
  const cfgConf = Object.values(NHL_TEAMS_2027.reduce((a, t) => { (a[t.conference] = a[t.conference] || []).push(t.code); return a; }, {} as Record<string, string[]>)).map((x) => x.sort().join(' ')).sort();
  T.eq('divisions re-derived from the schedule (pairs meeting 4 times) equal the configured divisions', comps(4), cfgDiv);
  T.eq('conferences re-derived from the schedule (pairs meeting 3+ times) equal the configured conferences', comps(3), cfgConf);
  T.eq('meeting counts: 112 pairs x4 (division), 128 x3 (conference), 256 x2 (cross-conference)', [4, 3, 2].map((k) => [...n.values()].filter((v) => v === k).length), [112, 128, 256]);
  T.eq('84 games per club, 42 at home: the schedule\'s own length (1,344 games)', [D.games.length, NHL_2027.regular_season_games_per_club], [1344, 84]);
  T.chk('four divisions of eight, two per conference', cfgDiv.length === 4 && cfgDiv.every((d) => d.split(' ').length === 8) && cfgConf.length === 2);
}
/* ---- 2 club identities: the hockey identity table's active clubs ---- */
{
  const teams = JSON.parse(fs.readFileSync(path.join(REPO, 'hockey', 'data', 'teams.json'), 'utf8')).teams;
  const active = Object.keys(teams).filter((k) => !teams[k].inactive_since).sort();
  T.eq('the 32 configured codes are hockey/data/teams.json\'s active clubs', NHL_TEAMS_2027.map((t) => t.code).sort(), active);
  T.chk('names agree with the identity table', NHL_TEAMS_2027.every((t) => teams[t.code].name === t.name));
  T.eq('the 2025-26 alignment (Utah in the Central) is the 2026-27 alignment', Object.fromEntries(Object.entries(nhlAlignment(2026)).sort(([a], [b]) => a.localeCompare(b)).map(([d, c]) => [d, c.slice().sort()])),
    Object.fromEntries(['Atlantic', 'Central', 'Metropolitan', 'Pacific'].map((d) => [d, NHL_TEAMS_2027.filter((t) => t.division === d).map((t) => t.code).sort()])));
  T.throws('no alignment is replayed for the 2019-20 and 2020-21 emergency formats', () => nhlAlignment(2021), /temporary format/);
}
/* ---- 3 the served model, reproduced: the slate's own games re-priced by the snapshot's code path ---- */
{
  const slate = JSON.parse(fs.readFileSync(path.join(REPO, 'hockey', 'slate.json'), 'utf8'));
  const live = require(path.join(REPO, 'hockey', 'model', 'params', 'live.json'));
  const GLM = require(path.join(REPO, 'hockey', 'model', 'glm.js'));
  const W = hockeyWalkforward();
  const through = slate.readiness && slate.readiness.data && slate.readiness.data.latest_completed_game;
  if (!through || slate.model.params_generated_at !== live.generated_at) {
    /* the slate is rebuilt by its own pipeline; until it is, its prices come from other parameters and cannot be compared */
    console.log('NOTE: hockey/slate.json was priced with live.json of ' + slate.model.params_generated_at + ', not the current ' + live.generated_at + ': re-price comparison not possible until the slate is rebuilt.');
  } else {
    const seasons: number[] = []; for (let s = 2011; s <= live.for_season; s++) seasons.push(s);
    const { rows, games } = W.loadGames(seasons);
    const P = W.seasonParams(rows, seasons, false);
    const { state: rs } = W.ratingsPass(games.filter((g: any) => g.date <= through), P, live.ratings, null);
    let worst = 0, n = 0;
    for (const g of slate.games.slice().sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
      const fh = rs.snapshot(g.home, g.away, true, g.date, null), fa = rs.snapshot(g.away, g.home, false, g.date, null);
      const bh = g.evidence.home.back_to_back ? 1 : 0, ba = g.evidence.away.back_to_back ? 1 : 0;
      fh.b2b = bh; fh.b2b_opp = ba; fa.b2b = ba; fa.b2b_opp = bh;
      const c = GLM.applyPairCalibration(GLM.predict(live.glm[live.model], fh), GLM.predict(live.glm[live.model], fa), live.pair_calibration[live.model]);
      worst = Math.max(worst, Math.abs(c.lh - g.lambda.home), Math.abs(c.la - g.lambda.away)); n++;
    }
    T.chk('every slate game (' + n + ') re-priced by the snapshot\'s path matches the slate\'s λ to its 4-decimal rounding', n > 0 && worst <= 5.1e-5, worst);
  }
  const first = D.games.filter((g) => !g.done && g.date === D.as_of.ratings_day);
  const onSlate = first.filter((g) => slate.games.some((s: any) => s.game_id === g.game_id && s.date === g.date));
  const dl = onSlate.map((g) => { const s = slate.games.find((x: any) => x.game_id === g.game_id); return Math.max(Math.abs(s.lambda.home - g.model!.lam_home), Math.abs(s.lambda.away - g.model!.lam_away)); });
  T.chk('the fixture\'s first-day games are priced exactly as the slate priced them when both share the ratings (or the slate has moved on)', dl.every((x) => x <= 5.1e-5) || slate.readiness.data.latest_completed_game !== D.as_of.ratings_through, dl);
  T.eq('the snapshot prices with the chosen model of live.json', D.model.chosen, live.model);
  T.chk('back-to-back flags come from the schedule (the second of consecutive days)', D.games.filter((g) => !g.done).every((g) => {
    const prev = (t: string) => Math.max(-1, ...D.games.filter((x) => (x.home === t || x.away === t) && dayNum(x.date) < dayNum(g.date)).map((x) => dayNum(x.date)));
    return g.model!.b2b_home === (dayNum(g.date) - prev(g.home) === 1 ? 1 : 0) && g.model!.b2b_away === (dayNum(g.date) - prev(g.away) === 1 ? 1 : 0);
  }));
}
/* ---- 4 the facts that block publication ---- */
{
  for (const [k, f] of [['rules', NHL_2027.rules], ['playoff_format', NHL_2027.playoff_format], ['home_ice', NHL_2027.home_ice]] as const) {
    T.chk(k + ' affects results, names a source, and is not verified (no verifier, no date)', f.affects_results && f.source.length > 40 && !isVerified(f) && f.verified_by === null);
  }
  T.chk('a fact with VERIFIED but no verifier does not count', !isVerified({ ...NHL_2027.rules, verification: 'VERIFIED' }));
  T.chk('availability: confirmed starters only, with the baseline stated', NHL_2027.availability.mode === 'confirmed_starters_only' && /No starting goalie is assumed/.test(NHL_2027.availability.baseline));
  T.eq('drift is off', NHL_2027.drift.mode, 'off');
}
process.exit(T.done());
