#!/usr/bin/env node
/* ===========================================================================
   Tests for the research boards' workbook download in app.html -- the file
   the operator actually reads, and whose Raw Export sheet is what the
   Collective's slate uploader maps.

   THE SPEC IS A REAL FILE. fixtures/cfb_p4_clean_board.json is lifted from a
   hand-cleaned workbook built off a live Power 4 export: its Board sheet,
   its Drivers sheet, and the raw export rows all three were derived from.
   The assertions below rebuild the Board and Drivers rows from that raw
   export and check they come out identical -- so "the download looks like
   the cleaned-up file" is a thing this suite can fail on, not a thing
   somebody has to open Excel to check.

   The other half is the writer. An .xlsx is a zip of XML and app.html builds
   one by hand, with no library and no build step, so the package it emits is
   unzipped here and read back: the parts that must exist, the sheets in
   order, the header row where the uploader expects it, dates as numbers,
   and a game id that stays TEXT rather than being rounded into scientific
   notation by the first tool that opens it.

   Run: node tools/collective/app_export.test.js
   =========================================================================== */
'use strict';

/* The fixture's kickoffs are Central, which is the zone its board was built
   in. Pinned before anything reads a clock so the suite is the same on a
   laptop, in CI, and on a runner in another hemisphere. */
process.env.TZ = 'America/Chicago';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.stack) || e) }; }
  }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}

/* ---- the code under test, cut out of the page that ships it ------------ */
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
/* Disjoint regions rather than one span: the board code and the export code
   sit either side of a few thousand lines of engine that has no business
   running here. Every marker is asserted, so a moved block fails loudly
   instead of quietly testing nothing. */
const REGIONS = [
  ['var EDXlsx=(function(){', '/* ---- CSV export: identical columns to the offline generator'],
  ["var FB_CSV_HEAD=['season'", 'function fbNflRowValues(it){'],
  ['var FBNFL_IX=null;', 'function fbSeasonTableHTML(){'],
  ["var FBP4_CSV_HEAD=['season'", 'function fbP4Basis(){'],
  ['var FBP4_IX=null;', '/* ---- posting a slate to the Model Collective']
];
function slice(start, end) {
  const a = APP.indexOf(start);
  if (a < 0) throw new Error('app.html no longer contains: ' + start);
  const b = APP.indexOf(end, a);
  if (b < 0) throw new Error('app.html no longer contains, after ' + start + ': ' + end);
  return APP.slice(a, b);
}

/* Everything the export reaches for that lives elsewhere in app.html. None
   of it is under test: the football is stubbed so the FORMAT is what these
   assertions are about. */
global.window = global;
global.document = { createElement: () => ({ click(){}, remove(){}, style:{} }),
                    body: { appendChild(){} }, getElementById: () => null };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL(){} };
global.alert = () => {};
global.fbEsc = x => String(x == null ? '' : x);
global.FB = { scope: 'auto', nfl: { curSeason: 2026, games: [] }, p4: { season: 2026, up: [] } };
global.FB_LOOKAHEAD_D = 12;

REGIONS.forEach(([a, b], i) => vm.runInThisContext(slice(a, b), { filename: 'app.html [export ' + i + ']' }));

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cfb_p4_clean_board.json'), 'utf8'));
const X = global.EDXlsx.S;

/* A workbook cell is {v,k,s} or null. The fixture holds plain values, so
   unwrap to compare like with like -- and turn a date serial back into the
   wall clock it encodes, which is the only thing a date cell means. */
function plain(c) {
  if (c == null) return null;
  if (c.s === X.DATE) return new Date(Math.round((c.v - 25569) * 86400000)).toISOString().slice(0, 19);
  return c.v;
}
const row = i => FX.rows[i];
const kickOf = r => global.fbParseUtc(r.raw[FX.raw_head.indexOf('kickoff_local')]);

/* ---- the sanity of the slice itself ------------------------------------ */
chk('the raw export is still the 80 columns the fixture was built from',
  global.FBP4_CSV_HEAD.length === FX.raw_head.length
  && global.FBP4_CSV_HEAD.join('|') === FX.raw_head.join('|'),
  { got: global.FBP4_CSV_HEAD.length, want: FX.raw_head.length });
chk('the fixture carries rows to check', FX.rows.length >= 5);

/* ---- the Board sheet --------------------------------------------------- */
chk('the timezone label is the one people use, not the daylight variant',
  global.fbTzLabel() === 'CT', { got: global.fbTzLabel() });
chk('the Board header is the cleaned board\'s header, column for column',
  (function () {
    const h = global.FBP4_BOARD_HEAD.slice();
    h[0] = 'Kickoff (' + global.fbTzLabel() + ')';
    return h.join('|') === FX.board_head.join('|');
  })(),
  { got: global.FBP4_BOARD_HEAD, want: FX.board_head });

FX.rows.forEach(function (r, i) {
  const built = global.fbP4BoardRow(r.raw, kickOf(r)).map(plain);
  chk('Board row ' + (i + 1) + ' rebuilds from the raw export exactly',
    built.length === r.board.length && built.every((v, c) => v === r.board[c]),
    { game: r.raw[FX.raw_head.indexOf('away_team')] + ' @ ' + r.raw[FX.raw_head.indexOf('home_team')],
      diff: built.map((v, c) => (v === r.board[c] ? null : { col: FX.board_head[c], got: v, want: r.board[c] }))
              .filter(Boolean) });
});

/* The quality flag is the one column the board DERIVES rather than copies,
   so it is the one that can drift on its own. */
chk('the quality flag reads the row\'s own caveats',
  global.fbQualityFlag({ spread: -3, total: '', source: 'cfb.lines', qb: 'home QB unknown', notes: '' })
    === 'NO TOTAL · QB UNKNOWN');
chk('a row with nothing wrong says so rather than going blank',
  global.fbQualityFlag({ spread: -3, total: 48.5, source: 'cfb.lines', qb: '', notes: '' }) === 'CLEAN');
chk('a stale market is flagged, with how stale left in Market Source beside the book',
  global.fbQualityFlag({ spread: -3, total: 48.5, source: 'captured (stale 321h) · Nordic Bet', qb: '', notes: '' })
    === 'STALE MARKET');
chk('a missing book number is flagged too',
  global.fbQualityFlag({ spread: '', total: '', source: '', qb: '', notes: '' }) === 'NO LINE · NO TOTAL');
chk('a thin sample is a caveat the row states',
  /THIN SAMPLE/.test(global.fbQualityFlag({ spread: -3, total: 48, source: '', qb: '',
    notes: 'opponent-adjusted team rating is in the number but rests on a thin sample' })));

/* ---- the Drivers sheet ------------------------------------------------- */
chk('the Drivers header matches, except that the contributions carry a unit',
  (function () {
    const h = global.FBP4_DRIVERS_HEAD.slice();
    h[0] = 'Kickoff (' + global.fbTzLabel() + ')';
    return h.length === FX.drivers_head.length && h.every(function (name, i) {
      /* columns 10..18 are the contribution points; everything else is theirs verbatim */
      return (i >= 10 && i <= 18) ? name === FX.drivers_head[i] + ' (pts)' : name === FX.drivers_head[i];
    });
  })(),
  { got: global.FBP4_DRIVERS_HEAD, want: FX.drivers_head });
chk('no two Drivers columns share a name, so a lookup against the sheet resolves',
  new Set(global.FBP4_DRIVERS_HEAD).size === global.FBP4_DRIVERS_HEAD.length);

FX.rows.forEach(function (r, i) {
  const built = global.fbP4DriverRow(r.raw, kickOf(r)).map(plain);
  chk('Drivers row ' + (i + 1) + ' rebuilds from the raw export exactly',
    built.length === r.drivers.length && built.every((v, c) => v === r.drivers[c]),
    { diff: built.map((v, c) => (v === r.drivers[c] ? null : { col: FX.drivers_head[c], got: v, want: r.drivers[c] }))
              .filter(Boolean) });
});

/* ---- the NFL board, which has no drivers to separate out --------------- */
chk('the NFL board leads with the same columns as the Power 4 one',
  global.FBNFL_BOARD_HEAD.slice(0, 16).join('|') === global.FBP4_BOARD_HEAD.slice(0, 16).join('|'));
chk('and carries the grading columns the NFL export has and the college one does not',
  global.FBNFL_BOARD_HEAD.slice(-5).join('|') === 'Home Score|Away Score|Spread Result|Total Result|ML Result');
chk('every NFL board column has a width',
  global.FBNFL_BOARD_HEAD.length === global.FBNFL_BOARD_W.length);
chk('every Power 4 board column has a width',
  global.FBP4_BOARD_HEAD.length === global.FBP4_BOARD_W.length);
chk('every Drivers column has a width',
  global.FBP4_DRIVERS_HEAD.length === global.FBP4_DRIVERS_W.length);

/* ---- kickoffs -------------------------------------------------------- */
chk('a kickoff with no zone marker is read as UTC, never as the reader\'s clock',
  global.fbParseUtc('2026-09-03 22:00') === Date.UTC(2026, 8, 3, 22, 0));
chk('a zone marker is honoured when the source states one',
  global.fbParseUtc('2026-09-03T22:00:00Z') === Date.UTC(2026, 8, 3, 22, 0));
chk('a timestamp passes straight through', global.fbParseUtc(1756900000000) === 1756900000000);
chk('nothing is not a date', global.fbParseUtc('') === null && global.fbParseUtc(null) === null);
chk('an unparseable kickoff is null rather than 1970',
  global.fbParseUtc('kickoff tbd') === null);
chk('the date cell holds the wall clock its header claims',
  plain(global.fbXlKick(Date.UTC(2026, 8, 3, 22, 0))) === '2026-09-03T17:00:00');

/* ---- the writer: unzip what it emits and read it back ------------------ */
/* app.html stores every entry uncompressed, so a reader is a few slices --
   which is also what proves the central directory and the local headers
   agree about where everything is. */
function unzip(buf) {
  const out = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('central directory entry ' + i + ' is not one');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('local header for ' + name + ' is not one');
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    out[name] = (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
    p += 46 + nlen + elen + clen;
  }
  return out;
}
/* Shared strings resolved, so a cell can be compared to what it displays. */
function readSheet(xml, sst) {
  const rows = {};
  const rowRe = /<row r="(\d+)">(.*?)<\/row>/g;
  let m;
  while ((m = rowRe.exec(xml))) {
    const cells = {};
    const cRe = /<c r="([A-Z]+)(\d+)"(?: s="(\d+)")?(?: t="(\w+)")?><v>([^<]*)<\/v><\/c>/g;
    let c;
    while ((c = cRe.exec(m[2]))) {
      cells[c[1]] = { s: +(c[3] || 0), t: c[4] || 'n', v: c[4] === 's' ? sst[+c[5]] : +c[5] };
    }
    rows[+m[1]] = cells;
  }
  return rows;
}

const BUILT = (function () {
  const S = X;
  const sheets = [
    { name: 'Board', freeze: 6, filter: 'A6:C6', cols: [18, 20, 20], merges: ['A1:C1'],
      rows: [
        [{ v: 'EdgeDesk CFB Power 4 — 2026 Research Board', k: 's', s: S.TITLE }],
        [{ v: 'Research context, not edges. 5 < 6 & "quoted"', k: 's', s: S.MUTED }],
        [{ v: 'Games', k: 's', s: S.KPI_L }],
        [{ v: 2, k: 'n', s: S.KPI_V }],
        [],
        global.fbXlHead(['Kickoff (CT)', 'Away', 'Home']),
        [global.fbXlKick(Date.UTC(2026, 8, 3, 22, 0)), 'Massachusetts', 'Rutgers']
      ] },
    { name: 'Raw Export', freeze: 3, filter: 'A3:C3', cols: [11, 11, 22],
      rows: [
        [{ v: 'Original 80-column export', k: 's', s: S.MUTED }],
        [],
        global.fbXlHead(['season', 'week', 'game_id']),
        [global.fbXlRaw(2026, 'season'), global.fbXlRaw(1, 'week'), global.fbXlRaw('401858423', 'game_id')]
      ] }
  ];
  return sheets;
})();

let PKG = null, SHEET1 = null, SHEET2 = null, SST = [];

(async function () {
  const blob = global.EDXlsx.build(BUILT);
  const buf = Buffer.from(await blob.arrayBuffer());
  PKG = unzip(buf);

  chk('every part an .xlsx must carry is in the package',
    ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
     'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']
      .every(n => n in PKG), { got: Object.keys(PKG) });
  chk('the workbook names its sheets in order',
    /name="Board" sheetId="1"/.test(PKG['xl/workbook.xml'])
    && /name="Raw Export" sheetId="2"/.test(PKG['xl/workbook.xml']),
    { got: PKG['xl/workbook.xml'] });
  chk('every sheet is declared in [Content_Types] or Excel refuses the file',
    /worksheets\/sheet1\.xml/.test(PKG['[Content_Types].xml'])
    && /worksheets\/sheet2\.xml/.test(PKG['[Content_Types].xml']));
  chk('every sheet has a relationship pointing at it',
    (PKG['xl/_rels/workbook.xml.rels'].match(/relationships\/worksheet/g) || []).length === 2);

  SST = (PKG['xl/sharedStrings.xml'].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
    .map(t => t.replace(/^<t[^>]*>|<\/t>$/g, '')
               .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  SHEET1 = readSheet(PKG['xl/worksheets/sheet1.xml'], SST);
  SHEET2 = readSheet(PKG['xl/worksheets/sheet2.xml'], SST);

  chk('XML-hostile text survives the round trip',
    SHEET1[2].A.v === 'Research context, not edges. 5 < 6 & "quoted"', { got: SHEET1[2].A.v });
  chk('the header row is styled as one',
    SHEET1[6].A.s === X.HEAD && SHEET1[6].C.s === X.HEAD);
  chk('a kickoff is a NUMBER carrying a date format, not text',
    SHEET1[7].A.t === 'n' && SHEET1[7].A.s === X.DATE
    && new Date(Math.round((SHEET1[7].A.v - 25569) * 86400000)).toISOString().slice(0, 19) === '2026-09-03T17:00:00',
    { got: SHEET1[7].A });
  chk('an empty row stays empty rather than becoming a row of blanks',
    SHEET1[5] === undefined, { got: SHEET1[5] });
  chk('the header is frozen and filterable where the reader expects it',
    /ySplit="6"/.test(PKG['xl/worksheets/sheet1.xml'])
    && /autoFilter ref="A6:C6"/.test(PKG['xl/worksheets/sheet1.xml']));
  chk('column widths are carried',
    /<col min="1" max="1" width="18"/.test(PKG['xl/worksheets/sheet1.xml']));
  chk('merged cells come after the sheet data, where the schema wants them',
    PKG['xl/worksheets/sheet1.xml'].indexOf('<mergeCells') > PKG['xl/worksheets/sheet1.xml'].indexOf('</sheetData>'));

  chk('the raw sheet puts its header on row 3, under the note',
    SHEET2[3].A.v === 'season' && SHEET2[3].B.v === 'week' && SHEET2[3].C.v === 'game_id',
    { got: SHEET2[3] });
  chk('a season is a number the sheet can sum', SHEET2[4].A.t === 'n' && SHEET2[4].A.v === 2026);
  chk('a game id stays TEXT, so it is never rounded into scientific notation',
    SHEET2[4].C.t === 's' && SHEET2[4].C.v === '401858423', { got: SHEET2[4].C });

  /* ---- report ---------------------------------------------------------- */
  failures.forEach(function (f) {
    console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail).slice(0, 600) : ''));
  });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.log('FAIL | the suite could not run  ' + String((e && e.stack) || e));
  process.exit(1);
});
