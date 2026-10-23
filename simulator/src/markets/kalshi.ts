/* ===========================================================================
   Kalshi's public REST API, the way supabase/functions/kalshi_sync reads it:
   the same two documented hosts (external-api.kalshi.com, falling back to
   api.elections.kalshi.com), the same fixed-point dollar fields
   (yes_bid_dollars, yes_ask_dollars, yes_ask_size_fp, ...), backoff on 429
   and 5xx (at most 4 attempts per host), a refusal handing over to the next
   host. No Kalshi key exists or is needed. Nothing here trades.
   =========================================================================== */
import { sha256Hex } from '../core/canonical.ts';
import type { Quote } from './compare.ts';

export const KALSHI_HOSTS = ['https://external-api.kalshi.com/trade-api/v2', 'https://api.elections.kalshi.com/trade-api/v2'];

const num = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const price = (v: unknown): number | null => { const n = num(v); return n == null || n < 0 || n > 1 ? null : n; };

export interface KalshiClient { get(path: string, params?: Record<string, string | number>): Promise<any>; host: string | null }

export function kalshiClient(opt: { hosts?: string[]; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): KalshiClient {
  const hosts = opt.hosts || KALSHI_HOSTS, f = opt.fetchImpl || fetch;
  const sleep = opt.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const c: KalshiClient = {
    host: null,
    async get(path, params = {}) {
      let last: Error | null = null;
      const order = c.host ? [c.host, ...hosts.filter((h) => h !== c.host)] : hosts;
      for (const base of order) {
        const url = new URL(base + path);
        for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, String(v));
        for (let attempt = 0; attempt < 4; attempt++) {
          let res: Response;
          try { res = await f(url.toString(), { headers: { accept: 'application/json', 'user-agent': 'EdgeDesk-Simulator/0.1 (research; public data)' } }); }
          catch (e) { last = new Error('Kalshi could not be reached at ' + new URL(base).host + ': ' + String((e as Error).message || e)); break; }
          if (res.status === 429 || res.status >= 500) { last = new Error('Kalshi answered ' + res.status + ' on ' + url.pathname); await sleep(250 * 2 ** attempt); continue; }
          if (res.status === 401 || res.status === 403) { last = new Error('Kalshi refused ' + url.pathname + ' at ' + new URL(base).host + ' (HTTP ' + res.status + ')'); break; }
          if (!res.ok) throw new Error('Kalshi answered ' + res.status + ' on ' + url.pathname + ': ' + (await res.text()).slice(0, 200));
          c.host = base;
          return res.json();
        }
      }
      throw last || new Error('Kalshi could not be reached');
    }
  };
  return c;
}

/** a market object -> the quote the comparison reads, stamped with the capture time */
export function quoteFromMarket(m: any, capturedAt: string, host: string | null): Quote {
  return {
    market_ticker: m.ticker, event_ticker: m.event_ticker ?? null, series_ticker: m.series_ticker ?? null, captured_at: capturedAt, status: m.status ?? null,
    yes_bid: price(m.yes_bid_dollars), yes_ask: price(m.yes_ask_dollars), no_bid: price(m.no_bid_dollars), no_ask: price(m.no_ask_dollars),
    yes_ask_size: num(m.yes_ask_size_fp), yes_bid_size: num(m.yes_bid_size_fp), last_price: price(m.last_price_dollars),
    close_time: m.close_time ?? null, rules_sha256: m.rules_primary ? sha256Hex(String(m.rules_primary) + '\n' + String(m.rules_secondary || '')) : null,
    host: host ? new URL(host).host : null
  };
}

/** every open market of the given tickers (in groups of 100) */
export async function fetchQuotes(c: KalshiClient, tickers: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  for (let i = 0; i < tickers.length; i += 100) {
    const page = await c.get('/markets', { tickers: tickers.slice(i, i + 100).join(','), limit: 1000 });
    const at = new Date().toISOString();
    for (const m of (page && page.markets) || []) if (m && m.ticker) out.set(m.ticker, quoteFromMarket(m, at, c.host));
  }
  return out;
}
