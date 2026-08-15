// ============================================================================
// EdgeDesk : model_predict / models / nfl   —   nfl_game_v1
//
// STATUS ON TODAY'S DATABASE: insufficient_data.
//
// EdgeDesk owns no NFL efficiency table. The model below is complete and
// tested, and it runs the moment `public.nfl_team_features` is populated (the
// migration creates it empty and documents every column). Until then it writes
// nothing and reports exactly which columns are missing. That is deliberate:
// a fabricated 57.3% in the historical record is worse than a gap in it.
//
// MATHEMATICS — WHY NOT A NORMAL DISTRIBUTION.
// NFL scores are not continuous and their margins are not smooth. Points arrive
// in blocks of 7 and 3, which is why 3 and 7 are the key numbers a normal curve
// cannot see: a Normal(mean, sd) fitted to NFL margins puts the same density on
// a 3-point margin as on a 4-point one, and the whole spread market lives in
// that difference.
//
// So scoring is simulated as a COMPOUND COUNT process: touchdowns and field
// goals are drawn as counts and converted to points, which reproduces the
// discreteness and the key-number spikes by construction. Expected points come
// from efficiency against the specific opponent:
//
//   pts_off = league_ppg
//           + (off_epa_play - lg_off_epa) * plays
//           + (opp_def_epa_play - lg_def_epa) * plays
//
// EPA per play is points added per play by definition, so multiplying by plays
// per game and adding the league baseline is a units-correct construction, not
// a fitted mapping.
//
// PUSH HANDLING. NFL ties are real and NFL spread lines are frequently whole
// numbers, so a push is a live outcome. A pushed bet returns the stake, so the
// fair probability of the priced market is P(win) / (P(win) + P(loss)) — the
// push is removed from the denominator, not counted as half a win. (MLB's
// totals keep their v1.2 (over + 0.5*push) treatment untouched; the two sports
// are not being made consistent with each other at the cost of changing the
// frozen baseline.)
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
import { negBinomial } from "../core/rng.ts";
import { envNum } from "../core/db.ts";
import { leagueMean, loadTeamFeatures, numOr, type TeamFeatureSet } from "./team_loader.ts";

export const NFL_MODEL_VERSION = "nfl_game_v1";
export const NFL_SPORT_KEY = "americanfootball_nfl";

const N_SIM = 20000;
/* Home field, in points. A published league-level constant of the same kind as
   MLB's HOME_XR_MULT, reported on every row as an unfitted parameter and
   overridable from the environment. It is NOT derived from the market. */
const HFA_POINTS = () => envNum("NFL_HFA_POINTS", 2.0);
/* Share of a team's points that arrive as touchdowns, used to split expected
   points into TD and FG counts when the features table does not carry the split
   itself. Reported as an unfitted parameter. */
const TD_SHARE = () => envNum("NFL_TD_SHARE", 0.62);
/* variance/mean for scoring-event counts. 1.0 = Poisson. */
const SCORE_DISPERSION = () => envNum("NFL_SCORE_DISPERSION", 1.15);

export const NFL_REQUIRED_COLUMNS = [
  "off_epa_play",
  "def_epa_play",
  "plays_per_game",
];

export const NFL_OPTIONAL_COLUMNS = [
  "off_pass_epa_play", "off_rush_epa_play", "def_pass_epa_play", "def_rush_epa_play",
  "off_success_rate", "def_success_rate", "sack_rate", "sack_rate_allowed",
  "explosive_rate", "explosive_allowed", "points_for_pg", "points_against_pg",
  "td_per_game", "fg_per_game", "qb_status", "rest_days",
];

export interface NflCtxData {
  set: TeamFeatureSet;
  lgOffEpa: number;
  lgDefEpa: number;
  lgPlays: number;
  lgPpg: number;
  index: ReturnType<typeof buildMarketIndex>;
}

const CONTRACT: DataContractEntry[] = [
  { feature: "offensive EPA per play (opponent-adjusted)", source: "public.nfl_team_features.off_epa_play", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "weekly", historicalDepth: "season", reliability: "not currently ingested", critical: true },
  { feature: "defensive EPA per play (opponent-adjusted)", source: "public.nfl_team_features.def_epa_play", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "weekly", historicalDepth: "season", reliability: "not currently ingested", critical: true },
  { feature: "plays per game / pace", source: "public.nfl_team_features.plays_per_game", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "weekly", historicalDepth: "season", reliability: "not currently ingested", critical: true },
  { feature: "pass / rush EPA split, success rate, explosive rate", source: "public.nfl_team_features (optional columns)", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "weekly", historicalDepth: "season", reliability: "not currently ingested", critical: false },
  { feature: "pressure and sack rate, both directions", source: "public.nfl_team_features (optional columns)", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "weekly", historicalDepth: "season", reliability: "not currently ingested", critical: false },
  { feature: "points scored / allowed per game (degraded fallback)", source: "public.game_stats, only if points_for/points_against/games exist", sourceClass: "NOT_AVAILABLE", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "columns not present today", critical: false },
  { feature: "quarterback status", source: "not ingested — NEVER inferred", sourceClass: "NOT_AVAILABLE", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "n/a", critical: false },
  { feature: "injury report", source: "not ingested — NEVER inferred", sourceClass: "NOT_AVAILABLE", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "n/a", critical: false },
  { feature: "rest days / bye / short week / travel", source: "derivable from public.signals commence_time history", sourceClass: "AVAILABLE_FROM_EXISTING_PROVIDER", updateFrequency: "with capture", historicalDepth: "capture history", reliability: "derived", critical: false },
  { feature: "weather at kickoff", source: "public.venue_weather / api.weather.gov", sourceClass: "AVAILABLE_FROM_EXISTING_PROVIDER", updateFrequency: "hourly", historicalDepth: "n/a", reliability: "NWS", critical: false },
];

/** Expected points for both sides. Pure, so the tests can pin it without a
 *  simulator or a database. */
export function expectedPoints(
  d: NflCtxData,
  homeNorm: string,
  awayNorm: string,
): { home: number; away: number } | null {
  const h = d.set.byTeam.get(homeNorm);
  const a = d.set.byTeam.get(awayNorm);
  if (!h || !a) return null;

  if (d.set.kind === "points_fallback") {
    const hFor = numOr(h, "points_for", null), hAg = numOr(h, "points_against", null), hG = numOr(h, "games", null);
    const aFor = numOr(a, "points_for", null), aAg = numOr(a, "points_against", null), aG = numOr(a, "games", null);
    if (hFor == null || hAg == null || !hG || aFor == null || aAg == null || !aG) return null;
    /* Offence and defence each contribute half the deviation from the league
       baseline — the standard points-for/points-against decomposition. */
    const hOff = hFor / hG, hDef = hAg / hG, aOff = aFor / aG, aDef = aAg / aG;
    const lg = d.lgPpg;
    const home = lg + (hOff - lg) + (aDef - lg) + HFA_POINTS() / 2;
    const away = lg + (aOff - lg) + (hDef - lg) - HFA_POINTS() / 2;
    return { home: Math.max(3, home), away: Math.max(3, away) };
  }

  const hOffEpa = numOr(h, "off_epa_play", null);
  const hDefEpa = numOr(h, "def_epa_play", null);
  const hPlays = numOr(h, "plays_per_game", d.lgPlays) ?? d.lgPlays;
  const aOffEpa = numOr(a, "off_epa_play", null);
  const aDefEpa = numOr(a, "def_epa_play", null);
  const aPlays = numOr(a, "plays_per_game", d.lgPlays) ?? d.lgPlays;
  if (hOffEpa == null || hDefEpa == null || aOffEpa == null || aDefEpa == null) return null;

  /* Plays are shared between the two offences in a game, so each offence gets
     the average of its own pace and the opponent's — a fast offence facing a
     slow one lands in between rather than getting its full season pace. */
  const plays = (hPlays + aPlays) / 2;

  const home = d.lgPpg
    + (hOffEpa - d.lgOffEpa) * plays
    + (aDefEpa - d.lgDefEpa) * plays
    + HFA_POINTS() / 2;
  const away = d.lgPpg
    + (aOffEpa - d.lgOffEpa) * plays
    + (hDefEpa - d.lgDefEpa) * plays
    - HFA_POINTS() / 2;
  return { home: Math.max(3, home), away: Math.max(3, away) };
}

/** Draw one team's score. Touchdown and field-goal counts, not a normal curve —
 *  this is what puts mass on 3, 7, 10, 14, 17 and 21. */
export function drawScore(rng: { next(): number }, expPts: number, tdShare: number, disp: number): number {
  const tdPoints = 6.94; // TD + the conversion actually made, league-typical
  const lamTd = Math.max(0, expPts * tdShare) / tdPoints;
  const lamFg = Math.max(0, expPts * (1 - tdShare)) / 3;
  const td = negBinomial(rng as any, lamTd, disp);
  const fg = negBinomial(rng as any, lamFg, disp);
  let pts = fg * 3;
  for (let i = 0; i < td; i++) {
    // Extra point vs two-point try, at league-typical rates. Keeps 7 dominant
    // while allowing the 6 and 8 that make key numbers imperfect.
    const u = rng.next();
    pts += u < 0.92 ? 7 : u < 0.96 ? 6 : 8;
  }
  return pts;
}

export const NFLModel: SportPredictionModel = {
  sportKey: NFL_SPORT_KEY,
  sportKeyPrefixes: ["americanfootball_nfl"],
  uiLabel: "NFL",
  modelVersion: NFL_MODEL_VERSION,
  supportedMarkets: ["h2h", "spreads", "totals"],
  dataContract: CONTRACT,

  supportsMarket(market: string): boolean {
    return market === "h2h" || market === "spreads" || market === "totals";
  },

  async loadContext(deps: ModelDeps): Promise<ModelContext> {
    const set = await loadTeamFeatures(deps, {
      contractTable: "nfl_team_features",
      requiredColumns: NFL_REQUIRED_COLUMNS,
      fallbackTable: "game_stats",
      pointsColumns: { scored: "points_for", allowed: "points_against", games: "games" },
    });

    if (set.kind === "none") {
      return {
        status: "insufficient_data",
        missing: set.missingColumns.length ? set.missingColumns : ["nfl_team_features"],
        detail: set.detail ??
          "No NFL team-efficiency source. Populate public.nfl_team_features (see supabase/migrations) with at least off_epa_play, def_epa_play and plays_per_game.",
      };
    }

    const lgOffEpa = leagueMean(set, "off_epa_play") ?? 0;
    const lgDefEpa = leagueMean(set, "def_epa_play") ?? 0;
    const lgPlays = leagueMean(set, "plays_per_game") ?? 63;
    const lgPpg = leagueMean(set, "points_for_pg")
      ?? (set.kind === "points_fallback" ? pointsFallbackLeaguePpg(set) : null)
      ?? envNum("NFL_LEAGUE_PPG", 22.5);

    const data: NflCtxData = { set, lgOffEpa, lgDefEpa, lgPlays, lgPpg, index: buildMarketIndex([]) };
    return {
      status: "ok",
      dataAsOf: set.dataAsOf,
      featureSnapshotId: `${NFL_MODEL_VERSION}:${set.table}:${set.dataAsOf ?? "na"}:${set.byTeam.size}`,
      detail: set.detail,
      data: data as unknown as Record<string, unknown>,
    };
  },

  async buildEvents(deps, marketRows, ctx) {
    const skipped: SkipEntry[] = [];
    const events: Array<{ event: EventContext; market: MarketContext }> = [];
    const idx = buildMarketIndex(marketRows);
    if (ctx.status === "ok") (ctx.data as unknown as NflCtxData).index = idx;

    const all = Object.values(idx.byEvent)
      .sort((a, b) => String(a.commence_time ?? "").localeCompare(String(b.commence_time ?? "")));

    if (ctx.status !== "ok") {
      for (const ev of all) {
        skipped.push({ event_id: ev.event_id, label: `${ev.away_team} @ ${ev.home_team}`, reason: "model_context_failed", detail: ctx.detail });
      }
      return { events, skipped, scheduled: all.length };
    }

    const d = ctx.data as unknown as NflCtxData;
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
          sport_key: ev.sport_key || NFL_SPORT_KEY,
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
    const d = ctx.data as unknown as NflCtxData;
    const x = event.extra as any;
    if (!expectedPoints(d, x.hk, x.ak)) {
      return { ok: false, reason: "missing_team_stats", detail: "expected points could not be computed from the loaded columns" };
    }
    return { ok: true };
  },

  async predict(event, market, ctx, deps): Promise<ModelPrediction[]> {
    const d = ctx.data as unknown as NflCtxData;
    const x = event.extra as any;
    const ev = market.event;
    const xp = expectedPoints(d, x.hk, x.ak);
    if (!xp) return [];

    const totalLine = ev.mainTotal?.point ?? null;
    const spreadLine = ev.mainSpread?.point ?? null; // home handicap
    const tdShare = TD_SHARE(), disp = SCORE_DISPERSION();

    let hWin = 0, aWin = 0, tie = 0;
    let over = 0, under = 0, totalPush = 0;
    let homeCover = 0, awayCover = 0, spreadPush = 0;
    let sumTotal = 0, sumMargin = 0;

    for (let i = 0; i < N_SIM; i++) {
      const hs = drawScore(deps.rng, xp.home, tdShare, disp);
      const as = drawScore(deps.rng, xp.away, tdShare, disp);
      if (hs > as) hWin++; else if (as > hs) aWin++; else tie++;
      const t = hs + as, m = hs - as;
      sumTotal += t; sumMargin += m;
      if (totalLine != null) {
        if (t > totalLine) over++; else if (t < totalLine) under++; else totalPush++;
      }
      if (spreadLine != null) {
        const adj = m + spreadLine; // home covers when margin + handicap > 0
        if (adj > 0) homeCover++; else if (adj < 0) awayCover++; else spreadPush++;
      }
    }

    /* Push-excluded normalisation. A pushed bet returns the stake, so the fair
       probability of the priced outcome conditions on the bet resolving. */
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

    const missing: string[] = ["qb_status", "injury_report", "weather", "rest_travel"];
    if (d.set.kind === "points_fallback") missing.push("opponent_adjusted_efficiency", "pass_rush_split", "pressure_rate");
    else {
      for (const c of ["off_pass_epa_play", "off_rush_epa_play", "sack_rate", "explosive_rate"]) {
        if (d.set.columns.indexOf(c) < 0) missing.push(c);
      }
    }
    missing.push("home_field_advantage (unfitted parameter)");
    const quality = d.set.kind === "points_fallback" ? "LOW" : missing.length > 6 ? "LOW" : "MEDIUM";

    const detail = {
      basis: d.set.kind === "points_fallback" ? "points_differential" : "epa_efficiency",
      source_table: d.set.table,
      expected_home_points: +xp.home.toFixed(2),
      expected_away_points: +xp.away.toFixed(2),
      sim_mean_total: +(sumTotal / N_SIM).toFixed(2),
      sim_mean_margin: +(sumMargin / N_SIM).toFixed(2),
      p_tie: +(tie / N_SIM).toFixed(4),
      total_push_rate: totalLine != null ? +(totalPush / N_SIM).toFixed(4) : null,
      spread_push_rate: spreadLine != null ? +(spreadPush / N_SIM).toFixed(4) : null,
      n_sim: N_SIM,
      hfa_points: HFA_POINTS(),
      td_share: tdShare,
      score_dispersion: disp,
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
    const d = ctx.data as unknown as NflCtxData;
    return {
      source_table: d.set.table,
      source_kind: d.set.kind,
      teams_loaded: d.set.byTeam.size,
      league_baselines: {
        off_epa_play: +d.lgOffEpa.toFixed(4),
        def_epa_play: +d.lgDefEpa.toFixed(4),
        plays_per_game: +d.lgPlays.toFixed(2),
        points_per_game: +d.lgPpg.toFixed(2),
      },
      unfitted_parameters: { hfa_points: HFA_POINTS(), td_share: TD_SHARE(), score_dispersion: SCORE_DISPERSION() },
    };
  },
};

function pointsFallbackLeaguePpg(set: TeamFeatureSet): number | null {
  let s = 0, n = 0;
  for (const [, row] of set.byTeam) {
    const f = numOr(row, "points_for", null), g = numOr(row, "games", null);
    if (f != null && g) { s += f / g; n++; }
  }
  return n ? s / n : null;
}
