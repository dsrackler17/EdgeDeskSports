#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_lead_lag.js — who moved first, with the timing the samplers
   allow and no more.

     moves       ≥ 1 pp between consecutive observations of one venue
     verdicts    first only when its whole interval ends before the other's
                 begins; overlapping intervals undetermined; no same-direction
                 move inside the window is NO_FOLLOW
     pregame     in-play observations are not used
     honesty     shares carry Wilson intervals and n; the note says sequence,
                 not causation; a selection seen at one venue only is excluded
                 and named

   Run: node tools/novig/lead_lag.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_lead_lag.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const T0 = Date.parse('2026-11-01T12:00:00Z'), at = (min) => new Date(T0 + min * 60000).toISOString();
const nv = (min, ask, pre) => ({ venue: 'novig', book_market: 'h2h', line: null, side: 'Buffalo Bills', point: null, at: at(min), ask: String(ask), pregame: pre !== false });
const dk = (min, dec, pre) => ({ venue: 'draftkings', book_market: 'h2h', line: null, side: 'Buffalo Bills', point: null, at: at(min), price_dec: dec, pregame: pre !== false });

/* Novig moves 0.60 -> 0.63 between minutes 60 and 65; DraftKings (hourly) moves 1/1.667=0.600 -> 1/1.587=0.630 between 120 and 180 */
const rows = [nv(0, 0.60), nv(5, 0.60), nv(60, 0.60), nv(65, 0.63), nv(70, 0.63), nv(200, 0.63), dk(0, 1.667), dk(60, 1.667), dk(120, 1.667), dk(180, 1.587)];
const s = L.study(rows);
const g = s.groups[0];
chk('moves: one ≥1 pp move each; Novig\'s 0.60→0.63 is in (60, 65]', g.moves.novig.length === 1 && g.moves.novig[0].from === Date.parse(at(60)) && g.moves.novig[0].to === Date.parse(at(65)) && g.moves.draftkings.length === 1);
chk('verdict: Novig\'s interval ends (65) before DraftKings\' begins (120): Novig moved first', g.moves.novig[0].verdict === 'THIS_FIRST' && s.tally.novig_first === 1 && s.tally.dk_first === 0);
chk('sampling: medians 5-ish and 60 minutes reported', g.sampling_minutes.draftkings === 60 && g.sampling_minutes.novig >= 5);
const ov = L.study([nv(0, 0.60), nv(100, 0.60), nv(150, 0.63), dk(0, 1.667), dk(120, 1.667), dk(180, 1.587)]);
chk('verdict: Novig in (100, 150] and DraftKings in (120, 180] overlap: undetermined, not credited to the faster sampler', ov.tally.undetermined === 1 && ov.tally.novig_first === 0 && ov.determined === 0 && ov.novig_first_share.p === null);
const nf = L.study([nv(0, 0.60), nv(60, 0.64), dk(0, 1.667), dk(60, 1.667), dk(400, 1.667)]);
chk('no follow: DraftKings never moved the same way inside 180 minutes', nf.tally.no_follow_novig === 1);
const opp = L.study([nv(0, 0.60), nv(60, 0.64), dk(0, 1.667), dk(120, 1.80)]);
chk('direction: an opposite move at the other venue is not a follow', opp.tally.no_follow_novig === 1 && opp.tally.novig_first === 0);
const live = L.study([nv(0, 0.60), nv(60, 0.70, false), dk(0, 1.667), dk(120, 1.25, false)]);
chk('pregame only: in-play observations are not used', live.tally.moves_novig === 0 && live.tally.moves_dk === 0);
const small = L.study([nv(0, 0.600), nv(5, 0.605), dk(0, 1.667), dk(60, 1.66)]);
chk('threshold: a 0.5 pp wiggle is not a move', small.tally.moves_novig === 0);
const one = L.study([nv(0, 0.60), nv(5, 0.62)]);
chk('exclusion: a selection seen at one venue only is excluded and says why', one.groups[0].excluded && /one venue/.test(one.groups[0].excluded) && one.determined === 0);
chk('honesty: the note says sequence, not causation; the window is the data\'s own', /not causation/.test(s.note) && s.window.from === at(0) && s.window.to === at(200));
const many = [];
for (let k = 0; k < 10; k++) { const b = k * 1000; many.push(Object.assign(nv(b, 0.50), { side: 'S' + k }), Object.assign(nv(b + 5, 0.53), { side: 'S' + k }), Object.assign(dk(b, 2.0), { side: 'S' + k }), Object.assign(dk(b + (k < 7 ? 60 : -1), k < 7 ? 1.887 : 2.0), { side: 'S' + k })); if (k >= 7) many.push(Object.assign(dk(b + 4, 1.887), { side: 'S' + k }), Object.assign(nv(b - 30, 0.50), { side: 'S' + k })); }
const st = L.study(many);
chk('shares: counted with a Wilson interval and n (never a bare percentage)', st.novig_first_share.n === st.determined && st.novig_first_share.low <= st.novig_first_share.p && st.novig_first_share.high >= st.novig_first_share.p);

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' lead-lag: ' + pass + ' passed, ' + fail + ' failed');
for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
process.exit(fail ? 1 : 0);
