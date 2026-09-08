#!/usr/bin/env node
/* ============================================================================
   THE PRESS BRIEF, HELD TO THE BOARD.

   The brief restates two of app.html's rules in Node so it can print them:
   which status a game gets, and how a projected score is split. A restatement
   drifts. These checks pin both to the page they were copied from — by reading
   `fbP4StatusFor` and `fbGxScore` out of app.html and asserting the thresholds
   and the arithmetic still match — so the printed document and the screen
   cannot tell a reader two different things about the same game.

   The rest holds what a press document must never do: publish a score it
   cannot split, print a market column with no market in it, or lose the
   uncertainty on the way to the page.

     node tools/football/press_brief.test.js      # exit 0 = green
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PB = require('./press_brief.js');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); } }
  if (cond === true) { pass++; return; }
  if (typeof cond === 'string') { fail++; fails.push(name + ' — ' + cond); return; }
  fail++; fails.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }

/* ---------------------------------------------------------------- */
/* 1. THE THRESHOLDS ARE THE PAGE'S THRESHOLDS                       */
/* ---------------------------------------------------------------- */
(function parity() {
  const statusSrc = APP.slice(APP.indexOf('function fbP4StatusFor('),
    APP.indexOf('function fbP4Line('));
  ok('parity: the board still has fbP4StatusFor', statusSrc.length > 200);

  /* the guard bound the page compares a gap against */
  const guard = APP.match(/FB_GUARD\s*=\s*\{[\s\S]{0,400}?p4:\s*\{\s*game:\s*(\d+)/);
  ok('parity: the board declares a Power 4 guard bound', !!guard);
  if (guard) eq('parity: and the brief uses the same one', PB.GUARD_P4_GAME, +guard[1]);

  ok('parity: the board escalates to INVESTIGATE at a 7-point gap',
    /gap>=7\)return\s*\{t:'INVESTIGATE'/.test(statusSrc.replace(/\s+/g, '')),
    'the 7-point rung moved in app.html and press_brief.js still prints 7');

  const conf = APP.match(/min_confidence\s*!=\s*null\s*\?\s*MP\.min_confidence\s*:\s*(\d+)/);
  ok('parity: the board declares a confidence floor', !!conf);
  if (conf) eq('parity: and the brief uses the same one', PB.MIN_CONFIDENCE, +conf[1]);

  const rgap = APP.match(/min_research_gap\s*!=\s*null\s*\?\s*MP\.min_research_gap\s*:\s*(\d+)/);
  ok('parity: the board declares a research gap', !!rgap);
  if (rgap) eq('parity: and the brief uses the same one', PB.MIN_RESEARCH_GAP, +rgap[1]);

  /* the score split, character for character on the arithmetic */
  const scoreSrc = APP.slice(APP.indexOf('function fbGxScore('), APP.indexOf('/* ── THE SUMMARY'));
  ok('parity: the board still splits a score from spread and total', scoreSrc.length > 80);
  ok('parity: and it refuses when either is missing',
    /fair_total==null\|\|m\.fair_spread==null\)returnnull/.test(scoreSrc.replace(/\s+/g, '')));
  ok('parity: home is (total + spread) / 2, rounded',
    /home:Math\.round\(\(m\.fair_total\+m\.fair_spread\)\/2\)/.test(scoreSrc.replace(/\s+/g, '')));
  ok('parity: away is (total − spread) / 2, rounded',
    /away:Math\.round\(\(m\.fair_total-m\.fair_spread\)\/2\)/.test(scoreSrc.replace(/\s+/g, '')));
})();

/* ---------------------------------------------------------------- */
/* 2. THE SCORE IS NEVER INVENTED                                    */
/* ---------------------------------------------------------------- */
(function score() {
  eq('score: a margin with no total produces no score', PB.projectedScore(10, null), null);
  eq('score: a total with no margin produces no score', PB.projectedScore(null, 50), null);
  const s = PB.projectedScore(8.4, 57.3);
  ok('score: a normal game splits', !!s);
  eq('score: home is the higher side when the home team is favoured', s.home, 33);
  eq('score: and the away side is the remainder', s.away, 24);
  ok('score: the two sides sum back to the total', Math.abs((s.home + s.away) - 57.3) <= 1);
  ok('score: and their difference is the margin', Math.abs((s.home - s.away) - 8.4) <= 1);
  /* THE CASE THAT MATTERS: a 50-point margin with no total. The first proof of
     this document printed "Florida A&M −25.1" from exactly this input. */
  eq('score: a 50-point margin and no total is refused, not halved',
    PB.projectedScore(50.19, null), null);
  eq('score: a margin that outruns its total publishes nothing rather than a negative side',
    PB.projectedScore(60, 40), null);
})();

/* ---------------------------------------------------------------- */
/* 3. THE STATUS SAYS WHAT THE EVIDENCE SUPPORTS                     */
/* ---------------------------------------------------------------- */
(function status() {
  const g = (o) => Object.assign({ data_status: 'PREDICTED', confidence: 60, spread_gap: 0 }, o);
  eq('status: no projection at all is awaiting data', PB.statusFor(g({ data_status: 'INSUFFICIENT_DATA' })).key, 'AWAITING');
  eq('status: below the confidence floor is thin data', PB.statusFor(g({ confidence: 34.9 })).key, 'THIN');
  eq('status: at the floor it is not', PB.statusFor(g({ confidence: 35 })).key, 'AGREE');
  eq('status: thin data outranks a large gap',
    PB.statusFor(g({ confidence: 10, spread_gap: 18 })).key, 'THIN');
  eq('status: no market number is no market', PB.statusFor(g({ spread_gap: null })).key, 'NO_MARKET');
  eq('status: a 1.9-point gap is agreement', PB.statusFor(g({ spread_gap: 1.9 })).key, 'AGREE');
  eq('status: a 2-point gap is review', PB.statusFor(g({ spread_gap: 2 })).key, 'REVIEW');
  eq('status: a 6.9-point gap is still review', PB.statusFor(g({ spread_gap: 6.9 })).key, 'REVIEW');
  eq('status: a 7-point gap is investigate', PB.statusFor(g({ spread_gap: 7 })).key, 'INVESTIGATE');
  eq('status: the sign of the gap does not matter', PB.statusFor(g({ spread_gap: -7 })).key, 'INVESTIGATE');
  eq('status: 21 points is still investigate', PB.statusFor(g({ spread_gap: 21 })).key, 'INVESTIGATE');
  eq('status: past the guard bound it is a data fault', PB.statusFor(g({ spread_gap: 21.1 })).key, 'FAULT');
  ok('status: every status explains itself in words a reader can use',
    ['AWAITING', 'THIN', 'NO_MARKET', 'AGREE', 'REVIEW', 'INVESTIGATE', 'FAULT'].every(k => {
      const cases = { AWAITING: { data_status: 'X' }, THIN: { confidence: 5 }, NO_MARKET: { spread_gap: null },
        AGREE: { spread_gap: 0 }, REVIEW: { spread_gap: 3 }, INVESTIGATE: { spread_gap: 9 }, FAULT: { spread_gap: 30 } };
      const st = PB.statusFor(g(cases[k]));
      return st.key === k && typeof st.means === 'string' && st.means.length > 30 && st.label && st.glyph;
    }));
  ok('status: a data fault is called a data fault and explicitly not an edge',
    /probable data fault/.test(PB.statusFor(g({ spread_gap: 30 })).means)
    && /not as an edge/.test(PB.statusFor(g({ spread_gap: 30 })).means));
  ok('status: and neither is a large-gap investigate',
    /missing information/.test(PB.statusFor(g({ spread_gap: 12 })).means));
})();

/* ---------------------------------------------------------------- */
/* 4. THE DOCUMENTS SAY WHAT THEY DO NOT KNOW                        */
/* ---------------------------------------------------------------- */
(function documents() {
  const R = PB.loadRankings();
  if (!R) { ok('documents: the rankings artifact loads', false, 'run npm run cfb:rankings'); return; }

  const slate = {
    has_market: false,
    games: [
      { game_id: '1', season: 2026, week: 2, kickoff: '2026-09-12 19:30', venue: 'Test Field',
        home: 'Home U', away: 'Away A & M', home_conf: 'ACC', away_conf: 'SEC', neutral: false,
        margin: 8.4, total: 57.3, home_line: -8.4, win_prob: 70.6,
        ref_line: null, ref_total: null, ref_source: '', spread_gap: null, total_gap: null,
        confidence: 39, volatility: 80, sigma: 15.5, p10: -15.6, p90: 29.4,
        preseason_share: 86, games_played: 1, injury_uncertainty: 100,
        qb_status: 'home QB unknown', data_status: 'PREDICTED',
        drivers: ['A driver'], counter: 'A counterargument', unavailable: ['Home starting quarterback'],
        notes: [], model_version: 'edgedesk_cfb_p4_v1.0.0', ratings_basis: 'test',
        score: PB.projectedScore(8.4, 57.3), status: PB.statusFor({ data_status: 'PREDICTED', confidence: 39, spread_gap: null }) },
      { game_id: '2', season: 2026, week: 2, kickoff: '2026-09-13 00:00', venue: '',
        home: 'Big State', away: 'Tiny College', home_conf: '', away_conf: '', neutral: false,
        margin: 50.2, total: null, home_line: -50.2, win_prob: 100,
        ref_line: null, ref_total: null, ref_source: '', spread_gap: null, total_gap: null,
        confidence: 8, volatility: 90, sigma: 15.5, p10: 26, p90: 71,
        preseason_share: 86, games_played: 1, injury_uncertainty: 100,
        qb_status: '', data_status: 'PREDICTED',
        drivers: [], counter: '', unavailable: [], notes: [],
        model_version: 'edgedesk_cfb_p4_v1.0.0', ratings_basis: 'test',
        score: PB.projectedScore(50.2, null), status: PB.statusFor({ data_status: 'PREDICTED', confidence: 8, spread_gap: null }) }
    ]
  };
  const html = PB.buildHtml(slate, R);

  ok('slate brief: it renders', html.length > 5000);
  ok('slate brief: the unproven record leads the document', /UNPROVEN/.test(html) && /does <b>not<\/b> beat the closing line|not<\/b>\s*beat/.test(html.replace(/\n/g, ' ')));
  ok('slate brief: a game with no total says so instead of showing a score',
    /no total published/.test(html));
  ok('slate brief: and never prints a negative score', !/>-\d+<\/b>/.test(html));
  ok('slate brief: with no market joined it drops the market columns rather than printing dashes',
    html.indexOf('<th class="c-mkt num">Mkt</th>') < 0);
  ok('slate brief: and says why they are absent', /no market number joined any game in this run/.test(html));
  ok('slate brief: an ampersand in a team name survives once, not twice',
    /Away A &amp; M/.test(html) && !/&amp;amp;/.test(html));
  ok('slate brief: every kickoff carries its zone', /Kickoff|EDT|EST|CDT|CST|UTC/.test(html));
  ok('slate brief: the confidence floor is stated as a number a reader can check',
    new RegExp(PB.MIN_CONFIDENCE + '%').test(html));
  ok('slate brief: what nobody can see has its own section',
    /What no public feed carries/.test(html));
  ok('slate brief: it states that no language model touched a rating',
    /No language model produced, ranked, adjusted or explained any rating/.test(html));
  ok('slate brief: it carries the responsible-gambling line', /1-800-GAMBLER/.test(html));
  ok('slate brief: nothing renders as the literal string undefined or NaN',
    !/undefined|NaN/.test(html), 'a null reached the page as text');

  const rk = PB.rankingsBrief(R, { upcoming_week: 2 });
  ok('rankings brief: it renders', rk.length > 3000);
  ok('rankings brief: the masthead says which week it is FOR and which it was built ON',
    /Week 2 rankings/.test(rk) && /Built on every completed result through/.test(rk));
  ok('rankings brief: it states it is not a poll', /Not a poll/.test(rk));
  ok('rankings brief: every spotlight prints the rule that selected it',
    (rk.match(/class="rule"/g) || []).length >= 2);
  ok('rankings brief: special teams is presented as measured, not a depth-chart read',
    /Special teams is a measured team unit here, not a depth-chart read/.test(rk));
  ok('rankings brief: and it says special teams is not an ETSR input',
    /not an input to ETSR/.test(rk));
  ok('rankings brief: the movers are bounded and the bound is explained',
    /artifact of the floor/.test(rk));
  ok('rankings brief: unranked teams are explained, not hidden',
    /keep|kept/.test(rk) && /confidence floor/.test(rk));
  ok('rankings brief: nothing renders as undefined or NaN', !/undefined|NaN/.test(rk));

  /* the categories the request named are all present in both the config and the page */
  const want = ['Overall (ETSR)', 'Talent', 'Performance', 'Offense', 'Defense', 'Special teams',
    'Run offense', 'Pass offense', 'Run defense', 'Pass defense', 'QB room', 'OL', 'WR / TE',
    'RB', 'DL', 'LB', 'Secondary', 'Depth', 'Continuity'];
  const labels = PB.CATEGORIES.map(c => c[1]);
  const missing = want.filter(w => labels.indexOf(w) < 0);
  ok('rankings brief: every category the brief promises is in the contract',
    missing.length === 0, 'missing: ' + missing.join(', '));
  const notOnPage = want.filter(w => rk.indexOf('>' + w + '<') < 0);
  ok('rankings brief: and every one reaches the page',
    notOnPage.length === 0, 'missing from the page: ' + notOnPage.join(', '));
})();

/* ---------------------------------------------------------------- */
/* 5. NO MODEL, NO NETWORK, NO INVENTION IN THE GENERATOR            */
/* ---------------------------------------------------------------- */
(function architecture() {
  const src = fs.readFileSync(path.join(__dirname, 'press_brief.js'), 'utf8');
  ok('architecture: the generator calls no language model',
    !/\b(openai|anthropic|claude|gpt-|completions?\.create)\b/i.test(src));
  ok('architecture: it calls no Edge Function', !/functions\/v1\/|supabase\.co\/functions/.test(src));
  ok('architecture: it fetches nothing itself — every input is a committed artifact or the exporter',
    !/\bfetch\s*\(/.test(src) && !/https?:\/\//.test(src.replace(/https?:\/\/[^\s'"`]*gambler/gi, '')));
  ok('architecture: it names the app functions it restates, so the parity check has a target',
    /fbP4StatusFor/.test(src) && /fbGxScore/.test(src));
})();

/* ---------------------------------------------------------------- */
console.log(fails.map(f => '  FAIL  ' + f).join('\n'));
console.log(`\npress brief: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
