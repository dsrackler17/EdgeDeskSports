#!/usr/bin/env node
/* ============================================================================
   THE QB ROSTER SNAPSHOT, READ BACK BY THE CODE THAT HAS TO READ IT.

   The registry in app.html used to fetch nflverse's roster CSV straight from
   a GitHub release download. A browser cannot: the 302 that URL answers with
   carries no Access-Control-Allow-Origin, so fetch() rejects with a bare
   TypeError — "Failed to fetch" — while the file itself is healthy. The
   registry sat on its bundled snapshot indefinitely and said so.

   build_qb_roster.js fetches it where there is no CORS and commits the
   result. That only helps if the committed file is one the BROWSER can
   parse, so this drives app.html's own fbCsv / fbQbFromRow / fbQbParse /
   fbQbSane over the committed artifact rather than trusting that the columns
   line up. The parser is lifted out of app.html, not reimplemented: a copy
   would agree with itself while the page disagreed.

   Run: node football/nfl/qb_roster.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 220) : '')); }
const eq = (name, got, want) => chk(name, got === want, { got, want });

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const B = require('./build_qb_roster.js');

/* ---- app.html's own reader, lifted ------------------------------------- */
const START = APP.indexOf('var FB=window.FB=');
const END = APP.indexOf('function fbQbApply(');
chk('the football module is found in app.html', START >= 0 && END > START);
const ctx = {
  console, Date, Math, JSON, String, Number, Object, Array, RegExp, Error, Promise, isFinite, parseInt, parseFloat,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { querySelector: () => null, createElement: () => ({ setAttribute() {}, addEventListener() {} }), head: { appendChild() {} } },
  fetch: () => Promise.reject(new Error('no network in this test')),
  _escHtml: (s) => String(s == null ? '' : s),
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(APP.slice(START, END), ctx, { filename: 'app.html:football' });

/* ---- the committed artifact -------------------------------------------- */
const SEASON = 2026;
const FILE = path.join(__dirname, `qbs_${SEASON}.csv`);
chk('the QB snapshot is committed', fs.existsSync(FILE), FILE);
if (!fs.existsSync(FILE)) { report(); }

const text = fs.readFileSync(FILE, 'utf8');
const rows = ctx.fbCsv(text);
chk('app.html parses it as CSV at all', Array.isArray(rows) && rows.length > 0, rows.length);

const parsed = ctx.fbQbParse(rows, SEASON);
chk('and every active row survives fbQbFromRow (team code, name, position)',
  parsed.active.length > 0 && parsed.active.every(q => q && q.position === 'QB' && q.status === 'ACT'
    && typeof q.name === 'string' && q.name.length > 0 && ctx.fbNflTeamCode(q.team) === q.team),
  parsed.active.slice(0, 2));

chk('the registry accepts it as a roster (fbQbSane)', ctx.fbQbSane(parsed.active),
  { active: parsed.active.length, teams: new Set(parsed.active.map(q => q.team)).size });

const teams = new Set(parsed.active.map(q => q.team));
chk('every NFL club carries at least one active QB', teams.size === 32, teams.size);
chk('and no club carries more than five', [...teams].every(t => parsed.active.filter(q => q.team === t).length <= 5));

/* THE IDENTITY THE REST OF THE MODULE JOINS ON. fbQbByGsis()/fbResolveQb()
   key on it, so a snapshot without GSIS ids parses and then resolves nothing. */
const withGsis = parsed.active.filter(q => q.gsisId);
chk('active QBs carry the GSIS id the module joins on', withGsis.length === parsed.active.length,
  { with_id: withGsis.length, total: parsed.active.length });
eq('GSIS ids are unique across the active set', new Set(withGsis.map(q => q.gsisId)).size, withGsis.length);

/* ---- the builder's own refusals ---------------------------------------- */
chk('a feed that parses to too few QBs is refused, not written',
  B.sane(Array.from({ length: 12 }, (_, i) => ({ team: 'KC', gsis_id: 'x' + i }))) === false);
chk('and one spread over too few teams is refused too',
  B.sane(Array.from({ length: 60 }, (_, i) => ({ team: i % 4 === 0 ? 'KC' : 'SF', gsis_id: 'x' + i }))) === false);
chk('a healthy shape is accepted',
  B.sane(Array.from({ length: 64 }, (_, i) => ({ team: 'T' + (i % 32), gsis_id: 'x' + i }))) === true);

/* A traded QB must resolve to the club he ended on: the client keeps the
   LATER row for a repeated GSIS id, so week order is load-bearing. */
{
  const built = B.build([
    { season: '2026', team: 'SF', position: 'QB', status: 'ACT', full_name: 'Test Passer', gsis_id: '00-0000001', week: '3' },
    { season: '2026', team: 'KC', position: 'QB', status: 'ACT', full_name: 'Test Passer', gsis_id: '00-0000001', week: '1' },
  ], 2026);
  eq('the builder emits a repeated GSIS id in week order', built.rows.map(r => r.team).join(','), 'KC,SF');
  const back = ctx.fbQbParse(ctx.fbCsv(B.serialise(built.rows)), 2026);
  eq('so the client resolves the trade to the later club', back.active.length && back.active[0].team, 'SF');
}

/* A name with a comma is why this is a real CSV writer and not a join(','). */
{
  const built = B.build([{ season: '2026', team: 'NE', position: 'QB', status: 'ACT',
    full_name: 'Odd, Name "Jr."', gsis_id: '00-0000002', week: '1' }], 2026);
  const back = ctx.fbQbParse(ctx.fbCsv(B.serialise(built.rows)), 2026);
  eq('a comma and a quote in a name survive the round trip', back.active.length && back.active[0].name, 'Odd, Name "Jr."');
}

/* Non-active rows are kept aside rather than dropped, the same split the
   client makes, so the reserve list is not silently empty. */
chk('reserve QBs are carried through, not discarded', parsed.reserve.length > 0, parsed.reserve.length);

/* ---- the URL the page actually asks for -------------------------------- */
const urlFn = /function FB_URL_ROSTER\(y\)\{return ([^;]+);\}/.exec(APP);
chk('FB_URL_ROSTER is still a single expression', !!urlFn, urlFn && urlFn[1]);
chk('and it no longer points at a GitHub release download, which CORS refuses',
  !!urlFn && !/github\.com\/[^']*releases\/download/.test(urlFn[1]), urlFn && urlFn[1]);
chk('it points at this repository’s own committed snapshot',
  !!urlFn && /football\/nfl\/qbs_/.test(urlFn[1]), urlFn && urlFn[1]);

function report() {
  failures.forEach(f => console.log('  FAIL  ' + f));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
report();
