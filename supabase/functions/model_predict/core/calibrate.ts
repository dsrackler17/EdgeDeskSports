// ============================================================================
// EdgeDesk : model_predict / core / calibrate
//
// Where a model's feature weights come from. Nowhere else.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a feature may influence a probability
// only if a coefficient for it was fitted on outcomes the model could not see
// at prediction time. Everything here is WALK-FORWARD — features for a match
// are computed from the state BEFORE that match, then the state is updated —
// and the holdout is the chronological tail, never a random split.
//
// WHAT IS DELIBERATELY EXCLUDED, AND WHY.
// UFC's career striking and grappling averages (SLpM, takedown defence, style
// indices) are career-TO-DATE values as of today. Using them to predict a fight
// from 2019 lets the model see how that fight went. There is no time-sliced
// version of those columns in the ufc schema and none can be reconstructed from
// ufc.fighter_fights, which carries no strike counts. So they are computed and
// stored on every prediction for audit, and they are NOT fitted and NOT applied.
// Fitting them would produce a model that looks excellent in backtest and is
// worth nothing live, which is the single most common way a sports model lies.
//
// Tennis rankings are excluded from the fit for the same reason:
// tennis.rankings_current holds today's ranking only. Ranking still does real
// work as a COLD START for players with too few matches to rate, where it is
// applied to an upcoming match and is not retrospective.
//
// MLB is not calibratable here: mlb_runs_v1.2_nbinom_dh is a frozen baseline
// and its constants change only through a new model version. NFL and WNBA have
// no owned history to fit against at all.
// ============================================================================

import type { ModelDeps, SportPredictionModel } from "./types.ts";
import { fitLogistic, metrics, reliability, type FitResult } from "./fit.ts";
import { eloProb } from "./odds.ts";
import { newElo, ratingOf, matchesOf, updateElo, blendedRating, daysBetween, type EloState } from "./elo.ts";
import { ATP_PARAMS } from "../models/atp.ts";
import { WTA_PARAMS } from "../models/wta.ts";
import { normSurface, TENNIS_FIT_FEATURES, type TennisMatchRow, type TourParams } from "../models/tennis_engine.ts";
import { UFC_FIT_FEATURES, UFC_MODEL_VERSION } from "../models/ufc.ts";

export interface CalibrateResult {
  ok: boolean;
  model_version?: string;
  reason?: string;
  fit?: {
    features: string[];
    weights: number[];
    intercept: number;
    n_train: number;
    n_test: number;
    train: unknown;
    test: unknown;
    converged: boolean;
  };
  /** the self-calibrating baseline's score on the same holdout, so a fit that
   *  does not beat plain Elo can be seen to not beat plain Elo */
  baseline?: unknown;
  reliability?: unknown;
  written?: boolean;
  note?: string;
}

export interface CalibrateDeps {
  dry: boolean;
  upsert?: (table: string, rows: unknown[], onConflict: string, resolution?: "merge-duplicates" | "ignore-duplicates") => Promise<number>;
}

export async function calibrate(
  deps: ModelDeps,
  registryKey: string,
  model: SportPredictionModel,
  opts: { dry: boolean; upsert?: CalibrateDeps["upsert"] },
): Promise<CalibrateResult> {
  if (registryKey === "baseball_mlb") {
    return {
      ok: false,
      model_version: model.modelVersion,
      reason: "mlb_runs_v1.2_nbinom_dh is a frozen baseline. Its constants change only by cutting a new model version, never by refitting in place.",
    };
  }
  if (registryKey === "americanfootball_nfl" || registryKey === "basketball_wnba") {
    return {
      ok: false,
      model_version: model.modelVersion,
      reason: `No owned historical result table for ${registryKey}. Populate the team-features table and a game-results history before calibration is meaningful.`,
    };
  }
  if (registryKey === "tennis_atp") return calibrateTennis(deps, ATP_PARAMS, opts);
  if (registryKey === "tennis_wta") return calibrateTennis(deps, WTA_PARAMS, opts);
  if (registryKey === "mma_mixed_martial_arts") return calibrateUfc(deps, opts);
  return { ok: false, reason: `no calibration routine for ${registryKey}` };
}

async function pagedSchema(deps: ModelDeps, schema: string, base: string, order: string, maxPages = 60): Promise<any[]> {
  const out: any[] = [];
  const PAGE = 1000;
  for (let p = 0; p < maxPages; p++) {
    const rows = await deps.sbGetSchema(schema, `${base}&order=${order}&limit=${PAGE}&offset=${p * PAGE}`);
    if (!rows || !rows.length) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tennis
// ---------------------------------------------------------------------------

async function calibrateTennis(
  deps: ModelDeps,
  params: TourParams,
  opts: { dry: boolean; upsert?: CalibrateDeps["upsert"] },
): Promise<CalibrateResult> {
  const cutoff = new Date(deps.now.getTime() - params.historyYears * 365.25 * 86400000)
    .toISOString().slice(0, 10);
  let matches: TennisMatchRow[];
  try {
    matches = await pagedSchema(
      deps, "tennis",
      `matches?select=match_id,match_date,tourney_name,surface,level,round,winner_id,loser_id,minutes&tour=eq.${params.tour}&match_date=gte.${cutoff}`,
      "match_date.asc,match_id.asc",
    ) as TennisMatchRow[];
  } catch (e) {
    return { ok: false, model_version: params.modelVersion, reason: String((e as Error)?.message ?? e) };
  }
  if (matches.length < 2000) {
    return {
      ok: false,
      model_version: params.modelVersion,
      reason: `only ${matches.length} ${params.tour} matches in the last ${params.historyYears}y; need >= 2000 to fit and still hold out a tail.`,
    };
  }

  matches.sort((a, b) =>
    String(a.match_date).localeCompare(String(b.match_date)) ||
    String(a.match_id ?? "").localeCompare(String(b.match_id ?? "")));

  const overall = newElo(params.elo);
  const bySurface: Record<string, EloState> = {};
  const recent = new Map<string, Array<{ date: string; won: boolean; minutes: number | null }>>();
  const h2h = new Map<string, { a: number; b: number }>();

  const rows: number[][] = [];
  const labels: number[] = [];
  const baselineProbs: number[] = [];

  for (const m of matches) {
    const w = m.winner_id != null ? String(m.winner_id) : "";
    const l = m.loser_id != null ? String(m.loser_id) : "";
    if (!w || !l || w === l) continue;
    const date = String(m.match_date);
    const surf = normSurface(m.surface);

    /* Side A is the alphabetically-first id. Deterministic, and independent of
       who won, so the label is not encoded in the ordering. */
    const A = w < l ? w : l;
    const B = w < l ? l : w;
    const label = A === w ? 1 : 0;

    const sA = strengthAt(overall, bySurface, params, A, surf);
    const sB = strengthAt(overall, bySurface, params, B, surf);
    const rated = matchesOf(overall, A) >= params.minMatches && matchesOf(overall, B) >= params.minMatches;

    if (rated) {
      const fA = formAt(recent, A, date);
      const fB = formAt(recent, B, date);
      const hk = A + "|" + B;
      const hh = h2h.get(hk) ?? { a: 0, b: 0 };
      rows.push([
        sA.rating - sB.rating,
        sA.surfaceRating - sB.surfaceRating,
        (fA.rest ?? 0) - (fB.rest ?? 0),
        fA.matches14 - fB.matches14,
        (fA.form10 ?? 0.5) - (fB.form10 ?? 0.5),
        hh.a - hh.b,
      ]);
      labels.push(label);
      baselineProbs.push(eloProb(sA.rating - sB.rating, params.elo.scale));
    }

    // ---- state update happens AFTER the features are read ----
    updateElo(overall, w, l, date);
    if (surf !== "unknown") {
      const st = bySurface[surf] || (bySurface[surf] = newElo(params.elo));
      updateElo(st, w, l, date);
    }
    const mins = m.minutes != null && Number.isFinite(+m.minutes) ? +m.minutes : null;
    pushForm(recent, w, { date, won: true, minutes: mins });
    pushForm(recent, l, { date, won: false, minutes: mins });
    const hk2 = w < l ? w + "|" + l : l + "|" + w;
    const cur = h2h.get(hk2) ?? { a: 0, b: 0 };
    if (w < l) cur.a++; else cur.b++;
    h2h.set(hk2, cur);
  }

  if (rows.length < 500) {
    return {
      ok: false,
      model_version: params.modelVersion,
      reason: `only ${rows.length} matches had both players rated (>= ${params.minMatches} career matches). Load more history.`,
    };
  }

  const fit = fitLogistic(TENNIS_FIT_FEATURES, rows, labels, { l2: 2.0, iterations: 6000, learningRate: 0.2 });
  if (!fit) return { ok: false, model_version: params.modelVersion, reason: "fit did not converge on a usable sample" };

  const nTest = fit.nTest;
  const baselineTail = baselineProbs.slice(baselineProbs.length - nTest);
  const labelTail = labels.slice(labels.length - nTest);
  const baseline = metrics(baselineTail, labelTail);

  const written = await storeParams(opts, params.modelVersion, {
    elo: params.elo,
    surface_max_weight: params.surfaceMaxWeight,
    blend: {
      featureNames: fit.featureNames,
      weights: fit.weights,
      intercept: fit.intercept,
      mean: fit.mean,
      sd: fit.sd,
    },
  }, fit, baseline);

  return {
    ok: true,
    model_version: params.modelVersion,
    fit: summarise(fit),
    baseline,
    reliability: reliability(baselineTail, labelTail),
    written,
    note: fit.test.logLoss < (baseline as { logLoss: number }).logLoss
      ? "fitted model beats plain Elo on the holdout"
      : "fitted model does NOT beat plain Elo on the holdout — it is stored, but predict() will still be strictly worse than the baseline until the feature set improves. Consider deleting the model_parameters row.",
  };
}

function strengthAt(
  overall: EloState,
  bySurface: Record<string, EloState>,
  params: TourParams,
  id: string,
  surface: string,
) {
  const o = ratingOf(overall, id);
  const st = bySurface[surface];
  const sMatches = st ? matchesOf(st, id) : 0;
  const sRating = st ? ratingOf(st, id) : o;
  const b = blendedRating(o, sRating, sMatches, params.surfaceMaxWeight, params.surfaceFullAt);
  return { rating: b.rating, surfaceRating: sRating, overall: o };
}

function pushForm(
  map: Map<string, Array<{ date: string; won: boolean; minutes: number | null }>>,
  id: string,
  row: { date: string; won: boolean; minutes: number | null },
) {
  const arr = map.get(id) ?? [];
  arr.push(row);
  if (arr.length > 40) arr.shift();
  map.set(id, arr);
}

function formAt(
  map: Map<string, Array<{ date: string; won: boolean; minutes: number | null }>>,
  id: string,
  asOf: string,
) {
  const hist = map.get(id) ?? [];
  const last = hist.length ? hist[hist.length - 1] : null;
  const rest = last ? daysBetween(last.date, asOf) : null;
  const t = Date.parse(asOf);
  let m14 = 0, wins = 0, n = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const d = Date.parse(hist[i].date);
    if (Number.isFinite(t) && Number.isFinite(d)) {
      const days = (t - d) / 86400000;
      if (days >= 0 && days <= 14) m14++;
    }
    if (n < 10) { n++; if (hist[i].won) wins++; }
  }
  return { rest, matches14: m14, form10: n ? wins / n : null };
}

// ---------------------------------------------------------------------------
// UFC
// ---------------------------------------------------------------------------

async function calibrateUfc(
  deps: ModelDeps,
  opts: { dry: boolean; upsert?: CalibrateDeps["upsert"] },
): Promise<CalibrateResult> {
  let fights: any[];
  let fighters: any[];
  try {
    fights = await pagedSchema(deps, "ufc", "fighter_fights?select=fighter_id,opponent_id,date,winner", "date.asc", 40);
    fighters = await pagedSchema(deps, "ufc", "fighters?select=fighter_id,stance,reach_inches,age", "fighter_id", 20);
  } catch (e) {
    return { ok: false, model_version: UFC_MODEL_VERSION, reason: String((e as Error)?.message ?? e) };
  }

  const bio = new Map<string, { stance: string; reach: number | null; age: number | null }>();
  for (const f of fighters) {
    if (f?.fighter_id == null) continue;
    bio.set(String(f.fighter_id), {
      stance: String(f.stance ?? "").toLowerCase(),
      reach: f.reach_inches != null && Number.isFinite(+f.reach_inches) ? +f.reach_inches : null,
      age: f.age != null && Number.isFinite(+f.age) ? +f.age : null,
    });
  }

  // Deduplicate the two corner rows per bout, exactly as the model does.
  let idLike = 0, resultLike = 0;
  for (const r of fights) {
    const s = String(r?.winner ?? "").toLowerCase();
    if (s === "win" || s === "loss" || s === "w" || s === "l") resultLike++;
    else if (String(r?.fighter_id) === String(r?.winner) || String(r?.opponent_id) === String(r?.winner)) idLike++;
  }
  const semantics = idLike >= resultLike && idLike > 0 ? "winner_id" : resultLike > 0 ? "result_string" : "unknown";
  if (semantics === "unknown") {
    return { ok: false, model_version: UFC_MODEL_VERSION, reason: "ufc.fighter_fights.winner is neither a fighter id nor a W/L result" };
  }

  const seen = new Set<string>();
  const bouts: Array<{ date: string; winner: string; loser: string }> = [];
  for (const r of fights) {
    const a = r?.fighter_id != null ? String(r.fighter_id) : "";
    const b = r?.opponent_id != null ? String(r.opponent_id) : "";
    const date = r?.date ? String(r.date) : "";
    if (!a || !b || a === b || !date) continue;
    const key = (a < b ? a + "|" + b : b + "|" + a) + "|" + date;
    if (seen.has(key)) continue;
    let winner: string | null = null;
    if (semantics === "winner_id") {
      const w = String(r.winner ?? "");
      if (w === a) winner = a; else if (w === b) winner = b;
    } else {
      const s = String(r.winner ?? "").toLowerCase();
      if (s === "win" || s === "w") winner = a; else if (s === "loss" || s === "l") winner = b;
    }
    if (!winner) continue;
    seen.add(key);
    bouts.push({ date, winner, loser: winner === a ? b : a });
  }
  bouts.sort((x, y) => x.date.localeCompare(y.date));

  if (bouts.length < 1500) {
    return { ok: false, model_version: UFC_MODEL_VERSION, reason: `only ${bouts.length} resolvable bouts; need >= 1500.` };
  }

  const elo = newElo({ initial: 1500, kFactor: 120, kShift: 4, kDecay: 0.35, scale: 400 });
  const lastFight = new Map<string, string>();
  const rows: number[][] = [];
  const labels: number[] = [];
  const baselineProbs: number[] = [];
  const nowMs = deps.now.getTime();

  for (const b of bouts) {
    const A = b.winner < b.loser ? b.winner : b.loser;
    const B = b.winner < b.loser ? b.loser : b.winner;
    const label = A === b.winner ? 1 : 0;

    if (matchesOf(elo, A) >= 3 && matchesOf(elo, B) >= 3) {
      const bioA = bio.get(A), bioB = bio.get(B);
      const eloDiff = ratingOf(elo, A) - ratingOf(elo, B);
      const reach = (bioA?.reach ?? 0) - (bioB?.reach ?? 0);
      /* Age is reconstructed AS OF the bout: the stored age is today's, so the
         years elapsed since the fight are subtracted back off. Using today's
         age directly would leak the passage of time into an old fight. */
      const yearsAgo = (nowMs - Date.parse(b.date)) / (365.25 * 86400000);
      const ageA = bioA?.age != null ? bioA.age - yearsAgo : null;
      const ageB = bioB?.age != null ? bioB.age - yearsAgo : null;
      const ageDiff = (ageA ?? 0) - (ageB ?? 0);
      const layA = daysBetween(lastFight.get(A) ?? null, b.date);
      const layB = daysBetween(lastFight.get(B) ?? null, b.date);
      const layoff = (layA ?? 0) - (layB ?? 0);
      let stance = 0;
      if (bioA?.stance && bioB?.stance) {
        const aS = bioA.stance.indexOf("southpaw") >= 0;
        const bS = bioB.stance.indexOf("southpaw") >= 0;
        stance = aS === bS ? 0 : (aS ? 1 : -1);
      }
      rows.push([eloDiff, reach, ageDiff, layoff, stance]);
      labels.push(label);
      baselineProbs.push(eloProb(eloDiff, 400));
    }

    updateElo(elo, b.winner, b.loser, b.date);
    lastFight.set(b.winner, b.date);
    lastFight.set(b.loser, b.date);
  }

  if (rows.length < 500) {
    return { ok: false, model_version: UFC_MODEL_VERSION, reason: `only ${rows.length} bouts had both fighters rated. Load more history.` };
  }

  const fit = fitLogistic(UFC_FIT_FEATURES, rows, labels, { l2: 2.0, iterations: 6000, learningRate: 0.2 });
  if (!fit) return { ok: false, model_version: UFC_MODEL_VERSION, reason: "fit did not converge on a usable sample" };

  const baselineTail = baselineProbs.slice(baselineProbs.length - fit.nTest);
  const labelTail = labels.slice(labels.length - fit.nTest);
  const baseline = metrics(baselineTail, labelTail);

  const written = await storeParams(opts, UFC_MODEL_VERSION, {
    blend: {
      featureNames: fit.featureNames,
      weights: fit.weights,
      intercept: fit.intercept,
      mean: fit.mean,
      sd: fit.sd,
    },
  }, fit, baseline);

  return {
    ok: true,
    model_version: UFC_MODEL_VERSION,
    fit: summarise(fit),
    baseline,
    reliability: reliability(baselineTail, labelTail),
    written,
    note: "career striking/grappling/style features are deliberately NOT fitted: ufc.fighter_career_stats holds career-to-date values only, so using them on a past bout would leak that bout's result into its own prediction. They remain in model_detail for audit.",
  };
}

function summarise(fit: FitResult) {
  return {
    features: fit.featureNames,
    weights: fit.weights.map((w) => +w.toFixed(5)),
    intercept: +fit.intercept.toFixed(5),
    n_train: fit.nTrain,
    n_test: fit.nTest,
    train: fit.train,
    test: fit.test,
    converged: fit.converged,
  };
}

async function storeParams(
  opts: { dry: boolean; upsert?: CalibrateDeps["upsert"] },
  modelVersion: string,
  params: Record<string, unknown>,
  fit: FitResult,
  baseline: unknown,
): Promise<boolean> {
  if (opts.dry || !opts.upsert) return false;
  await opts.upsert("model_parameters", [{
    model_version: modelVersion,
    param_set: "default",
    params,
    n_train: fit.nTrain,
    n_test: fit.nTest,
    metrics: { train: fit.train, test: fit.test, baseline },
  }], "model_version,param_set", "merge-duplicates");
  return true;
}
