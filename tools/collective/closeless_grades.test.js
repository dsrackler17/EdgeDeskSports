#!/usr/bin/env node
/* ===========================================================================
   A SETTLED WIN OR LOSS ON A GAME WITH NO CAPTURED CLOSE — one rule, both
   ends of the wire.

   THE BUG. A Thursday night game finished. The score landed, the board said
   "no captured close" — which was true, and is the honest answer — and the
   same game went into every model's record as a LOSS while the settlement
   run caught up. Two statements about one game, and only one of them can be
   right: there is no number that game could have been graded against.

   The published rule, stated on the site and in this API's own
   documentation, is that a pick is decided by the final score against the
   COLLECTIVE'S OWN captured closing spread, that the close is the yardstick
   so every model faces the same number, and that a missing close is null,
   never invented. A finished game with no captured close therefore has no
   against-the-spread result for anybody and is counted by nobody.

   The page applied that to its own grading and accepted a verdict on the
   same game from the settlement run without asking. Now both ends refuse
   it — collective/index.html (noCapturedClose, closelessLogRow) and
   collective_public (atsServed) — and that is exactly the shape of thing
   that drifts. So this suite runs BOTH over one table of cases. A verdict
   the page would set aside and the API would serve, or the reverse, is a
   red line here.

   Run: node tools/collective/closeless_grades.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./reconcile_ats.js');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; }
  }
  if (ok) { pass++; return; }
  fail++; fails.push({ name, detail });
}

const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'collective_public', 'index.ts');
const src = fs.readFileSync(FN, 'utf8');

/* ---- the API's half, lifted out of the deployed function ----------------
   The edge function cannot import from this repository, so the rule lives
   there under a marked block. Extract it and run it here, exactly as the
   week-rollover suite does with its own mirror. */
const MARK = 'THE CAPTURED CLOSE IS THE YARDSTICK';
const END = '/* ---8<--- END ---8<--- */';
const a = src.indexOf(MARK), b = src.indexOf(END);
chk('the edge function still carries the marked block', a >= 0 && b > a, { open: a, close: b });

/* Defined and never called is the same as not defined at all: both served
   shapes that carry a settled verdict have to go through it. */
chk('the games payload runs every settled verdict through it',
  /pick_result: atsServed\(m\.pick_result, g\.closing_spread\)/.test(src));
chk('and so does the model page’s game log',
  /pick_result: atsServed\(g\.pick_result, g\.closing_spread\)/.test(src));

/* Home convention throughout: a close of 0 is a pick'em, which IS a
   captured close; null and undefined are the absence of one. */
const CASES = [
  { why: 'a loss graded against a real close stands', pick: 'loss', close: -7.5, want: 'loss' },
  { why: 'so does a win', pick: 'win', close: -3, want: 'win' },
  { why: 'so does a push on the number', pick: 'push', close: 7, want: 'push' },
  { why: 'a pick’em is a captured close, not a missing one', pick: 'loss', close: 0, want: 'loss' },
  { why: 'a verdict with no close behind it is not served', pick: 'loss', close: null, want: null },
  { why: 'nor a win', pick: 'win', close: null, want: null },
  { why: 'a missing close that arrives as undefined is missing too', pick: 'win', close: undefined, want: null },
  { why: 'a game with a close and no verdict is unchanged', pick: null, close: -7, want: null },
  { why: 'and neither is invented where there is neither', pick: null, close: null, want: null },
];

(async function () {
  let mirror = null;
  if (a >= 0 && b > a) {
    const block = src.slice(src.indexOf('*/', a) + 2, b);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closeless-'));
    const file = path.join(dir, 'mirror.ts');
    /* Node 22 strips TypeScript types natively, which is how the rest of
       this repository drives the deployed .ts bundles. */
    fs.writeFileSync(file, block + '\nexport { atsServed };\n');
    try { mirror = await import('file://' + file); }
    catch (e) { chk('the marked block compiles on its own', false, { threw: String(e && e.message) }); }
  }

  if (mirror) {
    chk('the marked block compiles on its own', true);
    const wrong = CASES.filter(c => mirror.atsServed(c.pick, c.close) !== c.want);
    chk('the API serves a verdict only where a captured close exists',
      wrong.length === 0,
      { wrong: wrong.map(c => ({ why: c.why, got: mirror.atsServed(c.pick, c.close), want: c.want })) });
  }

  /* ---- the page's half, driven from collective/index.html --------------
     The same table, through the surface a reader actually sees: a settled
     grade on a game whose result carries that close. */
  let P = null;
  try { P = R.loadPage(); }
  catch (e) { chk('the page loads', false, { threw: String(e && e.message) }); }

  if (P) {
    chk('the page still names the rule it applies',
      typeof P.noCapturedClose === 'function' && typeof P.closelessLogRow === 'function');

    const gameFor = (close, pick) => ({
      game_id: 'g1', label: 'AWAY @ HOME', home: 'HOME', away: 'AWAY', week: 1,
      kickoff_at: '2026-09-17T23:30:00Z',
      result: { home_score: 27, away_score: 13, closing_spread: close, closing_total: null },
      models: [{ creator_slug: 'c', model_slug: 'm', pick_side: 'away',
        projected_spread: 2.5, home_win_probability: 0.4,
        grade: { pick_result: pick, margin_error: 1.5, brier: 0.36 } }],
    });
    const pageSays = c => {
      const g = gameFor(c.close, c.pick);
      const gr = P.rowGrade(g, g.models[0]);
      return gr ? gr.pick_result : null;
    };
    const disagree = CASES.filter(c => pageSays(c) !== c.want);
    chk('the page shows a verdict only where a captured close exists',
      disagree.length === 0,
      { disagree: disagree.map(c => ({ why: c.why, got: pageSays(c), want: c.want })) });

    if (mirror) {
      const split = CASES.filter(c => pageSays(c) !== mirror.atsServed(c.pick, c.close));
      chk('and the page and the API answer every case identically',
        split.length === 0,
        { split: split.map(c => ({ why: c.why, page: pageSays(c), api: mirror.atsServed(c.pick, c.close) })) });
    }

    /* The numbers that need no closing line are not collateral damage. */
    chk('the margin error and the brier survive the verdict being set aside',
      (function () {
        const g = gameFor(null, 'loss');
        const gr = P.rowGrade(g, g.models[0]);
        return gr && gr.pick_result === null && gr.margin_error === 1.5 && gr.brier === 0.36;
      })());
    chk('and the row says which of the four reasons it is',
      (function () {
        const g = gameFor(null, 'loss');
        return P.atsReason(g, g.models[0]) === 'no_close';
      })());
    chk('the record counts it nowhere — not as a loss, not in a win percentage',
      (function () {
        const g = gameFor(null, 'loss');
        const rec = P.modelRecord([g], 'c', 'm');
        return rec.losses === 0 && rec.graded === 0 && rec.win_pct === null
          && rec.ats_missing.no_close === 1 && rec.margin_n === 1;
      })());
  }

  if (fail) {
    fails.forEach(f => console.log('FAIL | ' + f.name +
      (f.detail ? '  ' + JSON.stringify(f.detail) : '')));
    console.log(`FAILED ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`ALL GREEN ${pass} passed, 0 failed`);
})();
