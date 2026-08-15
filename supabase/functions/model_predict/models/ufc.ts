// ============================================================================
// EdgeDesk : model_predict / models / ufc   —   ufc_fight_v1
//
// A fight is not a game between two teams and this model does not pretend it
// is. The output is P(fighter A wins) built from fighter-level form and an
// explicit matchup, not from two career averages compared side by side.
//
// DATA. The isolated `ufc` research schema (accept-profile: ufc) the app's UFC
// module already reads:
//     ufc.fighters                 fighter_id, full_name, division, stance,
//                                  height_inches, reach_inches, age, W/L/D
//     ufc.fighter_career_stats     slpm, sapm, striking_accuracy,
//                                  striking_defense, takedown_avg,
//                                  takedown_accuracy, takedown_defense,
//                                  submission_avg, knockdown_avg,
//                                  control_time_avg
//     ufc.fighter_style_metrics    primary_style, distance_striker,
//                                  pressure_striker, counter_striker, wrestler,
//                                  submission_specialist, grappler, high_output,
//                                  power_striker, durability_score, finisher
//     ufc.fighter_derived_metrics  finish_rate, win/loss streak,
//                                  days_since_last_fight, activity_last365,
//                                  title_fight_experience, opponent quality
//     ufc.fighter_fights           per-bout results, used for the rating
// No new provider is introduced.
//
// MATHEMATICS.
//   BASELINE: a fighter Elo built chronologically from ufc.fighter_fights. Like
//   the tennis rating it is self-calibrating — the numbers come out of the
//   results, so nothing had to be guessed.
//
//   MATCHUP: the interaction terms below are the ones that decide fights —
//   elite takedown offence against weak takedown defence, a pressure striker
//   against a counter striker, volume against durability, reach against a
//   distance game. They are COMPUTED on every prediction and stored in
//   model_detail so a row can be audited, but they move the probability only
//   through coefficients fitted on this schema's own fight results
//   (?calibrate=1). A hand-chosen weight on "wrestler vs weak TD defence" would
//   be exactly the impressive-looking garbage this file exists to avoid.
//
// MARKETS. Winner only. Method of victory, round, distance and strike/takedown
// props are all present in the odds feed, but a market existing is not the same
// as EdgeDesk having the information to model it: method and round need a
// hazard model over fight time that this schema's per-bout rows cannot support
// at the sample sizes available. They return unsupported_by_model rather than a
// manufactured number.
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
import { buildNameIndex, resolveName, type NameIndex } from "../core/names.ts";
import { newElo, ratingOf, matchesOf, updateElo, type EloState, daysBetween } from "../core/elo.ts";
import { eloProb } from "../core/odds.ts";
import { applyFit } from "../core/fit.ts";
import { claimById } from "../core/identity.ts";
import { buildMarketIndex } from "../core/market.ts";
import { envNum } from "../core/db.ts";

export const UFC_MODEL_VERSION = "ufc_fight_v1";
export const UFC_SPORT_KEY = "mma_mixed_martial_arts";

export interface FighterCareer {
  slpm?: number | null;
  sapm?: number | null;
  striking_accuracy?: number | null;
  striking_defense?: number | null;
  takedown_avg?: number | null;
  takedown_accuracy?: number | null;
  takedown_defense?: number | null;
  submission_avg?: number | null;
  knockdown_avg?: number | null;
  control_time_avg?: number | null;
}

export interface FighterStyle {
  primary_style?: string | null;
  distance_striker?: number | null;
  pressure_striker?: number | null;
  counter_striker?: number | null;
  wrestler?: number | null;
  submission_specialist?: number | null;
  grappler?: number | null;
  high_output?: number | null;
  power_striker?: number | null;
  durability_score?: number | null;
  finisher?: number | null;
}

export interface FighterDerived {
  finish_rate?: number | null;
  finish_rate_last5?: number | null;
  win_streak?: number | null;
  loss_streak?: number | null;
  days_since_last_fight?: number | null;
  activity_last365?: number | null;
  title_fight_experience?: number | null;
  opponent_average_win_pct?: number | null;
  average_fight_time?: number | null;
}

export interface FighterBio {
  fighter_id: string;
  full_name: string;
  division?: string | null;
  stance?: string | null;
  height_inches?: number | null;
  reach_inches?: number | null;
  age?: number | null;
  wins?: number | null;
  losses?: number | null;
  draws?: number | null;
}

export interface UfcCtxData {
  elo: EloState;
  nameIndex: NameIndex;
  bio: Map<string, FighterBio>;
  career: Map<string, FighterCareer>;
  style: Map<string, FighterStyle>;
  derived: Map<string, FighterDerived>;
  lastFight: Map<string, string>;
  fightsUsed: number;
  historyThrough: string | null;
  fitted: {
    featureNames: string[];
    weights: number[];
    intercept: number;
    mean: number[];
    sd: number[];
    fitted_at?: string;
    metrics?: unknown;
  } | null;
  index: ReturnType<typeof buildMarketIndex>;
}

/** Everything the matchup engine computes. All of it is written to
 *  model_detail so a row can be audited years later. */
export const UFC_FEATURES = [
  "elo_diff",
  "strike_output_edge",
  "strike_defense_edge",
  "takedown_pressure_edge",
  "takedown_resistance_edge",
  "power_vs_durability",
  "grappling_control_edge",
  "reach_diff",
  "age_diff",
  "layoff_diff",
  "opponent_quality_diff",
  "stance_mismatch",
];

/**
 * The subset that may be FITTED, and therefore the only subset that can move a
 * probability.
 *
 * The striking, grappling, style and opponent-quality features are excluded
 * because ufc.fighter_career_stats and ufc.fighter_derived_metrics hold
 * career-TO-DATE values as of today. Fitting them on a 2019 bout would let the
 * model see how that bout went — a backtest that looks superb and is worth
 * nothing live. Reconstructing them as-of-date is impossible from this schema:
 * ufc.fighter_fights carries no strike or takedown counts. Elo, reach, age
 * (rolled back to the bout date), layoff and stance ARE reconstructible, so
 * they are the fit.
 *
 * Order is part of the contract with core/calibrate.ts.
 */
export const UFC_FIT_FEATURES = [
  "elo_diff",
  "reach_diff",
  "age_diff",
  "layoff_diff",
  "stance_mismatch",
];

/** Positions of UFC_FIT_FEATURES inside the full UFC_FEATURES vector. */
const FIT_INDEX = UFC_FIT_FEATURES.map((f) => UFC_FEATURES.indexOf(f));

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
};

/** Rates in this schema may be stored as 0-1 or as 0-100. Normalise to 0-1 by
 *  inspecting the value rather than assuming, because assuming turns a 47%
 *  takedown defence into 4700%. */
const rate = (v: unknown): number | null => {
  const n = num(v);
  if (n == null) return null;
  if (n < 0) return null;
  return n > 1.0000001 ? n / 100 : n;
};

/**
 * Matchup features. Every one is a DIFFERENCE OF INTERACTIONS, not a difference
 * of averages: what matters is A's offence measured against B's specific
 * defence, which is why `strike_output_edge` multiplies A's volume by the share
 * B fails to defend rather than subtracting B's volume from A's.
 */
export function matchupFeatures(
  d: UfcCtxData,
  aId: string,
  bId: string,
  commenceIso: string | null,
): { values: number[]; missing: string[] } {
  const missing: string[] = [];
  const ca = d.career.get(aId) ?? {};
  const cb = d.career.get(bId) ?? {};
  const sa = d.style.get(aId) ?? {};
  const sb = d.style.get(bId) ?? {};
  const da = d.derived.get(aId) ?? {};
  const db = d.derived.get(bId) ?? {};
  const ba = d.bio.get(aId);
  const bb = d.bio.get(bId);

  if (!d.career.has(aId) || !d.career.has(bId)) missing.push("career_striking_grappling_stats");
  if (!d.style.has(aId) || !d.style.has(bId)) missing.push("style_metrics");
  if (!d.derived.has(aId) || !d.derived.has(bId)) missing.push("derived_metrics");

  const eloDiff = ratingOf(d.elo, aId) - ratingOf(d.elo, bId);

  // Striking. A's landed volume weighted by the fraction B does NOT defend,
  // minus the same quantity for B. Volume alone says nothing about a matchup.
  const slpmA = num(ca.slpm) ?? 0, slpmB = num(cb.slpm) ?? 0;
  const sdefA = rate(ca.striking_defense) ?? 0.55, sdefB = rate(cb.striking_defense) ?? 0.55;
  const strikeOutput = slpmA * (1 - sdefB) - slpmB * (1 - sdefA);

  // Absorption. Being hit less than the opponent is hit is the other half.
  const sapmA = num(ca.sapm) ?? 0, sapmB = num(cb.sapm) ?? 0;
  const strikeDefense = sapmB - sapmA;

  // Wrestling. Attempts × accuracy against the opponent's takedown defence.
  const tdA = (num(ca.takedown_avg) ?? 0) * (rate(ca.takedown_accuracy) ?? 0.4);
  const tdB = (num(cb.takedown_avg) ?? 0) * (rate(cb.takedown_accuracy) ?? 0.4);
  const tddA = rate(ca.takedown_defense) ?? 0.6, tddB = rate(cb.takedown_defense) ?? 0.6;
  const tdPressure = tdA * (1 - tddB) - tdB * (1 - tddA);
  const tdResistance = tddA - tddB;

  // Power against chin. A knockdown rate is only dangerous against someone who
  // can be dropped, which is what durability_score is measuring.
  const kdA = num(ca.knockdown_avg) ?? 0, kdB = num(cb.knockdown_avg) ?? 0;
  const durA = num(sa.durability_score) ?? 0, durB = num(sb.durability_score) ?? 0;
  const powerVsChin = kdA * (1 - clamp01(durB)) - kdB * (1 - clamp01(durA));

  // Control. Time on top plus submission threat.
  const ctrl = ((num(ca.control_time_avg) ?? 0) - (num(cb.control_time_avg) ?? 0)) +
    ((num(ca.submission_avg) ?? 0) - (num(cb.submission_avg) ?? 0));

  const reachDiff = (num(ba?.reach_inches) ?? 0) - (num(bb?.reach_inches) ?? 0);
  if (ba?.reach_inches == null || bb?.reach_inches == null) missing.push("reach");
  const ageDiff = (num(ba?.age) ?? 0) - (num(bb?.age) ?? 0);
  if (ba?.age == null || bb?.age == null) missing.push("age");

  // Layoff. Prefer the schema's own days_since_last_fight; fall back to the
  // fight history's last date. Neither present means the feature is missing,
  // not zero-by-default with a straight face.
  let layA = num(da.days_since_last_fight);
  let layB = num(db.days_since_last_fight);
  if (layA == null) layA = daysBetween(d.lastFight.get(aId) ?? null, commenceIso);
  if (layB == null) layB = daysBetween(d.lastFight.get(bId) ?? null, commenceIso);
  if (layA == null || layB == null) missing.push("layoff");
  const layoffDiff = (layA ?? 0) - (layB ?? 0);

  const oppQ = (num(da.opponent_average_win_pct) ?? 0) - (num(db.opponent_average_win_pct) ?? 0);
  if (da.opponent_average_win_pct == null || db.opponent_average_win_pct == null) missing.push("opponent_quality");

  // Southpaw/orthodox. Coded as a mismatch indicator from A's point of view:
  // a southpaw facing an orthodox opponent is the historically advantaged half.
  const stA = String(ba?.stance ?? "").toLowerCase();
  const stB = String(bb?.stance ?? "").toLowerCase();
  let stance = 0;
  if (stA && stB) {
    const aSouth = stA.indexOf("southpaw") >= 0;
    const bSouth = stB.indexOf("southpaw") >= 0;
    stance = aSouth === bSouth ? 0 : (aSouth ? 1 : -1);
  } else missing.push("stance");

  return {
    values: [
      eloDiff, strikeOutput, strikeDefense, tdPressure, tdResistance,
      powerVsChin, ctrl, reachDiff, ageDiff, layoffDiff, oppQ, stance,
    ],
    missing,
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  const x = v > 1.0000001 ? v / 100 : v;
  return Math.min(1, Math.max(0, x));
}

async function pagedUfc(deps: ModelDeps, base: string, order: string, maxPages = 30): Promise<any[]> {
  const out: any[] = [];
  const PAGE = 1000;
  for (let p = 0; p < maxPages; p++) {
    const rows = await deps.sbGetSchema("ufc", `${base}&order=${order}&limit=${PAGE}&offset=${p * PAGE}`);
    if (!rows || !rows.length) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Build the fighter rating from the bout history.
 *
 * ufc.fighter_fights stores one row PER CORNER, so every bout appears twice.
 * Feeding both to Elo would double every update. Rows are deduplicated on the
 * unordered pair plus date before anything is applied.
 *
 * The `winner` column's meaning is detected rather than assumed: some loads
 * store the winning fighter's id, others store a W/L result relative to
 * fighter_id. Guessing wrong would inverte every rating in the schema.
 */
export function buildFighterElo(rows: any[]): { elo: EloState; used: number; through: string | null; semantics: string } {
  const elo = newElo({ initial: 1500, kFactor: 120, kShift: 4, kDecay: 0.35, scale: 400 });

  let idLike = 0, resultLike = 0;
  for (const r of rows) {
    const w = r?.winner;
    if (w == null) continue;
    const s = String(w).toLowerCase();
    if (s === "win" || s === "loss" || s === "w" || s === "l" || s === "draw" || s === "nc") resultLike++;
    else if (String(r.fighter_id) === String(w) || String(r.opponent_id) === String(w)) idLike++;
  }
  const semantics = idLike >= resultLike && idLike > 0 ? "winner_id" : resultLike > 0 ? "result_string" : "unknown";
  if (semantics === "unknown") return { elo, used: 0, through: null, semantics };

  const seen = new Set<string>();
  const bouts: Array<{ date: string; winner: string; loser: string }> = [];
  for (const r of rows) {
    const a = r?.fighter_id != null ? String(r.fighter_id) : "";
    const b = r?.opponent_id != null ? String(r.opponent_id) : "";
    const date = r?.date ? String(r.date) : "";
    if (!a || !b || a === b || !date) continue;
    const key = (a < b ? a + "|" + b : b + "|" + a) + "|" + date;
    if (seen.has(key)) continue;

    let winner: string | null = null;
    if (semantics === "winner_id") {
      const w = r.winner != null ? String(r.winner) : "";
      if (w === a) winner = a;
      else if (w === b) winner = b;
    } else {
      const s = String(r.winner ?? "").toLowerCase();
      if (s === "win" || s === "w") winner = a;
      else if (s === "loss" || s === "l") winner = b;
    }
    // Draws and no-contests move nobody's rating and are not evidence of an
    // ordering; they are counted out rather than assigned to a side.
    if (!winner) continue;
    seen.add(key);
    bouts.push({ date, winner, loser: winner === a ? b : a });
  }

  bouts.sort((x, y) => x.date.localeCompare(y.date));
  for (const b of bouts) updateElo(elo, b.winner, b.loser, b.date);
  return {
    elo,
    used: bouts.length,
    through: bouts.length ? bouts[bouts.length - 1].date : null,
    semantics,
  };
}

const CONTRACT: DataContractEntry[] = [
  { feature: "bout results (fighter, opponent, date, winner)", source: "ufc.fighter_fights", sourceClass: "AVAILABLE_NOW", updateFrequency: "per event", historicalDepth: "as loaded", reliability: "descriptive dataset", critical: true },
  { feature: "fighter identity, stance, reach, height, age, record", source: "ufc.fighters", sourceClass: "AVAILABLE_NOW", updateFrequency: "per event", historicalDepth: "full roster", reliability: "descriptive dataset", critical: true },
  { feature: "striking volume/accuracy/defence, absorbed per minute, knockdowns", source: "ufc.fighter_career_stats", sourceClass: "AVAILABLE_NOW", updateFrequency: "per event", historicalDepth: "career to date", reliability: "career averages, not opponent-adjusted", critical: false },
  { feature: "takedown avg/accuracy/defence, submission avg, control time", source: "ufc.fighter_career_stats", sourceClass: "AVAILABLE_NOW", updateFrequency: "per event", historicalDepth: "career to date", reliability: "career averages, not opponent-adjusted", critical: false },
  { feature: "style classification, durability, finisher indices", source: "ufc.fighter_style_metrics", sourceClass: "AVAILABLE_NOW", updateFrequency: "per event", historicalDepth: "career to date", reliability: "derived by the loader", critical: false },
  { feature: "layoff, activity, opponent quality, finish rate", source: "ufc.fighter_derived_metrics", sourceClass: "AVAILABLE_NOW", updateFrequency: "per event", historicalDepth: "career to date", reliability: "derived by the loader", critical: false },
  { feature: "round-by-round positional data", source: "ufc.live_fight_round_stats (live only, not historical)", sourceClass: "AVAILABLE_FROM_EXISTING_PROVIDER", updateFrequency: "live", historicalDepth: "events captured live only", reliability: "live feed", critical: false },
  { feature: "short-notice / replacement flag", source: "not ingested", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "n/a", critical: false },
  { feature: "weigh-in result / missed weight", source: "not ingested", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "n/a", critical: false },
  { feature: "camp / injury / training-camp disruption", source: "not ingested", sourceClass: "NOT_AVAILABLE", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "n/a", critical: false },
];

export const UFCModel: SportPredictionModel = {
  sportKey: UFC_SPORT_KEY,
  sportKeyPrefixes: [UFC_SPORT_KEY, "mma_"],
  uiLabel: "MMA",
  modelVersion: UFC_MODEL_VERSION,
  supportedMarkets: ["h2h"],
  dataContract: CONTRACT,

  supportsMarket(market: string): boolean {
    return market === "h2h";
  },

  async loadContext(deps: ModelDeps): Promise<ModelContext> {
    let fighters: any[] = [];
    try {
      fighters = await pagedUfc(deps, "fighters?select=fighter_id,full_name,division,stance,height_inches,reach_inches,age,wins,losses,draws", "full_name", 20);
    } catch (e) {
      return {
        status: "insufficient_data",
        missing: ["ufc.fighters"],
        detail: `ufc schema unreadable: ${String((e as Error)?.message ?? e)}. Expose the "ufc" schema under Supabase > API settings > Exposed schemas.`,
      };
    }
    if (!fighters.length) {
      return { status: "insufficient_data", missing: ["ufc.fighters rows"], detail: "ufc schema reachable but the fighter table is empty." };
    }

    let fights: any[] = [];
    try {
      fights = await pagedUfc(deps, "fighter_fights?select=fighter_id,opponent_id,date,winner,method,round,went_distance", "date.asc", 40);
    } catch (e) {
      return { status: "insufficient_data", missing: ["ufc.fighter_fights"], detail: String((e as Error)?.message ?? e) };
    }

    const built = buildFighterElo(fights);
    const minFights = envNum("UFC_MIN_FIGHTS", 400);
    if (built.used < minFights) {
      return {
        status: "insufficient_data",
        missing: [`ufc.fighter_fights usable bouts (have ${built.used}, need >= ${minFights})`],
        detail: built.semantics === "unknown"
          ? "ufc.fighter_fights.winner could not be interpreted as either a fighter id or a W/L result, so no rating can be built."
          : `Only ${built.used} bouts resolved to a winner. No predictions written.`,
      };
    }

    const career = new Map<string, FighterCareer>();
    const style = new Map<string, FighterStyle>();
    const derived = new Map<string, FighterDerived>();
    // Optional tables: their absence degrades the matchup features, it does not
    // stop the rating, so each is tried independently and reported.
    const optionalMissing: string[] = [];
    try {
      const rows = await pagedUfc(deps, "fighter_career_stats?select=fighter_id,slpm,sapm,striking_accuracy,striking_defense,takedown_avg,takedown_accuracy,takedown_defense,submission_avg,knockdown_avg,control_time_avg", "fighter_id", 20);
      for (const r of rows) if (r?.fighter_id != null) career.set(String(r.fighter_id), r);
    } catch (_) { optionalMissing.push("ufc.fighter_career_stats"); }
    try {
      const rows = await pagedUfc(deps, "fighter_style_metrics?select=fighter_id,primary_style,distance_striker,pressure_striker,counter_striker,wrestler,submission_specialist,grappler,high_output,power_striker,durability_score,finisher", "fighter_id", 20);
      for (const r of rows) if (r?.fighter_id != null) style.set(String(r.fighter_id), r);
    } catch (_) { optionalMissing.push("ufc.fighter_style_metrics"); }
    try {
      const rows = await pagedUfc(deps, "fighter_derived_metrics?select=fighter_id,finish_rate,finish_rate_last5,win_streak,loss_streak,days_since_last_fight,activity_last365,title_fight_experience,opponent_average_win_pct,average_fight_time", "fighter_id", 20);
      for (const r of rows) if (r?.fighter_id != null) derived.set(String(r.fighter_id), r);
    } catch (_) { optionalMissing.push("ufc.fighter_derived_metrics"); }

    const bio = new Map<string, FighterBio>();
    for (const f of fighters) {
      if (f?.fighter_id == null) continue;
      bio.set(String(f.fighter_id), { ...f, fighter_id: String(f.fighter_id), full_name: String(f.full_name ?? "") });
    }
    const nameIndex = buildNameIndex(
      Array.from(bio.values()).filter((b) => b.full_name).map((b) => ({ id: b.fighter_id, name: b.full_name })),
    );

    const lastFight = new Map<string, string>();
    for (const [id, dt] of built.elo.lastDate) lastFight.set(id, dt);

    let fitted: UfcCtxData["fitted"] = null;
    try {
      const rows = await deps.sbGet(
        `model_parameters?select=params,fitted_at,metrics&model_version=eq.${encodeURIComponent(UFC_MODEL_VERSION)}&param_set=eq.default&limit=1`,
      );
      const p = rows?.[0]?.params;
      if (p?.blend?.weights?.length === UFC_FEATURES.length) {
        fitted = { ...p.blend, fitted_at: rows[0].fitted_at, metrics: rows[0].metrics };
      }
    } catch (_) { /* no calibration stored yet */ }

    const data: UfcCtxData = {
      elo: built.elo,
      nameIndex,
      bio,
      career,
      style,
      derived,
      lastFight,
      fightsUsed: built.used,
      historyThrough: built.through,
      fitted,
      index: buildMarketIndex([]),
    };
    return {
      status: "ok",
      dataAsOf: built.through,
      featureSnapshotId: `${UFC_MODEL_VERSION}:${built.through ?? "na"}:${built.used}`,
      detail: optionalMissing.length ? `optional tables unavailable: ${optionalMissing.join(", ")}` : undefined,
      missing: optionalMissing.length ? optionalMissing : undefined,
      data: data as unknown as Record<string, unknown>,
    };
  },

  async buildEvents(deps, marketRows, ctx) {
    const skipped: SkipEntry[] = [];
    const events: Array<{ event: EventContext; market: MarketContext }> = [];
    const idx = buildMarketIndex(marketRows);
    if (ctx.status === "ok") (ctx.data as unknown as UfcCtxData).index = idx;

    const all = Object.values(idx.byEvent)
      .sort((a, b) => String(a.commence_time ?? "").localeCompare(String(b.commence_time ?? "")));

    if (ctx.status !== "ok") {
      for (const ev of all) {
        skipped.push({ event_id: ev.event_id, label: `${ev.away_team} vs ${ev.home_team}`, reason: "model_context_failed", detail: ctx.detail });
      }
      return { events, skipped, scheduled: all.length };
    }

    const d = ctx.data as unknown as UfcCtxData;
    for (const ev of all) {
      if (!ev.h2hHome && !ev.h2hAway) {
        skipped.push({ event_id: ev.event_id, label: `${ev.away_team} vs ${ev.home_team}`, reason: "missing_market", detail: "no h2h captured" });
        continue;
      }
      const claimed = claimById(idx, ev.event_id);
      if (!claimed) {
        skipped.push({ event_id: ev.event_id, label: `${ev.away_team} vs ${ev.home_team}`, reason: "duplicate_event", detail: "event already claimed this run" });
        continue;
      }
      /* A rematch is a DIFFERENT event with the same two names. Identity is the
         event_id, so the pair is never used to look anything up — the same two
         fighters meeting twice produce two independent predictions. */
      const rh = resolveName(d.nameIndex, ev.home_team);
      const ra = resolveName(d.nameIndex, ev.away_team);
      if (!rh.ok || !ra.ok || rh.id === ra.id) {
        const detail = [
          !rh.ok ? `${ev.home_team}: ${rh.reason}` : "",
          !ra.ok ? `${ev.away_team}: ${ra.reason}` : "",
          (rh.ok && ra.ok && rh.id === ra.id) ? "both corners resolved to the same fighter" : "",
        ].filter(Boolean).join("; ");
        skipped.push({ event_id: ev.event_id, label: `${ev.away_team} vs ${ev.home_team}`, reason: "missing_participant", detail: `unresolved in ufc.fighters: ${detail}` });
        continue;
      }
      events.push({
        event: {
          event_id: ev.event_id,
          sport_key: ev.sport_key || UFC_SPORT_KEY,
          commence_time: ev.commence_time,
          home_team: ev.home_team,
          away_team: ev.away_team,
          extra: { homeId: rh.id, awayId: ra.id, homeHow: rh.how, awayHow: ra.how },
        },
        market: { event: claimed },
      });
    }
    return { events, skipped, scheduled: all.length };
  },

  validateContext(event, ctx): ValidationResult {
    if (ctx.status !== "ok") return { ok: false, reason: "model_context_failed", detail: ctx.detail };
    const d = ctx.data as unknown as UfcCtxData;
    const x = event.extra as any;
    const minBouts = envNum("UFC_MIN_FIGHTER_BOUTS", 3);
    const ha = matchesOf(d.elo, x.homeId);
    const aa = matchesOf(d.elo, x.awayId);
    if (ha < minBouts || aa < minBouts) {
      return {
        ok: false,
        reason: "insufficient_sample",
        detail: `rated bouts: ${event.home_team}=${ha}, ${event.away_team}=${aa} (need >= ${minBouts} each)`,
      };
    }
    return { ok: true };
  },

  async predict(event, market, ctx): Promise<ModelPrediction[]> {
    const d = ctx.data as unknown as UfcCtxData;
    const x = event.extra as any;
    const ev = market.event;

    const { values, missing } = matchupFeatures(d, x.homeId, x.awayId, event.commence_time);
    let pHome = eloProb(values[0], d.elo.params.scale);
    let basis = "fighter_elo";
    const fitVec = FIT_INDEX.map((i) => values[i]);
    if (d.fitted && d.fitted.weights.length === fitVec.length) {
      pHome = applyFit(d.fitted, fitVec);
      basis = "fitted_logistic_matchup";
    } else {
      missing.push("fitted_matchup_weights (run ?calibrate=1)");
    }
    /* The career-average matchup terms are never applied. They are computed and
       stored, and they stay unapplied until a time-sliced stats source exists —
       see UFC_FIT_FEATURES for why. */
    missing.push("as_of_date_career_stats (career averages cannot be applied without leakage)");

    missing.push("short_notice_flag", "weigh_in_result", "camp_status");

    const boutsH = matchesOf(d.elo, x.homeId);
    const boutsA = matchesOf(d.elo, x.awayId);
    const thin = boutsH < 6 || boutsA < 6;
    const quality = thin || !d.career.has(x.homeId) || !d.career.has(x.awayId) ? "LOW" : "MEDIUM";

    const detail: Record<string, unknown> = {
      basis,
      home_elo: +ratingOf(d.elo, x.homeId).toFixed(1),
      away_elo: +ratingOf(d.elo, x.awayId).toFixed(1),
      home_rated_bouts: boutsH,
      away_rated_bouts: boutsA,
      matchup: Object.fromEntries(UFC_FEATURES.map((k, i) => [k, +values[i].toFixed(4)])),
      fit_features: d.fitted ? UFC_FIT_FEATURES : null,
      features_computed_not_applied: UFC_FEATURES.filter((f) =>
        !d.fitted ? f !== "elo_diff" : UFC_FIT_FEATURES.indexOf(f) < 0
      ),
      name_match: { home: x.homeHow, away: x.awayHow },
      history_through: d.historyThrough,
    };

    const out: ModelPrediction[] = [];
    if (ev.h2hHome) out.push({ market: "h2h", selection: ev.home_team, point: null, model_prob: pHome, context_quality: quality, missing_features: missing, detail });
    if (ev.h2hAway) out.push({ market: "h2h", selection: ev.away_team, point: null, model_prob: 1 - pHome, context_quality: quality, missing_features: missing, detail });
    return out;
  },

  telemetryExtra(_rows, ctx) {
    if (ctx.status !== "ok") return { rated_fighters: 0 };
    const d = ctx.data as unknown as UfcCtxData;
    return {
      rated_fighters: d.elo.rating.size,
      bouts_used: d.fightsUsed,
      history_through: d.historyThrough,
      career_stats_rows: d.career.size,
      style_rows: d.style.size,
      derived_rows: d.derived.size,
      parameters: d.fitted ? "calibrated" : "elo_only (no fitted matchup weights stored)",
      unsupported_markets: ["method_of_victory", "fight_goes_distance", "round_props", "totals", "sig_strike_props", "takedown_props"],
    };
  },
};
