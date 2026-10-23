/* ===========================================================================
   edgedesk-sim fetch-sources — read the PRIMARY sources the simulator's
   activation gates name, from somewhere that can reach them (GitHub's
   runners: .github/workflows/simulator-sources.yml), and print them whole.

     node simulator/src/cli/fetch_sources.ts [--out simulator/out/sources]

   Read-only. No credential, no database, nothing written outside --out.
   Prints, for each source: the URL asked and the URL answered, the HTTP
   status, the byte count and sha256 of the body, then the page text. A
   person (or a reviewed commit citing this log) compares that text with
   SIMULATOR_NOTES.md §7 and simulator/src/sports/nfl/config.ts; nothing here
   marks anything verified.

   NFL: the tiebreaking procedures and playoff seeding page, the Super Bowl
   LXI site announcement, the rules index (its playoff / rulebook links).
   Kalshi: every Sports series whose title names the NFL, Super Bowl, AFC or
   NFC (with the series' own fee_type / fee_multiplier), every open market in
   them with its FULL settlement rules and their sha256 (the hash
   simulator/src/markets/kalshi.ts computes), and Kalshi's fee schedule.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { kalshiClient } from '../markets/kalshi.ts';
import { sha256Hex } from '../core/canonical.ts';

const a = process.argv.slice(2), get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const OUT = get('--out') || path.join('simulator', 'out', 'sources');
const UA = 'Mozilla/5.0 (compatible; EdgeDesk-Simulator-SourceCheck/0.1; +https://github.com/dsrackler17/EdgeDeskSports)';
fs.mkdirSync(OUT, { recursive: true });

const PAGES: Array<{ id: string; url: string; links?: RegExp }> = [
  { id: 'nfl_tiebreaking', url: 'https://operations.nfl.com/the-rules/nfl-tiebreaking-procedures/', links: /playoff|seed|tie|rulebook/i },
  { id: 'nfl_rules_index', url: 'https://operations.nfl.com/the-rules/', links: /playoff|seed|tie|rulebook|2026/i },
  { id: 'nfl_standings_tiebreaking', url: 'https://www.nfl.com/standings/tie-breaking-procedures' },
  { id: 'nfl_super_bowl_lxi', url: 'https://www.nfl.com/news/sofi-stadium-approved-to-host-super-bowl-lxi-in-2027' },
  { id: 'kalshi_fee_schedule_pdf', url: 'https://kalshi.com/docs/kalshi-fee-schedule.pdf' }
];

/** page text: scripts and styles dropped, block ends as newlines, entities decoded */
export function htmlText(html: string): string {
  const ent: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/tr|\/section|\/article|\/ol|\/ul)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ent[n.toLowerCase()] ?? m)
    .replace(/[ \t\f\r\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function section(title: string) { console.log('\n' + '='.repeat(100) + '\n== ' + title + '\n' + '='.repeat(100)); }
const SUMMARY: string[] = [];

async function fetchPage(p: (typeof PAGES)[number]) {
  section('SOURCE ' + p.id + '  ' + p.url);
  let res: Response;
  try { res = await fetch(p.url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8' }, redirect: 'follow' }); }
  catch (e) { console.log('FETCH FAILED: ' + String((e as Error).message || e)); SUMMARY.push(p.id + ': FETCH FAILED ' + String((e as Error).message || e)); return; }
  const body = Buffer.from(await res.arrayBuffer());
  const head = 'status ' + res.status + ' · final url ' + res.url + ' · ' + body.length + ' bytes · sha256 ' + sha256Hex(body) + ' · fetched_at ' + new Date().toISOString();
  console.log(head);
  const isPdf = /\.pdf($|\?)/i.test(res.url) || (res.headers.get('content-type') || '').includes('pdf');
  fs.writeFileSync(path.join(OUT, p.id + (isPdf ? '.pdf' : '.html')), body);
  let text: string;
  if (isPdf) {
    try { text = execFileSync('pdftotext', ['-layout', path.join(OUT, p.id + '.pdf'), '-'], { encoding: 'utf8', maxBuffer: 32 << 20 }); }
    catch (e) { console.log('pdftotext unavailable or failed: ' + String((e as Error).message).slice(0, 200)); return; }
  } else {
    const html = body.toString('utf8');
    text = htmlText(html);
    if (p.links) {
      const links = [...new Set([...html.matchAll(/href="([^"#]+)"/gi)].map((m) => m[1]).filter((h) => p.links!.test(h)))].slice(0, 80);
      console.log('-- links matching ' + p.links + ':\n' + links.map((l) => '  ' + l).join('\n'));
    }
  }
  fs.writeFileSync(path.join(OUT, p.id + '.txt'), text);
  SUMMARY.push(p.id + ': ' + head + ' · text ' + text.length + ' chars, sha256 ' + sha256Hex(text));
  console.log('-- text (' + text.length + ' chars, sha256 ' + sha256Hex(text) + '):\n' + text.slice(0, 60000));
}

/* season futures: a series whose title names a champion, conference, division, playoff berth or seed.
   Per-game, per-player and in-season prop series (thousands of markets) are listed by name and count only. */
const FUTURES = /Super Bowl|champion|conference|AFC|NFC|division|playoff|seed/i;
const NOT_FUTURES = /game|spread|total|points|yards|touchdown|TD|MVP|player|quarter|half|draft|coach|week|rookie|award|passing|rushing|receiving|sack|score|margin|first|anytime/i;

async function kalshi() {
  section('SOURCE kalshi_api  public REST, no key');
  const c = kalshiClient();
  const match = /NFL|Super Bowl|Pro Football|AFC|NFC/i;
  let s: any;
  try { s = await c.get('/series', { category: 'Sports' }); } catch (e) { console.log('KALSHI FAILED: ' + String((e as Error).message || e)); SUMMARY.push('kalshi: FAILED ' + String((e as Error).message || e)); return; }
  const series = ((s && s.series) || []).filter((x: any) => x && x.ticker && match.test(String(x.title || '') + ' ' + String(x.ticker)) && !/GAME$/.test(x.ticker));
  const futures = series.filter((x: any) => FUTURES.test(String(x.title || '')) && !NOT_FUTURES.test(String(x.title || '')));
  console.log('host ' + c.host + ' · ' + ((s && s.series) || []).length + ' Sports series · ' + series.length + ' name the NFL · ' + futures.length + ' look like season futures');
  console.log('-- every NFL-named series (ticker | title | fee_type | fee_multiplier):');
  for (const x of series) console.log('  ' + x.ticker + ' | ' + x.title + ' | ' + x.fee_type + ' | ' + x.fee_multiplier + (futures.includes(x) ? '   <- futures' : ''));
  const all: any[] = [];
  for (const x of futures) {
    console.log('\n## SERIES ' + x.ticker + ' | ' + x.title + ' | fee_type ' + x.fee_type + ' | fee_multiplier ' + x.fee_multiplier + ' | frequency ' + x.frequency
      + ' | settlement_sources ' + JSON.stringify(x.settlement_sources || null));
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      let m: any;
      try { m = await c.get('/markets', { series_ticker: x.ticker, status: 'open', limit: 1000, cursor }); } catch (e) { console.log('  markets failed: ' + String((e as Error).message)); break; }
      for (const k of (m && m.markets) || []) {
        const rules_sha256 = k.rules_primary ? sha256Hex(String(k.rules_primary) + '\n' + String(k.rules_secondary || '')) : null;
        all.push({ series_ticker: x.ticker, event_ticker: k.event_ticker, market_ticker: k.ticker, title: k.title, yes_sub_title: k.yes_sub_title, close_time: k.close_time,
          rules_primary: k.rules_primary, rules_secondary: k.rules_secondary || null, rules_sha256, yes_bid: k.yes_bid_dollars, yes_ask: k.yes_ask_dollars, yes_ask_size: k.yes_ask_size_fp });
        console.log('  - ' + k.ticker + ' | event ' + k.event_ticker + ' | ' + (k.yes_sub_title || '') + ' | close ' + k.close_time + ' | bid ' + k.yes_bid_dollars + ' ask ' + k.yes_ask_dollars
          + ' | rules_sha256 ' + rules_sha256 + '\n    RULES: ' + String(k.rules_primary || '').replace(/\s+/g, ' ') + (k.rules_secondary ? '\n    RULES2: ' + String(k.rules_secondary).replace(/\s+/g, ' ') : ''));
      }
      cursor = (m && m.cursor) || '';
      if (!cursor) break;
    }
  }
  fs.writeFileSync(path.join(OUT, 'kalshi_candidates.json'), JSON.stringify({ fetched_at: new Date().toISOString(), host: c.host, series, futures: futures.map((x: any) => x.ticker), markets: all }, null, 1));
  SUMMARY.push('kalshi: host ' + c.host + ' · ' + series.length + ' NFL-named series · ' + futures.length + ' futures series · ' + all.length + ' open futures markets');
}

await kalshi();
for (const p of PAGES) await fetchPage(p);
section('SUMMARY');
console.log(SUMMARY.join('\n') + '\nwritten to ' + OUT);
