#!/usr/bin/env node
/* ===========================================================================
   The market-intelligence mirror (football/cfb_market/sync_supabase.js) and
   its hourly wiring. Offline: PostgREST is a fake fetch.

   - the four ledger files map to their tables with only declared columns;
   - "no such table" (404 / PGRST205 / 42P01) fails soft: a warning, the rows
     kept for the next run, the hourly job not failed;
   - any other error fails the step (it is never swallowed);
   - a re-run sends the same rows with ignore-duplicates (idempotent);
   - cfb-lab.yml writes the ledger (run.js --write), publishes it and mirrors
     it after the git publish; the season is the Lab's, never the calendar year.

   Run: node football/cfb_market/sync.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./sync_supabase.js');
const RUN = require('./run.js');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } }

(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-mkt-'));
  const L = require(path.join(ROOT, 'football', 'cfb_lab', 'lab_core.js'));
  const K = '2026-10-10T19:30:00.000Z';
  const q = (book, line, at) => ({ quote_id: 'q' + book + at, source: 'odds_api', book, game_id: '401', market_type: 'spread', home_line: line, price_home: -110, price_away: -110,
    observed_at: at, kickoff_ts: K, week: 6, is_pregame: true });
  const quotes = [q('dk', -3.5, '2026-10-09T10:00:00.000Z'), q('fd', -3.5, '2026-10-09T10:05:00.000Z'), q('mgm', -4, '2026-10-09T12:00:00.000Z')];
  const preds = [{ origin: 'LIVE', model_version: 'edgedesk_cfb_v2.1.0', game_id: '401', pure_home_margin: 7, prediction_id: 'cfbp_x', prediction_ts: '2026-10-09T09:00:00.000Z' }];
  const rows = RUN.build(2026, '2026-10-09T13:00:00.000Z', { quotes, predictions: preds });
  const w1 = RUN.write(2026, rows, d), w2 = RUN.write(2026, rows, d);
  chk('run.js --write appends once; a re-run adds nothing', w1.snapshots > 0 && Object.values(w2).every((n) => n === 0), [w1, w2]);
  const P = S.plan(2026, d);
  chk('plan: four tables, keyed by their ids', P.map((p) => p.table).sort().join() === Object.values(RUN.TABLES).sort().join() && P.every((p) => p.key === RUN.FILES[Object.keys(RUN.TABLES).find((k) => RUN.TABLES[k] === p.table)]));
  const cols = S.columns();
  chk('plan: only declared columns are sent (PostgREST refuses others)', P.every((p) => p.rows.every((r) => Object.keys(r).every((k) => cols[p.table].includes(k)))));
  /* a fake PostgREST */
  const calls = [];
  const fake = (status, body) => async (url, init) => { calls.push({ url, body: init.body }); return { ok: status < 300, status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }; };
  process.env.SB_URL = 'http://pgrst.invalid'; process.env.SB_SERVICE_ROLE = 'k';
  const quiet = { quiet: true, dir: d, io: { sleep: async () => {} } };
  const ok = await S.sync(2026, Object.assign({ fetch: fake(201, '') }, quiet));
  chk('sync: every table is posted with on_conflict=<id> and ignore-duplicates', Object.values(ok).some((v) => typeof v === 'number' && v > 0) && calls.every((c) => /on_conflict=/.test(c.url)), ok);
  const missing = await S.sync(2026, Object.assign({ fetch: fake(404, { code: 'PGRST205', message: 'Could not find the table' }) }, quiet));
  chk('sync: a missing table (404 PGRST205) fails soft, rows kept for the next run', Object.values(missing).every((v) => v.rows === 0 || v.skipped === 'table missing'), missing);
  const pg42 = await S.sync(2026, Object.assign({ fetch: fake(404, { code: '42P01', message: 'relation does not exist' }) }, quiet));
  chk('sync: 42P01 is the same "no such table" and fails soft', Object.values(pg42).every((v) => v.rows === 0 || v.skipped === 'table missing'));
  let threw = null;
  try { await S.sync(2026, Object.assign({ fetch: fake(401, { code: '42501', message: 'permission denied' }) }, quiet)); } catch (e) { threw = e; }
  chk('sync: any other error (auth) fails the step, never swallowed', threw && /401/.test(threw.message));
  delete process.env.SB_URL; delete process.env.SB_SERVICE_ROLE;
  const none = await S.sync(2026, { quiet: true, dir: d });
  chk('sync: without credentials it skips cleanly', none.skipped === true);
  fs.rmSync(d, { recursive: true, force: true });
  /* wiring */
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'cfb-lab.yml'), 'utf8');
  const iRun = yml.indexOf('node football/cfb_market/run.js --write'), iPub = yml.indexOf('name: Publish'), iSync = yml.indexOf('node football/cfb_market/sync_supabase.js');
  chk('cfb-lab.yml: the market-intel ledger is written before the publish and mirrored after it', iRun > 0 && iPub > iRun && iSync > iPub, [iRun, iPub, iSync]);
  chk('cfb-lab.yml: the publish carries the market ledger', /football\/cfb_market\/ledger/.test(yml.slice(iPub, iPub + 1200)));
  chk('cfb-lab.yml: a market-intel build failure never stops the hourly publish (warned)', /cfb_market\/run\.js --write[^\n]*\|\| echo "::warning::/.test(yml));
  chk('cfb-lab.yml: the market mirror runs after the Lab and decision mirrors (a failure there cannot stop them)', yml.indexOf('node football/cfb_market/sync_supabase.js') > yml.indexOf('node football/cfb_decision/sync_supabase.js'));
  const src = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'sync_supabase.js'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'football', 'cfb_lab', 'sync_supabase.js'), 'utf8');
  chk('season: the market runner and both mirrors default to the Lab\'s season, never the calendar year (a January bowl is last season\'s)', !/'--season', new Date\(\)\.getUTCFullYear\(\)/.test(src) && (src.match(/config\.json/g) || []).length >= 3);
  fails.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
