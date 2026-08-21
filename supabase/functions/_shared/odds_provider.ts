// The odds provider contract.
//
// Everything upstream of this file is vendor-specific; everything downstream
// speaks only these types. Adding a second provider means writing one more
// module that returns NormalizedSlate — no other file changes, because
// nothing else in the Collective ever sees a vendor payload.
//
// The credential never appears in any of these types. It is read from the
// environment inside a provider implementation and used only to build the
// outbound request.

/** Canonical markets. New families (props, futures) become new ids here and
 *  new rows in odds.markets; the pipeline itself does not change. */
export type MarketId =
  | "moneyline"
  | "spread"
  | "total"
  | "team_total"
  | "alternate_spread"
  | "alternate_total"
  | string;

/** Which side of a market a price belongs to. */
export type Outcome = "home" | "away" | "over" | "under" | "draw" | string;

/** One price, at one book, on one side of one market, at one moment. */
export interface NormalizedOdd {
  book: string;
  market: MarketId;
  outcome: Outcome;
  outcome_label?: string | null;
  /** Points. Null for moneyline. Home convention for spreads: negative means
   *  the home team is favoured. */
  line?: number | null;
  /** American odds. -110, +135. Never a decimal or a probability. */
  price: number;
  is_live?: boolean;
  is_main?: boolean;
  /** The vendor row this was derived from, kept for audit. Bounded by the
   *  caller so a payload cannot balloon the snapshot table. */
  raw?: unknown;
}

/** One game, named in our terms, with the provider's id kept alongside as a
 *  mapping rather than as identity. */
export interface NormalizedEvent {
  provider_event_id: string | null;
  home: string;
  away: string;
  home_name?: string | null;
  away_name?: string | null;
  commence_time: string;
  season?: number | null;
  week?: number | null;
  status?: string | null;
  is_live?: boolean;
  provider_updated_at?: string | null;
  odds: NormalizedOdd[];
}

/** What a provider hands back for one league, plus an honest account of what
 *  it could not map. Unmapped rows are reported, never silently dropped and
 *  never filled in with a guess. */
export interface NormalizedSlate {
  provider: string;
  league: string;
  fetched_at: string;
  provider_updated_at: string | null;
  events: NormalizedEvent[];
  books_ok: string[];
  books_failed: { book: string; reason: string }[];
  /** Rows whose shape we did not recognise. Carries the row's KEY NAMES and
   *  a redacted sample, never a credential, so an API change is diagnosable
   *  from the run record alone. */
  unmapped: UnmappedRow[];
  counts: { events: number; odds: number; unmapped: number };
  /** Present only for metered providers. */
  quota?: ProviderQuota;
}

/** Credit accounting a metered provider reports alongside its data. Numbers
 *  only, never a raw header value. A provider that does not meter leaves every
 *  field null, and the caller treats "unknown" as "no budget information",
 *  never as "unlimited". */
export interface ProviderQuota {
  /** Credits left in the current billing period. */
  remaining: number | null;
  /** Credits spent so far in the current billing period. */
  used: number | null;
  /** What the request that produced this slate cost. Authoritative: it is the
   *  provider's own accounting, not our prediction of it. */
  last_cost: number | null;
}

export interface UnmappedRow {
  book: string;
  reason: string;
  keys: string[];
  sample?: unknown;
}

export interface FetchOptions {
  league: string;
  books: string[];
  markets: MarketId[];
  /** true = live only, false = pregame only, undefined = both. */
  live?: boolean;
  /** true = main lines only. Alternates are off by default; turning them on
   *  is a settings change, not a code change. */
  mainOnly?: boolean;
  timeoutMs?: number;
  booksPerRequest?: number;
}

/** A provider is a named fetcher that returns canonical data. */
export interface OddsProvider {
  readonly id: string;
  readonly name: string;
  /** True when the credential this provider needs is present. Checked before
   *  a run so a missing secret is a clear message, not a 401 from a vendor. */
  isConfigured(): boolean;
  fetchSlate(opts: FetchOptions): Promise<NormalizedSlate>;
  /** One request, reporting the observed response STRUCTURE rather than the
   *  data: endpoint reachability, status, and the key paths that came back.
   *  Used to confirm the integration against the live API without printing
   *  anything sensitive. */
  probe(opts: FetchOptions): Promise<ProbeResult>;
}

export interface ProbeResult {
  provider: string;
  ok: boolean;
  /** The URL with every credential removed. Safe to log and to display. */
  url_redacted: string;
  http_status: number | null;
  /** Key paths seen in the response, e.g. "events[].odds[].selection.line". */
  observed_shape: string[];
  sample_event: unknown;
  sample_odd: unknown;
  counts: { events: number; odds: number };
  error: string | null;
  /** What the adapter made of the sample: proof the mapping works against
   *  the real feed, or a precise account of where it did not. */
  mapping: { mapped: number; unmapped: UnmappedRow[] };
  /** Present only for metered providers. */
  quota?: ProviderQuota;
}

const REGISTRY = new Map<string, OddsProvider>();

export function registerProvider(p: OddsProvider): void {
  REGISTRY.set(p.id, p);
}

export function getProvider(id: string): OddsProvider | null {
  return REGISTRY.get(id) ?? null;
}

export function listProviders(): { id: string; name: string; configured: boolean }[] {
  return [...REGISTRY.values()].map((p) => ({
    id: p.id,
    name: p.name,
    configured: p.isConfigured(),
  }));
}
