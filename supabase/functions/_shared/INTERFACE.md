# Shared module interface (binding)

Every Collective edge function is dependency-free Deno TypeScript: no external imports, no npm, no jsr. `Deno.serve` for the server, `fetch` for outbound calls, Web Crypto for hashing. Shared code lives here and exports exactly this interface. Functions import with relative paths, for example `import { json, err } from "../_shared/http.ts"`.

## env.ts
```ts
export const SB_URL: string;        // Deno.env.get("SUPABASE_URL")
export const SERVICE_KEY: string;   // Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
export const ANON_KEY: string;      // Deno.env.get("SUPABASE_ANON_KEY")
export const BASE_URL: string;      // Deno.env.get("COLLECTIVE_BASE_URL") ?? "https://edgedesksports.com"
```

## http.ts
```ts
export function json(body: unknown, status?: number, headers?: Record<string, string>): Response;
// error response in the contract shape { error: { code, message, details } }
export function err(code: string, message: string, status: number, details?: unknown): Response;
export function corsHeaders(origin?: string): Record<string, string>; // default origin "*"
// Allow-Headers: authorization, apikey, content-type, x-collective-key,
// x-collective-collector, x-client-info
// returns a 204 Response for OPTIONS requests, else null
export function preflight(req: Request, origin?: string): Response | null;
// path after /functions/v1/<fnName>, normalized, e.g. "/v1/projections"; "" becomes "/"
export function subpath(req: Request, fnName: string): string;
```

## db.ts
```ts
export class RpcError extends Error { status: number; body: string; }
// POST `${SB_URL}/rest/v1/rpc/${fn}` with service key, content-type json and
// header "Content-Profile": "collective". Returns parsed JSON. Throws RpcError on non-2xx.
export function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
```
Convention: RPCs return jsonb outcome objects like `{ ok: true, ... }` or `{ ok: false, code: "token_expired", message: "..." }`. Edge functions translate `ok: false` codes to the HTTP error taxonomy. RpcError means an unexpected database failure and maps to 500 `server_error` (log it, do not leak the body to callers).

## keys.ts
```ts
export function randBase62(n: number): string;                       // crypto.getRandomValues
export function sha256hex(s: string): Promise<string>;               // crypto.subtle.digest
// validates shape mck_live_<8+32 base62> or mck_test_<8+32 base62>
export function parseCollectiveKey(raw: string): { prefix: string; kind: "live" | "test" } | null;
// prefix is the 8 chars after mck_live_/mck_test_; hash is sha256hex of the FULL raw key
export function newApiKey(kind: "live" | "test"): Promise<{ raw: string; prefix: string; hash: string }>;
// invite tokens: mci_<24 base62>; prefix = first 8 of the 24; hash of full raw token
export function newInviteToken(): Promise<{ raw: string; prefix: string; hash: string }>;
```

## auth.ts
```ts
// Validates a Bearer JWT by calling `${SB_URL}/auth/v1/user` with apikey ANON_KEY.
// Returns the user or null. Never decodes the JWT locally.
export function getUser(req: Request): Promise<{ id: string; email: string | null } | null>;
// getUser + membership of admin.user_ids (via rpc get_config). Returns the user
// or an err() Response (401 invalid_key / 403 forbidden) ready to return.
export function requireAdmin(req: Request): Promise<{ id: string; email: string | null } | Response>;
```

## prompt_template.ts
```ts
export const PROMPT_TEMPLATE: string;                       // the Universal Creator Prompt with {{PLACEHOLDERS}}
export function renderPrompt(vars: Record<string, string>): string;  // replaces every {{KEY}}
```
Placeholders: `{{CREATOR_NAME}} {{MODEL_NAME}} {{SPORT}} {{API_BASE}} {{API_KEY}} {{EMBED_SNIPPET}} {{DASHBOARD_URL}} {{DOCS_URL}}`. The template text must match `collective/claude-prompt-template.md` (that file is the human-readable copy of this constant).

## oddsblaze.ts
```ts
// The only file that knows an odds provider's JSON. Deno-free on purpose, so
// tools/collective/test_oddsblaze.ts can exercise it offline against the
// captured response in tools/collective/fixtures/.
export const DEFAULT_LEAGUE_TO_SPORT: Record<string, string>;  // { mlb: "MLB", nfl: "NFL", ... }
export const ODDS_BASE_URL: string;                            // https://odds.oddsblaze.com/
export function classifyMarket(market: unknown): "spread" | "moneyline" | "total" | null;
export function parseAmericanPrice(v: unknown): number | null;  // American only; never converts
export function parsePoints(v: unknown): number | null;
export function parseTimestamp(v: unknown): string | null;      // ISO or epoch; never "now"
export function seasonFor(sport: string, kickoffIso: string, seasons: SeasonWindow[]): number | null;
export function payloadsOf(body: unknown): Payload[];
export function normalizeOddsBlaze(body: unknown, opts: NormalizeOptions): NormalizeResult;
export function oddsUrl(baseUrl: string | null, sportsbook: string, league: string, key: string): string;
export function redactUrl(url: string): string;                 // key=REDACTED
export function fetchOddsBlaze(fetchImpl, baseUrl, sportsbook, league, key, timeoutMs?): Promise<FetchOutcome>;
export function shapeOf(v: unknown, depth?: number): unknown;    // structure only, no values
export function marketCensus(body: unknown): Array<{ market: string; count: number; read_as: string }>;
```
`normalizeOddsBlaze` returns `{ rows, links, skipped, book, league, captured_at }`. `rows` are the `record_market_snapshots` contract (M-odds section 7); `links` are `link_provider_events` rows; `skipped` carries a reason per dropped event and is never silent. The provider key is passed in as an argument and never read, stored, or logged here.

## Key auth flow (ingest)
1. Read `x-collective-key` header, `parseCollectiveKey`.
2. `sha256hex(raw)`, then `rpc("verify_key", { p_prefix, p_hash })`.
3. Result carries key id, creator, model, sport, key kind and status. Revoked or unknown maps to 401.
4. `rpc("rate_check", { p_key_id, p_endpoint })` false maps to 429 `rate_limited`.
