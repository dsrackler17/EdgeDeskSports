// ============================================================================
// MLB regression: mlb_runs_v1.2_nbinom_dh must survive the refactor unchanged.
//
// The strongest evidence available is a REFERENCE IMPLEMENTATION: the v1.2
// formulas are transcribed here verbatim from the shipped function and the
// refactored module is required to agree with them to the last digit across a
// swept grid of inputs. That catches a transposed prior or a dropped multiplier
// in a way that a hand-picked expected value never would.
//
// The doubleheader behaviour that v1.2 exists to fix is exercised end to end
// against a fake StatsAPI and a fake signals table.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggPitcher,
  expectedRuns,
  leagueConstants,
  MLB_MODEL_VERSION,
  MLBModel,
  PARK,
  parseIP,
  type MlbCtxData,
} from "../supabase/functions/model_predict/models/mlb.ts";
import { negBinomial, makeRng, poisson } from "../supabase/functions/model_predict/core/rng.ts";
import { nrm } from "../supabase/functions/model_predict/core/names.ts";
import { eventRows, makeFakeDeps, mlbSchedule, mlbTeamPayloads } from "./helpers.ts";

// ---------------------------------------------------------------------------
// v1.2 REFERENCE IMPLEMENTATION — transcribed from the shipped function.
// Do not refactor. Its whole value is that it is a second, independent copy.
// ---------------------------------------------------------------------------
const REF = {
  IP_PRIOR_FIP: 50,
  G_PRIOR_OFF: 50,
  IP_PRIOR_TEAM: 120,
  DEFAULT_START_IP: 5.5,
  START_IP_MIN: 4.0,
  START_IP_MAX: 6.8,
  HOME_XR_MULT: 1.03,
  AWAY_XR_MULT: 0.975,
};

function refLeague(teamIds: number[], teamHit: any, teamPit: any) {
  let lgRS = 0, lgGP = 0, lgER = 0, lgR = 0, lgIP = 0, lgK = 0, lgBB = 0, lgHBP = 0, lgHR = 0;
  for (const id of teamIds) {
    const h = teamHit[id];
    if (h) { lgRS += h.r; lgGP += h.g; }
    const p = teamPit[id];
    if (p) { lgER += p.er; lgR += p.r; lgIP += p.ip; lgK += p.k; lgBB += p.bb; lgHBP += p.hbp; lgHR += p.hr; }
  }
  const leagueRG = lgRS / lgGP;
  const leagueERA = lgER * 9 / lgIP;
  const leagueRA9 = lgR * 9 / lgIP;
  const leagueRawFIP = (13 * lgHR + 3 * (lgBB + lgHBP) - 2 * lgK) / lgIP;
  const cFIP = leagueERA - leagueRawFIP;
  return { leagueRG, leagueERA, leagueRA9, cFIP, leagueFIP: leagueERA, r9_over_er9: leagueRA9 / leagueERA };
}

function refOffMult(L: any, teamHit: any, id: number) {
  const t = teamHit[id];
  if (!t || !t.g) return 1;
  const rsPg = t.r / t.g;
  const reg = (rsPg * t.g + L.leagueRG * REF.G_PRIOR_OFF) / (t.g + REF.G_PRIOR_OFF);
  return reg / L.leagueRG;
}

function refTeamRA9(L: any, teamPit: any, id: number) {
  const t = teamPit[id];
  if (!t || !t.ip) return L.leagueRA9;
  const ra9 = t.r * 9 / t.ip;
  return (ra9 * t.ip + L.leagueRA9 * REF.IP_PRIOR_TEAM) / (t.ip + REF.IP_PRIOR_TEAM);
}

function refPitcherRate(L: any, pitCache: any, id: number) {
  if (!id) return { ra9: L.leagueRA9, expIP: REF.DEFAULT_START_IP };
  const p = pitCache[id];
  if (!p || p.ip < 1) return { ra9: L.leagueRA9, expIP: REF.DEFAULT_START_IP };
  const rawFIP = (13 * p.hr + 3 * (p.bb + p.hbp) - 2 * p.k) / p.ip;
  const fip = rawFIP + L.cFIP;
  const fipReg = (fip * p.ip + L.leagueFIP * REF.IP_PRIOR_FIP) / (p.ip + REF.IP_PRIOR_FIP);
  const ra9 = fipReg * L.r9_over_er9;
  const expIP = p.gs >= 1
    ? Math.min(REF.START_IP_MAX, Math.max(REF.START_IP_MIN, p.ip / p.gs))
    : REF.DEFAULT_START_IP;
  return { ra9, expIP };
}

function refExpectedRuns(L: any, teamHit: any, teamPit: any, pitCache: any, hId: number, aId: number, hPid: number, aPid: number, homeName: string) {
  const hp = refPitcherRate(L, pitCache, hPid);
  const ap = refPitcherRate(L, pitCache, aPid);
  const park = PARK[nrm(homeName)] ?? 1.0;
  const homePrevRA9 = (hp.ra9 * hp.expIP + refTeamRA9(L, teamPit, hId) * (9 - hp.expIP)) / 9;
  const awayPrevRA9 = (ap.ra9 * ap.expIP + refTeamRA9(L, teamPit, aId) * (9 - ap.expIP)) / 9;
  const homePrevMult = homePrevRA9 / L.leagueRA9;
  const awayPrevMult = awayPrevRA9 / L.leagueRA9;
  return {
    homeXR: L.leagueRG * refOffMult(L, teamHit, hId) * awayPrevMult * park * REF.HOME_XR_MULT,
    awayXR: L.leagueRG * refOffMult(L, teamHit, aId) * homePrevMult * park * REF.AWAY_XR_MULT,
  };
}

// ---------------------------------------------------------------------------

function buildFixture() {
  const teamIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const teamHit: MlbCtxData["teamHit"] = {};
  const teamPit: MlbCtxData["teamPit"] = {};
  for (const id of teamIds) {
    teamHit[id] = { r: 620 + id * 14, g: 150 + (id % 5) };
    teamPit[id] = {
      r: 600 + id * 11, ip: 1330 + id * 7, er: 555 + id * 10,
      k: 1250 + id * 9, bb: 460 + id * 4, hbp: 55 + id, hr: 170 + id * 2,
    };
  }
  const pitCache: MlbCtxData["pitCache"] = {
    101: { ip: 150.1, k: 180, bb: 40, hbp: 6, hr: 18, gs: 25 },
    102: { ip: 42.2, k: 38, bb: 22, hbp: 3, hr: 9, gs: 8 },
    103: { ip: 0.2, k: 1, bb: 0, hbp: 0, hr: 0, gs: 1 },
    104: { ip: 200, k: 260, bb: 35, hbp: 4, hr: 14, gs: 31 },
    105: { ip: 90, k: 70, bb: 55, hbp: 9, hr: 22, gs: 0 },
  };
  const league = leagueConstants(teamIds, teamHit, teamPit);
  const d: MlbCtxData = {
    season: "2026", league, teamHit, teamPit, pitCache,
    marketIndex: { byEvent: {}, pairs: {} },
    dhMarketEvents: 0, simTotalSum: 0, simTotalN: 0, simMedians: [],
  };
  return { d, teamIds, teamHit, teamPit, pitCache };
}

test("league constants match the v1.2 reference exactly", () => {
  const { d, teamIds, teamHit, teamPit } = buildFixture();
  const ref = refLeague(teamIds, teamHit, teamPit);
  assert.equal(d.league.leagueRG, ref.leagueRG);
  assert.equal(d.league.leagueERA, ref.leagueERA);
  assert.equal(d.league.leagueRA9, ref.leagueRA9);
  assert.equal(d.league.cFIP, ref.cFIP);
  assert.equal(d.league.leagueFIP, ref.leagueFIP);
  assert.equal(d.league.r9_over_er9, ref.r9_over_er9);
});

test("expected runs match the v1.2 reference across a swept grid", () => {
  const { d, teamIds, teamHit, teamPit, pitCache } = buildFixture();
  const L = refLeague(teamIds, teamHit, teamPit);
  const parks = ["Colorado Rockies", "Seattle Mariners", "Athletics", "Some Unlisted Park"];
  const pids = [101, 102, 103, 104, 105, 0];
  let checked = 0;
  for (const hId of teamIds) {
    for (const aId of teamIds) {
      if (hId === aId) continue;
      for (const hPid of pids) {
        for (const aPid of pids) {
          const park = parks[(hId + aId + hPid + aPid) % parks.length];
          const got = expectedRuns(d, hId, aId, hPid, aPid, park);
          const want = refExpectedRuns(L, teamHit, teamPit, pitCache, hId, aId, hPid, aPid, park);
          assert.equal(got.homeXR, want.homeXR, `homeXR ${hId}/${aId}/${hPid}/${aPid}/${park}`);
          assert.equal(got.awayXR, want.awayXR, `awayXR ${hId}/${aId}/${hPid}/${aPid}/${park}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 3000, `swept ${checked} combinations`);
});

test("home-field split lands a neutral matchup near the MLB home rate", () => {
  const { d } = buildFixture();
  // identical teams, identical pitchers, neutral park
  d.teamHit[1] = { r: 700, g: 162 };
  d.teamHit[2] = { r: 700, g: 162 };
  d.teamPit[1] = { r: 700, ip: 1450, er: 645, k: 1350, bb: 480, hbp: 60, hr: 185 };
  d.teamPit[2] = { r: 700, ip: 1450, er: 645, k: 1350, bb: 480, hbp: 60, hr: 185 };
  const { homeXR, awayXR } = expectedRuns(d, 1, 2, 104, 104, "Minnesota Twins");
  assert.ok(homeXR > awayXR, "the home side is favoured");
  const rng = makeRng(4242);
  let hw = 0, tie = 0;
  const N = 40000;
  for (let i = 0; i < N; i++) {
    const h = negBinomial(rng, homeXR, 1.0);
    const a = negBinomial(rng, awayXR, 1.0);
    if (h > a) hw++; else if (h === a) tie++;
  }
  const p = (hw + 0.5 * tie) / N;
  assert.ok(p > 0.51 && p < 0.56, `neutral home win prob ${p.toFixed(4)} should sit near the MLB rate`);
});

test("parseIP handles the StatsAPI thirds notation", () => {
  assert.equal(parseIP("142.1"), 142 + 1 / 3);
  assert.equal(parseIP("142.2"), 142 + 2 / 3);
  assert.equal(parseIP("142"), 142);
  assert.equal(parseIP(null), 0);
  assert.equal(parseIP("142.0"), 142);
});

test("aggPitcher sums the splits a mid-season trade produces", () => {
  const got = aggPitcher([
    { stat: { inningsPitched: "80.1", strikeOuts: 90, baseOnBalls: 20, hitByPitch: 3, homeRuns: 8, gamesStarted: 13 } },
    { stat: { inningsPitched: "60.2", strikeOuts: 70, baseOnBalls: 15, hitByPitch: 2, homeRuns: 7, gamesStarted: 10 } },
  ]);
  assert.ok(Math.abs(got.ip - 141) < 1e-9, `ip ${got.ip}`);
  assert.equal(got.k, 160);
  assert.equal(got.gs, 23);
});

test("leagueConstants refuses implausible inputs instead of predicting on them", () => {
  assert.throws(() => leagueConstants([1], { 1: { r: 5000, g: 162 } }, { 1: { r: 700, ip: 1450, er: 645, k: 1, bb: 1, hbp: 1, hr: 1 } }), /implausible/);
  assert.throws(() => leagueConstants([1], {}, {}), /no team totals/);
});

// ---------------------------------------------------------------------------
// The negative binomial
// ---------------------------------------------------------------------------

test("dispersion 1.0 collapses the negative binomial to the v1.0 Poisson", () => {
  const a = makeRng(999);
  const b = makeRng(999);
  for (let i = 0; i < 500; i++) {
    assert.equal(negBinomial(a, 4.5, 1.0), poisson(b, 4.5), "same stream, same draw");
  }
});

test("dispersion above 1 adds right skew without moving the mean", () => {
  const N = 200000;
  const lam = 4.6;
  const draw = (disp: number) => {
    const rng = makeRng(20260815);
    const out: number[] = [];
    for (let i = 0; i < N; i++) out.push(negBinomial(rng, lam, disp));
    return out;
  };
  const stats = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const varr = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
    const sorted = xs.slice().sort((x, y) => x - y);
    return { mean, varr, median: sorted[Math.floor(xs.length / 2)] };
  };
  const p = stats(draw(1.0));
  const nb = stats(draw(1.8));
  assert.ok(Math.abs(p.mean - lam) < 0.05, `poisson mean ${p.mean}`);
  assert.ok(Math.abs(nb.mean - lam) < 0.05, `nbinom mean ${nb.mean} is unchanged`);
  assert.ok(nb.varr / nb.mean > 1.6, `variance/mean ${(nb.varr / nb.mean).toFixed(2)} reflects the dispersion`);
  assert.ok(nb.varr > p.varr * 1.5, "the extra variance is real");
  assert.ok(nb.median <= p.median, "the skew pulls the median below the mean");
});

test("a seed makes a run reproducible and a different seed does not", () => {
  const run = (seed: number) => {
    const rng = makeRng(seed);
    let hw = 0;
    for (let i = 0; i < 5000; i++) {
      if (negBinomial(rng, 4.6, 1.7) > negBinomial(rng, 4.4, 1.7)) hw++;
    }
    return hw;
  };
  assert.equal(run(12345), run(12345), "same seed, identical result");
  assert.notEqual(run(12345), run(54321), "a different seed explores a different stream");
});

// ---------------------------------------------------------------------------
// Doubleheaders, end to end
// ---------------------------------------------------------------------------

function mlbDeps(games: Parameters<typeof mlbSchedule>[0], signals: any[]) {
  const t = mlbTeamPayloads();
  return makeFakeDeps({
    tables: { "signals?": signals },
    http: {
      "/teams?sportId=1": t.teams,
      "group=hitting": t.hitting,
      "group=pitching&season": t.pitching,
      "/schedule?sportId=1": mlbSchedule(games),
      "/people/": { stats: [{ splits: [{ stat: { inningsPitched: "150.1", strikeOuts: 170, baseOnBalls: 42, hitByPitch: 5, homeRuns: 17, gamesStarted: 25 } }] }] },
    },
  });
}

test("a doubleheader produces two predictions on two distinct event_ids", async () => {
  const signals = [
    ...eventRows("evt-g1", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T17:10:00Z", { total: 8.5, sharpHome: 0.55 }),
    ...eventRows("evt-g2", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T23:40:00Z", { total: 9.5, sharpHome: 0.52 }),
  ];
  const deps = mlbDeps([
    { gamePk: 1, gameDate: "2026-08-15T17:10:00Z", home: "Chicago Cubs", away: "Milwaukee Brewers", homeId: 1, awayId: 2, gameNumber: 1 },
    { gamePk: 2, gameDate: "2026-08-15T23:40:00Z", home: "Chicago Cubs", away: "Milwaukee Brewers", homeId: 1, awayId: 2, gameNumber: 2 },
  ], signals);

  const ctx = await MLBModel.loadContext(deps, signals);
  assert.equal(ctx.status, "ok", ctx.detail);
  const built = await MLBModel.buildEvents(deps, signals, ctx);
  assert.equal(built.events.length, 2, "both games are assembled");
  assert.deepEqual(built.events.map((e) => e.event.event_id).sort(), ["evt-g1", "evt-g2"]);

  // game 1 gets the earlier market, game 2 the later one — not each other's
  const g1 = built.events.find((e) => (e.event.extra as any).gamePk === 1)!;
  const g2 = built.events.find((e) => (e.event.extra as any).gamePk === 2)!;
  assert.equal(g1.event.event_id, "evt-g1");
  assert.equal(g2.event.event_id, "evt-g2");
  assert.equal(g1.market.event.mainTotal?.point, 8.5);
  assert.equal(g2.market.event.mainTotal?.point, 9.5, "game 2 is priced on its own total");

  const p1 = await MLBModel.predict(g1.event, g1.market, ctx, deps);
  const p2 = await MLBModel.predict(g2.event, g2.market, ctx, deps);
  assert.equal(p1.filter((p) => p.market === "totals")[0].point, 8.5);
  assert.equal(p2.filter((p) => p.market === "totals")[0].point, 9.5);
});

test("a scheduled game with no captured market is skipped with a machine-readable reason", async () => {
  const signals = eventRows("evt-other", "Boston Red Sox", "New York Yankees", "2026-08-15T23:10:00Z");
  const deps = mlbDeps([
    { gamePk: 9, gameDate: "2026-08-15T23:05:00Z", home: "Miami Marlins", away: "Atlanta Braves", homeId: 3, awayId: 4 },
  ], signals);
  const ctx = await MLBModel.loadContext(deps, signals);
  const built = await MLBModel.buildEvents(deps, signals, ctx);
  assert.equal(built.events.length, 0);
  assert.equal(built.skipped[0].reason, "event_match_failed");
  assert.match(built.skipped[0].detail ?? "", /no captured market within \d+m of first pitch/);
});

test("a game without a probable pitcher is skipped, not predicted on a league-average arm", async () => {
  const signals = eventRows("evt-1", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T23:05:00Z");
  const deps = mlbDeps([
    { gamePk: 5, gameDate: "2026-08-15T23:05:00Z", home: "Chicago Cubs", away: "Milwaukee Brewers", homeId: 1, awayId: 2, homePid: null },
  ], signals);
  const ctx = await MLBModel.loadContext(deps, signals);
  const built = await MLBModel.buildEvents(deps, signals, ctx);
  assert.equal(built.events.length, 0);
  assert.equal(built.skipped[0].reason, "missing_probable_pitcher");
});

test("an in-progress game is not predicted", async () => {
  const signals = eventRows("evt-1", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T23:05:00Z");
  const deps = mlbDeps([
    { gamePk: 6, gameDate: "2026-08-15T23:05:00Z", home: "Chicago Cubs", away: "Milwaukee Brewers", homeId: 1, awayId: 2, state: "Live" },
  ], signals);
  const ctx = await MLBModel.loadContext(deps, signals);
  const built = await MLBModel.buildEvents(deps, signals, ctx);
  assert.equal(built.events.length, 0);
  assert.equal(built.skipped[0].reason, "not_upcoming");
});

test("MLB telemetry still reports doubleheader counts and unmatched events", async () => {
  const signals = [
    ...eventRows("evt-g1", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T17:10:00Z", { total: 8.5 }),
    ...eventRows("evt-g2", "Chicago Cubs", "Milwaukee Brewers", "2026-08-15T23:40:00Z", { total: 9.5 }),
    ...eventRows("evt-orphan", "Miami Marlins", "Atlanta Braves", "2026-08-15T22:40:00Z", { total: 8.0 }),
  ];
  const deps = mlbDeps([
    { gamePk: 1, gameDate: "2026-08-15T17:10:00Z", home: "Chicago Cubs", away: "Milwaukee Brewers", homeId: 1, awayId: 2, gameNumber: 1 },
    { gamePk: 2, gameDate: "2026-08-15T23:40:00Z", home: "Chicago Cubs", away: "Milwaukee Brewers", homeId: 1, awayId: 2, gameNumber: 2 },
  ], signals);
  const ctx = await MLBModel.loadContext(deps, signals);
  await MLBModel.buildEvents(deps, signals, ctx);
  const extra = MLBModel.telemetryExtra!([], ctx) as any;
  assert.equal(extra.doubleheaders.dh_market_events, 2);
  assert.equal(extra.doubleheaders.market_events, 3);
  assert.equal(extra.doubleheaders.claimed_events, 2);
  assert.equal(extra.doubleheaders.unmatched_events[0].event_id, "evt-orphan");
  assert.ok(extra.league.runs_per_game > 2 && extra.league.runs_per_game < 7);
  assert.ok(extra.totals_summary && extra.edge_summary, "the v1.2 summary blocks are still emitted");
});

test("the model version is unchanged", () => {
  assert.equal(MLB_MODEL_VERSION, "mlb_runs_v1.2_nbinom_dh");
  assert.equal(MLBModel.modelVersion, "mlb_runs_v1.2_nbinom_dh");
});
