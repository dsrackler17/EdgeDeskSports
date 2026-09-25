#!/usr/bin/env node
/* ============================================================================
   WHAT DOES EACH CONFERENCE ACTUALLY SERVE? — a read-only probe.

   football/availability/sync_reports.js reads one URL per conference
   (policy.js report_url) and turns whatever comes back into a report. When
   that URL is a homepage or a policy announcement, the ingester finds no
   roster name on it and — for a conference whose policy makes silence mean
   "available" — records a clean bill of health. This probe exists so the
   pages can be LOOKED AT from the machine that fetches them (GitHub Actions),
   before any parser is written against them.

   It prints, per URL: the status for EdgeDesk's user agent and a browser's,
   the content type, the dates the server sends, the title, any embedded data
   blob (__NEXT_DATA__ and the like), the links that look like reports or
   PDFs, API-looking strings, and the readable text around the first mention
   of "availability". It follows up to four report-looking links one level
   deep. It writes nothing and commits nothing.

     node football/availability/probe_sources.js            all candidates
     node football/availability/probe_sources.js sec acc    just those
   ========================================================================== */
'use strict';
const path = require('path');

const EDGE_UA = 'EdgeDesk-availability-sync (+https://edgedesksports.com)';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const CANDIDATES = {
  sec: ['https://www.secsports.com/fbreports', 'https://www.secsports.com/reports',
    'https://www.secsports.com/fbreports-archive'],
  bigten: ['https://bigten.org/fb/availability-reports/'],
  acc: ['https://theacc.com/sports/2025/8/28/availability-reporting-football.aspx',
    'https://theacc.com/sports/football'],
  big12: ['https://big12sports.com/sports/football?path=football', 'https://big12sports.com/'],
  mountainwest: ['https://themw.com/sports/2026/8/21/football_reports.aspx'],
  conferenceusa: ['https://conferenceusa.com/sports/2025/8/23/FB_0823254134.aspx'],
  sunbelt: ['https://sunbeltsports.org/news/2025/8/11/football-availability-report-new.aspx'],
  american: ['https://theamerican.org/sports/football'],
  mac: ['https://getsomemaction.com/sports/football'],
  /* the platforms the conference pages embed (found by this probe) */
  hdi: ['https://app.hdintelligence.com/?source=SEC&sport=Football&conf=SEC&type=report',
    'https://app.hdintelligence.com/?source=B10&sport=Football&conf=B10&type=report'],
  faktor: ['https://faktorsports.com/k/embed/player-availability/full/MountainWest/11/MFB/2026?signature=e098b656dbb0b78335ef78c8d9c68e2cceb940d4519d54f4c05aaaa48c62eef7'],
  espn: ['https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/145/injuries',
    'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/teams/145/injuries']
};

const REPORTISH = /availab|injur|report|\.pdf(\?|$)/i;

function strip(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d|table|section)>/gi, '\n')
    .replace(/<t[dh][^>]*>/gi, ' | ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;?/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&rsquo;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function get(url, ua) {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': ua, accept: '*/*' },
      signal: AbortSignal.timeout(25000) });
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, url: r.url, buf,
      type: r.headers.get('content-type') || '', lastModified: r.headers.get('last-modified'),
      date: r.headers.get('date') };
  } catch (e) { return { ok: false, status: 'ERR ' + String((e && e.message) || e).slice(0, 120) }; }
}

function linksOf(html, base) {
  const out = [], seen = {};
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href;
    try { href = new URL(m[1], base).toString(); } catch (_) { continue; }
    const text = strip(m[2]).replace(/\s+/g, ' ').slice(0, 90);
    if (!REPORTISH.test(href) && !REPORTISH.test(text)) continue;
    if (seen[href]) continue;
    seen[href] = 1;
    out.push({ href, text });
  }
  return out;
}

async function show(label, r, depth) {
  const pad = depth ? '    ' : '';
  console.log(pad + '---- ' + label);
  if (!r.ok) { console.log(pad + '  status ' + r.status); return null; }
  console.log(pad + '  status ' + r.status + ' · final ' + r.url + ' · ' + r.type + ' · ' + r.buf.length + ' bytes'
    + ' · last-modified ' + r.lastModified + ' · date ' + r.date);
  const isPdf = /pdf/i.test(r.type) || r.buf.slice(0, 5).toString('latin1') === '%PDF-';
  if (isPdf) {
    let text = '';
    try { const P = require(path.join(__dirname, 'pdf_text.js')); const x = P.extract(r.buf); text = x.ok ? x.lines.join('\n') : ('(pdf unreadable: ' + x.why + ')'); }
    catch (e) { text = '(pdf reader threw: ' + e.message + ')'; }
    console.log(pad + '  PDF TEXT >>>\n' + text.slice(0, 2500) + '\n' + pad + '  <<<');
    return null;
  }
  const html = r.buf.toString('utf8');
  if (/json/i.test(r.type) || /^\s*[\[{]/.test(html)) {
    console.log(pad + '  JSON >>> ' + html.slice(0, 2500) + '\n' + pad + '  <<<');
    return null;
  }
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  console.log(pad + '  title: ' + (title ? strip(title).slice(0, 160) : '(none)'));
  ['__NEXT_DATA__', '__NUXT__', 'window.__INITIAL_STATE__', 'application/ld+json', 'data-reactroot', 'ng-app',
    'sidearm', 'wp-content'].forEach(k => { if (html.indexOf(k) >= 0) console.log(pad + '  contains ' + k); });
  const next = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (next) console.log(pad + '  __NEXT_DATA__ >>> ' + next[1].slice(0, 3000) + '\n' + pad + '  <<<');
  const scripts = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map(x => x[1]).slice(0, 12);
  if (scripts.length) console.log(pad + '  scripts: ' + scripts.join(' , '));
  const apis = [...new Set((html.match(/https?:\/\/[^"'\s<>]*(api|json|graphql|feeds?)[^"'\s<>]*/gi) || []))].slice(0, 15);
  if (apis.length) console.log(pad + '  api-looking: ' + apis.join(' , '));
  const dates = [...new Set((html.match(/(datetime|datePublished|dateModified|published_time|modified_time)["'=:\s]+["']?[^"'<>]{8,40}/gi) || []))].slice(0, 8);
  if (dates.length) console.log(pad + '  date markup: ' + dates.join(' | '));
  /* WHERE A SCRIPT-FILLED PAGE GETS ITS TABLE: iframes and embeds, inline
     scripts that carry a status word, the SEC's encoded page data, and the
     raw markup under the page's own heading */
  const frames = [...html.matchAll(/<(iframe|embed|object)\b[^>]*(src|data)=["']([^"']+)["']/gi)].map(x => x[3]);
  if (frames.length) console.log(pad + '  frames: ' + frames.slice(0, 10).join(' , '));
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(x => x[1])
    .filter(t => /questionable|probable|doubtful|availab|\.pdf|sheet|airtable|api\//i.test(t));
  inline.slice(0, 6).forEach((t, i) => {
    const at = t.search(/questionable|probable|doubtful|availab|\.pdf|sheet|airtable|api\//i);
    console.log(pad + '  inline script ' + i + ' (' + t.length + ' chars) >>> ' + t.slice(Math.max(0, at - 300), at + 900).replace(/\s+/g, ' ') + ' <<<');
  });
  const dp = html.match(/data-page=["']([^"']+)["']/i);
  if (dp) {
    const json = dp[1].replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    try {
      const page = JSON.parse(json);
      console.log(pad + '  data-page component=' + page.component + ' props=' + Object.keys(page.props || {}).join(','));
      const hits = [];
      (function walk(v, at) {
        if (hits.length > 80) return;
        if (v && typeof v === 'object') { Object.keys(v).forEach(k => walk(v[k], at + '.' + k)); return; }
        if (typeof v === 'string' && /report|availab|\.pdf|questionable|probable|doubtful|\bout\b|updated|posted/i.test(v + at))
          hits.push(at + ' = ' + v.slice(0, 200));
      })(page.props, 'props');
      hits.forEach(h => console.log(pad + '    ' + h));
    } catch (e) { console.log(pad + '  data-page did not parse: ' + e.message + ' · ' + json.slice(0, 600)); }
  }
  const hosts = {};
  (html.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) || []).forEach(h => { hosts[h.toLowerCase()] = (hosts[h.toLowerCase()] || 0) + 1; });
  console.log(pad + '  hosts: ' + Object.keys(hosts).filter(h => !/google|doubleclick|facebook|twitter|cloudflare|gstatic|adsrvr|attn\.tv|blueconic|solarwinds|transcend|youtube|instagram|tiktok|onetrust|cookielaw|fonts/.test(h)).slice(0, 40).join(' '));
  const body = html.slice(Math.max(0, html.search(/<body/i)));
  const plat = /hdintelligence|faktor|availability[-_ ]?report|player[-_ ]availability|embed/gi;
  let pm, pn = 0;
  while ((pm = plat.exec(body)) && pn < 6) { pn++; console.log(pad + '  body@' + pm.index + ' >>> ' + body.slice(Math.max(0, pm.index - 250), pm.index + 450).replace(/\s+/g, ' ') + ' <<<'); }
  /* a script-built app loads its table from somewhere: grep its own bundles */
  if (depth === 0 && /hdintelligence|faktorsports/.test(r.url)) {
    const own = scripts.map(u => { try { return new URL(u, r.url).toString(); } catch (_) { return null; } })
      .filter(u => u && new URL(u).host === new URL(r.url).host).slice(0, 4);
    for (const u of own) {
      const js = await get(u, BROWSER_UA);
      if (!js.ok) { console.log(pad + '  bundle ' + u + ' → ' + js.status); continue; }
      const src = js.buf.toString('utf8');
      const eps = [...new Set((src.match(/["'`](\/?(api|v\d|graphql|reports?|availability)[^"'`\s]{0,120})["'`]/gi) || []))].slice(0, 40);
      const abs = [...new Set((src.match(/https?:\/\/[^"'`\s]{6,140}/g) || []))].filter(x => !/w3\.org|reactjs|mozilla|github|npmjs|sentry|google/.test(x)).slice(0, 30);
      console.log(pad + '  bundle ' + u + ' (' + src.length + ' chars)\n' + pad + '    endpoints: ' + eps.join(' , ') + '\n' + pad + '    urls: ' + abs.join(' , '));
      ['fetch(', 'axios', 'baseURL', 'source=', 'type=report', 'sport='].forEach(k => {
        const at = src.indexOf(k);
        if (at >= 0) console.log(pad + '    ctx[' + k + '] ' + src.slice(Math.max(0, at - 200), at + 300).replace(/\s+/g, ' '));
      });
    }
  }
  const head = title ? strip(title).split(' - ')[0].trim() : null;
  if (head) {
    const first = html.indexOf(head), second = first >= 0 ? html.indexOf(head, first + head.length) : -1;
    const at = second >= 0 ? second : first;
    if (at >= 0) console.log(pad + '  RAW HTML after heading >>> ' + html.slice(at, at + 3500).replace(/\s+/g, ' ') + ' <<<');
  }
  const links = linksOf(html, r.url);
  console.log(pad + '  report-looking links (' + links.length + '):');
  links.slice(0, 50).forEach(l => console.log(pad + '    ' + l.href + '  «' + l.text + '»'));
  const text = strip(html);
  const at = text.search(/availab/i);
  console.log(pad + '  TEXT (from first "availab", ' + text.length + ' chars total) >>>\n'
    + text.slice(Math.max(0, at - 200), Math.max(0, at - 200) + (depth ? 1800 : 3500)) + '\n' + pad + '  <<<');
  return links;
}

(async function main() {
  const want = process.argv.slice(2);
  const keys = want.length ? want : Object.keys(CANDIDATES);
  for (const k of keys) {
    console.log('\n######## ' + k);
    for (const url of CANDIDATES[k] || []) {
      const b = await get(url, BROWSER_UA);
      const e = await get(url, EDGE_UA);
      console.log('==== ' + url + '  [edgedesk UA: ' + e.status + ' · browser UA: ' + b.status + ']');
      const links = await show('browser UA', b.ok ? b : e, 0);
      if (!links) continue;
      const host = new URL(b.url || url).host;
      const follow = links.filter(l => /availab/i.test(l.href + ' ' + l.text) && l.href !== (b.url || url)
        && (new URL(l.href).host === host || /\.pdf/i.test(l.href))).slice(0, 4);
      for (const l of follow) await show('follow ' + l.href, await get(l.href, BROWSER_UA), 1);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
