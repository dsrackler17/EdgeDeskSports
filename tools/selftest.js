/* Node harness: load the EdgeDesk Intelligence IIFE out of app.html with a
   minimal DOM/global stub and run its deterministic self-tests.

   This exists so "tests pass" is something observed rather than asserted. The
   IIFE is browser code, but every function under test is pure deterministic
   logic over owned fields, so a stub DOM is enough to exercise all of it. */
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || require('path').join(__dirname, '..', 'app.html');
const src = fs.readFileSync(path, 'utf8');

/* The block under test is the one that defines EDGE_BRAIN. */
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, code = null, idx = 0, found = -1;
while ((m = re.exec(src))) {
  idx++;
  if (m[1].indexOf('EDGE_BRAIN') >= 0 && m[1].indexOf('EDBetQuality') >= 0) { code = m[1]; found = idx; break; }
}
if (!code) { console.error('could not locate the EdgeDesk Intelligence script block'); process.exit(2); }

function el() {
  const e = {
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    children: [], innerHTML: '', textContent: '', className: '', id: '',
    appendChild(c){ this.children.push(c); return c; },
    removeChild(c){ return c; },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    setAttribute(){}, getAttribute(){ return null; },
    addEventListener(){}, remove(){}, scrollTop: 0, scrollHeight: 0, disabled: false,
  };
  return e;
}
const document = {
  getElementById(){ return null; },
  createElement(){ return el(); },
  querySelector(){ return null; },
  querySelectorAll(){ return []; },
  addEventListener(){},
};

const sandbox = {
  console, document, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Date, Math, JSON, isFinite, parseFloat, parseInt, encodeURIComponent, Intl, RegExp,
  Object, Array, String, Number, Boolean, Error,
  fetch: async () => { throw new Error('network disabled in harness'); },
  localStorage: (() => { const s = {}; return {
    getItem: k => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); },
    removeItem: k => { delete s[k]; }, key: i => Object.keys(s)[i] || null,
    get length(){ return Object.keys(s).length; }, __dump: () => s }; })(),
  /* App globals the IIFE reads through typeof guards or directly. */
  SB_URL: '', REAL_FLOOR: 0.005, EDGE_MAX_AGE_MIN: 90, WX_STALE_H: 6,
  GE: {
    fmtPrice(d){ const a = d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
      return (a > 0 ? '+' : '') + a; },
    amToDec(a){ return a >= 100 ? 1 + a / 100 : 1 + 100 / -a; },
    decToAm(d){ return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); },
  },
  sbGet: async () => [], sbPost: async () => null,
  sbGetUfc: async () => [], sbGetTennis: async () => [], sbGetCfb: async () => [],
  mlbLookup: () => null, loadMlbSched: async () => {}, isTrusted: () => true,
  selLabel: e => String(e && e.selection || ''), mktLabel: m => String(m || ''),
  evSportLabel: e => String((e && (e.sport_title || e.sport_key)) || ''),
  whenLabel: () => '', wxAgeH: () => 0, onlyFlagged: r => r, filterTradeable: r => ({ keep: r, dropped: [] }),
  ufcNormName(n){ return String(n == null ? '' : n).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' '); },
  mlbNorm(s){ return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); },
  MLBG: {}, EDGES: [], D5_POOL: [], WX: {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

try { new vm.Script(code, { filename: 'edgedesk-intelligence' }).runInContext(sandbox); }
catch (e) { console.error('LOAD ERROR: ' + e.stack); process.exit(3); }

let total = 0, failed = 0;
function run(name, fn) {
  let r;
  try { r = fn(); }
  catch (e) { console.log('  ' + name + ': THREW ' + e.message); failed++; total++; return; }
  if (!r) { console.log('  ' + name + ': returned nothing'); failed++; total++; return; }
  total += r.passed + r.failed; failed += r.failed;
  console.log('  ' + name + ': ' + r.passed + ' passed, ' + r.failed + ' failed');
  (r.results || []).filter(x => !x.ok).forEach(x =>
    console.log('     FAIL ' + x.t + '  got ' + JSON.stringify(x.got) + '  want ' + JSON.stringify(x.want)));
}

console.log('EdgeDesk deterministic self-tests (script block ' + found + ')');
if (sandbox.EDBetQuality) run('EDBetQuality.selfTest', () => sandbox.EDBetQuality.selfTest(false));
else { console.log('  EDBetQuality not exported'); failed++; total++; }
if (sandbox.EDResearchV2 && sandbox.EDResearchV2.selfTest) run('EDResearchV2.selfTest', () => sandbox.EDResearchV2.selfTest(false));

console.log((failed === 0 ? 'ALL GREEN — ' : 'FAILURES — ') + (total - failed) + '/' + total + ' passed');
process.exit(failed === 0 ? 0 : 1);
