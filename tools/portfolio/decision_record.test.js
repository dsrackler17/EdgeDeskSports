#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_decision_record.js and the Decision Record views of
   lib/edgedesk_portfolio_journal_ui.js, in Node.

     - the canonical record renders BEFORE · ENTRY · MARKET PATH · RESULT ·
       GRADE · REFLECTION · FOLLOW-UP, says what EdgeDesk did not observe,
       never invents a close, and shows each price with its time and source;
     - a stale saved price is never presented as current;
     - process memory reads FIRST DETECTED · THEN · NOW · STATUS, the status
       by test, never by comparing two letters;
     - the baseline card and analysis depth describe what the evidence allows
       and never ask for more wagers;
     - "Ask EdgeDesk about this decision" speaks only from the record;
     - an experiment's result is the pre-registered test on frozen evidence;
     - nothing the reader typed becomes markup; no banned word anywhere.

   Run: node tools/portfolio/decision_record.test.js
   =========================================================================== */
'use strict';
const path = require('path');
global.window = global;
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_portfolio.js'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_process.js'));
const R = require(path.join(ROOT, 'lib', 'edgedesk_decision_record.js'));
const J = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_journal_ui.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); } }
const plain = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const BANNED = /\bBET THIS\b|DON'?T BET|\bLOCK\b|GUARANTEED|bet more|place (another|more)/i;

/* a record as portfolio_decision_record() returns it */
const REC = {
  methodology: { process: 'process_v1', context_quality: 'context_quality_v1', edge_capture: 'edge_capture_v1', outcome_class: 'outcome_class_v1', snapshot: 'snapshot_v1', calc: 'portfolio_calc_v1' },
  position: { id: 'p1', platform: 'draftkings', platform_label: 'DraftKings', platform_type: 'SPORTSBOOK', position_type: 'SPREAD', sport: 'NFL', event_name: 'Bills @ Chiefs <script>',
    market_name: 'Spread', selection: 'Chiefs -3', line: -3, source: 'MANUAL' },
  context_quality: 'FULL',
  before: {
    snapshot: { origin: 'CARD', origin_ref: 'ce_1', saved_at: '2026-10-05T00:00:00Z', recorded_at: '2026-10-05T03:00:00Z', version: 'snapshot_v1',
      edgedesk: { model_version: 'nfl_r2', probability: 0.56, fair_odds_decimal: 1.787402, ev: 0.069, decision: 'BET' },
      market: { captured_at: '2026-10-05T00:00:00Z', book: 'draftkings', odds_american: -110, odds_decimal: 1.909091, line: -3, consensus_line: -3, n_books: 6 },
      user_state: { unit: 50, max_single_units: 2, prior_24h_positions: 1, prior_24h_units: 0.5, rules: [{ label: 'Two units <b>max</b>' }], experiments: [{ title: 'Early entries' }] },
      market_freshness: 'STALE', content_hash: 'abc', research_to_decision_seconds: 10800 },
    journal: { thesis: 'Rest edge <img src=x onerror=1>', planned: true, decision_tags: ['MODEL'], research_odds_decimal: 1.909091, research_line: -3, research_at: '2026-10-05T00:00:00Z', research_pre_event: true },
    card: [{ event: 'ADDED', at: '2026-10-05T00:00:00Z' }, { event: 'RECORDED', at: '2026-10-05T03:00:00Z' }]
  },
  entry: { placed_at: '2026-10-05T03:00:00Z', odds_american: -105, odds_decimal: 1.952381, line: -3, stake: 25, cost_basis: 25, units: 0.5, lead_seconds: 150000, timing_bucket: 'D1_3' },
  market_path: [
    { kind: 'DECISION', observed_at: '2026-10-05T00:00:00Z', time_basis: 'OBSERVED', source: 'EDGEDESK_SNAPSHOT', book: 'draftkings', odds_decimal: 1.909091, line: -3 },
    { kind: 'ENTRY', observed_at: '2026-10-05T03:00:00Z', time_basis: 'OBSERVED', source: 'USER', book: 'draftkings', odds_decimal: 1.952381, line: -3 },
    { kind: 'CLOSE', observed_at: '2026-10-07T20:00:00Z', time_basis: 'RECORDED', source: 'USER', odds_decimal: 1.8, line: -3 }],
  result: { status: 'LOST', result: 'LOSS', settled_at: '2026-10-08T00:00:00Z', profit_loss: -25, closing_source: 'USER', closing_odds_decimal: 1.8, closing_line: -3 },
  grade: { process_score: 92.1, grade: 'A+', components: { clv: 100, price: 100, market: 80, sizing: null }, clv_pct: 0.084656,
    edge_capture: { basis: 'PRICE', edge_at_decision: 0.069091, edge_at_entry: 0.093333, capture_ratio: 1.3509, slip_pct: 0.022676, clv_pct: 0.084656, limitations: ['IMPLIED_PROBABILITY_INCLUDES_MARGIN'] },
    outcome: { class: 'GOOD_LOSS', methodology: 'outcome_class_v1' } },
  reflection: { current: { would_repeat: 'YES' }, history: [{ written_at: '2026-10-06T00:00:00Z', would_repeat: 'YES', result_known: false }, { written_at: '2026-10-08T01:00:00Z', would_repeat: 'YES', review_note: 'Beat the close', result_known: true, result: 'LOSS' }] },
  follow_up: { needs_review: false, experiments: [{ title: 'Early entries', followed: true }], patterns: [{ label: 'NFL · Spread', first_detected_at: '2026-09-20T00:00:00Z' }], rules_broken: [] }
};

/* ═══ THE RECORD ═════════════════════════════════════════════════════ */
let h = J.decisionRecordView(REC, { ask: true }), t = plain(h);
chk('every section, in order: Before · Entry · Market path · Result · Grade · Reflection · Follow-up',
  ['Before', 'Entry', 'Market path', 'Result', 'Grade', 'Reflection', 'Follow-up'].map((x) => h.indexOf('<div class="pfo-dr-h">' + x + '</div>')).every((i, k, a) => i > 0 && (k === 0 || i > a[k - 1])));
chk('its context quality is named and explained', /Full context/.test(t) && /Recorded before the event with EdgeDesk's model state/.test(t));
chk('BEFORE: what EdgeDesk said (model and version), the market then with its capture time — stale said so — and the reader\'s own state',
  /EdgeDesk said BET · probability 56\.0% · fair −127/.test(t) && /nfl_r2/.test(t) && /captured more than 90 minutes before the decision — not current at the time/.test(t)
  && /unit \$50\.00/.test(t) && /Two units &lt;b&gt;max/.test(h) && /Early entries/.test(t), t.slice(0, 1400));
chk('…and how long from saving to deciding, frozen', /3 h from saving to deciding/.test(t) && /frozen, never rewritten/.test(t));
chk('MARKET PATH: each price with its source, and a typed close stamped as recorded, not observed', /At your decision/.test(t) && /Your entry/.test(t) && /Close/.test(t) && /\(when it was recorded\)/.test(t)
  && /EdgeDesk, at your decision/.test(t), t);
chk('GRADE: the components, edge capture with what was kept, the outcome class and its meaning, limitations and methodology',
  /Closing line value 100 · Price quality 100 · Market structure 80/.test(t) && !/Sizing discipline/.test(t) && /kept 135%/.test(t) && /Good loss/.test(t) && /result went against a sound decision/.test(t) && /margin/.test(t) && /process_v1 · edge_capture_v1/.test(t));
chk('REFLECTION: every version, each saying whether the result was known', /before the result/.test(t) && /after the result \(LOSS\)/.test(t) && /Every version is kept/.test(t));
chk('FOLLOW-UP: the experiment it fell in and the pattern it belongs to; Ask about this decision is offered', /did not follow|followed the change/.test(t) && /NFL · Spread/.test(t) && /data-act="dr-ask"/.test(h));
chk('nothing the reader typed becomes markup', !/<img src=x|<b>max/.test(h) && /&lt;img src=x/.test(h));
chk('and the record never tells the reader what to do', !BANNED.test(t));

const bare = JSON.parse(JSON.stringify(REC));
bare.before = { snapshot: null, journal: null, card: [] }; bare.context_quality = 'RESULT_ONLY'; bare.market_path = [REC.market_path[1]];
bare.result = { status: 'WON', result: 'WIN' }; bare.grade = { process_score: null, grade: null, components: {}, edge_capture: { basis: 'NONE', limitations: ['NO_ENTRY_PRICE'] }, outcome: { class: 'NOT_CLASSIFIED', provisional: true } };
t = plain(J.decisionRecordView(bare));
chk('an imported, result-only record says EdgeDesk did not observe the decision, invents no path and no close, and is not classified from its result',
  /Result only/.test(t) && /did not observe this decision/.test(t) && /No other prices were observed/.test(t) && /No closing price recorded — closing line value is never estimated/.test(t)
  && /Not graded/.test(t) && /Not classified/.test(t) && /the result alone is not used/.test(t), t);

/* ═══ FROM THE CARD ══════════════════════════════════════════════════ */
const NOW = Date.parse('2026-10-05T03:00:00Z');
const card = { entry: { entry_id: 'ce_1', saved_at: '2026-10-05T00:00:00Z', captured_at: '2026-10-05T00:00:00Z', selection: 'Chiefs -3', american: -110, book: 'draftkings', kickoff: '2026-10-07T20:00:00Z' } };
t = plain(J.cardOriginNote(card, NOW));
chk('Record Position from the Card says where it came from and that a 3-hour-old price is not current', /From your Card/.test(t) && /captured 3 h ago; confirm the price at the book/.test(t) && /Record what you actually got/.test(t));
t = plain(J.cardOriginNote({ entry: Object.assign({}, card.entry, { captured_at: '2026-10-05T02:50:00Z' }) }, NOW));
chk('…a fresh one is not nagged', !/confirm the price/.test(t));
t = plain(J.cardOriginNote({ entry: Object.assign({}, card.entry, { kickoff: '2026-10-05T02:00:00Z' }) }, NOW));
chk('…and after the start it records the position, not a decision snapshot', /records the position, not a decision snapshot/.test(t));

/* ═══ PROCESS MEMORY, BASELINE, DEPTH ═══════════════════════════════ */
const mem = R.memoryItem({ insight: { id: 'i1', label: 'Live positions', kind: 'LEAK', metric: 'clv', dim: 'timing', key: 'LIVE', first_detected_at: '2026-08-01T00:00:00Z', methodology_version: 'insight_v1' },
  first: { grp: [30, -0.6, 0.05], comparison: [80, 0.8, 0.2] },
  latest: { observed_at: '2026-10-01T00:00:00Z', grp: [42, -0.62, 0.07], since_first: [12, 0.24, 0.02], before_first: [30, -0.6, 0.05], position_count: 42, excluded: { NO_CLOSING_PRICE: 3 }, confidence: 'MEDIUM', methodology_version: 'insight_v1' },
  observations: 4 });
t = plain(J.memoryLine(mem));
chk('process memory: FIRST DETECTED · THEN · NOW · STATUS, the status by test', /First detected 2026-08-01/.test(t) && /Then −2\.00%/.test(t) && /n=30/.test(t) && /Now \+2\.00%/.test(t) && /12 new/.test(t)
  && ['IMPROVING', 'UNCHANGED', 'DECLINED'].indexOf(mem.status) >= 0 && mem.test && mem.status === 'IMPROVING', { t, status: mem.status });
const why = J.whyItem('mem:i1', { memory: [mem] });
chk('its WHY gives the lineage: positions used, excluded and why, comparison, calculation, methodology', why && why.rows.some((r) => r[0] === 'Excluded' && /3 no closing price/.test(r[1]))
  && why.rows.some((r) => r[0] === 'Calculation' && /Welch/.test(r[1])) && why.rows.some((r) => r[0] === 'Methodology' && /insight_v1/.test(r[1])), why);
chk('too few new positions is INSUFFICIENT NEW EVIDENCE, never a guess', R.memoryItem({ insight: {}, first: { grp: [30, 1, 1] }, latest: { since_first: [4, 1, 1], before_first: [30, 1, 1], grp: [34, 1, 1] } }).status === 'INSUFFICIENT_NEW_EVIDENCE');
const bc = R.baselineChange({ status: 'FROZEN', n: 30, frozen_at: '2026-09-01T00:00:00Z', first_placed: '2026-06-01T00:00:00Z', last_placed: '2026-08-30T00:00:00Z',
  moments: { ps: [30, 1650, 92000], clv: [30, 0.3, 0.05] }, recent: { n: 14, moments: { ps: [14, 700, 35500], clv: [14, 0.14, 0.03] } } });
t = plain(J.baselineCard(bc));
chk('since your baseline: first 30 against those since, tested — not letter to letter', /Your first 30 graded decisions/.test(t) && /14 graded since/.test(t) && /Tested, not compared letter to letter/.test(t)
  && /95% interval/.test(t), t);
chk('a building baseline says how far, and is quiet at zero', /12 of 30 graded decisions/.test(plain(J.baselineCard({ status: 'BUILDING', n: 12 })))
  && J.baselineCard(R.baselineChange({ status: 'BUILDING', n: 0, needed: 30 })) === '');
chk('analysis depth at 10 / 30 / 100 names what becomes possible and never asks for more wagers', [0, 9, 10, 29, 30, 99, 100, 400].every((n) => {
  const s = plain(J.depthLine(R.depth(n))); return /Analysis depth/.test(s) && /not from placing more/.test(s) && !BANNED.test(s) && X.clean(s);
}));

/* ═══ QUESTIONS, EXPERIMENTS, ASK ═══════════════════════════════════ */
const qs = R.questions({ not_working: [{ id: 'x1', dim: 'timing', key: 'LIVE', metric: 'clv', metric_label: 'CLV', cell: { n: 31, mean: -0.02 }, comparison: { n: 90, mean: 0.01 } }] },
  [Object.assign({}, mem, { status: 'DECLINED' })], J.metricText);
chk('questions come from the reader\'s own evidence, each with its WHY, and are questions, not instructions',
  qs.length === 2 && qs.every((q) => /\?$/.test(q.text) && q.why) && /31 positions/.test(qs[0].text) && !qs.some((q) => BANNED.test(q.text) || !X.clean(q.text)), qs);
chk('the questions block says they are not instructions', /Questions, not instructions/.test(plain(J.questionsBlock(qs))));
const ev = { min_sample: 10, window: { moments: [24, 0.48, 0.03] }, baseline: { moments: [26, -0.13, 0.03] } };
const et = R.experimentTest(ev), ex2 = X.evaluateExperiment({ metric: 'CLV', min_sample: 10, status: 'ENDED', ends_at: '2026-01-01' },
  [{ dim: 'all', key: 'all', n: 24, clv_n: 24, clv_sum: 0.48, clv_sq: 0.03 }], [{ dim: 'all', key: 'all', n: 26, clv_n: 26, clv_sum: -0.13, clv_sq: 0.03 }]);
chk('an experiment\'s recorded result is the same pre-registered test the page shows (' + et.status + ')', et.status === ex2.status && et.payload.ci_lo != null, { et: et.status, ex2: ex2.status });
chk('…and below the pre-registered sample it is INCONCLUSIVE', R.experimentTest({ min_sample: 30, window: { moments: [24, 0.48, 0.03] }, baseline: { moments: [26, -0.13, 0.03] } }).status === 'INCONCLUSIVE');
const exH = plain(J.experimentsView([{ id: 'e1', title: 'Early', metric: 'CLV', status: 'ENDED', starts_at: '2026-08-01', ends_at: '2026-08-29', min_sample: 10, success_criteria: 'CLV above',
  conclusion: 'SUPPORTED', concluded_at: '2026-08-30', result: { window: { moments: [24, 0.48, 0.03] }, baseline: { moments: [26, -0.13, 0.03] }, test: { ci_lo: 0.01, ci_hi: 0.04 } }, result_methodology: 'experiment_v1' },
  { id: 'e2', title: 'Late', metric: 'PROCESS', status: 'ENDED', starts_at: '2026-08-01', ends_at: '2026-08-29', min_sample: 20 }], {}, {}));
chk('a concluded experiment shows its permanent result and asks for the reflection once; an ended one offers to record its result',
  /Concluded 2026-08-30: SUPPORTED/.test(exH) && /95% interval/.test(exH) && /Your reflection \(written once\)/.test(exH) && /Record the result/.test(exH) && /Success looks like: CLV above/.test(exH), exH.slice(0, 900));
const ans = R.explain(REC), at = ans.map((x) => x.h + '. ' + x.t).join(' ');
chk('Ask about this decision: every sentence from the record — before, entry, path, result, grade, and what it does not say', ans.map((x) => x.h).join('|') === 'Before|Entry|Market path|Result|Grade|What this does not say'
  && /56\.0% probability/.test(at) && /You entered at −105 \(-3\)/.test(at) && /2\.27% better than the price at your decision/.test(at) && /beat the close by 8\.47% of price/.test(at)
  && /Good loss/.test(at) && /One decision is not a pattern/.test(at) && /yours/.test(at), at);
chk('…and it never tells the reader what to do', !BANNED.test(at) && X.clean(at));
const bareAns = R.explain(bare).map((x) => x.t).join(' ');
chk('…nor fills in what was not recorded', /did not observe this decision/.test(bareAns) && /never estimated/.test(bareAns) && /No later prices were observed/.test(bareAns), bareAns);

/* ═══ YOUR DATA ═════════════════════════════════════════════════════ */
t = plain(J.privacyBlock({}));
chk('your data: download everything as data, or delete it — both on the page', /Download everything \(JSON\)/.test(t) && /Delete my Portfolio/.test(t) && /private to your account/.test(t));

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' decision record UI — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
