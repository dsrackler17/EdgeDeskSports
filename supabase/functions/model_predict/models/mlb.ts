// ============================================================================
// EdgeDesk : model_predict / models / mlb   —   mlb_runs_v1.2_nbinom_dh
//
// THE BASELINE. This is the v1.2 model, moved behind the SportPredictionModel
// interface with its mathematics untouched. Every constant, every regression
// prior, every multiplier and the negative-binomial draw itself are the same
// values in the same order, and tests/mlb_regression.test.ts pins them.
//
// The two things that changed are structural, not numerical:
//   1. The uniform stream is injectable (core/rng.ts) so a run can be replayed.
//      Same distributions, same law — mulberry32 in place of Math.random.
//   2. Probable-pitcher fetches are prefetched under a concurrency cap instead
//      of awaited one game at a time. Same values, fewer round trips.
//
// ---------------------------------------------------------------------------
// FROM v1.0 -> v1.1: run counts are drawn from a NEGATIVE BINOMIAL, not Poisson.
//
// Measured over 55 graded games: model mean total 9.16, actual mean 9.35,
// market line 8.88, actual MEDIAN 8.00, and the market's own line split results
// 25 over / 29 under. The market line is calibrated and the model's mean is
// fine. The lean was never the mean — it was the SHAPE. Real MLB run totals are
// heavily right-skewed (mean 9.35 above median 8.00) because blowouts pull the
// mean up while most games land low. A sum of two Poissons is nearly symmetric,
// so v1.0 treated its mean as its median and computed P(over 8.88) near 52%
// when the honest answer is about 46% — twelve Over flags to one Under across a
// slate, which is a model artifact, not twelve findings.
//
// A negative binomial is a Poisson whose rate is itself Gamma-distributed: some
// nights the bullpen holds and some nights it does not. That is the actual
// generating process and it produces exactly the right skew.
//
// RUN_DISPERSION is variance/mean for team runs per game. 1.0 reproduces v1.0
// exactly. MEASURE IT from your own graded finals rather than taking a number
// on faith. MLB typically lands 1.5 to 2.0.
// ---------------------------------------------------------------------------
// ============================================================================

import type {
  DataContractEntry,
  EventContext,
  MarketContext,
  SignalRow,
  ModelContext,
  ModelDeps,
  ModelPrediction,
  PredictionRow,
  SkipEntry,
  SportPredictionModel,
  ValidationResult,
} from "../core/types.ts";
import { envNum } from "../core/db.ts";
import { matchKey, nrm } from "../core/names.ts";
import { claimEvent, duplicatePairEventCount, unmatchedEvents } from "../core/identity.ts";
import { buildMarketIndex } from "../core/market.ts";
import { negBinomial } from "../core/rng.ts";

export const MLB_MODEL_VERSION = "mlb_runs_v1.2_nbinom_dh";
export const MLB_SPORT_KEY = "baseball_mlb";

// ---- model tunables (v1.2 values, unchanged) -------------------------------
const N_SIM = 10000; // draws per game (trivial compute)
const IP_PRIOR_FIP = 50; // regress starter FIP toward league FIP
const G_PRIOR_OFF = 50; // regress team runs/game toward league
const IP_PRIOR_TEAM = 120; // light regression on team RA9 (bullpen proxy)
const DEFAULT_START_IP = 5.5;
const START_IP_MIN = 4.0;
const START_IP_MAX = 6.8;
const HOME_XR_MULT = 1.03; // home-field split: home xR up, away xR down, so a
const AWAY_XR_MULT = 0.975; // neutral matchup lands ~53.5% home. TUNABLE.

export function runDispersion(): number {
  return envNum("RUN_DISPERSION", 1.0);
}
export function matchWindowMs(): number {
  return envNum("MODEL_MATCH_WINDOW_MIN", 240) * 60000;
}

// ---- park run-environment factors (~1.0 neutral). Refresh yearly from Savant. ----
export const PARK: Record<string, number> = {
  coloradorockies: 1.14, bostonredsox: 1.06, cincinnatireds: 1.05, kansascityroyals: 1.03,
  arizonadiamondbacks: 1.03, philadelphiaphillies: 1.02, torontobluejays: 1.02, chicagocubs: 1.01,
  baltimoreorioles: 1.01, texasrangers: 1.01, atlantabraves: 1.01, washingtonnationals: 1.01,
  newyorkyankees: 1.01, chicagowhitesox: 1.01, minnesotatwins: 1.00, houstonastros: 1.00,
  milwaukeebrewers: 1.00, pittsburghpirates: 0.99, losangelesangels: 0.99, stlouiscardinals: 0.99,
  losangelesdodgers: 0.99, newyorkmets: 0.98, clevelandguardians: 0.98, miamimarlins: 0.97,
  detroittigers: 0.97, sandiegopadres: 0.95, sanfranciscogiants: 0.94, seattlemariners: 0.93,
  tampabayrays: 1.02, athletics: 1.04, oaklandathletics: 1.04, sacramentoathletics: 1.04,
};

/** StatsAPI innings come as "142.1" = 142 + 1/3, "142.2" = 142 + 2/3. */
export function parseIP(ip: unknown): number {
  if (ip == null) return 0;
  const s = String(ip);
  if (s.indexOf(".") < 0) return parseFloat(s) || 0;
  const [w, f] = s.split(".");
  const frac = f === "1" ? 1 / 3 : f === "2" ? 2 / 3 : 0;
  return (parseInt(w) || 0) + frac;
}

/** Aggregate a pitcher's season splits (mid-season trades produce several). */
export function aggPitcher(splits: any[]): { ip: number; k: number; bb: number; hbp: number; hr: number; gs: number } {
  let ip = 0, k = 0, bb = 0, hbp = 0, hr = 0, gs = 0;
  for (const sp of (splits || [])) {
    const st = sp.stat || {};
    ip += parseIP(st.inningsPitched);
    k += +st.strikeOuts || 0;
    bb += +st.baseOnBalls || 0;
    hbp += +st.hitByPitch || 0;
    hr += +st.homeRuns || 0;
    gs += +st.gamesStarted || 0;
  }
  return { ip, k, bb, hbp, hr, gs };
}

export interface MlbLeague {
  leagueRG: number;
  leagueERA: number;
  leagueRA9: number;
  cFIP: number;
  leagueFIP: number;
  r9_over_er9: number;
}

export interface MlbCtxData {
  season: string;
  league: MlbLeague;
  teamHit: Record<number, { r: number; g: number }>;
  teamPit: Record<number, { r: number; ip: number; er: number; k: number; bb: number; hbp: number; hr: number }>;
  pitCache: Record<number, { ip: number; k: number; bb: number; hbp: number; hr: number; gs: number }>;
  marketIndex: ReturnType<typeof buildMarketIndex>;
  dhMarketEvents: number;
  /** filled during predict, read by telemetryExtra */
  simTotalSum: number;
  simTotalN: number;
  simMedians: number[];
}

/** League constants from per-team season totals. Exported for the regression
 *  test, which feeds it fixed totals and pins the derived constants. */
export function leagueConstants(
  teamIds: number[],
  teamHit: MlbCtxData["teamHit"],
  teamPit: MlbCtxData["teamPit"],
): MlbLeague {
  let lgRS = 0, lgGP = 0, lgER = 0, lgR = 0, lgIP = 0, lgK = 0, lgBB = 0, lgHBP = 0, lgHR = 0;
  for (const id of teamIds) {
    const h = teamHit[id];
    if (h) { lgRS += h.r; lgGP += h.g; }
    const p = teamPit[id];
    if (p) {
      lgER += p.er; lgR += p.r; lgIP += p.ip;
      lgK += p.k; lgBB += p.bb; lgHBP += p.hbp; lgHR += p.hr;
    }
  }
  if (!lgGP || !lgIP) {
    throw new Error(
      "no team totals parsed (hit teams " + Object.keys(teamHit).length +
      " / pit teams " + Object.keys(teamPit).length + ")",
    );
  }
  const leagueRG = lgRS / lgGP;
  const leagueERA = lgER * 9 / lgIP;
  const leagueRA9 = lgR * 9 / lgIP;
  const leagueRawFIP = (13 * lgHR + 3 * (lgBB + lgHBP) - 2 * lgK) / lgIP;
  const cFIP = leagueERA - leagueRawFIP;
  const leagueFIP = leagueERA;
  const r9_over_er9 = leagueRA9 / leagueERA;

  if (leagueRG < 2 || leagueRG > 7 || leagueRA9 < 2.5 || leagueRA9 > 7) {
    throw new Error(
      "implausible league constants - RG=" + leagueRG.toFixed(2) +
      " RA9=" + leagueRA9.toFixed(2) + " (data shape check)",
    );
  }
  return { leagueRG, leagueERA, leagueRA9, cFIP, leagueFIP, r9_over_er9 };
}

export function offMult(d: MlbCtxData, id: number): number {
  const t = d.teamHit[id];
  if (!t || !t.g) return 1;
  const rsPg = t.r / t.g;
  const reg = (rsPg * t.g + d.league.leagueRG * G_PRIOR_OFF) / (t.g + G_PRIOR_OFF);
  return reg / d.league.leagueRG;
}

export function teamRA9reg(d: MlbCtxData, id: number): number {
  const t = d.teamPit[id];
  if (!t || !t.ip) return d.league.leagueRA9;
  const ra9 = t.r * 9 / t.ip;
  return (ra9 * t.ip + d.league.leagueRA9 * IP_PRIOR_TEAM) / (t.ip + IP_PRIOR_TEAM);
}

export function pitcherRate(d: MlbCtxData, id: number): { ra9: number; expIP: number } {
  const L = d.league;
  if (!id) return { ra9: L.leagueRA9, expIP: DEFAULT_START_IP };
  const p = d.pitCache[id];
  if (!p || p.ip < 1) return { ra9: L.leagueRA9, expIP: DEFAULT_START_IP };
  const rawFIP = (13 * p.hr + 3 * (p.bb + p.hbp) - 2 * p.k) / p.ip;
  const fip = rawFIP + L.cFIP;
  const fipReg = (fip * p.ip + L.leagueFIP * IP_PRIOR_FIP) / (p.ip + IP_PRIOR_FIP);
  const ra9 = fipReg * L.r9_over_er9;
  const expIP = p.gs >= 1
    ? Math.min(START_IP_MAX, Math.max(START_IP_MIN, p.ip / p.gs))
    : DEFAULT_START_IP;
  return { ra9, expIP };
}

/** Expected runs for both sides. Pure, so the regression test can pin it
 *  without a simulator, a network or a database. */
export function expectedRuns(
  d: MlbCtxData,
  hId: number,
  aId: number,
  hPid: number,
  aPid: number,
  homeName: string,
): { homeXR: number; awayXR: number; park: number } {
  const hp = pitcherRate(d, hPid);
  const ap = pitcherRate(d, aPid);
  const park = PARK[nrm(homeName)] ?? 1.0;
  const L = d.league;

  const homePrevRA9 = (hp.ra9 * hp.expIP + teamRA9reg(d, hId) * (9 - hp.expIP)) / 9;
  const awayPrevRA9 = (ap.ra9 * ap.expIP + teamRA9reg(d, aId) * (9 - ap.expIP)) / 9;
  const homePrevMult = homePrevRA9 / L.leagueRA9;
  const awayPrevMult = awayPrevRA9 / L.leagueRA9;

  const homeXR = L.leagueRG * offMult(d, hId) * awayPrevMult * park * HOME_XR_MULT;
  const awayXR = L.leagueRG * offMult(d, aId) * homePrevMult * park * AWAY_XR_MULT;
  return { homeXR, awayXR, park };
}

const CONTRACT: DataContractEntry[] = [
  { feature: "team runs scored / games played", source: "MLB StatsAPI /teams/{id}/stats?group=hitting", sourceClass: "AVAILABLE_NOW", updateFrequency: "daily", historicalDepth: "current season", reliability: "official", critical: true },
  { feature: "team runs allowed / IP / ER / K / BB / HBP / HR", source: "MLB StatsAPI /teams/{id}/stats?group=pitching", sourceClass: "AVAILABLE_NOW", updateFrequency: "daily", historicalDepth: "current season", reliability: "official", critical: true },
  { feature: "probable starters + season pitching line", source: "MLB StatsAPI /schedule?hydrate=probablePitcher, /people/{id}/stats", sourceClass: "AVAILABLE_NOW", updateFrequency: "hourly on game day", historicalDepth: "current season", reliability: "official", critical: true },
  { feature: "park run environment", source: "static PARK table in this module (Baseball Savant, refreshed yearly)", sourceClass: "AVAILABLE_NOW", updateFrequency: "yearly, manual", historicalDepth: "n/a", reliability: "hand-maintained", critical: false },
  { feature: "bullpen state (rest, taxed arms)", source: "public.mlb_pitcher_usage / mlb_bullpen_team", sourceClass: "AVAILABLE_FROM_EXISTING_PROVIDER", updateFrequency: "daily", historicalDepth: "season", reliability: "derived", critical: false },
  { feature: "weather / wind at first pitch", source: "public.weather_features, public.venue_weather", sourceClass: "AVAILABLE_FROM_EXISTING_PROVIDER", updateFrequency: "hourly", historicalDepth: "n/a", reliability: "NWS", critical: false },
  { feature: "lineup / rest-day regulars", source: "not ingested", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "n/a", critical: false },
];

export const MLBModel: SportPredictionModel & {
  telemetryExtra: (rows: PredictionRow[], ctx: ModelContext) => Record<string, unknown>;
} = {
  sportKey: MLB_SPORT_KEY,
  sportKeyPrefixes: [MLB_SPORT_KEY],
  uiLabel: "MLB",
  modelVersion: MLB_MODEL_VERSION,
  supportedMarkets: ["h2h", "totals"],
  dataContract: CONTRACT,

  /* v1.2 emitted h2h and totals and nothing else. Run lines are captured by the
     scanner but the simulator's margin distribution has never been validated
     against them, so spreads stay unsupported rather than becoming a number
     nobody checked. */
  supportsMarket(market: string): boolean {
    return market === "h2h" || market === "totals";
  },

  /* MLB's context is StatsAPI-only: the captured market plays no part in the
     league constants, so the signal rows are unused here and the index is built
     in buildEvents() where the claim ordering happens. */
  async loadContext(deps: ModelDeps, _marketRows: SignalRow[]): Promise<ModelContext> {
    const season = deps.etDate.slice(0, 4);
    const disp = runDispersion();
    if (!(disp >= 1) || disp > 4) {
      return {
        status: "error",
        detail: "RUN_DISPERSION out of range: " + disp + " (expected 1.0 to ~2.5)",
        missing: ["RUN_DISPERSION"],
      };
    }

    const teamsResp = await deps.jget(
      `https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${season}`,
    );
    const teamIds: number[] = (teamsResp?.teams || [])
      .filter((t: any) => t?.sport?.id === 1 && t?.active !== false && t?.id)
      .map((t: any) => t.id);
    if (teamIds.length < 20) {
      return { status: "error", detail: "team list short (" + teamIds.length + ") - check /teams shape", missing: ["teams"] };
    }

    const teamHit: MlbCtxData["teamHit"] = {};
    const teamPit: MlbCtxData["teamPit"] = {};
    await deps.pmap(teamIds, 8, async (id: number) => {
      try {
        const h = await deps.jget(`https://statsapi.mlb.com/api/v1/teams/${id}/stats?stats=season&group=hitting&season=${season}`);
        const hs = h?.stats?.[0]?.splits?.[0]?.stat;
        if (hs) teamHit[id] = { r: +hs.runs || 0, g: +hs.gamesPlayed || 0 };
      } catch (_) {
        /* leave team out; the league sum tolerates a miss and the shape check
           below catches a systemic failure. Recorded, not swallowed. */
        deps.log("mlb: team hitting fetch failed", { team_id: id });
      }
      try {
        const p = await deps.jget(`https://statsapi.mlb.com/api/v1/teams/${id}/stats?stats=season&group=pitching&season=${season}`);
        const ps = p?.stats?.[0]?.splits?.[0]?.stat;
        if (ps) {
          teamPit[id] = {
            r: +ps.runs || 0, ip: parseIP(ps.inningsPitched), er: +ps.earnedRuns || 0,
            k: +ps.strikeOuts || 0, bb: +ps.baseOnBalls || 0, hbp: +ps.hitBatsmen || 0, hr: +ps.homeRuns || 0,
          };
        }
      } catch (_) {
        deps.log("mlb: team pitching fetch failed", { team_id: id });
      }
    });

    let league: MlbLeague;
    try {
      league = leagueConstants(teamIds, teamHit, teamPit);
    } catch (e) {
      return { status: "error", detail: String((e as Error)?.message ?? e), missing: ["league_constants"] };
    }

    // Placeholder; the real index is built in buildEvents(), which is where the
    // claim ordering has to happen.
    const marketIndex = buildMarketIndex([]);
    const data: MlbCtxData = {
      season,
      league,
      teamHit,
      teamPit,
      pitCache: {},
      marketIndex,
      dhMarketEvents: 0,
      simTotalSum: 0,
      simTotalN: 0,
      simMedians: [],
    };
    return {
      status: "ok",
      dataAsOf: deps.now.toISOString(),
      featureSnapshotId: `mlb:${season}:${deps.etDate}`,
      data: data as unknown as Record<string, unknown>,
    };
  },

  /**
   * MLB is the one sport whose event universe is NOT the captured market: the
   * StatsAPI schedule is authoritative for what is being played, and the market
   * has to be joined onto it. That join is where the doubleheader bug lived, so
   * it goes through claimEvent — narrow by team pair, take the nearest
   * unclaimed first pitch, consume it.
   */
  async buildEvents(deps, marketRows, ctx) {
    const d = ctx.data as unknown as MlbCtxData;
    const idx = buildMarketIndex(marketRows);
    d.marketIndex = idx;
    d.dhMarketEvents = duplicatePairEventCount(idx);

    const sched = await deps.jget(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${deps.etDate}&hydrate=team,probablePitcher`,
    );
    const games = (sched?.dates?.[0]?.games) || [];
    /* Claim in first-pitch order so game 1 of a doubleheader claims the earlier
       market and game 2 the later one, rather than whichever the schedule
       happened to list first. */
    const ordered = [...games].sort((a: any, b: any) =>
      String(a.gameDate ?? "").localeCompare(String(b.gameDate ?? "")));

    const skipped: SkipEntry[] = [];
    const events: Array<{ event: EventContext; market: MarketContext }> = [];
    const window = matchWindowMs();

    for (const gm of ordered) {
      const st = gm.status?.abstractGameState;
      if (st && st !== "Preview") {
        skipped.push({ label: String(gm.gamePk), reason: "not_upcoming", detail: "abstractGameState=" + st });
        continue;
      }
      const H = gm.teams?.home, A = gm.teams?.away;
      const hId = H?.team?.id, aId = A?.team?.id;
      const hName = H?.team?.name, aName = A?.team?.name;
      const hPid = H?.probablePitcher?.id, aPid = A?.probablePitcher?.id;

      if (!hId || !aId) {
        skipped.push({ label: String(gm.gamePk), reason: "missing_participant", detail: "missing team id" });
        continue;
      }
      if (!hPid || !aPid) {
        skipped.push({ label: `${aName} @ ${hName}`, reason: "missing_probable_pitcher", detail: "gamePk " + gm.gamePk });
        continue;
      }

      const sg = claimEvent(idx.pairs, hName, aName, gm.gameDate ?? null, window);
      if (!sg || !sg.event_id) {
        skipped.push({
          label: `${aName} @ ${hName}`,
          reason: "event_match_failed",
          detail: `no captured market within ${Math.round(window / 60000)}m of first pitch (gamePk ${gm.gamePk}, game ${gm.gameNumber ?? "?"})`,
        });
        continue;
      }

      events.push({
        event: {
          event_id: sg.event_id,
          sport_key: MLB_SPORT_KEY,
          commence_time: sg.commence_time,
          home_team: sg.home_team,
          away_team: sg.away_team,
          extra: { hId, aId, hPid, aPid, gamePk: gm.gamePk, gameNumber: gm.gameNumber ?? null, homeName: hName },
        },
        market: { event: sg },
      });
    }

    // Prefetch every distinct probable starter once, under a concurrency cap.
    const pids = Array.from(new Set(events.flatMap((e) => [
      (e.event.extra as any).hPid as number,
      (e.event.extra as any).aPid as number,
    ]).filter(Boolean)));
    await deps.pmap(pids, 8, async (id: number) => {
      try {
        const r = await deps.jget(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=season&group=pitching&season=${d.season}`);
        d.pitCache[id] = aggPitcher(r?.stats?.[0]?.splits || []);
      } catch (_) {
        // A starter with no fetched line falls back to league-average rates,
        // exactly as v1.2 did. Recorded so the degradation is visible.
        d.pitCache[id] = { ip: 0, k: 0, bb: 0, hbp: 0, hr: 0, gs: 0 };
        deps.log("mlb: pitcher fetch failed, using league average", { pitcher_id: id });
      }
    });

    return { events, skipped, scheduled: games.length };
  },

  validateContext(event: EventContext, ctx: ModelContext): ValidationResult {
    if (ctx.status !== "ok") return { ok: false, reason: "model_context_failed", detail: ctx.detail };
    const x = event.extra as any;
    if (!x?.hId || !x?.aId) return { ok: false, reason: "missing_participant" };
    if (!x?.hPid || !x?.aPid) return { ok: false, reason: "missing_probable_pitcher" };
    return { ok: true };
  },

  async predict(event, market, ctx, deps): Promise<ModelPrediction[]> {
    const d = ctx.data as unknown as MlbCtxData;
    const x = event.extra as any;
    const sg = market.event;
    const disp = runDispersion();

    const { homeXR, awayXR, park } = expectedRuns(d, x.hId, x.aId, x.hPid, x.aPid, x.homeName);

    const line = sg.mainTotal?.point ?? null;
    let hw = 0, tie = 0, over = 0, under = 0, push = 0;
    const totals: number[] = [];
    for (let i = 0; i < N_SIM; i++) {
      const hr = negBinomial(deps.rng, homeXR, disp);
      const ar = negBinomial(deps.rng, awayXR, disp);
      if (hr > ar) hw++;
      else if (hr === ar) tie++;
      const t = hr + ar;
      totals.push(t);
      if (line != null) {
        if (t > line) over++;
        else if (t < line) under++;
        else push++;
      }
    }
    const pHome = (hw + 0.5 * tie) / N_SIM;
    const pAway = 1 - pHome;
    const pOver = line != null ? (over + 0.5 * push) / N_SIM : null;
    const pUnder = line != null ? (under + 0.5 * push) / N_SIM : null;

    totals.sort((a, b) => a - b);
    d.simMedians.push(totals[Math.floor(N_SIM / 2)]);
    d.simTotalSum += homeXR + awayXR;
    d.simTotalN++;

    const missing: string[] = [];
    if (!d.pitCache[x.hPid]?.ip) missing.push("home_starter_season_line");
    if (!d.pitCache[x.aPid]?.ip) missing.push("away_starter_season_line");
    if (PARK[nrm(x.homeName)] == null) missing.push("park_factor");
    missing.push("bullpen_state", "weather", "lineup");
    const quality = missing.length > 3 ? "LOW" : missing.length > 2 ? "MEDIUM" : "HIGH";

    const detail = {
      home_xr: +homeXR.toFixed(3),
      away_xr: +awayXR.toFixed(3),
      park_factor: +park.toFixed(3),
      run_dispersion: disp,
      n_sim: N_SIM,
      sim_median_total: totals[Math.floor(N_SIM / 2)],
      game_number: x.gameNumber,
      game_pk: x.gamePk,
    };

    const out: ModelPrediction[] = [];
    if (sg.h2hHome) out.push({ market: "h2h", selection: sg.home_team, point: null, model_prob: pHome, context_quality: quality, missing_features: missing, detail });
    if (sg.h2hAway) out.push({ market: "h2h", selection: sg.away_team, point: null, model_prob: pAway, context_quality: quality, missing_features: missing, detail });
    if (line != null && sg.mainTotal?.over) out.push({ market: "totals", selection: "Over", point: line, model_prob: pOver as number, context_quality: quality, missing_features: missing, detail });
    if (line != null && sg.mainTotal?.under) out.push({ market: "totals", selection: "Under", point: line, model_prob: pUnder as number, context_quality: quality, missing_features: missing, detail });
    return out;
  },

  /** v1.2's response blocks, preserved verbatim in shape so anything reading
   *  the MLB telemetry keeps working. */
  telemetryExtra(rows: PredictionRow[], ctx: ModelContext): Record<string, unknown> {
    const d = ctx.data as unknown as MlbCtxData | undefined;
    const homeH2h = rows.filter((r) => r.market === "h2h" && r.selection === r.home_team && r.model_edge != null);
    const he = homeH2h.map((r) => r.model_edge as number);
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const edge_summary = {
      h2h_games: he.length,
      mean_home_edge: +mean(he).toFixed(4),
      mean_abs_edge: +mean(he.map(Math.abs)).toFixed(4),
      max_abs_edge: he.length ? +Math.max(...he.map(Math.abs)).toFixed(4) : 0,
      pct_abs_gt_5pct: he.length ? +(he.filter((e) => Math.abs(e) > 0.05).length / he.length).toFixed(2) : 0,
    };

    const overFlags = rows.filter((r) => r.market === "totals" && r.selection === "Over" && (r.model_edge ?? 0) > 0).length;
    const underFlags = rows.filter((r) => r.market === "totals" && r.selection === "Under" && (r.model_edge ?? 0) > 0).length;
    const meds = (d?.simMedians ?? []).slice().sort((a, b) => a - b);
    const totals_summary = {
      run_dispersion: runDispersion(),
      sim_mean_total: d && d.simTotalN ? +(d.simTotalSum / d.simTotalN).toFixed(2) : null,
      sim_median_total: meds.length ? meds[Math.floor(meds.length / 2)] : null,
      over_flags: overFlags,
      under_flags: underFlags,
      note: "actuals over 55 graded games: mean 9.35, median 8.00, market split 25 over / 29 under",
    };

    const idx = d?.marketIndex;
    const doubleheaders = idx
      ? {
        dh_market_events: d!.dhMarketEvents,
        market_events: Object.keys(idx.byEvent).length,
        claimed_events: Object.values(idx.byEvent).filter((e) => e.claimed).length,
        unmatched_events: unmatchedEvents(idx).slice(0, 10),
        distinct_event_ids_predicted: new Set(rows.map((r) => r.event_id)).size,
      }
      : null;

    return {
      league: d
        ? {
          runs_per_game: +d.league.leagueRG.toFixed(3),
          RA9: +d.league.leagueRA9.toFixed(3),
          ERA: +d.league.leagueERA.toFixed(3),
          cFIP: +d.league.cFIP.toFixed(3),
        }
        : null,
      doubleheaders,
      edge_summary,
      totals_summary,
    };
  },
};

/** Re-exported so callers and tests keep one import site. */
export { buildMarketIndex, claimEvent, matchKey, nrm };
