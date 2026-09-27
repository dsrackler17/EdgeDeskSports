#!/usr/bin/env node
/* ===========================================================================
   Tests for THE PLAYER LAYER -> ENGINE ROSTER BUNDLE MERGE, and for the
   coverage number the board and the offline artifact publish off the back of
   it.

   What these hold, in the order they would break:

     1  the join exists at all — the engine's talent layer stopped reporting
        empty because a committed file reached it, not because a constant was
        edited;
     2  the merge is ADDITIVE — a measurement the roster diff made is never
        overwritten by one the player layer made, and neither is invented
        where both are silent;
     3  recruiting stays dark — this is measured production, and nothing here
        may relabel it as pedigree;
     4  confidence travels with the value, so a thinly-observed roster raises
        completeness without claiming certainty;
     5  the board and football/fbs/slate.json compute coverage the same way,
        because two numbers for one game is the bug this whole change exists
        to close.

   Run: node football/players/roster_quality.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const RQ = require(path.join(ROOT, 'football', 'players', 'roster_quality.js'));
const IN = require(path.join(ROOT, 'football', 'matchup', 'inputs.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.stack) || e).slice(0, 300) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 460) : '')));
  console.log('\nroster quality: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const isNum = x => typeof x === 'number' && isFinite(x);
const LAYER = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'players', 'current.json'), 'utf8'));

/* ============================================== 1. the join exists at all */
{
  const m = RQ.merge({}, LAYER, E.normKey);
  chk('every rated programme comes back with a bundle', m.teams === Object.keys(LAYER.teams).length,
    { merged: m.teams, in_layer: Object.keys(LAYER.teams).length });
  chk('the merge covers the full FBS field, not a handful', m.teams >= 130, m.teams);

  const withTalent = Object.keys(m.bundles).filter(k => isNum(m.bundles[k].overall_talent));
  chk('a roster composite reaches every rated programme', withTalent.length >= m.teams, withTalent.length);

  /* THE REGRESSION THIS EXISTS TO CATCH: the engine's talent layer reporting
     "no overall talent composite" on a team the player layer rates. */
  const anyKey = withTalent[0];
  const prof = E.talent.profile(m.bundles[anyKey], 'home');
  chk('the engine reads the composite instead of declaring it missing',
    prof.overall && prof.overall.available === true, prof.overall);
  chk('the engine reports it as production, and says in so many words that it is not pedigree',
    /production/i.test(String(prof.overall.basis))
    && /not recruiting pedigree/i.test(String(prof.overall.basis)), prof.overall.basis);
}

/* ================================================ 2. the merge is additive */
{
  /* a bundle the roster diff already measured: every field it filled must
     survive the merge untouched */
  const key = Object.keys(LAYER.teams)[0];
  const diff = { by_group: { OL: { n: 17, returning_share: 0.824, transfers_in: 3, transfers_out: 1, experience: 0.91 } },
    overall_talent: null, blue_chip_ratio: null, source: 'roster diff', as_of: '2026-09-01T00:00:00.000Z' };
  const before = JSON.parse(JSON.stringify(diff));
  const bundles = {}; bundles[key] = diff;
  const m = RQ.merge(bundles, LAYER, E.normKey);
  const after = m.bundles[key].by_group.OL;

  chk('a continuity the roster diff measured is not overwritten', after.returning_share === 0.824, after);
  chk('a portal count the roster diff measured is not overwritten',
    after.transfers_in === 3 && after.transfers_out === 1, after);
  chk('a class mix the roster diff measured is not overwritten', after.experience === 0.91, after);
  chk('the roster headcount the continuity was computed against is not overwritten', after.n === 17, after);
  chk('the group talent the diff could not measure is filled', isNum(after.talent), after);

  chk('the caller\'s own object is not mutated', JSON.stringify(diff) === JSON.stringify(before),
    { before, after: diff });
  chk('merging twice gives the same answer',
    JSON.stringify(RQ.merge(bundles, LAYER, E.normKey).bundles[key])
      === JSON.stringify(RQ.merge(bundles, LAYER, E.normKey).bundles[key]));

  /* a field NEITHER side measured stays null, so the engine widens rather
     than guesses — this is the line that must never be traded for a fuller
     percentage */
  const sparse = { by_group: { QB: { n: null, returning_share: null, transfers_in: null, transfers_out: null, experience: null } },
    overall_talent: null, blue_chip_ratio: null };
  const sm = RQ.merge({ someteam: sparse }, { teams: { someteam: { groups: { QB: {} }, overall: {} } },
    generated_at: null, season: 2026 }, E.normKey);
  chk('a field neither side measured stays null rather than being invented',
    sm.bundles.someteam.by_group.QB.talent === undefined
    && sm.bundles.someteam.overall_talent === null, sm.bundles.someteam);
}

/* ================================================ 3. recruiting stays dark */
{
  const m = RQ.merge({}, LAYER, E.normKey);
  const withChip = Object.keys(m.bundles).filter(k => isNum(m.bundles[k].blue_chip_ratio));
  chk('no programme acquires a blue-chip ratio from this merge', withChip.length === 0, withChip.slice(0, 5));
  const prof = E.talent.profile(m.bundles[Object.keys(m.bundles)[0]], 'home');
  chk('the engine still declares the blue-chip layer unavailable',
    prof.blue_chip && prof.blue_chip.available === false, prof.blue_chip);
  chk('the reason still names the missing recruiting feed',
    /recruiting/.test(String(prof.blue_chip.reason)), prof.blue_chip.reason);
}

/* ============================ 4. confidence travels with the value */
{
  const m = RQ.merge({}, LAYER, E.normKey);
  const key = Object.keys(m.bundles).find(k => isNum(m.bundles[k].overall_talent_confidence));
  chk('the layer\'s own confidence is carried, not a constant', !!key, key);
  const b = m.bundles[key];
  const prof = E.talent.profile(b, 'home');
  chk('the engine uses the supplied confidence rather than its 0.6 default',
    Math.abs(prof.overall.confidence - b.overall_talent_confidence) < 1e-9,
    { supplied: b.overall_talent_confidence, used: prof.overall.confidence });

  /* the old behaviour, still correct where nothing travelled with the value */
  const bare = { by_group: {}, overall_talent: 55, blue_chip_ratio: null, source: 'x' };
  chk('a composite with no confidence still falls back to the engine default',
    E.talent.profile(bare, 'home').overall.confidence === 0.6);

  /* a group confidence must not be replaced by a headcount proxy */
  const gk = Object.keys(b.by_group).find(g => isNum(b.by_group[g].talent_confidence));
  if (gk) {
    const gp = E.talent.profile(b, 'home').by_group[gk];
    chk('a group\'s measured confidence beats the roster-count proxy',
      Math.abs(gp.talent.confidence - b.by_group[gk].talent_confidence) < 1e-9,
      { supplied: b.by_group[gk].talent_confidence, used: gp.talent.confidence });
  }
}

/* =========================== 5. a missing layer is survivable, not fatal */
{
  const diff = { by_group: { OL: { n: 17, returning_share: 0.8 } }, overall_talent: null, blue_chip_ratio: null };
  const m = RQ.merge({ x: diff }, null, E.normKey);
  chk('no player layer leaves the bundles exactly as the roster sync built them',
    m.bundles.x === diff && m.teams === 0, m);
  chk('and says so rather than failing silently', /did not|not supplied/.test(String(m.note)), m.note);
}

/* =================== 6. the board and the artifact agree on the arithmetic */
{
  /* app.html used to carry its own ES5 copy of summarise() because the
     browser could not require() the node module, and this section extracted
     that copy and ran it against the offline one. There is no copy any more:
     the contract and its arithmetic live in football/matchup/contract.js,
     which the build requires and the board loads with a plain <script>. So
     the proof is that there is ONE function, and that the file the browser
     runs computes the same thing. */
  const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  chk('app.html no longer carries a summarise copy of its own', APP.indexOf('function fbP4Summarise(') < 0);
  chk('it loads the shared contract instead', /fbScript\('football\/matchup\/contract\.js'\)/.test(APP));
  const CONTRACT = require(path.join(ROOT, 'football', 'matchup', 'contract.js'));
  chk('and the offline assembly\'s summarise IS the shared one', IN.summarise === CONTRACT.summarise);
  /* the browser's copy of the file, run as the browser runs it: no module,
     no require, a window */
  const vm = require('vm');
  const win = { console };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'football', 'matchup', 'contract.js'), 'utf8'), win,
    { filename: 'contract.js' });
  chk('the shared file runs as a browser script', !!(win.EDInputContract && win.EDInputContract.summarise));
  const appSummarise = win.EDInputContract.summarise;

  const rows = [
    { field: 'a', side: 'home', state: 'USABLE' }, { field: 'a', side: 'away', state: 'USABLE' },
    { field: 'b', side: null, state: 'RESEARCH_ONLY' }, { field: 'c', side: null, state: 'STALE' },
    { field: 'd', side: null, state: 'NOT_APPLICABLE' }, { field: 'e', side: null, state: 'FETCH_FAILED' },
    { field: 'f', side: null, state: 'UNAVAILABLE' }
  ];
  const a = appSummarise(rows), b = IN.summarise(rows);
  chk('the board and the offline assembly count applicable fields the same way',
    a.applicable === b.applicable, { app: a.applicable, offline: b.applicable });
  /* KNOWN = USABLE + RESEARCH_ONLY. Two usable and one research-only is
     three; the STALE row is deliberately not among them, which is what the
     count of 3 out of four non-NOT_APPLICABLE "present" rows proves. */
  chk('they count KNOWN the same way — STALE is not known on either side',
    a.known === b.known && a.known === 3, { app: a.known, offline: b.known });
  chk('they publish the same input coverage', a.input_coverage === b.input_coverage,
    { app: a.input_coverage, offline: b.input_coverage });
  chk('they publish the same priced coverage', a.priced_coverage === b.priced_coverage,
    { app: a.priced_coverage, offline: b.priced_coverage });
  chk('NOT_APPLICABLE leaves the denominator on both sides',
    a.applicable === rows.length - 1 && b.applicable === rows.length - 1);
  chk('a refused source does NOT leave the denominator — it is a real hole',
    a.applicable === 6 && a.input_coverage === Math.round((3 / 6) * 1000) / 1000, a);
  /* the same rows with the refusal removed must score HIGHER, which is what
     makes the previous assertion mean something */
  chk('dropping the refused row raises coverage, so it was genuinely counted',
    IN.summarise(rows.filter(r => r.state !== 'FETCH_FAILED')).input_coverage > a.input_coverage);
}

/* ============ 7. the assembly actually carries the talent into the request */
{
  const ctx = IN.load({ season: 2026, params: global.EDCfbP4Params, normKey: E.normKey });
  chk('the offline assembly merges the player layer at load time',
    !!ctx.roster_quality && ctx.roster_quality.teams > 100, ctx.roster_quality);
  chk('and records how much of it landed', ctx.roster_quality && ctx.roster_quality.filled
    && ctx.roster_quality.filled.overall > 100, ctx.roster_quality && ctx.roster_quality.filled);
  const rated = Object.keys(ctx.rosters).filter(k => isNum(ctx.rosters[k].overall_talent));
  chk('the roster bundles the engine is handed carry a composite', rated.length > 100, rated.length);
}

done();
