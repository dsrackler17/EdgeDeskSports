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

function show(label, r, depth) {
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
      const links = show('browser UA', b.ok ? b : e, 0);
      if (!links) continue;
      const host = new URL(b.url || url).host;
      const follow = links.filter(l => /availab/i.test(l.href + ' ' + l.text) && l.href !== (b.url || url)
        && (new URL(l.href).host === host || /\.pdf/i.test(l.href))).slice(0, 4);
      for (const l of follow) show('follow ' + l.href, await get(l.href, BROWSER_UA), 1);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
