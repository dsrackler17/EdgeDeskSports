/* Does `close` price a fair the same way `capture` does?
 *
 * CLV is entry_decimal x closing_fair - 1. The entry side is capture's pricer,
 * the closing side is close's. Every place they disagree lands in the record as
 * something indistinguishable from market movement, so the disagreements are
 * pinned here as assertions rather than left as a comment somebody has to
 * believe. See tools/capture/pricer_parity.md for what each one costs.
 *
 * close/index.ts imports the supabase client from a URL, which Node cannot
 * resolve, so its pure pricing block is sliced out by text the same way the
 * app.html suites slice theirs. The slice markers are asserted first: a rename
 * that moves them must fail loudly rather than silently testing nothing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CLOSE = fs.readFileSync(path.join(ROOT, 'supabase/functions/close/index.ts'), 'utf8');

let pass = 0, fail = 0;
const chk = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};
const done = () => {
  console.log(fail ? `FAILED ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

/* ---- slice close's pure pricing block ---------------------------------- */
const a = CLOSE.indexOf('function bisect(');
const b = CLOSE.indexOf('const REGIONS =');
chk('close still has a sliceable pricing block', a > -1 && b > a,
  `bisect at ${a}, REGIONS at ${b}`);
if (a < 0 || b <= a) done();

/* Node strips TypeScript types on import, so the slice is written out as a .ts
   module and imported rather than hand-stripped with a regex. Same code path
   the rest of the suite uses for capture itself. */
const os = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-parity-'));
const SLICE = path.join(TMP, 'close_pricer.ts');
fs.writeFileSync(SLICE, CLOSE.slice(a, b));

/* ---- capture, imported for real ---------------------------------------- */
process.env.CAPTURE_NO_SERVE = '1';
globalThis.Deno = { env: { get: () => undefined }, serve: () => {} };

(async () => {
  const cap = await import(path.join(ROOT, 'supabase/functions/capture/index.ts'));
  let ctx;
  try { ctx = await import(SLICE); }
  catch (e) { chk('close pricing block evaluates', false, e.message); done(); }
  chk('close pricing block evaluates', typeof ctx.devig === 'function');

  /* 1 · devig agrees wherever the book has margin to remove. */
  const overround = [[1.909, 1.909], [1.83, 1.95], [2.6, 3.4, 2.9], [1.06, 9.5]];
  for (const decs of overround) {
    const A = cap.devig(decs, 'shin'), B = ctx.devig(decs, 'shin');
    const d = Math.max(...A.map((x, i) => Math.abs(x - B[i])));
    chk(`devig agrees on an overrounded book [${decs}]`, d < 1e-8, `max deviation ${d}`);
  }

  /* 2 · and disagrees on an UNDERROUND one, where close returns something that
         is not a probability distribution but still passes decideClose. */
  const under = [2.10, 2.10];
  const capU = cap.devig(under, 'shin'), cloU = ctx.devig(under, 'shin');
  const capSum = capU.reduce((x, y) => x + y, 0), cloSum = cloU.reduce((x, y) => x + y, 0);
  chk('booksum under 1 is genuinely underround', under.reduce((s, d) => s + 1 / d, 0) < 1);
  chk('capture normalises an underround book to a distribution', Math.abs(capSum - 1) < 1e-8, `sums to ${capSum}`);
  chk('close does NOT — its underround output is not a distribution', Math.abs(cloSum - 1) > 0.05, `sums to ${cloSum}`);
  chk('and close\'s value still looks like a valid probability, so nothing rejects it',
    cloU[0] > 0 && cloU[0] < 1, `close fair ${cloU[0]}`);

  /* 3 · the reference book. Structural, and the one that costs the most. */
  chk('close cannot fetch by bookmaker list at all', !/CAPTURE_BOOKMAKERS/.test(CLOSE));
  chk('close builds its odds URL with regions only', /&regions=\$\{regions\}/.test(CLOSE));
  chk('close defaults CAPTURE_REGIONS to "us", which excludes Pinnacle',
    /CAPTURE_REGIONS"\) \?\? "us"/.test(CLOSE));
  chk('capture defaults it to "us,eu", which does not',
    /regions:\s*g\("CAPTURE_REGIONS",\s*"us,eu"\)/.test(
      fs.readFileSync(path.join(ROOT, 'supabase/functions/capture/index.ts'), 'utf8')));
  chk('so close still carries the v8 line that substitutes consensus for sharp',
    /sharp = s\.sharp \?\? cons/.test(CLOSE),
    'this is the exact line capture v9 was written to remove');

  /* 4 · sigKey MUST match or close matches zero rows and writes nothing. */
  const o = { event_id: 'evt1', market: 'h2h', selection: 'Fresno State', point: null };
  chk('sigKey is identical, including the load-bearing trailing pipe',
    ctx.sigKey(o) === cap.sigKey(o) && ctx.sigKey(o).endsWith('|'),
    `close=${ctx.sigKey(o)} capture=${cap.sigKey(o)}`);

  /* 5 · the consensus population differs by construction. */
  chk('capture reduces its consensus over independent families with a trimmed median',
    typeof cap.trimmedMedian === 'function');
  chk('close reduces over every bookmaker row with a plain median',
    /const cons = median\(s\.fairs\)/.test(CLOSE));

  fs.rmSync(TMP, { recursive: true, force: true });
  done();
})().catch((e) => { console.log('FAILED to run: ' + e.message); process.exit(1); });
