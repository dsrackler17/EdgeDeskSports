/* Does `close` price a fair the same way `capture` does?
 *
 * CLV is entry_dec x closing_fair - 1. The entry side is capture's pricer, the
 * closing side is close's. Every place they disagree lands in the record as
 * something indistinguishable from market movement, so the agreement is pinned
 * here rather than left as a comment somebody has to believe.
 *
 * Four defects were found and fixed in close-v7-parity; this file is what stops
 * them coming back. See tools/capture/pricer_parity.md for what each one cost.
 *
 * close/index.ts imports the supabase client from a URL, which Node cannot
 * resolve, so the file is copied with that one import stubbed and imported for
 * real — the whole file, not a slice, so a syntax error anywhere in it fails
 * here too.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CLOSE_PATH = path.join(ROOT, 'supabase/functions/close/index.ts');
const CLOSE = fs.readFileSync(CLOSE_PATH, 'utf8');

/* Assertions about code shape must read CODE. This file's own header quotes the
   defective v8 line verbatim to explain what was removed, and a naive regex over
   the raw source cannot tell an explanation from an instruction. */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let pass = 0, fail = 0;
const chk = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};
const done = (tmp) => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail ? `FAILED ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

const CODE = codeOnly(CLOSE);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-parity-'));
fs.writeFileSync(path.join(TMP, 'stub.ts'),
  'export const createClient = (_u, _k, _o) => ({ from: () => ({}) });\n');
const stubbed = CLOSE.replace(
  /import \{ createClient \} from "https:\/\/[^"]+";/,
  'import { createClient } from "./stub.ts";');
chk('the supabase import is a single resolvable URL import', stubbed !== CLOSE,
  'if this fails the import shape changed and the stub no longer applies');
fs.writeFileSync(path.join(TMP, 'close.ts'), stubbed);

process.env.CAPTURE_NO_SERVE = '1';
globalThis.Deno = { env: { get: () => undefined }, serve: () => {} };

(async () => {
  let cap, clo;
  try {
    cap = await import(path.join(ROOT, 'supabase/functions/capture/index.ts'));
    clo = await import(path.join(TMP, 'close.ts'));
  } catch (e) { chk('both functions load', false, e.message); done(TMP); }
  chk('both functions load', typeof cap.devig === 'function' && typeof clo.devig === 'function');

  /* ── 1 · devig is the same function, including where it used to differ ──── */
  const cases = [
    ['normal 2-way', [1.909, 1.909]],
    ['juicy 2-way', [1.83, 1.95]],
    ['3-way', [2.6, 3.4, 2.9]],
    ['big favourite', [1.06, 9.5]],
    ['UNDERROUND — the v6 bug', [2.10, 2.10]],
    ['deeply underround', [2.5, 2.5]],
    ['barely overround', [2.0, 1.999]],
  ];
  for (const [name, decs] of cases) {
    const A = cap.devig(decs, 'shin'), B = clo.devig(decs, 'shin');
    const d = Math.max(...A.map((x, i) => Math.abs(x - B[i])));
    chk(`devig agrees: ${name}`, d < 1e-12, `max deviation ${d}`);
  }
  for (const method of ['shin', 'power', 'multiplicative']) {
    const decs = [1.87, 2.05];
    const A = cap.devig(decs, method), B = clo.devig(decs, method);
    chk(`devig agrees under method=${method}`,
      Math.max(...A.map((x, i) => Math.abs(x - B[i]))) < 1e-12);
  }

  /* every devig output is a probability distribution, which v6's was not */
  for (const [name, decs] of cases) {
    const B = clo.devig(decs, 'shin');
    const s = B.reduce((x, y) => x + y, 0);
    chk(`close devig returns a distribution: ${name}`, Math.abs(s - 1) < 1e-9, `sums to ${s}`);
  }

  /* ── 2 · the reference book is reachable ───────────────────────────────── */
  chk('close reads CAPTURE_BOOKMAKERS, the same env capture reads',
    /CAPTURE_BOOKMAKERS/.test(CODE));
  chk('close builds bookmakers= when a list is configured',
    /bookmakers=\$\{encodeURIComponent\(BOOKMAKERS\.join\(","\)\)\}/.test(CODE));
  chk('close defaults CAPTURE_REGIONS to us,eu — Pinnacle is an eu book',
    /CAPTURE_REGIONS"\) \?\? "us,eu"/.test(CODE),
    'a "us" default makes the reference book structurally unreachable');
  chk('capture and close default the region the same way',
    /regions:\s*g\("CAPTURE_REGIONS",\s*"us,eu"\)/.test(codeOnly(
      fs.readFileSync(path.join(ROOT, 'supabase/functions/capture/index.ts'), 'utf8'))));
  chk('the v8 silent substitution is gone',
    !/sharp = s\.sharp \?\? cons/.test(CODE),
    'consensus must never be stored wearing the word sharp');
  chk('and what replaced it labels the rule that produced the fair',
    /reference_type/.test(CODE) && /robust_consensus/.test(CODE));

  /* ── 3 · families, trimming, and the exec book kept out of its own fair ── */
  chk('close dedups to one quote per operator family', /byFamily/.test(CODE));
  chk('close shares capture\'s family map',
    JSON.stringify(clo.BOOK_FAMILY) === JSON.stringify(cap.BOOK_FAMILY),
    `close=${JSON.stringify(clo.BOOK_FAMILY)}`);
  for (const k of ['betonlineag', 'lowvig', 'williamhill_us', 'bovada', 'draftkings']) {
    chk(`bookFamily agrees on ${k}`, clo.bookFamily(k) === cap.bookFamily(k));
  }
  const sample = [0.51, 0.515, 0.52, 0.525, 0.6, 0.61];
  chk('trimmedMedian agrees', clo.trimmedMedian(sample) === cap.trimmedMedian(sample),
    `close=${clo.trimmedMedian(sample)} capture=${cap.trimmedMedian(sample)}`);
  chk('trimmedMedian is a plain median below five observations',
    clo.trimmedMedian([1, 2, 3]) === cap.median([1, 2, 3]));

  /* end to end on a real event shape: one soft book best-priced, Pinnacle present */
  const ev = {
    id: 'evt1', sport_key: 'americanfootball_ncaaf', sport_title: 'NCAAF',
    commence_time: '2026-09-06T16:00:00Z', home_team: 'Fresno State', away_team: 'Boise State',
    bookmakers: [
      { key: 'pinnacle', title: 'Pinnacle', last_update: '2026-09-06T15:58:00Z',
        markets: [{ key: 'h2h', last_update: '2026-09-06T15:58:00Z', outcomes: [
          { name: 'Fresno State', price: 1.95 }, { name: 'Boise State', price: 1.95 }] }] },
      { key: 'draftkings', title: 'DraftKings', last_update: '2026-09-06T15:57:00Z',
        markets: [{ key: 'h2h', last_update: '2026-09-06T15:57:00Z', outcomes: [
          { name: 'Fresno State', price: 1.91 }, { name: 'Boise State', price: 1.91 }] }] },
      { key: 'betonlineag', title: 'BetOnline', last_update: '2026-09-06T15:57:00Z',
        markets: [{ key: 'h2h', last_update: '2026-09-06T15:57:00Z', outcomes: [
          { name: 'Fresno State', price: 1.92 }, { name: 'Boise State', price: 1.90 }] }] },
      { key: 'lowvig', title: 'LowVig', last_update: '2026-09-06T15:57:00Z',
        markets: [{ key: 'h2h', last_update: '2026-09-06T15:57:00Z', outcomes: [
          { name: 'Fresno State', price: 1.92 }, { name: 'Boise State', price: 1.90 }] }] },
      { key: 'espnbet', title: 'ESPN BET', last_update: '2026-09-06T15:57:00Z',
        markets: [{ key: 'h2h', last_update: '2026-09-06T15:57:00Z', outcomes: [
          { name: 'Fresno State', price: 2.15 }, { name: 'Boise State', price: 1.75 }] }] },
    ],
  };
  const now = Date.parse('2026-09-06T15:59:00Z');
  const priced = clo.priceEvent(ev, 'shin', ['pinnacle'], now);
  const fs1 = priced.find((o) => o.selection === 'Fresno State');
  chk('priceEvent returns the selection', !!fs1);
  chk('the reference book is used, not substituted', fs1.reference_type === 'sharp', fs1.reference_type);
  chk('and it is named', fs1.reference_book === 'pinnacle', String(fs1.reference_book));
  chk('has_sharp is now true when the reference is present', fs1.has_sharp === true);
  chk('the best price is the soft book', fs1.best_book === 'espnbet' && fs1.best_dec === 2.15,
    `${fs1.best_book} @ ${fs1.best_dec}`);
  chk('betonline and lowvig count as ONE family',
    fs1.n_books === 5 && fs1.n_families === 4, `books=${fs1.n_books} families=${fs1.n_families}`);
  chk('the fair equals capture\'s devig of the reference book\'s own prices',
    Math.abs(fs1.sharp_fair - cap.devig([1.95, 1.95], 'shin')[0]) < 1e-12,
    `close=${fs1.sharp_fair}`);
  chk('the reference age is carried', fs1.ref_age_s === 60, String(fs1.ref_age_s));

  /* ── 4 · the coherence guard finally has its data ──────────────────────── */
  chk('pin_dec and pin_opp_dec are populated from the reference book',
    fs1.pin_dec === 1.95 && fs1.pin_opp_dec === 1.95,
    `pin_dec=${fs1.pin_dec} pin_opp_dec=${fs1.pin_opp_dec}`);
  const incoherent = { best_dec: 1.95, sharp_fair: 0.5, reference_type: 'sharp',
    has_sharp: true, pin_dec: 1.2, pin_opp_dec: 1.2 };            // overround 1.667
  chk('an incoherent reference market is now actually rejected',
    clo.decideClose(1.95, incoherent).reason === 'incoherent_close_market',
    JSON.stringify(clo.decideClose(1.95, incoherent)));
  const coherent = { ...incoherent, pin_dec: 1.95, pin_opp_dec: 1.95 };
  chk('a coherent one is not', clo.decideClose(1.95, coherent).reason === null);

  /* no reference at all is its own reason, not a fabricated number */
  const noRef = { best_dec: 1.95, sharp_fair: null, reference_type: 'none', has_sharp: false };
  chk('no reference and too thin a pack yields no CLV and says so',
    clo.decideClose(1.95, noRef).clv === null
    && clo.decideClose(1.95, noRef).reason === 'no_close_reference');

  /* a fair that is not a probability is still rejected */
  const badFair = { best_dec: 1.95, sharp_fair: 1.4, reference_type: 'sharp', has_sharp: true };
  chk('a fair outside (0,1) is still rejected',
    clo.decideClose(1.95, badFair).reason === 'invalid_close_fair');

  /* the -100% fabrication stays fixed */
  const ok = { best_dec: 1.95, sharp_fair: 0.5, reference_type: 'sharp', has_sharp: true };
  chk('a missing entry price is excluded, never graded as -100%',
    clo.decideClose(null, ok).clv === null && clo.decideClose(null, ok).reason === 'no_entry_price');
  chk('a real close computes the arithmetic definition of CLV',
    Math.abs(clo.decideClose(2.0, ok).clv - 0) < 1e-12, String(clo.decideClose(2.0, ok).clv));

  /* ── 5 · sigKey MUST match or close matches zero rows and writes nothing ─ */
  for (const o of [
    { event_id: 'e', market: 'h2h', selection: 'Fresno State', point: null },
    { event_id: 'e', market: 'spreads', selection: 'Fresno State', point: -3.5 },
    { event_id: 'e', market: 'totals', selection: 'Over', point: 51 },
  ]) {
    chk(`sigKey identical for ${o.market}`, clo.sigKey(o) === cap.sigKey(o),
      `close=${clo.sigKey(o)} capture=${cap.sigKey(o)}`);
  }
  chk('and the trailing pipe survives a null point',
    clo.sigKey({ event_id: 'e', market: 'h2h', selection: 'X', point: null }).endsWith('|'));

  /* ── 6 · the record can always separate the two eras ───────────────────── */
  chk('close stamps a policy on every row it writes', /closing_policy: CLOSE_POLICY/.test(CODE));
  chk('and the new columns are PROBED, never assumed',
    /const refCols = await hasColumn\("signals", "closing_reference_type"\)/.test(CODE),
    'writing a column the migration has not added fails every update in the function');
  chk('a missing column omits the labels and keeps writing everything else',
    /\.\.\.\(refCols \? \{/.test(CODE));

  done(TMP);
})().catch((e) => { console.log('FAILED to run: ' + e.message); process.exit(1); });
