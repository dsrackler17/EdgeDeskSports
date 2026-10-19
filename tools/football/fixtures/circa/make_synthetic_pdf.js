#!/usr/bin/env node
/* ===========================================================================
   A SYNTHETIC Circa-style selections PDF for tools/football/circa_ownership.test.js.

   THIS IS NOT A CIRCA DOCUMENT. EdgeDesk's build environment cannot reach
   circasports.com, so the parser is proved against a document built to the
   published shape ("16. EAGLES +1", five picks per entry, a stated entry
   total) over the real 2026 Week 7 schedule, with the cases the parser must
   refuse to hide: an entry that wraps onto a second line, a club that does
   not exist, a club on a bye, an ambiguous city. The first live week must
   still be checked against the real PDF (docs/market-structure/README.md).

     node tools/football/fixtures/circa/make_synthetic_pdf.js   (needs Playwright + Chromium)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'synthetic_week7.pdf');
/* the same document with narrow cells that wrap INSIDE themselves: a layout the
   line reader cannot read, which must FAIL as a format change, never publish */
const OUT_WRAPPED = path.join(__dirname, 'synthetic_week7_cellwrap.pdf');
const EXPECT = path.join(__dirname, 'synthetic_week7.expected.json');

/* 2026 Week 7 (football/pricing/lines_nfl.json): [away, home, home line] */
const GAMES = [['BENGALS', 'RAVENS', -3], ['BROWNS', 'TITANS', 1.5], ['COWBOYS', 'EAGLES', 4.5], ['BRONCOS', 'CARDINALS', 4.5], ['PACKERS', 'LIONS', -3],
  ['COLTS', 'VIKINGS', -5.5], ['CHIEFS', 'SEAHAWKS', -2.5], ['RAMS', 'RAIDERS', 5.5], ['DOLPHINS', 'JETS', -4.5], ['PATRIOTS', 'BEARS', -3],
  ['GIANTS', 'TEXANS', -9.5], ['STEELERS', 'SAINTS', 2.5], ['49ERS', 'FALCONS', 4.5], ['BUCCANEERS', 'PANTHERS', -3.5]];
const fmt = (n) => (n === 0 ? 'PK' : (n > 0 ? '+' : '') + String(n));
const SIDES = [];
GAMES.forEach((g, i) => { SIDES.push({ no: 2 * i + 1, team: g[0], line: -g[2] }); SIDES.push({ no: 2 * i + 2, team: g[1], line: g[2] }); });
const pick = (s) => s.no + '. ' + s.team + ' ' + fmt(s.line);

function build() {
  const rows = [];
  for (let e = 1; e <= 36; e++) {
    const p = []; for (let j = 0; j < 5; j++) p.push(SIDES[(e * 7 + j * 5) % SIDES.length]);
    rows.push({ entry: e, name: 'ENTRY ' + e + ' LLC', picks: p.map(pick) });
  }
  const P = (i) => pick(SIDES[i]);
  rows.push({ entry: 37, name: 'THE EXCEPTIONALLY LONG NAME OF A SYNDICATE THAT WRAPS', picks: [P(0), P(3), P(5)], cont: [P(9), P(12)] });
  rows.push({ entry: 38, name: 'ENTRY 38', picks: [P(1), P(2), '99. SPACE CADETS +3', P(6), P(8)] });
  rows.push({ entry: 39, name: 'ENTRY 39', picks: [P(4), '41. BILLS -2', P(7), P(11), P(13)] });
  rows.push({ entry: 40, name: 'ENTRY 40', picks: [P(15), P(17), '21. NEW YORK +9.5', P(19), P(23)] });
  return rows;
}

async function main() {
  const { chromium } = require(process.env.EDGEDESK_PLAYWRIGHT || 'playwright');
  const rows = build();
  const tr = rows.map((r) => '<tr><td>' + r.entry + '</td><td>' + r.name + '</td>' + r.picks.map((p) => '<td>' + p + '</td>').join('') + '</tr>'
    + (r.cont ? '<tr><td></td><td></td>' + r.cont.map((p) => '<td>' + p + '</td>').join('') + '</tr>' : '')).join('');
  const html = (td) => '<html><head><style>td{' + td + '}</style></head><body style="font:9px Arial"><h3>CIRCA SPORTS MILLION VIII</h3><h4>WEEK 7 SELECTIONS</h4><p>TOTAL ENTRIES: 40</p>'
    + '<p>SYNTHETIC TEST DOCUMENT — NOT PUBLISHED BY CIRCA SPORTS</p><table border="1" cellspacing="0">' + tr + '</table></body></html>';
  const b = await chromium.launch(); const pg = await b.newPage();
  await pg.setContent(html('white-space:nowrap;padding:1px 6px')); await pg.pdf({ path: OUT, format: 'Letter', landscape: true });
  await pg.setContent(html('max-width:60px')); await pg.pdf({ path: OUT_WRAPPED, format: 'Letter' });
  await b.close();
  fs.writeFileSync(EXPECT, JSON.stringify({ note: 'what circa_ownership.test.js expects from synthetic_week7.pdf', entries: 40, picks: 200, stated: 40, wrapped_entries: 1,
    quarantined: [{ team_raw: 'SPACE CADETS', reason: 'unresolved_team' }, { team_raw: 'BILLS', reason: 'no_event_for_team' }, { team_raw: 'NEW YORK', reason: 'ambiguous_team' }],
    sides: SIDES.map((s) => ({ no: s.no, team: s.team, line: s.line })) }, null, 1) + '\n');
  console.log('wrote ' + path.relative(process.cwd(), OUT));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { build, GAMES, SIDES };
