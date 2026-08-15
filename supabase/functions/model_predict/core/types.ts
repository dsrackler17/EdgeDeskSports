// ============================================================================
// EdgeDesk : model_predict / core / types
//
// The contract every sport model implements. Deliberately small: the shared
// layer owns event identity, market snapshotting, validation, writes and
// telemetry, and the sport module owns nothing but its own mathematics.
//
// Nothing in this file imports a runtime. It is pure types so the same source
// runs under Deno (production) and under node --test (regression suite).
// ============================================================================

/** A probability that has already been range-checked. Never write a raw number. */
export type Prob = number;

/** How much of the information the model wanted did it actually get?
 *  METADATA ONLY. It never scales a probability — see spec §29. */
export type ContextQuality = "HIGH" | "MEDIUM" | "LOW";

/** Per-feature availability. `missing` and `insufficient_sample` are different
 *  facts and collapsing them destroys the audit trail. */
export type FeatureAvailability =
  | "available"
  | "missing"
  | "insufficient_sample"
  | "stale"
  | "unsupported";

/** Where a feature can come from, classified before implementation (spec §27). */
export type SourceClass =
  | "AVAILABLE_NOW"
  | "AVAILABLE_FROM_EXISTING_PROVIDER"
  | "REQUIRES_NEW_PROVIDER"
  | "NOT_AVAILABLE";

/** Machine-readable skip reasons. Every dropped event carries exactly one.
 *  Adding a reason is fine; reusing a near-miss one is not. */
export type SkipReason =
  | "missing_market"
  | "missing_participant"
  | "missing_probable_pitcher"
  | "missing_player_stats"
  | "missing_fighter_stats"
  | "missing_team_stats"
  | "insufficient_sample"
  | "stale_data"
  | "unsupported_market"
  | "event_match_failed"
  | "invalid_market_line"
  | "invalid_probability"
  | "model_context_failed"
  | "not_upcoming"
  | "duplicate_event";

export type ModelStatus = "ok" | "insufficient_data" | "error";

export interface FeatureNote {
  feature: string;
  availability: FeatureAvailability;
  /** Table / view / endpoint the value came from, or would come from. */
  source: string;
  detail?: string;
}

/** Published, static description of what a model needs. Surfaced in telemetry
 *  and in the registry so the frontend and the backend cannot drift. */
export interface DataContractEntry {
  feature: string;
  source: string;
  sourceClass: SourceClass;
  updateFrequency: string;
  historicalDepth: string;
  reliability: string;
  /** true => the model cannot produce a probability without it. */
  critical: boolean;
}

/** One market event as captured by EdgeDesk. `event_id` is the identity. */
export interface MarketEvent {
  event_id: string;
  sport_key: string;
  sport_title?: string | null;
  commence_time: string | null;
  home_team: string;
  away_team: string;
  /** every signals row for this event, grouped by market */
  h2hHome?: SignalRow;
  h2hAway?: SignalRow;
  totalsRows: SignalRow[];
  spreadsRows: SignalRow[];
  mainTotal?: { point: number | null; over?: SignalRow; under?: SignalRow } | null;
  mainSpread?: { point: number | null; home?: SignalRow; away?: SignalRow } | null;
  /** consumed by an event claim; see core/identity.ts */
  claimed?: boolean;
}

export interface SignalRow {
  event_id: string;
  sport_key?: string;
  sport_title?: string | null;
  market: string;
  selection: string;
  point: number | null;
  sharp_fair: number | null;
  best_dec: number | null;
  best_book: string | null;
  n_books: number | null;
  commence_time: string | null;
  home_team: string;
  away_team: string;
}

/** What the shared layer hands a model for one event. For MLB this is a
 *  StatsAPI game joined to a claimed market event; for every other sport the
 *  market event IS the event, because signals.event_id is already canonical. */
export interface EventContext {
  event_id: string;
  sport_key: string;
  commence_time: string | null;
  /** Generic participant slots. For team sports these are teams; for tennis and
   *  MMA they are the two players/fighters. The column names are kept so
   *  historical MLB rows stay readable (spec §16). */
  home_team: string;
  away_team: string;
  /** sport-specific payload the model attached during event assembly */
  extra?: Record<string, unknown>;
}

/** The captured market for one event, already grouped. */
export interface MarketContext {
  event: MarketEvent;
}

/** Anything a model wants to carry from loadContext() into predict(). */
export interface ModelContext {
  status: ModelStatus;
  /** populated when status !== "ok" */
  missing?: string[];
  detail?: string;
  /** the newest input timestamp that fed this context */
  dataAsOf?: string | null;
  /** stable id for the exact input set, so a row can be traced back */
  featureSnapshotId?: string;
  /** free-form per-model payload */
  data?: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  reason?: SkipReason;
  detail?: string;
}

/** What a model returns per selection. The shared layer turns this into a row:
 *  the model never builds a database row and never sees the market price it is
 *  about to be scored against, so it cannot anchor to it. */
export interface ModelPrediction {
  market: string;
  selection: string;
  point: number | null;
  model_prob: Prob;
  context_quality: ContextQuality;
  missing_features: string[];
  /** optional model-specific diagnostics, stored as jsonb */
  detail?: Record<string, unknown>;
}

/** Deterministic RNG. Production seeds from crypto; tests pass a fixed seed. */
export interface Rng {
  /** uniform [0,1) */
  next(): number;
  seed: number;
}

export interface ModelDeps {
  /** REST read against the public schema */
  sbGet: (path: string) => Promise<any[]>;
  /** REST read against an isolated Postgres schema (accept-profile) */
  sbGetSchema: (schema: string, path: string) => Promise<any[]>;
  /** plain JSON GET, for keyless public providers such as MLB StatsAPI */
  jget: (url: string) => Promise<any>;
  rng: Rng;
  /** ISO date in America/New_York, the slate date the run is for */
  etDate: string;
  now: Date;
  /** bounded concurrency helper */
  pmap: <T>(arr: T[], n: number, fn: (x: T) => Promise<void>) => Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** The interface every sport implements. */
export interface SportPredictionModel {
  /** canonical key, e.g. "baseball_mlb". Prefix-matched against signals. */
  sportKey: string;
  /** every sport_key prefix that routes here (tennis_atp_* , nfl_preseason) */
  sportKeyPrefixes: string[];
  /** label the frontend already uses: MLB / ATP / WTA / MMA / NFL / WNBA */
  uiLabel: string;
  modelVersion: string;
  supportedMarkets: string[];
  dataContract: DataContractEntry[];

  supportsMarket(market: string, selection?: string): boolean;

  /** `marketRows` are the raw captured `signals` rows for this model's sport
   *  keys inside the run window. Models group them themselves via
   *  buildMarketIndex() so there is exactly one grouping implementation. */
  loadContext(deps: ModelDeps, marketRows: SignalRow[]): Promise<ModelContext>;

  /** Assemble the events this model will attempt. Most sports read their event
   *  universe straight out of the captured market, because signals.event_id is
   *  already canonical; MLB overrides it to join the StatsAPI schedule on. */
  buildEvents(
    deps: ModelDeps,
    marketRows: SignalRow[],
    ctx: ModelContext,
  ): Promise<{ events: Array<{ event: EventContext; market: MarketContext }>; skipped: SkipEntry[]; scheduled: number }>;

  validateContext(event: EventContext, ctx: ModelContext): ValidationResult;

  predict(
    event: EventContext,
    market: MarketContext,
    ctx: ModelContext,
    deps: ModelDeps,
  ): Promise<ModelPrediction[]>;

  /** Optional sport-specific telemetry block. MLB uses it to keep its
   *  doubleheader / edge / totals summaries in the response unchanged. */
  telemetryExtra?: (rows: PredictionRow[], ctx: ModelContext) => Record<string, unknown>;
}

export interface SkipEntry {
  event_id?: string | null;
  label: string;
  reason: SkipReason;
  detail?: string;
}

/** A row exactly as it is written to public.model_predictions. */
export interface PredictionRow {
  model_version: string;
  sport_key: string;
  event_id: string;
  commence_time: string | null;
  home_team: string;
  away_team: string;
  market: string;
  selection: string;
  point: number | null;
  model_prob: number;
  model_fair_american: number;
  market_prob_at_pred: number | null;
  market_am_at_pred: number | null;
  best_am_at_pred: number | null;
  /** PROBABILITY GAP in [-1,1]. Never an expected value. */
  model_edge: number | null;
  /** expected value on the best available price. Separate column on purpose. */
  model_ev: number | null;
  context_quality: ContextQuality;
  missing_features: string[];
  data_as_of: string | null;
  feature_snapshot_id: string | null;
  model_detail: Record<string, unknown> | null;
}

export interface SportTelemetry {
  model_version: string;
  ui_label: string;
  status: ModelStatus;
  scheduled: number;
  eligible: number;
  predicted: number;
  skipped: SkipEntry[];
  rows_built: number;
  rows_written: number;
  market_events: number;
  matched_events: number;
  unmatched_events: Array<{ event_id: string; game: string; commence_time: string | null }>;
  data_quality: {
    status: ModelStatus;
    missing?: string[];
    detail?: string;
    data_as_of?: string | null;
    feature_snapshot_id?: string;
    contract?: DataContractEntry[];
  };
  error?: string;
  /** sport-specific extras (MLB keeps its doubleheader + totals telemetry) */
  extra?: Record<string, unknown>;
}
