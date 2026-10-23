/* ===========================================================================
   edgedesk-sim kalshi-discover — list Kalshi futures CANDIDATES for a person.

     node simulator/src/cli/kalshi_discover.ts --sport nfl [--match "Super Bowl|AFC|NFC|playoff|division"]

   Reads Kalshi's public Sports series, keeps the ones whose title matches, and
   writes every open market with its title, sub-titles, close time and the FULL
   settlement rules (and their sha256) to simulator/out/kalshi_candidates.json.
   It never writes simulator/config/kalshi_futures.json: a person reads each
   market's rules, decides which simulated outcome (if any) settles the same
   way, and adds a mapping with verified_by / verified_at. A regular-season
   title is not a playoff title; a market that cannot be matched exactly is
   left out, with its reason, as an 'excluded' mapping.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kalshiClient } from '../markets/kalshi.ts';
import { sha256Hex } from '../core/canonical.ts';

const SIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const a = process.argv.slice(2), get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const sport = get('--sport') || 'nfl';
const match = new RegExp(get('--match') || (sport === 'nfl' ? 'NFL|Super Bowl|Pro Football|AFC|NFC' : sport), 'i');
(async () => {
  const c = kalshiClient();
  const s = await c.get('/series', { category: 'Sports' });
  const series = ((s && s.series) || []).filter((x: any) => x && x.ticker && match.test(String(x.title || '') + ' ' + String(x.ticker)) && !/GAME$/.test(x.ticker));
  const out: any[] = [];
  for (const x of series) {
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const m = await c.get('/markets', { series_ticker: x.ticker, status: 'open', limit: 1000, cursor });
      for (const k of (m && m.markets) || []) out.push({ series_ticker: x.ticker, series_title: x.title, event_ticker: k.event_ticker, market_ticker: k.ticker, title: k.title,
        yes_sub_title: k.yes_sub_title, no_sub_title: k.no_sub_title, close_time: k.close_time, rules_primary: k.rules_primary, rules_secondary: k.rules_secondary || null,
        rules_sha256: k.rules_primary ? sha256Hex(String(k.rules_primary) + '\n' + String(k.rules_secondary || '')) : null });
      cursor = (m && m.cursor) || '';
      if (!cursor) break;
    }
  }
  const file = path.join(SIM, 'out', 'kalshi_candidates.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetched_at: new Date().toISOString(), host: c.host, series: series.map((x: any) => x.ticker), markets: out }, null, 1));
  console.log(out.length + ' open markets in ' + series.length + ' candidate series -> ' + path.relative(process.cwd(), file) + ' (for review; nothing was mapped)');
})().catch((e) => { console.error('discovery failed: ' + (e as Error).message); process.exit(4); });
