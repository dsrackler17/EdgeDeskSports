'use strict';
/* ===========================================================================
   A preload that moves the clock: node --require tools/ci/clock_shift.js

   EDGEDESK_CLOCK_SHIFT_DAYS=14 makes Date.now() and new Date() read fourteen
   days later (negative: earlier); every other Date use is untouched. verify.js
   --clock-shift <days> sets NODE_OPTIONS so every node process a step starts
   inherits it. A suite whose result changes when the clock moves is reading
   the wall clock against committed data: it passes today and fails on a later
   day with no change to the code (#798, #794 and #793 each fixed one of these
   by hand, 2026-10-26). The browser's own clock is not moved.
   =========================================================================== */
const days = Number(process.env.EDGEDESK_CLOCK_SHIFT_DAYS || 0);
if (days && isFinite(days)) {
  const shift = Math.round(days * 864e5);
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + shift); else super(...a); }
    static now() { return RealDate.now() + shift; }
  }
  globalThis.Date = new Proxy(ShiftedDate, {
    apply() { return new ShiftedDate().toString(); },
  });
}
