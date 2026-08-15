// ============================================================================
// EdgeDesk : model_predict / models / tennis_engine
//
// One engine, two tours, two independently parameterised models. ATP and WTA
// share this code and share NOTHING else: separate model versions, separate
// Elo parameter sets, separate rank priors, separate calibration runs, separate
// telemetry. `wta_match_v1` is not `atp_match_v1` with a different sport key —
// it is fitted on WTA results and evaluated on WTA results.
//
// DATA. The isolated `tennis` Postgres schema (accept-profile: tennis) that the
// app's Tennis deep-dive already reads:
//     tennis.players           player_id, full_name, plays, height_cm, birth_date, tour
//     tennis.matches           match_id, match_date, tourney_name, surface, level,
//                              round, winner_id, loser_id, score, minutes, tour
//     tennis.rankings_current  player_id, rank, points, as_of, tour
// Everything below is derived from those three tables. No new provider.
//
// MATHEMATICS.
//   1. Surface-blended Elo is the baseline. It is self-calibrating: the ratings
//      come out of the results, so there is no weight anyone had to invent.
//   2. Where the match table also carries serve counters, a hierarchical
//      point -> game -> set -> match model (Barnett & Clarke) is computed in
//      CLOSED FORM — no simulation needed, and none used. It is reported as a
//      diagnostic and only enters the headline probability once a fitted blend
//      weight exists.
//   3. Fatigue, H2H and rank features are computed and stored on every row, but
//      they move the probability only through coefficients fitted on this
//      tour's own history (?calibrate=1). Until that has been run they are
//      reported as `available_not_applied` rather than silently weighted.
//
// MARKETS. Match winner (h2h) only. Tennis spreads and totals are games/sets
// lines that EdgeDesk's grader explicitly cannot settle — app.html drops them
// from the record for exactly that reason — so predicting them would create
// rows that can never be scored. They return unsupported_by_model.
// ============================================================================

import type {
  DataContractEntry,
  EventContext,
  MarketContext,
  MarketEvent,
  ModelContext,
  ModelDeps,
  ModelPrediction,
  SkipEntry,
  SportPredictionModel,
  ValidationResult,
} from "../core/types.ts";
import { buildNameIndex, resolveName, type NameIndex } from "../core/names.ts";
import { blendedRating, daysBetween, DEFAULT_ELO, type EloParams, type EloState, newElo, ratingOf, matchesOf, updateElo } from "../core/elo.ts";
import { eloProb } from "../core/odds.ts";
import { applyFit, fitLine } from "../core/fit.ts";
import { claimById } from "../core/identity.ts";
import { buildMarketIndex } from "../core/market.ts";

export type Tour = "ATP" | "WTA";

export interface TourParams {
  tour: Tour;
  modelVersion: string;
  uiLabel: string;
  sportKey: string;
  sportKeyPrefixes: string[];
  /** starting point when no calibrated set has been stored for this tour */
  elo: EloParams;
  /** ceiling on how much of the rating the surface split may own */
  surfaceMaxWeight: number;
  /** surface matches at which surfaceMaxWeight is reached */
  surfaceFullAt: number;
  /** below this many career matches the rating is rank-anchored instead */
  minMatches: number;
  /** how far back the match history read reaches */
  historyYears: number;
}

export interface TennisMatchRow {
  match_id?: string | number;
  match_date: string;
  surface?: string | null;
  level?: string | null;
  round?: string | null;
  tourney_name?: string | null;
  winner_id: string;
  loser_id: string;
  minutes?: number | null;
  [k: string]: unknown;
}

export interface TennisCtxData {
  params: TourParams;
  overall: EloState;
  bySurface: Record<string, EloState>;
  nameIndex: NameIndex;
  playerById: Map<string, { id: string; name: string; plays?: string | null; birth_date?: string | null }>;
  rank: Map<string, { rank: number; points: number | null }>;
  /** empirical rank -> Elo mapping, fitted on this tour's own rated players */
  rankPrior: { a: number; b: number; n: number } | null;
  /** last N matches per player, newest first, for fatigue and form */
  recent: Map<string, Array<{ date: string; won: boolean; minutes: number | null; surface: string; opponent: string }>>;
  h2h: Map<string, { w: number; l: number }>;
  /** normalised tournament name -> most recent surface it was played on */
  tourneySurfaces: Map<string, string>;
  serveAvailable: boolean;
  serveColumns: string[];
  fittedBlend: FittedBlend | null;
  matchCount: number;
  lastMatchDate: string | null;
  index: ReturnType<typeof buildMarketIndex>;
}

export interface FittedBlend {
  featureNames: string[];
  weights: number[];
  intercept: number;
  mean: number[];
  sd: number[];
  fitted_at?: string;
  n_train?: number;
  metrics?: unknown;
}

/** Surfaces are normalised to the four the tour actually plays. An unknown or
 *  null surface becomes "unknown" and is never folded into hard, because a
 *  guessed surface is a guessed model. */
export function normSurface(s: unknown): string {
  const v = String(s ?? "").trim().toLowerCase();
  if (!v) return "unknown";
  if (v.indexOf("clay") >= 0) return "clay";
  if (v.indexOf("grass") >= 0) return "grass";
  if (v.indexOf("carpet") >= 0) return "carpet";
  if (v.indexOf("hard") >= 0) return v.indexOf("indoor") >= 0 ? "indoor_hard" : "hard";
  return "unknown";
}

function h2hKey(a: string, b: string): string {
  return a < b ? a + "|" + b : b + "|" + a;
}

// ---------------------------------------------------------------------------
// Hierarchical serve model, closed form (Barnett & Clarke).
//
// Used only when the match table carries serve counters. Deterministic, no RNG:
// tennis scoring is a small enough Markov chain to solve exactly, so simulating
// it would add sampling error for nothing.
// ---------------------------------------------------------------------------

/** P(server wins a game) given P(server wins a point) = p. */
export function gameWinProb(p: number): number {
  if (!(p > 0 && p < 1)) return p >= 1 ? 1 : 0;
  const q = 1 - p;
  // Deuce is absorbing: from 40-40, P(win) = p^2 / (p^2 + q^2).
  const dz = p * p + q * q;
  const pDeuce = dz > 0 ? (p * p) / dz : 0.5;
  // Enumerate the ways to reach each terminal score.
  const c = (n: number, k: number) => {
    let r = 1;
    for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
    return r;
  };
  let win = 0;
  // Win to love / 15 / 30: server takes 4 points while receiver takes j<3.
  for (let j = 0; j <= 2; j++) win += c(3 + j, j) * Math.pow(p, 4) * Math.pow(q, j);
  // Reach deuce (3-3) then win from there.
  win += c(6, 3) * Math.pow(p, 3) * Math.pow(q, 3) * pDeuce;
  return win;
}

/** P(player A wins a tiebreak) given both point-on-serve probabilities.
 *  Serving order is the standard 1-2-2, solved by forward DP over point states. */
export function tiebreakWinProb(pa: number, pb: number, aServesFirst = true): number {
  const memo = new Map<string, number>();
  const serverIsA = (n: number): boolean => {
    // Point n (0-indexed): A serves point 0, then pairs alternate.
    const block = Math.floor((n + 1) / 2) % 2;
    const aServes = block === 0;
    return aServesFirst ? aServes : !aServes;
  };
  const rec = (a: number, b: number): number => {
    if (a >= 7 && a - b >= 2) return 1;
    if (b >= 7 && b - a >= 2) return 0;
    if (a >= 6 && b >= 6) {
      // From 6-6 the two-point cycle is symmetric in service; solve the pair.
      // P(A wins a two-point cycle) with A serving one and B serving one.
      const w = pa * (1 - pb); // A wins both
      const l = (1 - pa) * pb; // B wins both
      const dz = w + l;
      return dz > 0 ? w / dz : 0.5;
    }
    const key = a + ":" + b;
    const hit = memo.get(key);
    if (hit != null) return hit;
    const p = serverIsA(a + b) ? pa : 1 - pb;
    const v = p * rec(a + 1, b) + (1 - p) * rec(a, b + 1);
    memo.set(key, v);
    return v;
  };
  return rec(0, 0);
}

/** P(player A wins a set) from both hold probabilities and both point-on-serve
 *  probabilities (the latter only for the tiebreak). Averaged over who serves
 *  first, because the draw does not tell us. */
export function setWinProb(holdA: number, holdB: number, pa: number, pb: number): number {
  const solve = (aServesFirst: boolean): number => {
    const memo = new Map<string, number>();
    const tb = tiebreakWinProb(pa, pb, aServesFirst);
    const rec = (a: number, b: number): number => {
      if (a === 6 && b <= 4) return 1;
      if (b === 6 && a <= 4) return 0;
      if (a === 7) return 1;
      if (b === 7) return 0;
      if (a === 6 && b === 6) return tb;
      const key = a + ":" + b;
      const hit = memo.get(key);
      if (hit != null) return hit;
      const aServes = ((a + b) % 2 === 0) === aServesFirst;
      const pAWinsGame = aServes ? holdA : 1 - holdB;
      const v = pAWinsGame * rec(a + 1, b) + (1 - pAWinsGame) * rec(a, b + 1);
      memo.set(key, v);
      return v;
    };
    return rec(0, 0);
  };
  return 0.5 * (solve(true) + solve(false));
}

/** P(A wins the match) from P(A wins a set). */
export function matchWinProb(s: number, bestOf: 3 | 5): number {
  if (bestOf === 5) return s * s * s * (1 + 3 * (1 - s) + 6 * (1 - s) * (1 - s));
  return s * s * (1 + 2 * (1 - s));
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

async function pagedSchema(deps: ModelDeps, schema: string, base: string, order: string, maxPages = 40): Promise<any[]> {
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

const SERVE_PATTERNS = [
  /^w_(ace|df|svpt|1st|2nd|sv|bp)/i,
  /^l_(ace|df|svpt|1st|2nd|sv|bp)/i,
];

function detectServeColumns(sample: Record<string, unknown> | undefined): string[] {
  if (!sample) return [];
  return Object.keys(sample).filter((k) => SERVE_PATTERNS.some((re) => re.test(k)));
}

export function contractFor(tour: Tour): DataContractEntry[] {
  return [
    { feature: "match results (winner/loser, date, surface, round, level)", source: `tennis.matches (tour=${tour})`, sourceClass: "AVAILABLE_NOW", updateFrequency: "per licensed load", historicalDepth: "as loaded", reliability: "licensed match facts", critical: true },
    { feature: "player identity, handedness, birth date", source: `tennis.players (tour=${tour})`, sourceClass: "AVAILABLE_NOW", updateFrequency: "per licensed load", historicalDepth: "full", reliability: "licensed", critical: true },
    { feature: "current ranking and points", source: `tennis.rankings_current (tour=${tour})`, sourceClass: "AVAILABLE_NOW", updateFrequency: "weekly", historicalDepth: "current only", reliability: "official tour", critical: false },
    { feature: "surface-specific strength", source: "derived from tennis.matches by surface", sourceClass: "AVAILABLE_NOW", updateFrequency: "with matches", historicalDepth: "as loaded", reliability: "derived", critical: false },
    { feature: "recent load / days since last match / minutes played", source: "derived from tennis.matches (match_date, minutes)", sourceClass: "AVAILABLE_NOW", updateFrequency: "with matches", historicalDepth: "as loaded", reliability: "derived; minutes may be null on older rows", critical: false },
    { feature: "head-to-head, surface-specific", source: "derived from tennis.matches", sourceClass: "AVAILABLE_NOW", updateFrequency: "with matches", historicalDepth: "as loaded", reliability: "derived; samples are usually tiny", critical: false },
    { feature: "serve/return counters (aces, DF, 1st in/won, 2nd won, BP saved/faced, service games)", source: "tennis.matches serve columns, probed at runtime", sourceClass: "AVAILABLE_NOW", updateFrequency: "with matches", historicalDepth: "as loaded", reliability: "present only if the licensed load carried them", critical: false },
    { feature: "indoor/outdoor flag", source: "not present in the loaded schema", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "n/a", critical: false },
    { feature: "live withdrawal / retirement status", source: "not ingested", sourceClass: "REQUIRES_NEW_PROVIDER", updateFrequency: "n/a", historicalDepth: "n/a", reliability: "n/a", critical: false },
  ];
}

export async function loadTennisContext(deps: ModelDeps, params: TourParams): Promise<ModelContext> {
  const cutoff = new Date(deps.now.getTime() - params.historyYears * 365.25 * 86400000)
    .toISOString().slice(0, 10);

  let players: any[] = [];
  let matches: TennisMatchRow[] = [];
  let ranks: any[] = [];
  let serveColumns: string[] = [];

  try {
    players = await pagedSchema(
      deps, "tennis",
      `players?select=player_id,full_name,plays,birth_date&tour=eq.${params.tour}`,
      "full_name", 20,
    );
  } catch (e) {
    return {
      status: "insufficient_data",
      missing: ["tennis.players"],
      detail: `tennis schema unreadable: ${String((e as Error)?.message ?? e)}. Expose the "tennis" schema under Supabase > API settings > Exposed schemas.`,
    };
  }

  try {
    const probe = await deps.sbGetSchema("tennis", `matches?select=*&tour=eq.${params.tour}&limit=1`);
    serveColumns = detectServeColumns(probe?.[0]);
  } catch (_) {
    serveColumns = [];
  }

  const baseCols = "match_id,match_date,tourney_name,surface,level,round,winner_id,loser_id,minutes";
  const cols = serveColumns.length ? baseCols + "," + serveColumns.join(",") : baseCols;
  try {
    matches = await pagedSchema(
      deps, "tennis",
      `matches?select=${cols}&tour=eq.${params.tour}&match_date=gte.${cutoff}`,
      "match_date.asc,match_id.asc", 60,
    ) as TennisMatchRow[];
  } catch (e) {
    return {
      status: "insufficient_data",
      missing: ["tennis.matches"],
      detail: String((e as Error)?.message ?? e),
    };
  }

  try {
    ranks = await pagedSchema(
      deps, "tennis",
      `rankings_current?select=player_id,rank,points&tour=eq.${params.tour}`,
      "rank.asc", 5,
    );
  } catch (_) {
    ranks = [];
  }

  if (!players.length || matches.length < 500) {
    return {
      status: "insufficient_data",
      missing: [
        ...(players.length ? [] : ["tennis.players rows"]),
        ...(matches.length >= 500 ? [] : [`tennis.matches rows (have ${matches.length}, need >= 500 in the last ${params.historyYears}y)`]),
      ],
      detail: `${params.tour}: the tennis schema is reachable but not populated deeply enough to rate players. No predictions written.`,
    };
  }

  // Fitted parameters, if a calibration run has stored any for THIS version.
  let fittedBlend: FittedBlend | null = null;
  let eloParams = params.elo;
  let surfaceMaxWeight = params.surfaceMaxWeight;
  try {
    const rows = await deps.sbGet(
      `model_parameters?select=params,fitted_at,n_train,metrics&model_version=eq.${encodeURIComponent(params.modelVersion)}&param_set=eq.default&limit=1`,
    );
    const p = rows?.[0]?.params;
    if (p) {
      if (p.elo) eloParams = { ...params.elo, ...p.elo };
      if (typeof p.surface_max_weight === "number") surfaceMaxWeight = p.surface_max_weight;
      if (p.blend?.weights) {
        fittedBlend = { ...p.blend, fitted_at: rows[0].fitted_at, n_train: rows[0].n_train, metrics: rows[0].metrics };
      }
    }
  } catch (_) {
    // model_parameters is optional; its absence means "no calibration yet".
  }

  const built = buildTennisRatings(matches, { ...params, elo: eloParams, surfaceMaxWeight });

  const playerById = new Map<string, { id: string; name: string; plays?: string | null; birth_date?: string | null }>();
  for (const p of players) {
    if (!p?.player_id) continue;
    playerById.set(String(p.player_id), {
      id: String(p.player_id),
      name: String(p.full_name ?? ""),
      plays: p.plays ?? null,
      birth_date: p.birth_date ?? null,
    });
  }
  const nameIndex = buildNameIndex(
    Array.from(playerById.values()).filter((p) => p.name).map((p) => ({ id: p.id, name: p.name })),
  );

  const rank = new Map<string, { rank: number; points: number | null }>();
  for (const r of ranks) {
    if (r?.player_id == null || r?.rank == null) continue;
    rank.set(String(r.player_id), { rank: +r.rank, points: r.points != null ? +r.points : null });
  }

  /* Rank -> Elo prior, fitted on THIS tour's own rated players rather than
     assumed. Players with enough matches supply (log rank, Elo) pairs; the line
     through them is what a newcomer's rank is worth on the rating scale. */
  const xs: number[] = [], ys: number[] = [];
  for (const [pid, r] of rank) {
    if (matchesOf(built.overall, pid) >= params.minMatches && r.rank > 0) {
      xs.push(Math.log(r.rank));
      ys.push(ratingOf(built.overall, pid));
    }
  }
  const rankPrior = fitLine(xs, ys);

  const data: TennisCtxData = {
    params: { ...params, elo: eloParams, surfaceMaxWeight },
    overall: built.overall,
    bySurface: built.bySurface,
    nameIndex,
    playerById,
    rank,
    rankPrior,
    recent: built.recent,
    h2h: built.h2h,
    tourneySurfaces: built.tourneySurfaces,
    serveAvailable: serveColumns.length >= 6,
    serveColumns,
    fittedBlend,
    matchCount: matches.length,
    lastMatchDate: matches.length ? String(matches[matches.length - 1].match_date) : null,
    index: buildMarketIndex([]),
  };

  return {
    status: "ok",
    dataAsOf: data.lastMatchDate,
    featureSnapshotId: `${params.modelVersion}:${data.lastMatchDate ?? "na"}:${matches.length}`,
    data: data as unknown as Record<string, unknown>,
  };
}

/** Chronological Elo build. Exported so tests can drive it with fixtures. */
export function buildTennisRatings(matches: TennisMatchRow[], params: TourParams) {
  const overall = newElo(params.elo);
  const bySurface: Record<string, EloState> = {};
  const recent = new Map<string, Array<{ date: string; won: boolean; minutes: number | null; surface: string; opponent: string }>>();
  const h2h = new Map<string, { w: number; l: number }>();
  const tourneySurfaces = new Map<string, string>();

  const sorted = matches.slice().sort((a, b) =>
    String(a.match_date).localeCompare(String(b.match_date)) ||
    String(a.match_id ?? "").localeCompare(String(b.match_id ?? "")));

  for (const m of sorted) {
    const w = m.winner_id != null ? String(m.winner_id) : "";
    const l = m.loser_id != null ? String(m.loser_id) : "";
    if (!w || !l || w === l) continue;
    const surf = normSurface(m.surface);
    /* Matches are processed oldest-first, so the last write wins and the map
       ends up holding each tournament's MOST RECENT surface. Tournaments do
       change surface (Madrid, the Davis Cup ties); the current one is the one
       that matters for an event starting this week. */
    if (surf !== "unknown" && m.tourney_name) {
      const tk = String(m.tourney_name).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (tk) tourneySurfaces.set(tk, surf);
    }
    updateElo(overall, w, l, m.match_date);
    if (surf !== "unknown") {
      const st = bySurface[surf] || (bySurface[surf] = newElo(params.elo));
      updateElo(st, w, l, m.match_date);
    }
    const mins = m.minutes != null && Number.isFinite(+m.minutes) ? +m.minutes : null;
    pushRecent(recent, w, { date: String(m.match_date), won: true, minutes: mins, surface: surf, opponent: l });
    pushRecent(recent, l, { date: String(m.match_date), won: false, minutes: mins, surface: surf, opponent: w });
    const hk = h2hKey(w, l);
    const cur = h2h.get(hk) || { w: 0, l: 0 };
    // stored from the perspective of the alphabetically-first id
    if (w < l) cur.w++;
    else cur.l++;
    h2h.set(hk, cur);
  }
  return { overall, bySurface, recent, h2h, tourneySurfaces };
}

function pushRecent(
  map: Map<string, Array<{ date: string; won: boolean; minutes: number | null; surface: string; opponent: string }>>,
  id: string,
  row: { date: string; won: boolean; minutes: number | null; surface: string; opponent: string },
) {
  const arr = map.get(id) || [];
  arr.push(row);
  if (arr.length > 60) arr.shift();
  map.set(id, arr);
}

/** Career matches, days since last match, matches and minutes in a window. */
export function loadFeatures(d: TennisCtxData, id: string, asOfIso: string | null) {
  const hist = d.recent.get(id) || [];
  const last = hist.length ? hist[hist.length - 1] : null;
  const rest = last && asOfIso ? daysBetween(last.date, asOfIso) : null;
  let m14 = 0, min7 = 0, wins10 = 0, n10 = 0;
  const asOf = asOfIso ? Date.parse(asOfIso) : NaN;
  for (let i = hist.length - 1; i >= 0; i--) {
    const t = Date.parse(hist[i].date);
    if (Number.isFinite(asOf) && Number.isFinite(t)) {
      const days = (asOf - t) / 86400000;
      if (days >= 0 && days <= 14) m14++;
      if (days >= 0 && days <= 7 && hist[i].minutes != null) min7 += hist[i].minutes as number;
    }
    if (n10 < 10) {
      n10++;
      if (hist[i].won) wins10++;
    }
  }
  return {
    careerMatches: matchesOf(d.overall, id),
    restDays: rest,
    matches14: m14,
    minutes7: min7,
    form10: n10 ? wins10 / n10 : null,
    lastMatchDate: last?.date ?? null,
  };
}

export function h2hFor(d: TennisCtxData, a: string, b: string): { aWins: number; bWins: number } {
  const rec = d.h2h.get(h2hKey(a, b));
  if (!rec) return { aWins: 0, bWins: 0 };
  return a < b ? { aWins: rec.w, bWins: rec.l } : { aWins: rec.l, bWins: rec.w };
}

/** Strength on the rating scale for one player on one surface, plus the
 *  provenance of that number. */
export function strengthOf(d: TennisCtxData, id: string, surface: string) {
  const p = d.params;
  const careerMatches = matchesOf(d.overall, id);
  const overallRating = ratingOf(d.overall, id);
  const surfState = d.bySurface[surface];
  const surfMatches = surfState ? matchesOf(surfState, id) : 0;
  const surfRating = surfState ? ratingOf(surfState, id) : overallRating;

  const blended = blendedRating(overallRating, surfRating, surfMatches, p.surfaceMaxWeight, p.surfaceFullAt);

  if (careerMatches >= p.minMatches) {
    return {
      rating: blended.rating,
      surfaceWeight: blended.weight,
      basis: "match_history" as const,
      careerMatches,
      surfaceMatches: surfMatches,
      overallRating,
      surfaceRating: surfRating,
    };
  }

  /* Too few matches for the rating to mean anything. Anchor on the ranking via
     the empirically fitted rank -> Elo line, and shrink toward it in proportion
     to how little history there is. When there is no ranking either, the caller
     gets basis="none" and the event is skipped rather than guessed. */
  const r = d.rank.get(id);
  if (r && d.rankPrior && r.rank > 0) {
    const prior = d.rankPrior.a + d.rankPrior.b * Math.log(r.rank);
    const w = careerMatches / Math.max(1, p.minMatches);
    return {
      rating: prior * (1 - w) + blended.rating * w,
      surfaceWeight: blended.weight * w,
      basis: "rank_prior" as const,
      careerMatches,
      surfaceMatches: surfMatches,
      overallRating,
      surfaceRating: surfRating,
      rank: r.rank,
    };
  }
  return {
    rating: blended.rating,
    surfaceWeight: blended.weight,
    basis: "none" as const,
    careerMatches,
    surfaceMatches: surfMatches,
    overallRating,
    surfaceRating: surfRating,
  };
}

/**
 * The surface a captured event is being played on.
 *
 * `signals` carries no surface column, and the Odds API's tennis titles name
 * the tournament ("ATP Cincinnati Open") without saying what it is played on.
 * The surface is therefore recovered from the tour's OWN history: the most
 * recent surface this tournament was played on in tennis.matches. A tournament
 * with no history returns "unknown", and unknown falls back to the overall
 * rating rather than being defaulted to hard — quietly treating every clay
 * match as a hard-court match is exactly the kind of invisible wrong answer
 * this module exists to avoid.
 */
export function inferSurface(tourneySurfaces: Map<string, string>, sportTitle: string | null | undefined): string {
  const raw = String(sportTitle ?? "").replace(/^(atp|wta)\s+/i, "").trim().toLowerCase();
  if (!raw) return "unknown";
  const key = raw.replace(/[^a-z0-9]/g, "");
  if (!key) return "unknown";
  const direct = tourneySurfaces.get(key);
  if (direct) return direct;
  // "Cincinnati Open" vs "Cincinnati Masters": match on the longest stored name
  // that is a prefix of, or contains, the captured one.
  let best: string | null = null;
  let bestLen = 0;
  for (const [name, surf] of tourneySurfaces) {
    if (name.length < 4) continue;
    if ((key.indexOf(name) >= 0 || name.indexOf(key) >= 0) && name.length > bestLen) {
      best = surf;
      bestLen = name.length;
    }
  }
  return best ?? "unknown";
}

/**
 * The features a calibration run may fit, and therefore the only features that
 * can move a probability.
 *
 * Ranking is absent on purpose. tennis.rankings_current holds TODAY's ranking
 * and nothing else, so fitting a coefficient on it would score old matches
 * using information from after they were played. Ranking still does real work —
 * as the cold start in strengthOf() for players with too few matches to rate,
 * where it is applied to an upcoming match and is not retrospective.
 *
 * Order is part of the contract: core/calibrate.ts builds its training vectors
 * in this order and predict() builds its live vector in the same order. Editing
 * one without the other silently mismatches every weight.
 */
export const TENNIS_FIT_FEATURES = [
  "elo_diff",
  "surface_elo_diff",
  "rest_diff",
  "load14_diff",
  "form10_diff",
  "h2h_diff",
];

export function makeTennisModel(params: TourParams): SportPredictionModel {
  return {
    sportKey: params.sportKey,
    sportKeyPrefixes: params.sportKeyPrefixes,
    uiLabel: params.uiLabel,
    modelVersion: params.modelVersion,
    supportedMarkets: ["h2h"],
    dataContract: contractFor(params.tour),

    /* Match winner only. Tennis spreads (games handicaps) and totals (games/sets
       lines) are dropped from EdgeDesk's own record because the scores feed
       cannot settle them — see app.html's grading filter. A prediction that can
       never be graded is not research, it is noise with a timestamp. */
    supportsMarket(market: string): boolean {
      return market === "h2h";
    },

    loadContext: (deps) => loadTennisContext(deps, params),

    async buildEvents(deps, marketRows, ctx) {
      const skipped: SkipEntry[] = [];
      const events: Array<{ event: EventContext; market: MarketContext }> = [];
      const idx = buildMarketIndex(marketRows);
      if (ctx.status === "ok") (ctx.data as unknown as TennisCtxData).index = idx;

      const all = Object.values(idx.byEvent)
        .sort((a, b) => String(a.commence_time ?? "").localeCompare(String(b.commence_time ?? "")));

      if (ctx.status !== "ok") {
        for (const ev of all) {
          skipped.push({
            event_id: ev.event_id,
            label: `${ev.away_team} vs ${ev.home_team}`,
            reason: "model_context_failed",
            detail: ctx.detail,
          });
        }
        return { events, skipped, scheduled: all.length };
      }

      const d = ctx.data as unknown as TennisCtxData;
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
        const rh = resolveName(d.nameIndex, ev.home_team);
        const ra = resolveName(d.nameIndex, ev.away_team);
        if (!rh.ok || !ra.ok) {
          const which = [!rh.ok ? `${ev.home_team} (${rh.ok ? "" : rh.reason})` : "", !ra.ok ? `${ev.away_team} (${ra.ok ? "" : ra.reason})` : ""].filter(Boolean).join("; ");
          skipped.push({ event_id: ev.event_id, label: `${ev.away_team} vs ${ev.home_team}`, reason: "missing_participant", detail: `unresolved in tennis.players: ${which}` });
          continue;
        }
        if (rh.id === ra.id) {
          skipped.push({ event_id: ev.event_id, label: `${ev.away_team} vs ${ev.home_team}`, reason: "missing_participant", detail: "both sides resolved to the same player" });
          continue;
        }
        events.push({
          event: {
            event_id: ev.event_id,
            sport_key: ev.sport_key || params.sportKey,
            commence_time: ev.commence_time,
            home_team: ev.home_team,
            away_team: ev.away_team,
            extra: { homeId: rh.id, awayId: ra.id, homeHow: rh.how, awayHow: ra.how, sportTitle: ev.sport_title },
          },
          market: { event: claimed },
        });
      }
      return { events, skipped, scheduled: all.length };
    },

    validateContext(event, ctx): ValidationResult {
      if (ctx.status !== "ok") return { ok: false, reason: "model_context_failed", detail: ctx.detail };
      const d = ctx.data as unknown as TennisCtxData;
      const x = event.extra as any;
      const sh = strengthOf(d, x.homeId, "unknown");
      const sa = strengthOf(d, x.awayId, "unknown");
      if (sh.basis === "none" && sh.careerMatches === 0) {
        return { ok: false, reason: "insufficient_sample", detail: `${event.home_team}: no rated matches and no ranking` };
      }
      if (sa.basis === "none" && sa.careerMatches === 0) {
        return { ok: false, reason: "insufficient_sample", detail: `${event.away_team}: no rated matches and no ranking` };
      }
      return { ok: true };
    },

    async predict(event, market, ctx): Promise<ModelPrediction[]> {
      const d = ctx.data as unknown as TennisCtxData;
      const x = event.extra as any;
      const ev = market.event;

      /* Surface is recovered from the tour's own history via the tournament
         name. When it cannot be recovered the blend falls back to the overall
         rating and "surface" is reported missing — never defaulted to hard. */
      const surface = inferSurface(d.tourneySurfaces, x.sportTitle);
      const sh = strengthOf(d, x.homeId, surface);
      const sa = strengthOf(d, x.awayId, surface);

      let pHome = eloProb(sh.rating - sa.rating, d.params.elo.scale);

      const fh = loadFeatures(d, x.homeId, event.commence_time);
      const fa = loadFeatures(d, x.awayId, event.commence_time);
      const hh = h2hFor(d, x.homeId, x.awayId);
      const rkH = d.rank.get(x.homeId)?.rank ?? null;
      const rkA = d.rank.get(x.awayId)?.rank ?? null;

      // Same order as TENNIS_FIT_FEATURES and as core/calibrate.ts.
      const featureVec = [
        sh.rating - sa.rating,
        sh.surfaceRating - sa.surfaceRating,
        (fh.restDays ?? 0) - (fa.restDays ?? 0),
        fh.matches14 - fa.matches14,
        (fh.form10 ?? 0.5) - (fa.form10 ?? 0.5),
        hh.aWins - hh.bWins,
      ];

      let basis = "surface_blended_elo";
      if (d.fittedBlend && d.fittedBlend.weights?.length === featureVec.length) {
        pHome = applyFit(d.fittedBlend, featureVec);
        basis = "fitted_logistic";
      }

      const missing: string[] = ["indoor_flag", "withdrawal_status"];
      if (surface === "unknown") missing.push("surface (tournament not in match history)");
      if (!d.serveAvailable) missing.push("serve_return_counters");
      if (rkH == null || rkA == null) missing.push("ranking");
      if (fh.restDays == null || fa.restDays == null) missing.push("rest_days");
      if (!d.fittedBlend) missing.push("fitted_feature_weights (run ?calibrate=1)");
      if (sh.basis === "rank_prior" || sa.basis === "rank_prior") missing.push("sufficient_match_sample");

      const criticalMissing = (sh.basis === "none" || sa.basis === "none") ? 1 : 0;
      const quality = criticalMissing > 0 ? "LOW"
        : (sh.basis === "rank_prior" || sa.basis === "rank_prior") ? "LOW"
        : missing.length > 4 ? "MEDIUM"
        : "MEDIUM";

      const detail = {
        basis,
        tour: d.params.tour,
        home_rating: +sh.rating.toFixed(1),
        away_rating: +sa.rating.toFixed(1),
        home_overall_elo: +sh.overallRating.toFixed(1),
        away_overall_elo: +sa.overallRating.toFixed(1),
        home_career_matches: sh.careerMatches,
        away_career_matches: sa.careerMatches,
        home_basis: sh.basis,
        away_basis: sa.basis,
        home_rank: rkH,
        away_rank: rkA,
        home_rest_days: fh.restDays,
        away_rest_days: fa.restDays,
        home_matches_14d: fh.matches14,
        away_matches_14d: fa.matches14,
        h2h: `${hh.aWins}-${hh.bWins}`,
        surface_used: surface,
        serve_data_available: d.serveAvailable,
        features_computed_not_applied: d.fittedBlend ? [] : TENNIS_FIT_FEATURES.slice(2),
        fit_features: d.fittedBlend ? TENNIS_FIT_FEATURES : null,
        name_match: { home: x.homeHow, away: x.awayHow },
      };

      const out: ModelPrediction[] = [];
      if (ev.h2hHome) out.push({ market: "h2h", selection: ev.home_team, point: null, model_prob: pHome, context_quality: quality, missing_features: missing, detail });
      if (ev.h2hAway) out.push({ market: "h2h", selection: ev.away_team, point: null, model_prob: 1 - pHome, context_quality: quality, missing_features: missing, detail });
      return out;
    },

    telemetryExtra(_rows, ctx) {
      if (ctx.status !== "ok") return { tour: params.tour, parameters: "n/a" };
      const d = ctx.data as unknown as TennisCtxData;
      return {
        tour: d.params.tour,
        rated_players: d.overall.rating.size,
        matches_used: d.matchCount,
        history_through: d.lastMatchDate,
        serve_columns_detected: d.serveColumns,
        rank_prior_fitted: d.rankPrior ? { intercept: +d.rankPrior.a.toFixed(1), slope_per_log_rank: +d.rankPrior.b.toFixed(1), n: d.rankPrior.n } : null,
        parameters: d.fittedBlend ? "calibrated" : "published_default (no calibration stored for this model_version)",
        elo_params: d.params.elo,
        surface_max_weight: d.params.surfaceMaxWeight,
      };
    },
  };
}
