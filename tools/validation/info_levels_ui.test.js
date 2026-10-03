#!/usr/bin/env node
/* ============================================================================
   BEGINNER / RESEARCH / LAB — one decision, three depths, never three answers.

     node tools/validation/info_levels_ui.test.js

   every decision class at every level · the level switch · the one-line
   answer on every card is EDExplain's · the chip, the card, the CSV export
   and the watch row say the same decision and the same quote · no
   contradictory labels · beginner stays short · lab shows the gates, the
   curve, the buckets and the versions · model health prints n beside every
   percentage · the exposure safeguards warn before a limit
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
const D = require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
const U = require(path.join(ROOT, 'lib', 'edgedesk_decision_ui.js'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_explain.js'));
const BK = require(path.join(ROOT, 'lib', 'edgedesk_bankroll.js'));
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
function section(t) { console.log('  · ' + t); }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '’').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NOW = Date.parse('2026-10-04T12:00:00Z'), FRESH = '2026-10-04T11:50:00Z', OLD = '2026-10-04T06:00:00Z', KICK = '2026-10-04T17:00:00Z';
const qq = (side, line, am, book, extra) => Object.assign({ game_id: 'g', side, line, american: am, book: book || 'DraftKings', captured_at: FRESH, n_books: 1 }, extra || {});
function nflModel(fair) { return { sport: 'NFL', available: true, model_version: 'edgedesk_football_v1.0.0', fair_home_margin: fair, home_cover: (t) => E.dist.coverProbSpread('nfl', fair, t), tail: { validated_within_pts: 0 }, adjusted: { available: false } }; }
const board = (hl, hp, ap) => [qq('home', hl, hp || -110), qq('away', -hl, ap || -110), qq('home', hl, (hp || -110) - 2, 'FanDuel'), qq('away', -hl, (ap || -110) + 2, 'FanDuel')];
const CONTEXT = { reliability: { score: 86, grade: 'STRONG', components: [{ key: 'team_data', label: 'Team data', value: 94, unit: '%' }, { key: 'qb', label: 'QB', value: 'EXPECTED' }], main_deduction: 'rating uncertainty' },
  sensitivity_drivers: [{ key: 'rating_home', label: 'Miami rating', sd: 1.6 }], joint_sd: 1.9, provenance: [{ key: 'qb', what: 'Quarterback', source: 'nflverse', updated_at: FRESH, pricing_impact: 'yes' }] };
function decide(fair, quotes, extra) {
  return D.decide(Object.assign({ sport: 'NFL', game: { game_id: 'g', home: 'Miami Dolphins', away: 'Buffalo Bills', kickoff: KICK }, model: nflModel(fair), quotes, now: NOW,
    qb: { known: true }, availability: { known: true }, reliability: { score: 85 }, confidence: { score: 80 }, projection: { stability: 'STABLE', p10: -20, p50: -8, p90: 5 }, context: CONTEXT }, extra || {}));
}
/* the fair margins moved with audit 2026-09-30 #4 (the NFL table read by its
   median): Miami +10 against a fair +7 is the BET, against +8.25 the WATCH (near threshold) */
const CASES = {
  BET: decide(-7, board(10)),
  WATCH: decide(-8.25, board(10)),
  LEAN: decide(-8, [qq('home', 10, -110), qq('home', 10, -112, 'FanDuel')]),
  PASS: decide(3, board(-3, -115, -115)),
  NO_DECISION: decide(-8, board(10).map((q) => Object.assign({}, q, { captured_at: OLD })))
};
section('the fixtures cover every decision class');
Object.keys(CASES).forEach((k) => chk('fixture ' + k, CASES[k].decision === k, [k, CASES[k].decision_display, CASES[k].action_reason_code]));

section('the level switch');
chk('an explicit level wins', U.levelOf({ level: 'lab' }) === 'lab' && U.levelOf({ level: 'beginner' }) === 'beginner');
chk('beginner:true is the beginner level; beginner:false is research', U.levelOf({ beginner: true }) === 'beginner' && U.levelOf({ beginner: false }) === 'research');
chk('the default is research', U.levelOf({}) === 'research');
chk('three levels, in order', U.LEVELS.map((l) => l[0]).join() === 'beginner,research,lab');

const TONE = { BET: 'bet', WATCH: 'watch', LEAN: 'lean', PASS: 'pass', NO_DECISION: 'none' };
section('every class at every level: one badge, the level, the answer, clean words');
Object.keys(CASES).forEach((k) => {
  const d = CASES[k];
  ['beginner', 'research', 'lab'].forEach((lv) => {
    const h = U.actionCardHTML(d, { level: lv, track: null }), t = text(h);
    const badges = (h.match(/class="edd-badge edd-b-[a-z]+"/g) || []);
    chk(k + '/' + lv + ': exactly one decision badge, the right one', badges.length === 1 && badges[0] === 'class="edd-badge edd-b-' + TONE[k] + '"', badges);
    chk(k + '/' + lv + ': the card knows its level and marks the switch', new RegExp('data-edd-level="' + lv + '"').test(h) && new RegExp('class="edd-lv on" data-edd-act="level" data-edd-v="' + lv + '"').test(h));
    chk(k + '/' + lv + ': the one-line answer is EDExplain’s, verbatim', h.indexOf('<div class="edd-answer" data-edd-answer>' + esc(X.oneLine(d)) + '</div>') >= 0, X.oneLine(d));
    chk(k + '/' + lv + ': no tout words, no undefined / NaN', U.copyOk(h) && !/undefined|NaN|\[object/.test(t), t.match(/.{40}(undefined|NaN).{40}/));
    const top = text(h.split('View reasoning')[0].split('Show reasoning')[0]);
    if (k !== 'BET') chk(k + '/' + lv + ': no units or dollars above the reasoning', !/based on your \$/.test(top) && !/\b\d\.\d+U\b/.test(top), top.slice(0, 300));
  });
});

section('beginner is short: what should I do?');
{
  const b = U.actionCardHTML(CASES.BET, { level: 'beginner', track: null }), t = text(b);
  chk('BET: the pick, the price · book, the stake, playable to', /MIAMI DOLPHINS \+10/.test(t) && /-110 · DraftKings/.test(t) && /BET · 0\.25U/.test(t) && /PLAYABLE TO/.test(t), t.slice(0, 400));
  chk('BET: EV, edge and confidence in the execution summary', /EDGE \+[\d.]+ pp/.test(t) && /(MODEL-ESTIMATED|CALIBRATED) EV \+[\d.]+%/.test(t) && /CONFIDENCE \d+\/100/.test(t), t.slice(0, 600));
  chk('BET: WHY in one sentence and MAIN RISK in one line', /WHY EdgeDesk makes it/.test(t) && (b.match(/class="edd-why1"/g) || []).length === 1 && (b.match(/class="edd-risk"/g) || []).length === 1);
  chk('beginner never shows the Lab and folds the reasoning', !/edd-lab/.test(b) && !/<details class="edd-reason" open/.test(b));
  chk('beginner carries none of the Research blocks', !/WHY ISN’T THIS A BET|PRICE ALTERNATIVES|WHAT CHANGES MY MIND|BREAK THE NUMBER/.test(t) && /PRICE ALTERNATIVES/.test(text(U.actionCardHTML(CASES.BET, { level: 'research', track: null }))));
  const w = text(U.actionCardHTML(CASES.WATCH, { level: 'beginner', track: null }));
  chk('WATCH: DO NOT BET YET and what it waits for', /DO NOT BET YET/.test(w) && /is close, but EdgeDesk wants/.test(w), w.slice(0, 400));
}
section('research: why?');
{
  const r = U.actionCardHTML(CASES.PASS, { level: 'research', track: null }), t = text(r);
  chk('PASS: WHY ISN’T THIS A BET? with the gate that failed', /WHY ISN’T THIS A BET\?/.test(t) && /PASS because/.test(t) && /Price clears the BET threshold: not a BET at this price/.test(t), t.match(/WHY ISN’T.{0,300}/));
  chk('the canonical market: consensus, books, verification, a quality index that says it is not a probability', /MARKET/.test(t) && /Consensus/.test(t) && /Verification/.test(t) && /an index, not a probability/.test(t));
  chk('WHAT CHANGES MY MIND? — price, QB, availability, model, market', /WHAT CHANGES MY MIND\?/.test(t) && ['Price', 'QB', 'Availability', 'Model', 'Market'].every((x) => new RegExp(x + ' ').test(t)));
  const b = text(U.actionCardHTML(CASES.BET, { level: 'research', track: null }));
  chk('BET: price alternatives with the best execution and the ladder', /PRICE ALTERNATIVES/.test(b) && /Best execution/.test(b) && /AT -110/.test(b), b.match(/PRICE ALTERNATIVES.{0,300}/));
  {
    const rh = U.actionCardHTML(CASES.BET, { level: 'research', track: null }), L = CASES.BET.ladder;
    const rowsOf = (i) => ((rh.match(/<div class="edd-ladder">[\s\S]*?<\/div>/g) || [])[i] || '').match(/<span class="edd-lad[^"]*">[\s\S]*?<\/span>(?=<span class="edd-lad|<\/div>)/g) || [];
    const lineRows = rowsOf(0).map(text), priceRows = rowsOf(L.by_line.length > 1 ? 1 : 0).map(text);
    chk('the line ladder names only the number on each rung', L.by_line.length > 1 && lineRows.length === L.by_line.length && lineRows.every((x, i) => x.trim().indexOf(D.lineText ? D.lineText(L.by_line[i].line) : String(L.by_line[i].line).replace(/^(?=\d)/, '+')) === 0 && !/Miami/.test(x)), lineRows);
    chk('the price ladder names only the price on each rung', L.by_price.length <= 1 || (priceRows.length === L.by_price.length && priceRows.every((x) => /^\s*[-+]\d{3}/.test(x) && !/Miami/.test(x))), priceRows);
    chk('the current rung is marked now', /class="edd-lad now"/.test(rh) && /<small>now<\/small>/.test(rh));
  }
  chk('WHAT CHANGES MY MIND points to Break the number instead of repeating it', /Model See Break the number below\./.test(b) && (b.split(X.sensitivity(CASES.BET).text).length - 1) === 1);
  chk('BET: the reliability breakdown from measured components', /RELIABILITY 86 · STRONG/.test(b) && /Team data 94%/.test(b) && /not a win probability/.test(b));
  chk('BET: break the number, against the measured SD, with scenarios', /BREAK THE NUMBER/.test(b) && /Miami rating ±1\.6 pts/.test(b) && /CONSERVATIVE/.test(b) && /not a forecast/.test(b), b.match(/BREAK THE NUMBER.{0,300}/));
  chk('research keeps the existing reasoning (why it qualifies, what cancels it)', /WHY IT QUALIFIES/.test(b) && /WHAT CANCELS IT/.test(b));
  chk('research shows the Lab closed', /<details class="edd-lab"><summary>Lab/.test(U.actionCardHTML(CASES.BET, { level: 'research', track: null })));
  const nd = text(U.actionCardHTML(CASES.NO_DECISION, { level: 'research', track: null }));
  chk('NO DECISION: the blocker, the market it could not use, and what would change it', /STALE_QUOTE/.test(nd) && /WHAT CHANGES MY MIND\?/.test(nd) && !/Best execution/.test(nd), nd.slice(0, 400));
}
section('lab: how was it calculated?');
{
  const l = U.actionCardHTML(CASES.BET, { level: 'lab', track: null }), t = text(l);
  chk('the Lab is open', /<details class="edd-lab" open>/.test(l));
  chk('probability model: source, raw vs decision cover, raw vs calibrated EV, the distribution', /PROBABILITY MODEL/.test(t) && /Raw model cover/.test(t) && /Decision cover/.test(t) && /Raw EV/.test(t) && /Calibrated EV/.test(t) && /p10 -20 · p50 -8 · p90 5/.test(t));
  chk('the gates table, the binding gate marked', /GATES/.test(t) && /Gates, not an average/.test(t) && /class="bind"/.test(l));
  chk('the price curve with the engine self-check', /PRICE CURVE/.test(t) && /Self-check: the curve classifies the current quote as BET 0\.25U; the engine decided BET 0\.25U — they agree\./.test(t), t.match(/Self-check.{0,160}/));
  chk('historical buckets: loading until model health arrives (never invented)', /HISTORICAL BUCKETS/.test(t) && /Loading model health|did not load|No graded/.test(t));
  chk('versions and provenance', /VERSIONS & PROVENANCE/.test(t) && /edgedesk_football_decision_v2/.test(t) && /Quarterback nflverse/.test(t));
  U._state.health = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'model_health.json'), 'utf8'));
  const l2 = text(U.actionCardHTML(CASES.BET, { level: 'lab', track: null }));
  chk('with model health loaded: the NFL raw-model walk-forward buckets, each with n', /HISTORICAL BUCKETS Walk-forward NFL spread \(raw model, held out\) · n=\d+/.test(l2) && /Measurement only/.test(l2), l2.match(/HISTORICAL BUCKETS.{0,200}/));
}
section('one decision, every surface says the same thing');
{
  const csv = U.decisionsCSV(Object.values(CASES)).trim().split('\n');
  chk('the export has a header and one row per decision', csv.length === 1 + Object.keys(CASES).length && csv[0].split(',').length === U.CSV_HEAD.length);
  Object.keys(CASES).forEach((k) => {
    const d = CASES[k], row = U.decisionRow(d), col = (n) => row[U.CSV_HEAD.indexOf(n)];
    const chip = text(U.chipHTML(d)), card = U.actionCardHTML(d, { level: 'research', track: null }), wr = X.watchRow(d, null);
    const word = k === 'NO_DECISION' ? 'NO DECISION' : k;
    chk(k + ': chip, card, export and watch row name the same decision', chip.indexOf(word) >= 0 && col('decision') === k && wr.decision === k && wr.display.indexOf(k === 'NO_DECISION' ? 'NO DECISION' : k) === 0, [chip, col('decision'), wr.display]);
    chk(k + ': the export’s one-line answer is the card’s', col('one_line') === X.oneLine(d) && card.indexOf(esc(col('one_line'))) >= 0);
    const q = d.bet_price || d.reference_quote;
    if (q) chk(k + ': the export, the market object and the card read the same quote', col('line') === q.line && col('odds') === q.odds && col('book') === q.book && d.market.sportsbook === q.book && d.market.line === q.line, [col('line'), col('odds'), col('book'), d.market.sportsbook]);
    chk(k + ': units only on a BET, in every surface', (k === 'BET') === (col('units') > 0) && (k === 'BET') === /BET · \d/.test(chip));
    chk(k + ': the export carries the versions and the data time', col('decision_engine') === d.decision_engine_version && col('version_key') === d.versions.version_key && col('data_snapshot_at') === d.data_snapshot_at);
  });
  const b = U.actionCardHTML(CASES.BET, { level: 'research', track: null }), w = U.actionCardHTML(CASES.WATCH, { level: 'research', track: null });
  const p = U.actionCardHTML(CASES.PASS, { level: 'research', track: null }), n = U.actionCardHTML(CASES.NO_DECISION, { level: 'research', track: null });
  chk('no contradictory labels: a BET never says DO NOT BET YET; a WATCH never offers BET PLACED', !/DO NOT BET YET/.test(b) && !/BET PLACED/.test(w) && !/BET PLACED/.test(p) && !/BET PLACED/.test(n));
  chk('no contradictory labels: only a BET carries PLAYABLE TO above the reasoning', /PLAYABLE TO/.test(b.split('View reasoning')[0]) && !/PLAYABLE TO/.test(w.split('View reasoning')[0]) && !/PLAYABLE TO/.test(p.split('View reasoning')[0]));
  chk('the market grade and the canonical market agree on depth', Object.values(CASES).filter((d) => d.market && d.market.market_depth && d.market_quality).every((d) => !(d.market_quality === 'ACCEPTABLE' && d.market.market_depth.fresh_books >= 2 && d.market.verification_status === 'VERIFIED')));
}
section('model health on the Card page: n beside every percentage');
{
  const H = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'model_health.json'), 'utf8'));
  const h = U.modelHealthHTML(H, { open: true });
  const rows = h.match(/<tr>[\s\S]*?<\/tr>|<div class="edd-pr">[\s\S]*?<\/div><\/div>|<div class="edd-pr">[\s\S]*?<\/span><\/div>/g) || [];
  const bad = rows.filter((r) => /\d%/.test(text(r)) && !/n=\d/.test(text(r)));
  chk('every row with a percentage prints its n (' + rows.length + ' rows)', rows.length > 3 && bad.length === 0, bad.slice(0, 3).map(text));
  chk('the maturity ladder with n at each stage', /edd-maturity/.test(h) && (h.match(/<span>n=\d+<\/span>/g) || []).length === 5);
  chk('research alerts are shown, each saying nothing changes automatically', /RESEARCH ALERTS/.test(h) && /never an automatic change/.test(h) && (h.match(/class="edd-alert/g) || []).length >= 3);
  chk('modes are labelled apart (Backtest vs Live (reconstructed))', /CFB Lab · Backtest/.test(text(h)) && /CFB Lab · Live \(reconstructed\)/.test(text(h)));
  chk('the published record is labelled model-level', /the published fair line, not bettor decisions/.test(text(h)));
  const page = U.cardPageHTML(Object.values(CASES), { view: { filter: 'all', sort: 'kickoff' } });
  chk('the Card page carries the model health section and the export', /MODEL HEALTH/.test(page) && /Export decisions \(CSV\)/.test(page));
}
section('exposure safeguards warn before the limit');
{
  const P = (gid, u, ko) => ({ decision: 'BET', game_id: gid, recommended_units: u, kickoff: ko, sport: 'CFB', side: 'home', market_type: 'spread' });
  const ex = BK.exposure([P('a', 0.5, '2026-10-03T17:00:00Z'), P('b', 0.75, '2026-10-03T17:30:00Z'), P('c', 0.5, '2026-10-03T18:00:00Z')], {});
  const w = ex.limits.filter((l) => l.key === 'max_units_per_window')[0];
  chk('per game, per day, per sport and per kickoff window, with conservative defaults', ex.limits.map((l) => l.key).join() === 'max_units_per_game,max_units_per_day,max_units_per_sport,max_units_per_window' && ex.limits.map((l) => l.limit).join() === '1,3,3,2');
  chk('1.75U in a 2U window is NEAR, and warned', w.status === 'NEAR' && ex.warnings.some((x) => x.code === 'LIMIT_NEAR' && /kickoff window/.test(x.text)), ex.warnings);
  const over = BK.exposure([P('a', 1, '2026-10-03T17:00:00Z'), P('b', 1, '2026-10-03T17:30:00Z'), P('c', 0.5, '2026-10-03T18:00:00Z')], {});
  chk('2.5U in the window is EXCEEDED, warned — and nothing is held unless the reader opts in', over.warnings.some((x) => x.code === 'LIMIT_EXCEEDED') && over.held.length === 0 && over.total_units === 2.5);
  const held = BK.exposure([P('a', 1, '2026-10-03T17:00:00Z'), P('b', 1, '2026-10-03T17:30:00Z'), P('c', 0.5, '2026-10-03T18:00:00Z')], { bucket_limits_enabled: true });
  chk('opted in: the position past the window limit is held, with the reason', held.held.length === 1 && /kickoff window limit/.test(held.held[0].text) && held.total_units <= 2, held.held);
  chk('a remote settings row never resets the device limits', BK.fromRow({ bankroll_amount: 1000 }, { max_units_per_game: 0.5 }).max_units_per_game === 0.5);
  const sm = { exposure: ex };
  /* a kickoff ahead of the real clock: the Card drops a game that has kicked
     off (a fixed '2026-10-03T17:00:00Z' went red at that minute) */
  const page = U.cardPageHTML([Object.assign({}, CASES.BET, { kickoff: new Date(Date.now() + 6 * 3600e3).toISOString() })], { view: { filter: 'all', sort: 'kickoff' }, no_health: true });
  chk('the Card page prints the limits', /Limits/.test(page) && /Per kickoff window/.test(page), text(page).match(/EXPOSURE.{0,300}/));
}

console.log(fail ? 'FAILURES:\n  ' + failures.join('\n  ') : '');
console.log((fail ? 'FAIL' : 'ALL GREEN') + ' information levels — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
