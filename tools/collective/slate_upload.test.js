#!/usr/bin/env node
/* ===========================================================================
   Tests for the Collective uploader's file reader (parseXLSX in
   collective/index.html) against the workbook app.html now downloads.

   THE CASE: the research boards export three sheets -- a readable Board, the
   model's Drivers, and the raw export whose column names this uploader is
   built around -- and the raw one is LAST, because that is the order a
   person wants to read them in. Every one of them has a title above its
   header row, most a summary strip as well.

   The old reader took row 1 of sheet 1. That is the workbook's title cell,
   so the slate arrived with a header of "EdgeDesk CFB Power 4 - 2026
   Research Board" and a single column, mapped to nothing, and read to the
   creator as "my own export will not upload". It could not have read a
   hand-tidied sheet either, for the same reason.

   So this drives the REAL reader over a workbook built by the REAL writer,
   both sliced out of the pages that ship them, and checks it lands on the
   raw export's own header row -- through a stored zip (what app.html emits)
   and a deflated one (what Excel emits after a round trip through it).

   Run: node tools/collective/slate_upload.test.js
   =========================================================================== */
'use strict';

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

/* ---- a DOM just wide enough for the reader under test ------------------
   Node has no DOMParser and this repo has no dependencies. The XML in an
   .xlsx is plain elements, attributes and text, so parsing it is small --
   and a shim keeps the thing being tested the page's own code rather than
   a Node rewrite of it. */
function parseXml(src) {
  const root = { tag: '#doc', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const decode = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const text = src.slice(i, lt);
      if (text) stack[stack.length - 1].children.push({ text: decode(text) });
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!--', lt) || src.startsWith('<!', lt)) {
      const close = src.startsWith('<!--', lt) ? src.indexOf('-->', lt) + 3 : src.indexOf('>', lt) + 1;
      i = close > 0 ? close : src.length;
      continue;
    }
    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    const raw = src.slice(lt + 1, gt);
    if (raw[0] === '/') { stack.pop(); i = gt + 1; continue; }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const sp = body.search(/\s/);
    const tag = sp < 0 ? body : body.slice(0, sp);
    const attrs = {};
    if (sp >= 0) {
      const aRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
      let a;
      while ((a = aRe.exec(body.slice(sp)))) attrs[a[1]] = decode(a[2]);
    }
    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  return root;
}
function textOf(n) {
  if (n.text != null) return n.text;
  return (n.children || []).map(textOf).join('');
}
function wrap(n) {
  return {
    _n: n,
    getAttribute: k => (k in n.attrs ? n.attrs[k] : null),
    getAttributeNS: (_ns, local) => {
      for (const k in n.attrs) if (k === local || k.split(':').pop() === local) return n.attrs[k];
      return null;
    },
    get textContent() { return textOf(n); },
    getElementsByTagName: t => collect(n, t)
  };
}
function collect(node, tag) {
  const out = [];
  (function walk(x) {
    (x.children || []).forEach(c => {
      if (c.tag) {
        if (c.tag === tag || c.tag.split(':').pop() === tag) out.push(wrap(c));
        walk(c);
      }
    });
  })(node);
  out.item = i => out[i];
  return out;
}
global.DOMParser = class { parseFromString(src) { return wrap(parseXml(src)); } };

/* ---- both pages' real code -------------------------------------------- */
function slice(file, start, end) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  const a = src.indexOf(start);
  if (a < 0) throw new Error(file + ' no longer contains: ' + start);
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error(file + ' no longer contains, after that: ' + end);
  return src.slice(a, b);
}
global.window = global;
vm.runInThisContext(slice('app.html', 'var EDXlsx=(function(){',
  '/* ---- CSV export: identical columns to the offline generator'), { filename: 'app.html [writer]' });
vm.runInThisContext(slice('collective/index.html',
  '/* Minimal .xlsx reader: an xlsx is a zip;',
  '/* ---- the blank template ---'), { filename: 'collective/index.html [uploader]' });

const X = global.EDXlsx.S;
const head = names => names.map(h => ({ v: h, k: 's', s: X.HEAD }));

/* The shape app.html downloads: Board, Drivers, then the raw export, each
   under a title, the raw one under a title and a blank row. */
const RAW_HEAD = ['season', 'week', 'game_id', 'kickoff_local', 'away_team', 'home_team',
  'model_home_line', 'model_fair_total', 'ref_home_line', 'home_win_prob_pct',
  'p_spread_pick_pct', 'spread_pick', 'confidence', 'kickoff_tz'];
function workbook() {
  return [
    { name: 'Board', freeze: 6, rows: [
      [{ v: 'EdgeDesk CFB Power 4 — 2026 Research Board', k: 's', s: X.TITLE }],
      [{ v: 'Research context, not edges.', k: 's', s: X.MUTED }],
      [{ v: 'Games', k: 's', s: X.KPI_L }, null, null, null, { v: 'Research Leans', k: 's', s: X.KPI_L }],
      [{ v: 2, k: 'n', s: X.KPI_V }, null, null, null, { v: 1, k: 'n', s: X.KPI_V }],
      [],
      head(['Kickoff (CT)', 'Away', 'Home', 'Market Home Spread', 'Model Home Spread',
            'Spread Pick', 'Confidence', 'Venue', 'Game ID']),
      [{ v: global.EDXlsx.serial(2026, 9, 3, 17, 0), k: 'n', s: X.DATE }, 'Massachusetts', 'Rutgers',
       -30.5, -46.32, 'Rutgers', 41, 'SHI Stadium', '401858423'],
      [{ v: global.EDXlsx.serial(2026, 9, 3, 18, 0), k: 'n', s: X.DATE }, 'Akron', 'Wake Forest',
       -22.5, -24.41, 'Wake Forest', 41, 'Allegacy', '401858204']
    ] },
    { name: 'Drivers', freeze: 4, rows: [
      [{ v: 'Model Drivers & Diagnostics', k: 's', s: X.TITLE }],
      [{ v: 'Contributions are in home-team margin points.', k: 's', s: X.MUTED }],
      [],
      head(['Kickoff (CT)', 'Matchup', 'Spread Rec', 'Confidence', 'Rating (pts)', 'Primary Driver 1']),
      [{ v: global.EDXlsx.serial(2026, 9, 3, 17, 0), k: 'n', s: X.DATE }, 'Massachusetts @ Rutgers',
       'RESEARCH_LEAN', 41, 23.95, 'Rutgers is the better football team']
    ] },
    { name: 'Raw Export', freeze: 3, rows: [
      [{ v: 'Original 80-column export — preserved unchanged for audit', k: 's', s: X.MUTED }],
      [],
      head(RAW_HEAD),
      [2026, 1, '401858423', '2026-09-03 22:00', 'Massachusetts', 'Rutgers',
       -46.32, 53.2, -30.5, 99.8, 79.4, 'Rutgers', 41, 'UTC'],
      /* trailing blanks: a worksheet row simply stops, which is the shape
         that used to trip the ragged-row check downstream */
      [2026, 1, '401858204', '2026-09-03 23:00', 'Akron', 'Wake Forest',
       -24.41, 50.5, -22.5, 94, 53.6, 'Wake Forest']
    ] }
  ];
}

/* Excel deflates every entry; app.html stores them. Both have to open. */
/* zlib.crc32 landed in Node 20.15; the table below keeps this suite
   independent of whichever Node the runner ships. */
const CRCT = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRCT[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function redeflate(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    const csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28);
    const start = off + 30 + lnlen + lelen;
    files.push({ name, data: buf.slice(start, start + csize) });
    p += 46 + nlen + elen + clen;
  }
  const parts = [], central = [];
  let offset = 0;
  files.forEach(f => {
    const nm = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30 + nm.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nm.length, 26); nm.copy(lh, 30);
    parts.push(lh, comp);
    const ch = Buffer.alloc(46 + nm.length);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42); nm.copy(ch, 46);
    central.push(ch);
    offset += lh.length + comp.length;
  });
  const cd = central.reduce((n, c) => n + c.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

(async function () {
  const stored = Buffer.from(await global.EDXlsx.build(workbook()).arrayBuffer());

  /* ---- the header scorer, on its own ----------------------------------- */
  chk('a row with both teams and a kickoff is a header',
    global.slateHeaderScore(RAW_HEAD) > 0);
  chk('the Board sheet\'s own header is a header too, so a workbook trimmed to just it still uploads',
    global.slateHeaderScore(['Kickoff (CT)', 'Away', 'Home', 'Market Home Spread',
                             'Model Home Spread', 'Spread Pick', 'Game ID']) > 0);
  chk('a bracketed unit or zone does not stop a column being recognised',
    global.slateFieldFor('Kickoff (CT)') === 'kickoff'
    && global.slateFieldFor('Kickoff (ET)') === 'kickoff'
    && global.slateFieldFor('Kickoff') === 'kickoff');
  chk('the Board\'s two spread columns keep their sides straight',
    global.slateFieldFor('Model Home Spread') === 'projected_spread'
    && global.slateFieldFor('Market Home Spread') === 'line_at_submission');
  chk('ML Pick % is NOT read as the home win probability -- it is the favourite\'s',
    global.slateFieldFor('ML Pick %') === null);
  chk('the raw export still outscores the board, so the canonical sheet keeps winning',
    global.slateHeaderScore(RAW_HEAD)
      > global.slateHeaderScore(['Kickoff (CT)', 'Away', 'Home', 'Market Home Spread',
                                 'Model Home Spread', 'Spread Pick', 'Game ID']));
  chk('a title row is not a header',
    global.slateHeaderScore(['EdgeDesk CFB Power 4 — 2026 Research Board']) === 0);
  chk('a summary strip is not a header',
    global.slateHeaderScore(['Games', '', '', '', 'Research Leans']) === 0);
  chk('a row naming only the teams is not a header, because it has no game to attach to',
    global.slateHeaderScore(['home_team', 'away_team']) === 0);
  chk('a richer header outscores a thinner one',
    global.slateHeaderScore(RAW_HEAD) > global.slateHeaderScore(['home', 'away', 'date']));

  /* ---- the whole trip -------------------------------------------------- */
  for (const [label, buf] of [['stored', stored], ['deflated', redeflate(stored)]]) {
    const rows = await global.parseXLSX(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    chk(label + ': the reader lands on the raw export\'s own header row',
      rows[0].join('|') === RAW_HEAD.join('|'), { got: rows[0] });
    chk(label + ': it does not stop at the first sheet',
      rows.length === 3, { rows: rows.length });
    chk(label + ': the games come through with it',
      rows[1][4] === 'Massachusetts' && rows[1][5] === 'Rutgers'
      && rows[2][4] === 'Akron' && rows[2][5] === 'Wake Forest', { got: rows.slice(1) });
    chk(label + ': a row whose trailing cells are blank is padded, not called ragged',
      rows[2].length === rows[0].length, { header: rows[0].length, row: rows[2].length });
    chk(label + ': the blanks are blank rather than undefined',
      rows[2][12] === '' && rows[2][13] === '', { got: [rows[2][12], rows[2][13]] });
  }

  /* ---- a plain one-sheet file still opens exactly as it always did ------ */
  const plainBook = Buffer.from(await global.EDXlsx.build([
    { name: 'Sheet1', rows: [head(['home', 'away', 'date', 'spread']),
                             ['Rutgers', 'Massachusetts', '2026-09-03', -30.5]] }
  ]).arrayBuffer());
  const plainRows = await global.parseXLSX(
    plainBook.buffer.slice(plainBook.byteOffset, plainBook.byteOffset + plainBook.byteLength));
  chk('a single sheet with its header on row 1 is unchanged',
    plainRows.length === 2 && plainRows[0].join('|') === 'home|away|date|spread', { got: plainRows });

  /* ---- a file nothing scores on still reaches the mapping screen -------- */
  const oddBook = Buffer.from(await global.EDXlsx.build([
    { name: 'Sheet1', rows: [head(['col a', 'col b']), ['1', '2']] }
  ]).arrayBuffer());
  const oddRows = await global.parseXLSX(
    oddBook.buffer.slice(oddBook.byteOffset, oddBook.byteOffset + oddBook.byteLength));
  chk('a file whose headers match nothing is handed on to be mapped by hand, not refused',
    oddRows.length === 2 && oddRows[0].join('|') === 'col a|col b', { got: oddRows });

  failures.forEach(f => console.log('FAIL | ' + f.name
    + (f.detail ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('FAIL | the suite could not run  ' + String((e && e.stack) || e));
  process.exit(1);
});
