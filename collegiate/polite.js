'use strict';
/* ===========================================================================
   EdgeDesk collegiate — the one way a collegiate job reads a school's site.

   A school's athletics site is somebody else's server, read for public pages
   (schedules, results, box scores, rosters). Every read goes through here:

     IDENTITY     User-Agent "EdgeDeskBot/1.0 (+https://edgedesksports.com)",
                  the name every EdgeDesk crawler uses (growth_outbound_research).
     ROBOTS.TXT   read first, per origin, cached a day (RFC 9309: our group,
                  else '*'; the longest match wins, Allow on a tie). A 4xx
                  robots.txt allows; a 5xx or no answer means STAY OUT (RFC
                  9309 2.3.1.4). Crawl-delay is honoured.
     ONE HOST, ONE BUDGET  each host is its own engine/http.js provider: one
                  request in flight, at least 2 s apart, a per-run and a
                  per-day cap, the cache, retries with Retry-After and the
                  breaker. A host nobody registered is never read.
     REFUSALS     a disallow, a 401/403, or a host that keeps answering 429 is
                  recorded (collegiate/data/refusals.jsonl) and the host is
                  left alone after that; nothing here retries around a "no",
                  changes identity or uses another route to the same page
                  (the UFCStats rule: a site that refuses automated access is
                  not read, directly or through anyone else's copy).

   Nothing in this file knows a sport or a school; fetchImpl, now() and sleep()
   are injectable so the suite runs offline (tools/collegiate/collegiate.test.js).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const H = require('../engine/http');

const UA = 'EdgeDeskBot/1.0 (+https://edgedesksports.com)';
const BOT = 'edgedeskbot';
const ROOT = path.join(__dirname, '..');
const REFUSALS = path.join(__dirname, 'data', 'refusals.jsonl');

/** robots.txt (RFC 9309) -> { allows(path), crawlDelayMs } for our group, else '*' */
function parseRobots(txt) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(txt == null ? '' : txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else if ((k === 'allow' || k === 'disallow') && cur) {
      lastWasAgent = false;
      if (v) cur.rules.push({ allow: k === 'allow', path: v });
    } else if (k === 'crawl-delay' && cur) {
      lastWasAgent = false;
      const d = Number(v); if (isFinite(d) && d >= 0) cur.delay = d;
    } else lastWasAgent = false;
  }
  const mine = groups.filter((g) => g.agents.indexOf(BOT) >= 0);
  const use = mine.length ? mine : groups.filter((g) => g.agents.indexOf('*') >= 0);
  const rules = [].concat(...use.map((g) => g.rules));
  const delays = use.map((g) => g.delay).filter((d) => d != null);
  return {
    allows(p) {
      let best = null;
      for (const r of rules) {
        const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
        if (re.test(p) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
      }
      return best ? best.allow : true;
    },
    crawlDelayMs: delays.length ? Math.max(...delays) * 1000 : 0,
  };
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* engine/http.js returns a failed request as status 0 with the HTTP code in error.code */
const httpStatus = (r) => (r.status ? r.status : (r.error && /^HTTP_(\d+)$/.test(r.error.code || '') ? Number(r.error.code.slice(5)) : 0));

/**
 * createPolite({ hosts, cacheDir, refusalsPath, fetchImpl, now, sleep, log, perHost })
 *   hosts: the registered hosts (e.g. 'gostanford.com'); any other host is refused
 * → { get(url, opts) → engine/http result, or { ok:false, refused:true, error:{code,message} },
 *     refusals(), refusedHost(host), stats() }
 */
function createPolite(o) {
  o = o || {};
  const per = Object.assign({ perRun: 150, perDay: 600, minIntervalMs: 2000 }, o.perHost || {});
  const providers = {};
  for (const h of o.hosts || []) providers['site:' + h] = { host: new RegExp('^(www\\.)?' + esc(h.replace(/^www\./, '')) + '$'), paid: false, perRun: per.perRun, perDay: per.perDay, concurrency: 1, minIntervalMs: per.minIntervalMs };
  const now = o.now || (() => Date.now());
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = o.log || (() => {});
  const client = H.createClient({ cacheDir: o.cacheDir || path.join(ROOT, '.cache', 'collegiate_http'), providers, fetchImpl: o.fetchImpl, now, sleep, log, retries: 2 });
  const refusalsPath = o.refusalsPath || REFUSALS;
  const robots = new Map();
  const lastAt = new Map();
  const refused = new Map();
  try {
    for (const line of fs.readFileSync(refusalsPath, 'utf8').split('\n')) if (line.trim()) { const r = JSON.parse(line); refused.set(r.host, r); }
  } catch (_) { /* no refusals yet */ }

  function refuse(host, url, code, why, persist) {
    const rec = { host, url, code, why, at: new Date(now()).toISOString() };
    if (persist && !refused.has(host)) {
      refused.set(host, rec);
      fs.mkdirSync(path.dirname(refusalsPath), { recursive: true });
      fs.appendFileSync(refusalsPath, JSON.stringify(rec) + '\n');
    }
    log('[polite] ' + host + ': ' + why + ' (' + url + ')');
    return { ok: false, refused: true, status: 0, url, body: null, text: () => '', json: () => null, error: { code, message: why } };
  }

  async function robotsFor(origin) {
    if (robots.has(origin)) return robots.get(origin);
    let r;
    try { r = await client.get(origin + '/robots.txt', { ttlMs: 24 * 3600 * 1000, headers: { 'user-agent': UA } }); }
    catch (e) { r = { ok: false, status: 0 }; }
    const st = httpStatus(r);
    let parsed;
    if (r.ok && st >= 200 && st < 300) parsed = parseRobots(r.text());
    /* a robots.txt that is itself refused (401/403) is a site keeping robots out: stay out (stricter than RFC 9309) */
    else if (st === 401 || st === 403) parsed = false;
    else if (st >= 400 && st < 500) parsed = parseRobots('');                 /* unavailable: allowed (RFC 9309 2.3.1.3) */
    else parsed = null;                                                        /* unreachable: complete disallow */
    robots.set(origin, parsed);
    return parsed;
  }

  const lastPage = new Map();
  async function get(url, opts) {
    let u;
    try { u = new URL(url); } catch (_) { return refuse('?', url, 'BAD_URL', 'not a URL', false); }
    const host = u.hostname.replace(/^www\./, '');
    if (refused.has(host)) return refuse(host, url, 'REFUSED_BEFORE', 'this host refused automated reads on ' + refused.get(host).at.slice(0, 10) + ' (' + refused.get(host).why + ')', false);
    if (!client.providerFor(url)) return refuse(host, url, 'UNREGISTERED', 'not a registered school host', false);
    const rb = await robotsFor(u.origin);
    if (rb === false) return refuse(host, url, 'ROBOTS_FORBIDDEN', 'robots.txt itself is refused to robots', true);
    if (rb === null) return refuse(host, url, 'ROBOTS_UNREACHABLE', 'robots.txt did not answer (staying out)', false);
    if (!rb.allows(u.pathname + u.search)) return refuse(host, url, 'ROBOTS_DISALLOW', 'robots.txt disallows it', true);
    /* the same page asked for twice in a row (a collector re-reading after it learnt the platform) is not a second visit */
    const again = lastPage.get(host);
    if (again && again.url === url && !(opts && opts.ttlMs === 0)) return again.r;
    const gap = rb.crawlDelayMs - (now() - (lastAt.get(host) || 0));
    if (gap > 0) await sleep(gap);
    lastAt.set(host, now());
    const r = await client.get(url, Object.assign({}, opts || {}, { headers: Object.assign({ 'user-agent': UA }, (opts && opts.headers) || {}) }));
    if (r.ok) lastPage.set(host, { url, r }); else lastPage.delete(host);
    const st = httpStatus(r);
    if (!r.ok && (st === 401 || st === 403)) return refuse(host, url, 'HTTP_' + st, 'the site answered ' + st + ': it does not want automated reads', true);
    if (!r.ok && st === 429) return refuse(host, url, 'HTTP_429', 'the site kept answering 429 (too many requests)', true);
    return r;
  }

  return { get, refusals: () => [...refused.values()], refusedHost: (h) => refused.has(String(h).replace(/^www\./, '')), stats: () => client.stats(), UA };
}

module.exports = { createPolite, parseRobots, UA, BOT };
