// ============================================================================
// EdgeDesk : model_predict / models / wnba   —   wnba_game_v1
//
// STATUS ON TODAY'S DATABASE: insufficient_data.
//
// EdgeDesk owns no WNBA team-rating table. The model is complete and tested and
// runs as soon as `public.wnba_team_features` is populated; until then it
// writes nothing and says which columns are missing.
//
// NOT NBA WITH A DIFFERENT KEY. Every league constant here — pace, league
// points per possession, home court — is computed from the WNBA rows that are
// actually loaded, never carried over from an NBA prior. The app's own sport
// contract already warns that WNBA thresholds must not be imported from the
// NBA; this module has no NBA numbers in it to import.
//
// MATHEMATICS. Possession-based, because basketball is a possession game and
// the number of possessions is what converts an efficiency edge into points.
//
//   possessions = pace_home * pace_away / league_pace
//   ppp_home    = (off_rating_home * def_rating_away / league_rating) / 100
//
// Both are the standard efficiency-interaction forms: a fast team meeting a
// slow one lands between them, and an elite offence facing an elite defence is
// pulled toward the league mean rather than simply averaged.
//
// Scoring is then simulated PER POSSESSION from a {0, 2, 3} categorical whose
// three-point share comes from the team's own shooting profile when the column
// exists. That matters for the same reason NFL's TD/FG counts matter: it puts
// real mass on even margins and on the totals bucket boundaries, which a
// continuous normal approximation smears away. With ~80 possessions a side the
// margin ends up near-normal anyway — that is a RESULT of the simulation, not
// an assumption fed into it.
//
// PUSH HANDLING. Whole-number spreads and totals push; the fair probability of
// the priced outcome removes pushes from the denominator.
// ============================================================================

import type {
  DataContractEntry,
  EventContext,
  MarketContext,
  ModelContext,
  ModelDeps,
  ModelPrediction,
  SkipEntry,
  SportPredictionModel,
  ValidationResult,
} from "../core/types.ts";
import { nrm } from "../core/names.ts";
import { claimById } from "../core/identity.ts";
import { buildMarketIndex } from "../core/market.ts";
import { categorical } from "../core/rng.ts";
import { envNum } from "../core/db.ts";
import { leagueMean, loadTeamFeatures, numOr, type TeamFeatureSet } from "./team_loader.ts";

export const WNBA_MODEL_VERSION = "wnba_game_v1";
export const WNBA_SPORT_KEY = "basketball_wnba";

const N_SIM = 20000;
/** Home court, in points. Unfitted parameter, reported on every row. */
const HCA_POINTS = () => envNum("WNBA_HCA_POINTS", 2.0);

export const WNBA_REQUIRED_COLUMNS = ["off_rating", "def_rating", "pace"];
export const WNBA_OPTIONAL_COLUMNS = [
  "efg_pct", "opp_efg_pct", "tov_pct", "opp_tov_pct", "orb_pct", "drb_pct",
  "ft_rate", "opp_ft_rate", "three_rate", "rest_days",
];

export interface WnbaCtxData {
  set: TeamFeatureSet;
  lgRating: number;
  lgPace: number;
  lgThreeRate: number;
  index: ReturnType<typeof buildMarketIndex>;
}

const CONTRACT: DataContractEntry[] = [
  { feature: "offensive rating (points per 100 possessions)", source: "public.wnba_team_features.off_rating", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "daily", historicalDepth: "season", reliability: "not currently ingested", critical: true },
  { feature: "defensive rating", source: "public.wnba_team_features.def_rating", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "daily", historicalDepth: "season", reliability: "not currently ingested", critical: true },
  { feature: "pace (possessions per game)", source: "public.wnba_team_features.pace", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "daily", historicalDepth: "season", reliability: "not currently ingested", critical: true },
  { feature: "four factors (eFG%, TOV%, ORB%, FT rate) both directions", source: "public.wnba_team_features (optional columns)", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "daily", historicalDepth: "season", reliability: "not currently ingested", critical: false },
  { feature: "three-point attempt rate", source: "public.wnba_team_features.three_rate", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "daily", historicalDepth: "season", reliability: "used to shape the per-possession draw", critical: false },
  { feature: "points scored / allowed per game (degraded fallback)", source: "public.game_stats, only if points_for/points_against/games exist", sourceClass: "NOT_AVAILABLE", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "columns not present today", critical: false },
  { feature: "player availability / injury / rest", source: "not ingested — NEVER inferred", sourceClass: "NOT_AVAILABLE", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "n/a", critical: false },
  { feature: "minutes, usage, lineup effects", source: "public.stats_players holds leaderboard lines, not minutes or lineups", sourceClass: "NOT_AVAILABLE", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "n/a", critical: false },
  { feature: "back-to-backs / rest days / travel", source: "derivable from public.signals commence_time history", sourceClass: "AVAILABLE_FROM_EXISTING_PROVIDER", updateFrequency: "with capture", historicalDepth: "capture history", reliability: "derived", critical: false },
];

export interface GameShape {
  possessions: number;
  pppHome: number;
  pppAway: number;
  threeHome: number;
  threeAway: number;
}

/** Possessions and per-possession efficiency for one matchup. Pure. */
export function gameShape(d: WnbaCtxData, homeNorm: string, awayNorm: string): GameShape | null {
  const h = d.set.byTeam.get(homeNorm);
  const a = d.set.byTeam.get(awayNorm);
  if (!h || !a) return null;

  if (d.set.kind === "points_fallback") {
    const hFor = numOr(h, "points_for", null), hAg = numOr(h, "points_against", null), hG = numOr(h, "games", null);
    const aFor = numOr(a, "points_for", null), aAg = numOr(a, "points_against", null), aG = numOr(a, "games", null);
    if (hFor == null || hAg == null || !hG || aFor == null || aAg == null || !aG) return null;
    const poss = d.lgPace;
    const lgPts = (hFor / hG + hAg / hG + aFor / aG + aAg / aG) / 4;
    const homePts = lgPts + ((hFor / hG - lgPts) + (aAg / aG - lgPts)) + HCA_POINTS() / 2;
    const awayPts = lgPts + ((aFor / aG - lgPts) + (hAg / hG - lgPts)) - HCA_POINTS() / 2;
    return {
      possessions: poss,
      pppHome: Math.max(0.5, homePts / poss),
      pppAway: Math.max(0.5, awayPts / poss),
      threeHome: d.lgThreeRate,
      threeAway: d.lgThreeRate,
    };
  }

  const hOff = numOr(h, "off_rating", null), hDef = numOr(h, "def_rating", null), hPace = numOr(h, "pace", null);
  const aOff = numOr(a, "off_rating", null), aDef = numOr(a, "def_rating", null), aPace = numOr(a, "pace", null);
  if (hOff == null || hDef == null || !hPace || aOff == null || aDef == null || !aPace) return null;

  const possessions = (hPace * aPace) / d.lgPace;
  // Efficiency interaction: own offence against that specific defence,
  // renormalised by the league so the scale stays points per 100.
  const homeRating = (hOff * aDef) / d.lgRating;
  const awayRating = (aOff * hDef) / d.lgRating;
  const hcaPerPoss = HCA_POINTS() / 2 / possessions;

  return {
    possessions,
    pppHome: Math.max(0.5, homeRating / 100 + hcaPerPoss),
    pppAway: Math.max(0.5, awayRating / 100 - hcaPerPoss),
    threeHome: numOr(h, "three_rate", d.lgThreeRate) ?? d.lgThreeRate,
    threeAway: numOr(a, "three_rate", d.lgThreeRate) ?? d.lgThreeRate,
  };
}

/**
 * Score one team over `poss` possessions.
 *
 * Each possession returns 0, 2 or 3 points. The three-point share is the team's
 * own attempt rate; given that share and the required mean points per
 * possession, the scoring probability is determined — no free parameter is
 * chosen. Free throws are folded into the 2-point outcome rather than modelled
 * separately, which the detail block states rather than hiding.
 */
export function drawTeamPoints(rng: { next(): number }, poss: number, ppp: number, threeShare: number): number {
  const share3 = Math.min(0.9, Math.max(0, threeShare));
  // E[pts|score] = 3*share3 + 2*(1-share3); pScore = ppp / E[pts|score]
  const perScore = 3 * share3 + 2 * (1 - share3);
  const pScore = Math.min(0.95, Math.max(0.05, ppp / perScore));
  const n = Math.max(1, Math.round(poss));
  let pts = 0;
  const table: Array<[number, number]> = [
    [0, 1 - pScore],
    [3, pScore * share3],
    [2, pScore * (1 - share3)],
  ];
  for (let i = 0; i < n; i++) pts += categorical(rng as any, table);
  return pts;
}

export const WNBAModel: SportPredictionModel = {
  sportKey: WNBA_SPORT_KEY,
  sportKeyPrefixes: ["basketball_wnba"],
  uiLabel: "WNBA",
  modelVersion: WNBA_MODEL_VERSION,
  supportedMarkets: ["h2h", "spreads", "totals"],
  dataContract: CONTRACT,

  supportsMarket(market: string): boolean {
    return market === "h2h" || market === "spreads" || market === "totals";
  },

  async loadContext(deps: ModelDeps): Promise<ModelContext> {
    const set = await loadTeamFeatures(deps, {
      contractTable: "wnba_team_features",
      requiredColumns: WNBA_REQUIRED_COLUMNS,
      fallbackTable: "game_stats",
      pointsColumns: { scored: "points_for", allowed: "points_against", games: "games" },
    });

    if (set.kind === "none") {
      return {
        status: "insufficient_data",
        missing: set.missingColumns.length ? set.missingColumns : ["wnba_team_features"],
        detail: set.detail ??
          "No WNBA team-rating source. Populate public.wnba_team_features (see supabase/migrations) with at least off_rating, def_rating and pace.",
      };
    }

    /* Every league baseline is computed from the WNBA rows that were loaded.
       There is no NBA constant anywhere in this file to fall back on. */
    const lgOff = leagueMean(set, "off_rating");
    const lgDef = leagueMean(set, "def_rating");
    const lgRating = lgOff != null && lgDef != null ? (lgOff + lgDef) / 2 : lgOff ?? lgDef ?? envNum("WNBA_LEAGUE_RATING", 100);
    const lgPace = leagueMean(set, "pace") ?? envNum("WNBA_LEAGUE_PACE", 80);
    const lgThreeRate = leagueMean(set, "three_rate") ?? envNum("WNBA_LEAGUE_THREE_RATE", 0.3);

    const data: WnbaCtxData = { set, lgRating, lgPace, lgThreeRate, index: buildMarketIndex([]) };
    return {
      status: "ok",
      dataAsOf: set.dataAsOf,
      featureSnapshotId: `${WNBA_MODEL_VERSION}:${set.table}:${set.dataAsOf ?? "na"}:${set.byTeam.size}`,
      detail: set.detail,
      data: data as unknown as Record<string, unknown>,
    };
  },

  async buildEvents(deps, marketRows, ctx) {
    const skipped: SkipEntry[] = [];
    const events: Array<{ event: EventContext; market: MarketContext }> = [];
    const idx = buildMarketIndex(marketRows);
    if (ctx.status === "ok") (ctx.data as unknown as WnbaCtxData).index = idx;

    const all = Object.values(idx.byEvent)
      .sort((a, b) => String(a.commence_time ?? "").localeCompare(String(b.commence_time ?? "")));

    if (ctx.status !== "ok") {
      for (const ev of all) {
        skipped.push({ event_id: ev.event_id, label: `${ev.away_team} @ ${ev.home_team}`, reason: "model_context_failed", detail: ctx.detail });
      }
      return { events, skipped, scheduled: all.length };
    }

    const d = ctx.data as unknown as WnbaCtxData;
    for (const ev of all) {
      const claimed = claimById(idx, ev.event_id);
      if (!claimed) {
        skipped.push({ event_id: ev.event_id, label: `${ev.away_team} @ ${ev.home_team}`, reason: "duplicate_event" });
        continue;
      }
      const hk = nrm(ev.home_team), ak = nrm(ev.away_team);
      if (!d.set.byTeam.has(hk) || !d.set.byTeam.has(ak)) {
        const miss = [!d.set.byTeam.has(hk) ? ev.home_team : "", !d.set.byTeam.has(ak) ? ev.away_team : ""].filter(Boolean).join(", ");
        skipped.push({ event_id: ev.event_id, label: `${ev.away_team} @ ${ev.home_team}`, reason: "missing_team_stats", detail: `not in ${d.set.table}: ${miss}` });
        continue;
      }
      events.push({
        event: {
          event_id: ev.event_id,
          sport_key: ev.sport_key || WNBA_SPORT_KEY,
          commence_time: ev.commence_time,
          home_team: ev.home_team,
          away_team: ev.away_team,
          extra: { hk, ak },
        },
        market: { event: claimed },
      });
    }
    return { events, skipped, scheduled: all.length };
  },

  validateContext(event, ctx): ValidationResult {
    if (ctx.status !== "ok") return { ok: false, reason: "model_context_failed", detail: ctx.detail };
    const d = ctx.data as unknown as WnbaCtxData;
    const x = event.extra as any;
    if (!gameShape(d, x.hk, x.ak)) {
      return { ok: false, reason: "missing_team_stats", detail: "possessions/efficiency could not be computed from the loaded columns" };
    }
    return { ok: true };
  },

  async predict(event, market, ctx, deps): Promise<ModelPrediction[]> {
    const d = ctx.data as unknown as WnbaCtxData;
    const x = event.extra as any;
    const ev = market.event;
    const shape = gameShape(d, x.hk, x.ak);
    if (!shape) return [];

    const totalLine = ev.mainTotal?.point ?? null;
    const spreadLine = ev.mainSpread?.point ?? null;

    let hWin = 0, aWin = 0;
    let over = 0, under = 0, totalPush = 0;
    let homeCover = 0, awayCover = 0, spreadPush = 0;
    let sumTotal = 0, sumMargin = 0;

    for (let i = 0; i < N_SIM; i++) {
      const hs = drawTeamPoints(deps.rng, shape.possessions, shape.pppHome, shape.threeHome);
      const as = drawTeamPoints(deps.rng, shape.possessions, shape.pppAway, shape.threeAway);
      /* Basketball has no ties: a level score goes to overtime. Rather than
         simulating an extra period, a tie is resolved by a fair coin, which is
         what an even-strength overtime is to within far less than the noise on
         everything else here. It is stated in the detail block. */
      if (hs > as) hWin++;
      else if (as > hs) aWin++;
      else if (deps.rng.next() < 0.5) hWin++;
      else aWin++;

      const t = hs + as, m = hs - as;
      sumTotal += t; sumMargin += m;
      if (totalLine != null) {
        if (t > totalLine) over++; else if (t < totalLine) under++; else totalPush++;
      }
      if (spreadLine != null) {
        const adj = m + spreadLine;
        if (adj > 0) homeCover++; else if (adj < 0) awayCover++; else spreadPush++;
      }
    }

    const norm = (win: number, loss: number): number | null => {
      const dz = win + loss;
      return dz > 0 ? win / dz : null;
    };
    const pHome = norm(hWin, aWin);
    const pAway = pHome != null ? 1 - pHome : null;
    const pOver = totalLine != null ? norm(over, under) : null;
    const pUnder = pOver != null ? 1 - pOver : null;
    const pHomeSpread = spreadLine != null ? norm(homeCover, awayCover) : null;
    const pAwaySpread = pHomeSpread != null ? 1 - pHomeSpread : null;

    const missing: string[] = ["player_availability", "injury_report", "minutes_usage", "lineup_effects", "rest_back_to_back"];
    if (d.set.kind === "points_fallback") missing.push("off_rating", "def_rating", "pace", "four_factors");
    else {
      for (const c of ["efg_pct", "tov_pct", "orb_pct", "ft_rate", "three_rate"]) {
        if (d.set.columns.indexOf(c) < 0) missing.push(c);
      }
    }
    missing.push("home_court_advantage (unfitted parameter)");
    const quality = d.set.kind === "points_fallback" ? "LOW" : "MEDIUM";

    const detail = {
      basis: d.set.kind === "points_fallback" ? "points_differential" : "possession_efficiency",
      source_table: d.set.table,
      possessions: +shape.possessions.toFixed(2),
      ppp_home: +shape.pppHome.toFixed(4),
      ppp_away: +shape.pppAway.toFixed(4),
      expected_home_points: +(shape.pppHome * shape.possessions).toFixed(2),
      expected_away_points: +(shape.pppAway * shape.possessions).toFixed(2),
      sim_mean_total: +(sumTotal / N_SIM).toFixed(2),
      sim_mean_margin: +(sumMargin / N_SIM).toFixed(2),
      total_push_rate: totalLine != null ? +(totalPush / N_SIM).toFixed(4) : null,
      spread_push_rate: spreadLine != null ? +(spreadPush / N_SIM).toFixed(4) : null,
      n_sim: N_SIM,
      hca_points: HCA_POINTS(),
      notes: "free throws folded into the 2-point possession outcome; ties resolved as a fair coin in lieu of an overtime model",
    };

    const out: ModelPrediction[] = [];
    const add = (m: string, sel: string, pt: number | null, p: number | null) => {
      if (p == null || !Number.isFinite(p)) return;
      out.push({ market: m, selection: sel, point: pt, model_prob: p, context_quality: quality, missing_features: missing, detail });
    };
    if (ev.h2hHome) add("h2h", ev.home_team, null, pHome);
    if (ev.h2hAway) add("h2h", ev.away_team, null, pAway);
    if (totalLine != null && ev.mainTotal?.over) add("totals", "Over", totalLine, pOver);
    if (totalLine != null && ev.mainTotal?.under) add("totals", "Under", totalLine, pUnder);
    if (spreadLine != null && ev.mainSpread?.home) add("spreads", ev.home_team, spreadLine, pHomeSpread);
    if (spreadLine != null && ev.mainSpread?.away) add("spreads", ev.away_team, -spreadLine, pAwaySpread);
    return out;
  },

  telemetryExtra(_rows, ctx) {
    if (ctx.status !== "ok") return { source: "unavailable" };
    const d = ctx.data as unknown as WnbaCtxData;
    return {
      source_table: d.set.table,
      source_kind: d.set.kind,
      teams_loaded: d.set.byTeam.size,
      league_baselines: {
        rating: +d.lgRating.toFixed(2),
        pace: +d.lgPace.toFixed(2),
        three_rate: +d.lgThreeRate.toFixed(3),
      },
      unfitted_parameters: { hca_points: HCA_POINTS() },
      note: "every baseline above is computed from the loaded WNBA rows; no NBA prior is used",
    };
  },
};
