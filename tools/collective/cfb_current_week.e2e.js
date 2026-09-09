#!/usr/bin/env node
/* ===========================================================================
   COLLEGE FOOTBALL -> CURRENT, end to end, in a real browser.

   The unit suites prove the rule, the planner and the render functions. This
   proves the PRODUCT: the schedule sync run twice through its real entry
   point against a recorded feed and a PostgREST-shaped database, and then
   collective/index.html loaded in Chromium against the Collective's public
   function exactly as it is deployed today -- a week-less answer decided by
   the old 36-hour rule, no week on any row, and Week 1 unsettled because the
   settle job could not write a score. The page has to land on Week 2 on that
   wire, count Week 2 only, keep W1 as history, show W2 as the same slate as
   Current, survive a reload, and attach projections and market lines to the
   right games.

   Needs Playwright with Chromium (PLAYWRIGHT_BROWSERS_PATH or a global
   install); prints SKIPPED and exits 0 when neither is available, so it can
   sit beside the offline suites without failing a machine that has no
   browser. Everything else is local: no network, no credentials.

   Run:  node tools/collective/cfb_current_week.e2e.js
         node tools/collective/cfb_current_week.e2e.js --shots /tmp/shots
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOUR = 3600e3, DAY = 86400e3;
const NOW = Date.now();
const T = h => new Date(NOW + h * HOUR).toISOString();
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String(e && e.stack || e) }; } }
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; failures.push({ name, detail }); console.log('  FAIL ' + name + (detail ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}

/* ---------------------------------------------------------------- the world
   Week 1: the real 58 finished games out of the committed settlement record
   (their ids, so the page can grade them from that file), unsettled in the
   DATABASE the way they really are, kicked off last week -- the Monday game
   inside the old 36-hour lookback so the deployed rule answers Week 1.
   Week 2: ten games, Thursday to Saturday, one to three days ahead.
   Week 3: three games the week after. Nothing is loaded for 2 or 3 until the
   sync runs. */
const RECORD = JSON.parse(fs.readFileSync(path.join(ROOT, 'collective', 'settled', 'CFB_2026.json'), 'utf8'));
const W1 = Object.keys(RECORD.games).map((id, i) => {
  const g = RECORD.games[id];
  return { id, home: g.home, away: g.away, kickoff_at: i === 0 ? T(-26) : T(-84 + (i % 7) * 3) };
});
/* the one game the record has that ESPN never carried, held as it really is */
const W2 = [
  ['SMU', 'Baylor', 1.6, '401'], ['Idaho', 'Utah', 1.9, '402'], ['Boise State', 'Oregon', 2.5, '403'],
  ['Kansas State', 'Arizona', 2.6, '404'], ['Iowa', 'Iowa State', 3.3, '405'], ['Michigan', 'Oklahoma', 3.4, '406'],
  ['Texas', 'Ohio State', 3.5, '407'], ['Ole Miss', 'Kentucky', 3.6, '408'], ['Utah State', 'Texas A&M', 3.7, '409'],
  ['UCLA', 'UNLV', 3.9, '410'],
].map(([away, home, days, id]) => ({ away, home, kickoff_at: T(days * 24), espn_id: id, week: 2 }));
const W3 = [
  ['LSU', 'Florida', 8.5, '501'], ['Georgia', 'Tennessee', 9.5, '502'], ['Notre Dame', 'Purdue', 10.5, '503'],
].map(([away, home, days, id]) => ({ away, home, kickoff_at: T(days * 24), espn_id: id, week: 3 }));

const code = n => String(n).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10);

/* ------------------------------------------------------ the database (mock)
   PostgREST-shaped, over the collective schema: enough of the filter
   grammar for what the sync, the settler and the public function ask. */
const store = { teams: [], aliases: [], games: [], results: [], projections: [] };
let seq = 1000;
const uid = () => 'id-' + (++seq);
function seedTeam(name, teamCode) {
  const c = teamCode || code(name);
  let t = store.teams.find(x => x.code === c);
  if (!t) { t = { id: uid(), sport_code: 'CFB', code: c, name }; store.teams.push(t); }
  return t;
}
W1.forEach(g => {
  const h = seedTeam(g.home, g.home), a = seedTeam(g.away, g.away);   /* legacy: name IS the code */
  store.games.push({ id: g.id, sport_code: 'CFB', season: 2026, week: 1, kickoff_at: g.kickoff_at,
    home_team_id: h.id, away_team_id: a.id, status: 'scheduled', external_ref: null, created_at: T(-200) });
});
/* the game the real database holds that the feed never carried (the
   settle log's "WASHINGTO2 @ WASHINGTON: no_source_has_a_final") */
const ORPHAN = { id: 'orphan-w1', home: 'WASHINGTON', away: 'WASHINGTO2' };
(function () {
  const h = seedTeam('WASHINGTON', 'WASHINGTON'), a = seedTeam('WASHINGTO2', 'WASHINGTO2');
  store.games.push({ id: ORPHAN.id, sport_code: 'CFB', season: 2026, week: 1, kickoff_at: T(-80),
    home_team_id: h.id, away_team_id: a.id, status: 'scheduled', external_ref: null, created_at: T(-200) });
})();
const SEED_TEAMS = store.teams.length;
/* two models, posted on the first three Week 1 games (last week's numbers)
   -- these must never count on Week 2 */
const MODELS = [
  { creator_slug: 'edgedesksports', model_slug: 'edgedesk-cfb', creator_name: 'EdgeDesk Sports', model_name: 'EdgeDesk Model', monogram: 'ED' },
  { creator_slug: 'blerm', model_slug: 'blerm-s-model', creator_name: 'Blerm', model_name: "Blerm's Model", monogram: 'BL' },
];
W1.slice(0, 3).forEach(g => MODELS.forEach((m, i) => store.projections.push({
  id: uid(), game_id: g.id, creator_slug: m.creator_slug, model_slug: m.model_slug, pick_side: 'home',
  projected_spread: -7 - i, projected_total: 51, home_win_prob: 0.7, line_at_submission: -6.5, received_at: T(-120) })));

function teamName(id) { const t = store.teams.find(x => x.id === id); return t ? t.code : '?'; }
function detailRows() {
  return store.games.map(g => {
    const r = store.results.find(x => x.game_id === g.id) || {};
    const home = teamName(g.home_team_id), away = teamName(g.away_team_id);
    return { game_id: g.id, sport: g.sport_code, season: g.season, week: g.week, kickoff_at: g.kickoff_at,
      status: g.status, home, away, label: `${away} @ ${home}`,
      home_score: r.home_score == null ? null : r.home_score, away_score: r.away_score == null ? null : r.away_score,
      closing_spread: r.closing_spread == null ? null : r.closing_spread, closing_total: r.closing_total == null ? null : r.closing_total };
  });
}
/* the filter grammar: col=eq.v, in.(a,b), gte.v, lte.v, is.null, not.in.(..), not.is.null */
function applyQuery(rows, qs) {
  const q = new URLSearchParams(qs);
  let out = rows.slice();
  for (const [k, v] of q.entries()) {
    if (k === 'select' || k === 'order' || k === 'limit' || k === 'offset') continue;
    const m = /^(not\.)?(eq|in|gte|lte|gt|lt|is)\.(.*)$/.exec(v);
    if (!m) continue;
    const neg = !!m[1], op = m[2], val = m[3];
    out = out.filter(r => {
      const x = r[k];
      let hit;
      if (op === 'eq') hit = String(x) === val;
      else if (op === 'in') hit = val.replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, '')).indexOf(String(x)) >= 0;
      else if (op === 'is') hit = val === 'null' ? x == null : (val === 'true' ? x === true : x === false);
      else { const a = isNaN(Date.parse(x)) ? Number(x) : Date.parse(x); const b = isNaN(Date.parse(val)) ? Number(val) : Date.parse(val);
        hit = op === 'gte' ? a >= b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a < b; }
      return neg ? !hit : hit;
    });
  }
  const order = q.get('order');
  if (order) {
    const [col, dir] = order.split(',')[0].split('.');
    out.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
  }
  const lim = Number(q.get('limit'));
  if (lim) out = out.slice(0, lim);
  const sel = q.get('select');
  if (sel && sel !== '*') out = out.map(r => { const o = {}; sel.split(',').forEach(c => { o[c] = r[c]; }); return o; });
  return out;
}
const SCHEMA = { definitions: {
  games: { properties: Object.fromEntries(['id', 'sport_code', 'season', 'week', 'kickoff_at', 'home_team_id', 'away_team_id', 'status', 'external_ref', 'created_at'].map(c => [c, {}])) },
  game_results: { properties: Object.fromEntries(['game_id', 'home_score', 'away_score', 'closing_spread', 'closing_total', 'settled_at'].map(c => [c, {}])) },
  teams: { properties: Object.fromEntries(['id', 'sport_code', 'code', 'name'].map(c => [c, {}])) },
  team_aliases: { properties: Object.fromEntries(['id', 'sport_code', 'alias', 'team_id'].map(c => [c, {}])) },
  projections: { properties: Object.fromEntries(['id', 'model_id', 'game_id', 'pick_side', 'projected_spread', 'projected_total', 'home_win_prob', 'is_late', 'is_graded_candidate', 'data_origin', 'resolution_status', 'received_at', 'pick_result', 'margin_error', 'brier'].map(c => [c, {}])) },
} };
const dbLog = [];
function dbHandler(req, res, body) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname, qs = u.search.slice(1);
  dbLog.push(req.method + ' ' + p + (qs ? '?' + qs : ''));
  const send = (st, obj) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (p === '/rest/v1/' && req.method === 'GET') return send(200, SCHEMA);
  if (p === '/rest/v1/sports') return send(200, [{ code: 'CFB', name: 'College Football' }, { code: 'NFL', name: 'Football' }]);
  if (p === '/rest/v1/sport_seasons') return send(200, [{ sport_code: 'CFB', season: 2026, starts_on: '2026-08-01', ends_on: '2027-01-31' },
    { sport_code: 'NFL', season: 2026, starts_on: '2026-09-01', ends_on: '2027-02-15' }]);
  if (p === '/rest/v1/game_detail') return send(200, applyQuery(detailRows(), qs));
  if (p === '/rest/v1/games' && req.method === 'GET') return send(200, applyQuery(store.games, qs));
  if (p === '/rest/v1/teams' && req.method === 'GET') return send(200, applyQuery(store.teams, qs));
  if (p === '/rest/v1/team_aliases' && req.method === 'GET') return send(200, applyQuery(store.aliases, qs));
  if (p === '/rest/v1/teams' && req.method === 'POST') {
    const rows = JSON.parse(body).map(r => Object.assign({ id: uid() }, r));
    for (const r of rows) if (store.teams.some(t => t.code === r.code)) return send(409, { message: 'duplicate key value violates unique constraint teams_code' });
    store.teams.push(...rows); return send(201, rows);
  }
  if (p === '/rest/v1/team_aliases' && req.method === 'POST') { const rows = JSON.parse(body).map(r => Object.assign({ id: uid() }, r)); store.aliases.push(...rows); return send(201, rows); }
  if (p === '/rest/v1/games' && req.method === 'POST') {
    const rows = JSON.parse(body).map(r => Object.assign({ id: uid(), created_at: new Date().toISOString(), status: 'scheduled', external_ref: null }, r));
    for (const r of rows) if (r.external_ref && store.games.some(g => g.external_ref === r.external_ref)) return send(409, { message: 'duplicate external_ref' });
    store.games.push(...rows); return send(201, rows);
  }
  if (p === '/rest/v1/games' && req.method === 'PATCH') {
    const patch = JSON.parse(body); const hit = applyQuery(store.games, qs);
    hit.forEach(g => Object.assign(g, patch)); return send(200, hit);
  }
  if (p === '/rest/v1/game_results' && req.method === 'POST') {
    const rows = JSON.parse(body);
    rows.forEach(r => { const have = store.results.find(x => x.game_id === r.game_id); if (have) Object.assign(have, r); else store.results.push(Object.assign({ settled_at: new Date().toISOString() }, r)); });
    return send(201, rows);
  }
  if (p === '/rest/v1/rpc/admin_reresolve') return send(200, { ok: true, resolved: 0 });
  return send(404, { message: 'no route ' + req.method + ' ' + p });
}

/* ------------------------------------------------------------ ESPN (mock)
   The scoreboard, the shape the real one has. Week 1 carries the games the
   record holds (by their codes, which is what a legacy row is named);
   weeks 2 and 3 their slates; anything else nothing. MOVED=1 restates one
   Week 2 kickoff two hours later, the way a TV window does. */
function espnEvent(g, weekNo, id) {
  const side = (name, ha) => ({ homeAway: ha, score: '', team: { location: name, displayName: name, shortDisplayName: name, abbreviation: code(name).slice(0, 4), name: 'Team' } });
  return { id: String(id), date: g.kickoff_at, week: { number: weekNo }, season: { type: 2, year: 2026 },
    competitions: [{ status: { type: { completed: false, state: 'pre', name: 'STATUS_SCHEDULED' } }, competitors: [side(g.home, 'home'), side(g.away, 'away')] }] };
}
let MOVED = false;    /* run 2 restates one Week 2 kickoff two hours later */
function espnHandler(req, res) {
  const u = new URL(req.url, 'http://x');
  const week = Number(u.searchParams.get('week')), type = Number(u.searchParams.get('seasontype'));
  let events = [];
  if (type === 2 && week === 1) events = W1.map((g, i) => espnEvent(g, 1, 300 + i));
  if (type === 2 && week === 2) events = W2.map(g => espnEvent(MOVED && g.espn_id === '401'
    ? Object.assign({}, g, { kickoff_at: new Date(Date.parse(g.kickoff_at) + 2 * HOUR).toISOString() }) : g, 2, g.espn_id));
  if (type === 2 && week === 3) events = W3.map(g => espnEvent(g, 3, g.espn_id));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ week: { number: week }, season: { type, year: 2026 }, events }));
}

/* --------------------------------------- collective_public + odds (mock)
   AS DEPLOYED: a week-less call answers with the week of the earliest game
   kicking off at or after now minus 36 hours; no row carries a week. */
function boardRows(week) {
  return detailRows().filter(g => g.week === week).sort((a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at)).map(g => {
    const settled = g.status === 'final' || g.home_score !== null;
    return { game_id: g.game_id, label: g.label, home: g.home, away: g.away, kickoff_at: g.kickoff_at, status: g.status,
      result: settled && g.home_score !== null ? { home_score: g.home_score, away_score: g.away_score, closing_spread: g.closing_spread, closing_total: g.closing_total } : null,
      consensus: null,
      models: store.projections.filter(p => p.game_id === g.game_id).map(p => ({ creator_slug: p.creator_slug, model_slug: p.model_slug, locked: false, late: false,
        pick_side: p.pick_side, projected_spread: p.projected_spread, projected_total: p.projected_total, home_win_probability: p.home_win_prob,
        line_at_submission: p.line_at_submission, cover_probability: null, received_at: p.received_at, movement_n: 1, grade: null })) };
  });
}
function deployedCurrentWeek() {
  const grace = NOW - 36 * HOUR;
  const next = detailRows().filter(g => g.week != null && Date.parse(g.kickoff_at) >= grace).sort((a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at))[0];
  if (next) return next.week;
  const last = detailRows().sort((a, b) => Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at))[0];
  return last ? last.week : null;
}
const apiLog = [];
function publicHandler(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/^\/functions\/v1/, '');
  apiLog.push(p + u.search);
  const send = (st, obj) => { res.writeHead(st, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') return send(204, {});
  if (p === '/collective_public/v1/meta') return send(200, { name: 'Model Collective', pricing: { monthly_cents: 2499, annual_cents: 0, currency: 'usd' }, billing_live: false,
    sports: [{ code: 'NFL', name: 'Football', season: 2026, in_season: true }, { code: 'CFB', name: 'College Football', season: 2026, in_season: true }],
    counts: { creators: 2, models: 2, graded_games: 0, live_projections: store.projections.length }, urls: {} });
  if (p === '/collective_public/v1/wall') return send(200, { generated_at: new Date().toISOString(), rows: MODELS.map(m => ({
    creator_slug: m.creator_slug, creator_name: m.creator_name, model_slug: m.model_slug, model_name: m.model_name, sport: 'CFB',
    membership: 'ACTIVE CONTRIBUTOR', founding: false, record: null, coverage_pct: 100, last_submission_at: T(-3), monogram: m.monogram })) });
  if (p === '/collective_public/v1/activity') return send(200, { rows: [] });
  if (p === '/collective_public/v1/rules') return send(200, { version: 2, rules: [] });
  if (p === '/collective_public/v1/me') return send(200, { signed_in: false, role: 'guest' });
  if (p === '/collective_public/v1/rankings') return send(200, { thresholds: {}, boards: { win_pct: [], margin_mae: [], brier: [] }, unranked: [] });
  if (p === '/collective_public/v1/games') {
    const sport = u.searchParams.get('sport') || 'NFL';
    if (sport !== 'CFB') return send(200, { sport, season: 2026, week: 1, entitled: true, games: [] });
    const raw = u.searchParams.get('week');
    const week = raw ? Number(raw) : deployedCurrentWeek();
    return send(200, { sport, season: 2026, week, entitled: true, games: boardRows(week) });
  }
  if (/^\/collective_odds\/v1\/ncaaf\/odds/.test(p)) {
    /* the market, on the Week 2 games, by the Collective's own game id */
    const games = detailRows().filter(g => g.week === 2).map((g, i) => ({ event_id: 'ev-' + g.game_id, collective_game_id: g.game_id, home: g.home, away: g.away,
      commence_time: g.kickoff_at, last_odds_at: new Date(NOW - 5 * 60e3).toISOString(),
      consensus: { spread: { median: -(3.5 + i), books: 6 }, total: { median: 51.5, books: 6 }, moneyline: { home_fair_prob: 0.62 } } }));
    return send(200, { state: 'ok', league: 'ncaaf', last_updated: new Date().toISOString(), games });
  }
  if (/^\/collective_odds\//.test(p)) return send(200, { state: 'ok', games: [] });
  return send(404, { error: { code: 'not_found', message: p } });
}

/* ------------------------------------------------------------ static site */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain' };
function siteHandler(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function serve(handler, withBody) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (!withBody) return handler(req, res);
      let b = ''; req.on('data', c => { b += c; }); req.on('end', () => handler(req, res, b));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async function main() {
  console.log('\n== the sync, twice, through its real entry point ==');
  const db = await serve(dbHandler, true);
  const espn = await serve(espnHandler, false);
  const env = Object.assign({}, process.env, { EDGD_SB_URL: `http://127.0.0.1:${db.port}`, EDGD_SB_SERVICE: 'svc',
    ESPN_API: `http://127.0.0.1:${espn.port}`, COLLECTIVE_API: 'http://127.0.0.1:1/functions/v1', NODE_USE_ENV_PROXY: '0', HTTPS_PROXY: '', https_proxy: '' });
  /* asynchronously: the mock servers live in THIS process, and a blocking
     spawn would freeze the event loop they answer from */
  const run = extra => new Promise(resolve => {
    const c = spawn(process.execPath, [path.join(ROOT, 'tools', 'collective', 'sync_schedule.js'), '--commit', '--sport', 'CFB', '--season', '2026'],
      { env: Object.assign({}, env, extra || {}) });
    let out = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { c.kill('SIGKILL'); out += '\n[spawn] timed out'; }, 90000);
    c.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
  const before = store.games.length;
  const r1 = await run();
  console.log(r1.out.split('\n').filter(l => /Current is|missing|Done|games:|teams:|changed:|DUPLICATE|\?/.test(l)).map(l => '   ' + l).join('\n'));
  const afterFirst = store.games.length;
  chk('SYNC 1  exits clean', r1.code === 0, { code: r1.code, tail: r1.out.slice(-800) });
  chk('SYNC 1  Current was Week 1 (nothing later loaded yet), so it looked at weeks 1, 2 and 3', /Current is week 1/.test(r1.out) && /w2:/.test(r1.out) && /w3:/.test(r1.out));
  chk('SYNC 1  loads the Week 2 and Week 3 slates it was short of', afterFirst === before + W2.length + W3.length, { before, afterFirst });
  chk('SYNC 1  every loaded game carries the provider id and the provider week',
    store.games.filter(g => g.week === 2).every(g => /^espn:\d+$/.test(g.external_ref || '')) && store.games.filter(g => g.week === 2).length === W2.length);
  chk('SYNC 1  the Week 1 games it already held were given their provider id in place, same rows',
    store.games.filter(g => g.week === 1 && g.external_ref).length === W1.length
      && store.games.filter(g => g.week === 1).every(g => W1.some(x => x.id === g.id) || g.id === ORPHAN.id) && /changed: 58 updated/.test(r1.out),
    { withRef: store.games.filter(g => g.week === 1 && g.external_ref).length });
  chk('SYNC 1  the one held game the feed never carried is reported, not deleted',
    /WASHINGTO2 @ WASHINGTON .* is held but the feed does not carry it/.test(r1.out) && store.games.some(g => g.id === ORPHAN.id) && !store.games.find(g => g.id === ORPHAN.id).external_ref);
  chk('SYNC 1  no game was created for a fixture already held (no duplicate pairing inside a week)', function () {
    const seen = new Set();
    return store.games.every(g => { const k = g.week + ':' + g.home_team_id + ':' + g.away_team_id; if (seen.has(k)) return false; seen.add(k); return true; });
  });
  const created = store.teams.slice(SEED_TEAMS);
  chk('SYNC 1  a school the database already held by its code is reused; only the rest are created, with full names and aliases',
    created.length > 0 && created.every(t => t.name !== t.code)
      && created.filter(t => /\s/.test(t.name)).every(t => store.aliases.some(a => a.alias === t.name && a.team_id === t.id))
      && store.teams.filter(t => t.code === 'BAYLOR').length === 1 && new Set(store.teams.map(t => t.code)).size === store.teams.length,
    { created: created.map(t => t.code + '=' + t.name) });
  chk('SYNC 1  Iowa State, Ohio State, Utah State and Texas A&M are their own rows, not the legacy IOWA / OHIO / UTAH / TEXAS rows',
    ['IOWASTATE', 'OHIOSTATE', 'UTAHSTATE', 'TEXASAM'].every(c => store.teams.some(t => t.code === c))
      && store.games.filter(g => g.week === 2).every(g => g.home_team_id !== g.away_team_id),
    { codes: store.teams.map(t => t.code).filter(c => /IOWA|OHIO|UTAH|TEXAS/.test(c)) });
  const idsAfterFirst = store.games.map(g => g.id + '|' + g.external_ref).sort().join(',');
  const movedBefore = store.games.find(g => g.external_ref === 'espn:401');
  const kickBefore = movedBefore && movedBefore.kickoff_at;
  MOVED = true;
  const r2 = await run();
  console.log(r2.out.split('\n').filter(l => /Current is|missing|Done|changed|~|DUPLICATE/.test(l)).map(l => '   ' + l).join('\n'));
  chk('SYNC 2  exits clean', r2.code === 0, { code: r2.code, tail: r2.out.slice(-800) });
  chk('SYNC 2  Current is now Week 2, so it looked at weeks 2, 3 and 4', /Current is week 2/.test(r2.out) && /w4:/.test(r2.out));
  chk('SYNC 2  the game set is the same: nothing loaded twice, no ids changed', store.games.length === afterFirst && store.games.map(g => g.id + '|' + g.external_ref).sort().join(',') === idsAfterFirst,
    { n: store.games.length, afterFirst });
  const movedAfter = store.games.find(g => g.external_ref === 'espn:401');
  chk('SYNC 2  the kickoff the feed moved was updated on the SAME game, two hours later, by id',
    movedAfter && movedAfter.id === movedBefore.id && Date.parse(movedAfter.kickoff_at) - Date.parse(kickBefore) === 2 * HOUR && /\[ref\]\s+kickoff_at/.test(r2.out),
    { before: kickBefore, after: movedAfter && movedAfter.kickoff_at });
  chk('SYNC 2  no duplicate provider ids, no duplicate teams, and nothing reported as held twice',
    new Set(store.games.map(g => g.external_ref).filter(Boolean)).size === store.games.filter(g => g.external_ref).length
      && new Set(store.teams.map(t => t.code)).size === store.teams.length && !/HELD TWICE/.test(r2.out));
  chk('SYNC 2  week assignments did not change', store.games.filter(g => g.week === 1).length === W1.length + 1 && store.games.filter(g => g.week === 2).length === W2.length && store.games.filter(g => g.week === 3).length === W3.length,
    { w1: store.games.filter(g => g.week === 1).length, w2: store.games.filter(g => g.week === 2).length, w3: store.games.filter(g => g.week === 3).length });
  chk('SYNC 2  last week\'s projections are still on last week\'s games', store.projections.every(p => store.games.some(g => g.id === p.game_id && g.week === 1)));

  /* the two models post on the Week 2 slate the sync just loaded: three games */
  const w2games = store.games.filter(g => g.week === 2).sort((a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at));
  w2games.slice(0, 3).forEach((g, gi) => MODELS.forEach((m, i) => store.projections.push({
    id: uid(), game_id: g.id, creator_slug: m.creator_slug, model_slug: m.model_slug, pick_side: 'home',
    projected_spread: -(3 + gi) - i * 0.5, projected_total: 52, home_win_prob: 0.6 + i * 0.05, line_at_submission: -3.5, received_at: T(-6) })));

  console.log('\n== the page, in Chromium, against the function as deployed ==');
  let pw = null;
  try { pw = require('playwright'); } catch (_) {
    try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; }
  }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); return finish(); }
  const site = await serve(siteHandler, false);
  const api = await serve(publicHandler, false);
  const CFG_HOST = 'iattxbkbufslbauoumga.supabase.co';
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium (' + e.message.split('\n')[0] + ')'); return finish(); }
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1800 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('mc_sport', 'CFB'); } catch (e) {} });
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname === CFG_HOST) {
      /* the deployed functions, answered by the mock; the page is unchanged */
      const target = `http://127.0.0.1:${api.port}${u.pathname}${u.search}`;
      try {
        const r = await fetch(target, { method: route.request().method(), headers: { accept: 'application/json' } });
        const body = await r.text();
        return route.fulfill({ status: r.status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body });
      } catch (e) { return route.fulfill({ status: 502, body: '{}' }); }
    }
    if (/googleapis|gstatic/.test(u.hostname)) return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  const errors = [];
  const responses = [];
  page.on('response', r => { if (/settled\//.test(r.url())) responses.push(r.status() + ' ' + r.url()); });
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  const base = `http://127.0.0.1:${site.port}/collective/`;

  const read = async () => page.evaluate(() => {
    const t = document.querySelector('.slatetag');
    const on = document.querySelector('.wk button.on');
    const res = document.querySelector('.wk button.res');
    const cards = Array.from(document.querySelectorAll('.gamebd .gb-hd > span:first-child, .gamecard .gc-hd .lbl')).map(e => e.textContent.trim());
    const st = {}; document.querySelectorAll('.cc-stats .st').forEach(e => { st[e.querySelector('.k').textContent.trim()] = e.querySelector('.v').textContent.trim(); });
    const wallHtml = (document.getElementById('view') || document.body).innerHTML;
    return { tag: t ? t.textContent.replace(/\s+/g, ' ').trim() : null, on: on ? on.getAttribute('data-w') : null, onText: on ? on.textContent.trim() : null,
      res: res ? res.getAttribute('data-w') : null, cards, stats: st, hasFSU: wallHtml.indexOf('FLORIDASTA') >= 0,
      fin: document.querySelectorAll('.gamebd .fin').length,
      priced: Array.from(document.querySelectorAll('.gamebd .mco-line')).filter(e => !/mco-empty/.test(e.className) && /consensus/.test(e.textContent)).length,
      unpriced: document.querySelectorAll('.gamebd .mco-line.mco-empty').length,
      marketSample: Array.from(document.querySelectorAll('.gamebd .mco-line')).slice(0, 2).map(e => e.textContent.replace(/\s+/g, ' ').trim()),
      record: Object.keys(window.SETTLED_REC || {}).map(k => k + ':' + (window.SETTLED_REC[k] ? Object.keys(window.SETTLED_REC[k].games || {}).length : 'null')) };
  });
  const settle = async () => { await page.waitForSelector('.slatetag', { timeout: 20000 }); await page.waitForTimeout(600); };

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await settle();
  const cur = await read();
  console.log('   Current:', cur.tag, '| selected:', cur.on === '' ? 'Current' : cur.on, '| resolves-to mark:', cur.res, '| cards:', cur.cards.length);
  console.log('   stats:', JSON.stringify(cur.stats));
  chk('UI  the wire answered Week 1 to the week-less call (the deployed bug is reproduced), and the page asked for Week 2 by number',
    deployedCurrentWeek() === 1 && apiLog.some(x => /\/v1\/games\?sport=CFB&season=2026$/.test(x)) && apiLog.some(x => /week=2/.test(x)), { asked: apiLog.filter(x => /games/.test(x)).slice(0, 6) });
  chk('UI  College Football -> Current resolves to Week 2, and says so', cur.tag && /COLLEGE FOOTBALL · 2026 · WEEK 2/.test(cur.tag) && /the active slate/.test(cur.tag), cur.tag);
  chk('UI  Current stays the selected button; W2 is marked as where it lands', cur.on === '' && cur.res === '2', { on: cur.on, res: cur.res });
  chk('UI  the wall shows the upcoming Week 2 slate, all ten games, in kickoff order',
    cur.cards.length === W2.length && cur.cards[0] === 'SMU @ BAYLOR' && cur.cards.every(c => W2.some(g => c === `${code(g.away)} @ ${code(g.home)}`)), cur.cards);
  chk('UI  no Week 1 game is on the Current wall', !cur.hasFSU && !cur.cards.some(c => /FLORIDASTA|PITTSBURGH|OREGON$/.test(c) && !W2.some(g => c === `${code(g.away)} @ ${code(g.home)}`)));
  chk('UI  the counts are Week 2 only: 10 games, 6 projections, 3 covered, 2 of 2 models',
    (cur.stats['Games covered'] || '').replace(/\s+/g, '') === '3of10' && (cur.stats['Projections on the slate'] || '').trim() === '6' && (cur.stats['Active models'] || '').replace(/\s+/g, '') === '2of2active',
    cur.stats);
  chk('UI  model projections are attached to the Week 2 games they were posted on', function () {
    return page.evaluate(() => Array.from(document.querySelectorAll('.gamebd')).slice(0, 3).every(b => b.querySelectorAll('.gb-row:not(.ghead):not(.cons) .nm').length === 2)
      && Array.from(document.querySelectorAll('.gamebd')).slice(3).every(b => /No model has posted/.test(b.textContent)));
  });
  console.log('   market:', cur.priced, 'priced,', cur.unpriced, 'unpriced;', JSON.stringify(cur.marketSample));
  chk('UI  market lines attach to every Week 2 game by the Collective game id', cur.priced === W2.length && cur.unpriced === 0, { priced: cur.priced, unpriced: cur.unpriced, sample: cur.marketSample });
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'cfb-current.png'), fullPage: false }); }

  await page.click('.wk button[data-w="1"]');
  await page.waitForFunction(() => /WEEK 1/.test((document.querySelector('.slatetag') || {}).textContent || ''), null, { timeout: 15000 });
  await page.waitForTimeout(600);
  const w1 = await read();
  console.log('   W1:', w1.tag, '| cards:', w1.cards.length, '| finals:', w1.fin, '| record:', JSON.stringify(w1.record), '| settled fetches:', JSON.stringify(responses));
  console.log('   W1 stats:', JSON.stringify(w1.stats));
  chk('UI  W1 still works and is labelled history, naming Week 2 as Current', /WEEK 1/.test(w1.tag) && /history\. Current is Week 2\./.test(w1.tag), w1.tag);
  chk('UI  W1 shows last week\'s games, every one with its final from the settlement record',
    /of 59/.test(w1.stats['Games covered'] || '') && w1.cards.length === 12 && w1.fin === w1.cards.length
      && w1.cards.every(c => Object.values(RECORD.games).some(g => c === `${g.away} @ ${g.home}`) || c === 'WASHINGTO2 @ WASHINGTON'),
    { fin: w1.fin, cards: w1.cards.slice(0, 4), stats: w1.stats });
  chk('UI  W1\'s projections are counted on W1, not on Week 2', (w1.stats['Projections on the slate'] || '').trim() === '6' && w1.on === '1');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cfb-w1.png'), fullPage: false });

  await page.click('.wk button[data-w="2"]');
  await page.waitForFunction(() => /WEEK 2/.test((document.querySelector('.slatetag') || {}).textContent || ''), null, { timeout: 15000 });
  await page.waitForTimeout(600);
  const w2 = await read();
  chk('UI  W2 shows the same slate Current showed, and is called the active slate', w2.cards.join('|') === cur.cards.join('|') && /the active slate/.test(w2.tag) && w2.on === '2', { w2: w2.cards.slice(0, 3), cur: cur.cards.slice(0, 3) });
  chk('UI  W2 counts equal Current counts', JSON.stringify(w2.stats) === JSON.stringify(cur.stats), { w2: w2.stats, cur: cur.stats });

  await page.click('.wk button[data-w=""]');
  await page.waitForTimeout(800);
  const back = await read();
  chk('UI  pressing Current again returns to Week 2, not to the wire\'s stale answer', /WEEK 2/.test(back.tag) && back.on === '' && back.cards.join('|') === cur.cards.join('|'), back.tag);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle();
  const re = await read();
  chk('UI  a refresh lands on Week 2 again; nothing about the old slate is remembered', /WEEK 2/.test(re.tag) && re.on === '' && re.cards.join('|') === cur.cards.join('|'), re.tag);
  const stored = await page.evaluate(() => Object.keys(localStorage));
  chk('UI  storage holds the sport and nothing that names a week', stored.every(k => !/week|slate/i.test(k)), stored);

  await page.goto(base + '#board', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /The Board/.test(document.body.textContent) && document.querySelector('.slatetag'), null, { timeout: 15000 });
  await page.waitForTimeout(600);
  const bd = await read();
  chk('UI  the Board resolves to Week 2 too, with the same ten games', /WEEK 2/.test(bd.tag) && bd.cards.length === W2.length, { tag: bd.tag, n: bd.cards.length });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cfb-board.png'), fullPage: false });

  chk('UI  the page threw no errors', errors.length === 0, errors.slice(0, 5));
  await browser.close();
  site.srv.close(); api.srv.close();
  finish();

  function finish() {
    db.srv.close(); espn.srv.close();
    console.log('\n' + (fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
    failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail).slice(0, 800) : '')));
    process.exit(fail === 0 ? 0 : 1);
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
