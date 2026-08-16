/* Node harness: load the EdgeDesk Intelligence IIFE out of app.html with a
   minimal DOM/global stub and run its deterministic self-tests.

   This exists so "tests pass" is something observed rather than asserted. The
   IIFE is browser code, but every function under test is pure deterministic
   logic over owned fields, so a stub DOM is enough to exercise all of it. */
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || require('path').join(__dirname, '..', 'app.html');
const src = fs.readFileSync(path, 'utf8');

/* EVERY inline block that exports a selfTest is loaded, not just the first match.
   Scoping this to one block is how a whole suite goes unrun: the Intelligence
   Fabric's own tests live in a different <script> and were invisible here until
   the harness started looking for all of them. */
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const blocks = [];
let m, idx = 0;
while ((m = re.exec(src))) {
  idx++;
  if (m[1].indexOf('selfTest') >= 0) blocks.push({ n: idx, code: m[1] });
}
if (!blocks.length) { console.error('no inline script block exports a selfTest'); process.exit(2); }

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

const loaded = [];
for (const b of blocks) {
  try { new vm.Script(b.code, { filename: 'block' + b.n }).runInContext(sandbox); loaded.push(b.n); }
  catch (e) { console.error('LOAD ERROR in block ' + b.n + ': ' + e.message); process.exit(3); }
}

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

console.log('EdgeDesk deterministic self-tests (script blocks ' + loaded.join(', ') + ')');
/* Discovered, not hardcoded — a new suite is picked up by existing. */
const suites = Object.keys(sandbox).filter(k =>
  sandbox[k] && typeof sandbox[k] === 'object' && typeof sandbox[k].selfTest === 'function').sort();
if (!suites.length) { console.log('  no suite exported a selfTest'); process.exit(1); }
suites.forEach(k => run(k + '.selfTest', () => sandbox[k].selfTest(false)));

console.log((failed === 0 ? 'ALL GREEN — ' : 'FAILURES — ') + (total - failed) + '/' + total + ' passed');
process.exit(failed === 0 ? 0 : 1);
