#!/usr/bin/env node
/* ===========================================================================
   Tests for the founder split shown on the Collective admin screens
   (founderSplit / founderDriftHTML in collective/admin.html).

   THE CASE, and it is a real one: a founding member departed and had their
   founding_member flag cleared. That changes who the founding members ARE.
   It changes nothing at all about econ.founder_count -- a number set in
   config, which the payout math reads independently to size the split.

   So the pool goes on being divided N ways among fewer than N people. The
   departed member's share is paid to nobody, every remaining founder is
   quietly short, and no screen said a word, because the count of accounts
   that hold founding status (the overview) and the divisor the payout uses
   (the earnings screen) had never been in the same place.

   This does not fix the payout -- the backend owns that number. It makes the
   drift impossible to miss on the screen where the money is divided, and
   names the reason: clearing the flag does not decrement the count.

   Run: node tools/collective/founder_split.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'collective', 'admin.html'), 'utf8');
const a = SRC.indexOf('/* A percentage the server did not send is not 0%.');
const b = SRC.indexOf('function nav(){', a);
if (a < 0 || b < 0) {
  console.log('FAIL | collective/admin.html no longer carries the founder-split block between its markers');
  process.exit(1);
}
global.window = global;
vm.runInThisContext(SRC.slice(a, b), { filename: 'collective/admin.html [founder split]' });
const { pct, founderSplit, founderDriftHTML } = global;

/* 60% of Collective revenue, six configured seats. */
const ECON = { founder_pool_bps: 6000, founder_count: 6, reserve_bps: 1000, platform_bps: 3000 };

/* ---- a percentage nobody stated ---------------------------------------- */
chk('a missing percentage is not rendered as zero', pct(null) === '—' && pct(undefined) === '—');
chk('an unparseable one is not either', pct('lots') === '—');
chk('a real one still renders', pct(6000) === '60%' && pct(1250) === '12.5%');
chk('zero really being zero still says zero', pct(0) === '0%');

/* ---- the case that prompted this --------------------------------------- */
const departed = founderSplit(ECON, 5);
chk('a departed founder shows up as a seat nobody holds', departed.drift === -1,
  { got: departed });
chk('the payout is still dividing by the configured six',
  departed.per_configured_bps === 1000, { got: departed.per_configured_bps });
chk('an equal split across the five who remain would be more',
  departed.per_actual_bps === 1200, { got: departed.per_actual_bps });
const html = founderDriftHTML(departed);
chk('the warning names BOTH numbers, not just the wrong one',
  /\b6\b/.test(html) && /\b5\b/.test(html), { html });
chk('it says what each founder is being paid and what they should be',
  /10%/.test(html) && /12%/.test(html), { html });
chk('and it names the reason, because the flag is what was changed',
  /founder_count/.test(html) && /founding_member/.test(html), { html });
chk('it says the unheld share goes to no one',
  /paid to no one/i.test(html), { html });

/* ---- the other direction ----------------------------------------------- */
const extra = founderSplit(ECON, 7);
chk('more founders than seats is drift too', extra.drift === 1);
chk('and is described as sharing a pool sized for fewer',
  /sized for fewer/.test(founderDriftHTML(extra)));

/* ---- agreement is silent ----------------------------------------------- */
const agreed = founderSplit(ECON, 6);
chk('when the two numbers agree there is no drift', agreed.drift === 0);
chk('and nothing is shouted about it', founderDriftHTML(agreed) === '');

/* ---- a comparison that could not be made -------------------------------- */
const noRoll = founderSplit(ECON, null);
chk('an unavailable roll is not a drift of six',
  noRoll.drift === 0 && noRoll.actual === null, { got: noRoll });
chk('and claims nothing', founderDriftHTML(noRoll) === '');
chk('the configured share is still shown, because that part is known',
  noRoll.per_configured_bps === 1000);

/* ---- nothing is invented ------------------------------------------------ */
chk('a pool the server did not send is null, not 60%',
  founderSplit({ founder_count: 6 }, 5).per_configured_bps === null);
chk('a count the server did not send is null, not six',
  founderSplit({ founder_pool_bps: 6000 }, 5).configured === null);
chk('and that is not reported as drift either',
  founderSplit({ founder_pool_bps: 6000 }, 5).drift === 0);
chk('zero configured seats does not divide by zero',
  founderSplit({ founder_pool_bps: 6000, founder_count: 0 }, 5).per_configured_bps === null);
chk('zero actual founders does not either',
  founderSplit({ founder_pool_bps: 6000, founder_count: 6 }, 0).per_actual_bps === null);
chk('but zero founders against six seats IS the drift, and is stated',
  founderSplit({ founder_pool_bps: 6000, founder_count: 6 }, 0).drift === -6);
chk('no summary at all is survivable',
  founderSplit(null, null).pool_bps === null && founderDriftHTML(founderSplit(null, null)) === '');
chk('a drift warning for nothing is nothing', founderDriftHTML(null) === '');

/* ---- counts that arrive as strings, which is how JSON often carries them - */
chk('a stringified count is still a count',
  founderSplit({ founder_pool_bps: '6000', founder_count: '6' }, '5').drift === -1);
chk('an empty string is absent, not zero',
  founderSplit({ founder_pool_bps: 6000, founder_count: '' }, 5).configured === null);

/* ---- singulars, because this will be read by a person -------------------- */
const one = founderDriftHTML(founderSplit({ founder_pool_bps: 6000, founder_count: 2 }, 1));
chk('one account carries, it does not carry',
  /1<\/b> account currently carries founding status/.test(one), { html: one });
chk('one unheld seat reads as one seat',
  /1 seat is held by nobody/.test(one), { html: one });

failures.forEach(f => console.log('FAIL | ' + f.name
  + (f.detail ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
