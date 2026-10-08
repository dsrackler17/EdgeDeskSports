#!/usr/bin/env node
/* ===========================================================================
   FREE STAYS FREE, PAID STAYS PAID.

   The free research experience (the landing page, /today/, the tools, the
   sample game, and the libraries they share) must never become a way round
   the subscription. lib/edgedesk_plans.js says what is free, what is paid and
   which door serves each; this suite holds the pages and the SQL to it:

     PLANS      Full Access is exactly lib/edgedesk_pricing.js FEATURES; every
                free item names an anonymous door or none; every planned item
                is OFF and is never on a free or paid list as available
     DOORS      every database door the free surfaces call is in the map; the
                free pages call anonymous doors only; every anonymous door is
                granted to anon in supabase/*.sql; every account door is NOT
     ARTIFACTS  no free surface fetches a premium research file (the boards,
                props, slates, EV) — only the two small public home files, and
                the schedule carries no model number
     FLAGS      flags switch UI only: neither the access client nor the
                terminal loads them; the terminal's paywall stays live
     SECRETS    no served file carries a Stripe, webhook, Anthropic or private
                key, and every JWT for this project decodes to role anon
     THE DESK   the AI endpoint refuses the anon key and uses the database's
                past-due grace (tools/intelligence/intelligence.test.js §32
                drives it; this pins the two lines)

   Known and NOT covered here, by design (docs/product-led-growth/PLAN.md §2):
   paid research still committed as static JSON is public; that is Phase 2b.

   Run: node tools/site/free_access.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PLANS = require(path.join(ROOT, 'lib', 'edgedesk_plans.js'));
const PRICING = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
const FLAGS = require(path.join(ROOT, 'lib', 'edgedesk_flags.js'));
const ACCESS = require(path.join(ROOT, 'lib', 'edgedesk_access.js'));
let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }

/* ── PLANS ───────────────────────────────────────────────────────────── */
eq('Full Access is exactly the price card\'s FEATURES, in order', PLANS.FULL.map((f) => f.label), PRICING.FEATURES);
chk('every paid feature names what enforces it', PLANS.FULL.concat(PLANS.FULL_SERVER).every((f) => f.gate && f.gate.length > 10));
PLANS.FREE.forEach((f) => {
  const m = /^(rpc|view|function|static|client):?([a-z_]*)$/.exec(f.door || '');
  chk('free ' + f.key + ': its door is a kind the map knows', !!m, f.door);
  if (m && (m[1] === 'rpc' || m[1] === 'view')) chk('free ' + f.key + ': reads through an ANONYMOUS door', PLANS.isAnonDoor(m[1], m[2]), f.door);
  const rel = f.href.replace(/^\//, '') + (f.href.endsWith('/') ? 'index.html' : '');
  chk('free ' + f.key + ': its page exists', fs.existsSync(path.join(ROOT, rel)), rel);
});
const planned = PLANS.PLANNED.map((p) => p.label.toLowerCase());
const flagged = PLANS.PLANNED.filter((p) => p.flag);
flagged.forEach((p) => {
  chk('planned ' + p.key + ': its flag exists and is a planned flag', FLAGS.FLAGS[p.flag] && FLAGS.FLAGS[p.flag].kind === 'planned', p.flag);
  chk('planned ' + p.key + ': and is OFF', FLAGS.on(p.flag, '') === false);
});
Object.keys(FLAGS.FLAGS).filter((k) => FLAGS.FLAGS[k].kind === 'planned').forEach((k) =>
  chk('every planned flag belongs to a planned item: ' + k, flagged.some((p) => p.flag === k)));
chk('no planned feature is on the free list', PLANS.FREE.every((f) => planned.every((p) => f.label.toLowerCase().indexOf(p) < 0)));
chk('no planned feature is on the price card', PRICING.FEATURES.every((f) => planned.every((p) => f.toLowerCase().indexOf(p) < 0)));

/* ── DOORS ───────────────────────────────────────────────────────────── */
/* the free surfaces, and whether each may also use account doors (the
   landing page signs people up and starts checkout; the access client is
   the account's own door) */
const SURFACES = [
  ['index.html', true], ['lib/edgedesk_access.js', true],
  ['today/index.html', false], ['tools/index.html', false], ['tools/no-vig-calculator/index.html', false],
  ['tools/fair-odds-calculator/index.html', false], ['tools/model-vs-market/index.html', false],
  ['research/sample/index.html', false], ['lib/edgedesk_public.js', false], ['lib/edgedesk_track.js', false],
  ['lib/edgedesk_home.js', false], ['lib/edgedesk_flags.js', false], ['lib/edgedesk_plans.js', false],
  ['lib/edgedesk_odds_tools.js', false], ['lib/edgedesk_nav.js', false], ['lib/edgedesk_home_free.js', false]
];
function doorsIn(src) {
  const out = [];
  const add = (kind, name) => out.push(kind + ':' + name);
  for (const m of src.matchAll(/\/rest\/v1\/rpc\/([a-z_0-9]+)/g)) add('rpc', m[1]);
  for (const m of src.matchAll(/\b(?:rpc|post)\(\s*'([a-z_0-9]+)'/g)) add('rpc', m[1]);
  for (const m of src.matchAll(/sbGet\(\s*'([a-z_0-9]+)/g)) add('view', m[1]);
  for (const m of src.matchAll(/\/rest\/v1\/(?!rpc\b)([a-z_0-9]+)/g)) add('table', m[1]);
  for (const m of src.matchAll(/\/functions\/v1\/([a-z_0-9]+)/g)) add('fn', m[1]);
  return Array.from(new Set(out));
}
const inMap = (k, n) => (PLANS.DOORS.anon[k] || []).indexOf(n) >= 0 || (PLANS.DOORS.account[k] || []).indexOf(n) >= 0;
SURFACES.forEach(([rel, accountOk]) => {
  const src = read(rel);
  const doors = doorsIn(src);
  doors.forEach((d) => {
    const [k, n] = d.split(':');
    chk(rel + ': ' + d + ' is in the door map', inMap(k, n));
    if (!accountOk) chk(rel + ': ' + d + ' is an anonymous door (a free page needs no account)', PLANS.isAnonDoor(k, n));
  });
  /* the newsletter function is the one public function a free page posts to */
  if (!accountOk) chk(rel + ': calls no edge function but the newsletter', doors.filter((d) => d.indexOf('fn:') === 0).every((d) => d === 'fn:newsletter'), doors);
});
chk('the free pages found their doors (the scan is not blind)', doorsIn(read('today/index.html')).indexOf('rpc:public_home_board') >= 0
  && doorsIn(read('lib/edgedesk_public.js')).indexOf('rpc:acq_track_visit') >= 0 && doorsIn(read('research/sample/index.html')).indexOf('rpc:public_sample_research') >= 0);

/* the SQL: every anonymous RPC is granted to anon; no account door is */
const SQL = fs.readdirSync(path.join(ROOT, 'supabase')).filter((f) => f.endsWith('.sql')).map((f) => read('supabase/' + f)).join('\n');
function rpcGrantees(name) {
  const re = new RegExp('grant\\s+execute\\s+on\\s+function\\s+public\\.' + name + '\\s*\\([^)]*\\)\\s+to\\s+([^;]+);', 'gi');
  return Array.from(new Set([...SQL.matchAll(re)].flatMap((m) => m[1].split(',').map((x) => x.trim().toLowerCase()))));
}
function tableGrantees(name) {
  const re = new RegExp('grant\\s+[a-z, ]+\\s+on\\s+(?:table\\s+)?public\\.' + name + '\\s+to\\s+([^;]+);', 'gi');
  return Array.from(new Set([...SQL.matchAll(re)].flatMap((m) => m[1].split(',').map((x) => x.trim().toLowerCase()))));
}
PLANS.DOORS.anon.rpc.forEach((n) => chk('anon may call ' + n + ' (granted in supabase/*.sql)', rpcGrantees(n).indexOf('anon') >= 0, rpcGrantees(n)));
PLANS.DOORS.account.rpc.forEach((n) => {
  const g = rpcGrantees(n);
  chk('a signed-in account may call ' + n, g.indexOf('authenticated') >= 0, g);
  chk('anon may NOT call ' + n, g.indexOf('anon') < 0 && g.indexOf('public') < 0, g);
});
PLANS.DOORS.account.table.forEach((n) => chk('anon is granted nothing on ' + n, tableGrantees(n).indexOf('anon') < 0, tableGrantees(n)));
chk('subscriptions: every privilege is revoked from anon', /revoke\s+all\s+on\s+public\.subscriptions\s+from\s+anon/i.test(SQL));
chk('the shared research state is not readable by anon', tableGrantees('game_research_state').indexOf('anon') < 0);

/* ── ARTIFACTS ───────────────────────────────────────────────────────── */
const PUBLIC_FILES = ['/football/home/board.json', '/football/home/schedule.json'];
SURFACES.forEach(([rel]) => {
  const src = read(rel);
  const files = Array.from(new Set([...src.matchAll(/['"(](\/?football\/[A-Za-z0-9_./-]+\.json)/g)].map((m) => '/' + m[1].replace(/^\//, ''))));
  chk(rel + ': fetches no premium research file', files.every((f) => PUBLIC_FILES.indexOf(f) >= 0), files);
});
{
  const S = JSON.parse(read('football/home/schedule.json'));
  const ALLOWED = ['key', 'league', 'week', 'kickoff', 'away', 'home', 'away_code', 'home_code', 'venue', 'away_conf', 'home_conf', 'fcs'];
  chk('the public schedule carries no model number, market or EV', S.games.every((g) => Object.keys(g).every((k) => ALLOWED.indexOf(k) >= 0)));
}

/* ── FLAGS ───────────────────────────────────────────────────────────── */
const APP = read('app.html');
chk('the access client never reads a flag', !/EDFlags|edgedesk_flags/.test(read('lib/edgedesk_access.js')));
chk('the terminal does not load the flags at all', !/EDFlags|edgedesk_flags/.test(APP));
chk('the terminal\'s paywall stays live', /var PAYWALL_LIVE\s*=\s*true\b|PAYWALL_LIVE\s*=\s*true\b/.test(APP));
chk('an unknown flag is off', FLAGS.on('grant_access', '?ff=grant_access:1') === false);
chk('a URL cannot switch an unknown flag on', Object.keys(FLAGS._overrides('?ff=paywall:0,has_access:1')).length === 0);
chk('a planned flag forced on by URL changes no access decision', FLAGS.on('free_accounts', '?ff=free_accounts:1') === true && ACCESS.grants(null) === false
  && ACCESS.offerFor(null) === 'trial');
chk('a free account (no subscription row) is not granted access', ACCESS.grants(null) === false && ACCESS.grants({ status: 'canceled' }) === false);

/* ── SECRETS ─────────────────────────────────────────────────────────── */
{
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => /\.(html|js|ts|json|css|md|sql|yml|txt|xml)$/.test(f))
    /* test fixtures carry placeholder keys on purpose; they configure a
       throwaway local database and are never a live credential */
    .filter((f) => !/(\.test\.js|\.e2e\.js|_harness\.js|\/tests\.js|\/fixtures\/)/.test(f));
  const KEY = /sk_live_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY/;
  const JWT = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;
  const hits = [], jwts = [];
  files.forEach((f) => {
    let s; try { s = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return; }
    if (s.length > 6e6) return;
    if (KEY.test(s)) hits.push(f);
    for (const m of s.matchAll(JWT)) {
      let c = null; try { c = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (_) { c = null; }
      if (c && c.ref) jwts.push({ f, role: c.role, ref: c.ref });
    }
  });
  chk('scanned the served tree', files.length > 500, files.length);
  eq('no served file carries a Stripe, webhook, Anthropic or private key', hits, []);
  chk('the project key is found where it is shipped (the scan is not blind)', jwts.some((j) => j.f === 'index.html'));
  eq('every project JWT in a served file is the public anon key', jwts.filter((j) => j.role !== 'anon').map((j) => j.f + ':' + j.role), []);
}

/* ── THE DESK ────────────────────────────────────────────────────────── */
{
  const AI = read('supabase/functions/edgedesk_ai/index.ts');
  chk('the AI desk refuses a token whose role is anon', /bearerRole\(auth\) === "anon"\) return \{ ok: false, status: 401/.test(AI));
  chk('and refuses a 401/403 from the subscription read', /r\.status === 401 \|\| r\.status === 403\) \{\s*return \{ ok: false, status: 401/.test(AI));
  const g = /const PG_GRACE_DAYS = (\d+);/.exec(AI);
  eq('and uses the database\'s past-due grace', g ? +g[1] : null, ACCESS.PAST_DUE_GRACE_DAYS);
}

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'free access — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
