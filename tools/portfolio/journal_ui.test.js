#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_portfolio_journal_ui.js (and the server-driven views of
   lib/edgedesk_portfolio_ui.js) rendered in Node.

     - the Overview reads P&L, ROI, then the Decision Grade, then What's
       working / What's not — and an ungraded book shows no letter;
     - every claim carries a WHY with its data, sample, period, comparison,
       calculation, confidence and limits;
     - the calendar keeps entered / event / settled days apart;
     - a historical import says it has no pre-entry journal and invents none;
     - a recorded decision is shown locked, and the editor sends only what
       has not been recorded;
     - the journal files year → month → week → day and remembers its folders;
     - the Process Coach's pages render on real-shaped aggregates;
     - BEFORE YOU ENTER is context, never BET / DON'T BET / LOCK / GUARANTEED;
     - nothing the reader typed can become markup, and no rendered sentence
       uses a banned word.

   Run: node tools/portfolio/journal_ui.test.js
   =========================================================================== */
'use strict';
const path = require('path');
global.window = global;
const ROOT = path.join(__dirname, '..', '..');
const X = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_process.js'));
const J = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_journal_ui.js'));
const U = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_ui.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const XSS = '<img src=x onerror=alert(1)>';
const VERDICT = /\b(BET NOW|DON'?T BET|LOCK|GUARANTEED)\b|\bBET\b/;

/* ── real-shaped aggregates (portfolio_summary / portfolio_cells) ─────── */
function cell(dim, key, values) {
  const m = (vs) => [vs.length, vs.reduce((s, v) => s + v, 0), vs.reduce((s, v) => s + v * v, 0)];
  const seg = (lo, hi) => { const part = values.slice(Math.floor(values.length * lo), Math.floor(values.length * hi)); return [].concat(m(part.map((v) => v.ret)), m(part.map((v) => v.clv)), m(part.map((v) => v.ps))); };
  const [psn, pss, psq] = m(values.map((v) => v.ps)), [cn, cs, cq] = m(values.map((v) => v.clv)), [rn, rs, rq] = m(values.map((v) => v.ret));
  const wins = values.filter((v) => v.ret > 0).length;
  return { dim, key, n: values.length, settled: rn, wins, losses: rn - wins, staked: values.length * 100, pnl: (rs * 100).toFixed(2), ret_n: rn, ret_sum: rs, ret_sq: rq,
    clv_n: cn, clv_sum: cs, clv_sq: cq, ps_n: psn, ps_sum: pss, ps_sq: psq, units_n: 0, units_sum: 0, segs: { h1: seg(0, 0.5), h2: seg(0.5, 1), ho: seg(0.7, 1) } };
}
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const population = (n, mu) => Array.from({ length: n }, () => ({ ps: mu.ps + 12 * gauss(), clv: mu.clv + 0.03 * gauss(), ret: mu.ret + 0.9 * gauss() }));
const weak = population(140, { ps: 48, clv: -0.02, ret: -0.08 }), rest = population(260, { ps: 63, clv: 0.012, ret: -0.02 });
const CELLS = [cell('all', 'all', weak.concat(rest)), cell('sport_type', 'CFB · SPREAD', weak), cell('sport_type', 'NFL · SPREAD', rest),
  cell('platform_type', 'SPORTSBOOK', weak.concat(rest.slice(0, 200))), cell('platform_type', 'PREDICTION_MARKET', rest.slice(200)),
  cell('timing', 'H1_6', rest.slice(0, 120)), cell('timing', 'D1_3', weak.concat(rest.slice(120))), cell('placed_dow', '6', rest.slice(0, 50)),
  cell('decision_source', 'EDGEDESK', rest.slice(0, 90)), cell('tag', 'MODEL', rest.slice(0, 60))];
const ANALYSIS = X.analyze(CELLS, { period: 'last 30 days' });
const SUM = {
  tz: 'America/New_York',
  settled: { n: 400, pnl: '-1520.50', staked: '40000', roi: '-0.038013', wins: 190, losses: 205, pushes: 5, cashouts: 0,
    sportsbook: { n: 340, pnl: '-1600.00', staked: '34000' }, prediction: { n: 60, pnl: '79.50', staked: '6000' } },
  placed: { n: 410, staked: '41000', days: 30, units: '410', units_n: 410 },
  process: { n: 410, graded: 380, score: '58.2', letter: 'C+', confidence: 'HIGH', coverage: '71.4', ps_sum: 22116, ps_sq: 1340000,
    components: { clv: { n: 350, avg: '57.1' }, model: { n: 120, avg: '61.0' }, price: { n: 0, avg: null }, sizing: { n: 380, avg: '88.0' },
      timing: { n: 40, avg: '49.5' }, rules: { n: 200, avg: '94.0' }, market: { n: 410, avg: '72.0' } },
    clv: { n: 350, avg_pct: '0.0042', sum: 1.47, sq: 0.4, beat: 190, with_close: 350, points_n: 0, avg_points: null },
    model_ev: { n: 120, avg: '0.021' }, price_slip: { n: 0, given_up: '0' }, rules: { applicable: 600, followed: 570, positions_broken: 22 },
    tagged: 80, reviewed: 12, variance: { n: 395, wins: 190, expected_wins: '198.4', var: '98.1' } },
  matrix: { 'GOOD:WIN': { n: 80, pnl: '6100' }, 'GOOD:LOSS': { n: 70, pnl: '-7000' }, 'POOR:WIN': { n: 30, pnl: '2400' }, 'POOR:LOSS': { n: 60, pnl: '-6000' },
    'AVERAGE:WIN': { n: 80, pnl: '6000' }, 'AVERAGE:LOSS': { n: 75, pnl: '-7500' }, 'UNGRADED:OPEN': { n: 10, pnl: null } },
  open: { n: 10, exposure: '1000', unrealized: null, marked: 0 }, evidence: { full: 120, partial: 260, result_only: 30 },
  platforms: [{ platform: 'draftkings', label: 'DraftKings', platform_type: 'SPORTSBOOK', n: 340, pnl: '-1600.00', staked: '34000' },
    { platform: 'kalshi', label: 'Kalshi', platform_type: 'PREDICTION_MARKET', n: 60, pnl: '79.50', staked: '6000' }]
};
const ACCTS = [{ platform: 'draftkings', platform_label: 'DraftKings' }, { platform: 'evil', platform_label: XSS }];
const ROW = (o) => Object.assign({ id: 'a1', platform: 'draftkings', platform_label: 'DraftKings', platform_type: 'SPORTSBOOK', position_type: 'SPREAD', sport: 'NFL',
  event_name: 'Chiefs @ Bills', selection: 'Chiefs -2.5', odds_american: -110, stake_amt: '100', units: '1', status: 'LOST', result: 'LOSS', pnl: '-100.00',
  source: 'MANUAL', evidence: 'PARTIAL_CONTEXT', timing_bucket: 'H1_6', process_score: '97.1', grade: 'A+', clv_pct: '0.079052', model_ev: null,
  placed_day: '2026-09-07', settled_day: '2026-09-07', event_day: '2026-09-07', stake_type: 'CASH', rules_broken: [], journal: {} }, o);
const rendered = [];

/* ═══ THE DECISION GRADE ════════════════════════════════════════════════ */
let h = J.gradeCard({ n: 7, graded: 0, components: {} }), t = strip(h);
rendered.push(h);
chk('an ungraded book shows no letter and says what would grade it', /Not graded yet/.test(t) && /closing price/.test(t) && !/process score/.test(t), t);
h = J.gradeCard(SUM.process, { evidence: SUM.evidence }); t = strip(h);
rendered.push(h);
chk('a graded book: letter, score, how many graded, confidence', /C\+/.test(t) && /58\.2 \/ 100 process score/.test(t) && /380 of 410 positions graded/.test(t) && /confidence HIGH/.test(t), t.slice(0, 300));
chk('…graded on the decision, never on whether it won', /never on whether it won/.test(t));
chk('…every component with its weight, and "not recorded" — never a guess — where there is no data',
  /Closing line value 30%/.test(t) && /Price quality 15% not recorded/.test(t) && (t.match(/n=\d+/g) || []).length === 6, t);
chk('…and what EdgeDesk knows: full / partial / result only, and result-only is never graded', /120 full context/.test(t) && /260 partial/.test(t) && /30 result only/.test(t) && /never graded/.test(t));
chk('the grade has a WHY', /data-act="why" data-id="grade"/.test(h));
const gw = strip(J.whyPanel(J.GRADE_WHY));
chk('the grade\'s WHY: what it measures, weights, missing data, when graded, pre-event only, letters, confidence, limits',
  ['What it measures', 'Components and weights', 'Missing data', 'When a position is graded', 'Pre-event only', 'Letters', 'Confidence', 'Limitations'].every((k) => gw.indexOf(k) >= 0), gw);

/* ═══ WHAT'S WORKING / WHAT'S NOT ═══════════════════════════════════════ */
const hl = X.headlines(ANALYSIS);
h = J.insights(hl); t = strip(h);
rendered.push(h);
const leak = ANALYSIS.findings.find((f) => f.kind === 'LEAK' && f.key === 'CFB · SPREAD');
chk('a supported leak is listed under What\'s not, with its evidence level', leak && /What's not/.test(t) && t.indexOf(leak.headline) > t.indexOf('What\'s not'), leak && leak.headline);
chk('every finding has a WHY and a way to list its positions', leak && h.indexOf('data-act="why" data-id="f:' + leak.id + '"') >= 0 && /data-act="drill" data-dim="sport_type" data-key="CFB · SPREAD"/.test(h));
const fw = strip(J.whyPanel(leak));
chk('a finding\'s WHY names data used, sample, date range, comparison, methodology, confidence, limitations',
  ['Data used', 'Sample size', 'Date range', 'Comparison group', 'Methodology', 'Confidence', 'Limitations'].every((k) => fw.indexOf(k) >= 0) && /last 30 days/.test(fw), fw.slice(0, 400));
chk('…and the group\'s own positions, P&L, ROI and CLV, from its cell — CLV only over positions with a closing price',
  ['Positions', 'P&L', 'ROI', 'CLV'].every((k) => fw.indexOf(k) >= 0) && /positions in the group, \d+ settled/.test(fw) && /(with a closing price|No closing price is recorded)/.test(fw), fw);
const noClv = strip(J.whyPanel(Object.assign({}, leak, { why: Object.assign({}, leak.why, { group: { positions: 12, settled: 0, pnl: '0', staked: '0', clv_n: 0, clv_mean: null } }) })));
chk('a group with nothing settled and no closing prices says so, inventing neither', /n\/a — nothing in the group has settled/.test(noClv) && /No closing price is recorded for these positions/.test(noClv));
h = J.insights(X.headlines(X.analyze([cell('all', 'all', population(12, { ps: 60, clv: 0, ret: 0 }))], {})));
chk('with too little data: NO RELIABLE LEAK DETECTED, and how much more data it needs', /NO RELIABLE LEAK DETECTED/.test(strip(h)) && /more positions would let most groups qualify/.test(strip(h)));
rendered.push(h);

/* ═══ THE OVERVIEW, FROM THE SERVER ═════════════════════════════════════ */
const S = Object.assign(U.defaults(), { positions: [{ id: 'x' }], accounts: ACCTS, sum: SUM, cells: CELLS, analysis: ANALYSIS, period: '30D', tz: 'America/New_York' });
h = U.render.overviewServer(S); t = strip(h);
rendered.push(h);
const at = (re) => t.search(re);
chk('the Overview order: Total P&L, ROI, the Decision Grade, then What\'s working / What\'s not',
  at(/Total P&L/) >= 0 && at(/Total P&L/) < at(/ROI/) && at(/ROI/) < at(/Decision Grade/) && at(/Decision Grade/) < at(/What's working/) && at(/What's working/) < at(/What's not/), [at(/Total P&L/), at(/ROI/), at(/Decision Grade/), at(/What's working/)]);
chk('P&L is by settlement date for the period, with sportsbook and prediction-market P&L apart',
  /Total P&L · last 30 days · by settlement date/.test(t) && /−\$1,520\.50/.test(t) && /Sportsbook P&L −\$1,600\.00/.test(t) && /Prediction-market P&L \+\$79\.50/.test(t), t.slice(0, 500));
chk('one combined book, with a platform filter — and an account name cannot become markup', /data-act="platform" data-v="type:SPORTSBOOK"/.test(h) && h.indexOf(XSS) < 0 && h.indexOf('&lt;img') >= 0);
chk('an empty book still shows the empty state, not zeros dressed as a dashboard',
  /Build your portfolio/.test(strip(U.render.overviewServer(Object.assign({}, S, { positions: [], sum: Object.assign({}, SUM, { settled: { n: 0 }, open: { n: 0 } }) })))));
h = U.render.analyticsServer(S); t = strip(h);
rendered.push(h);
chk('Analytics: sportsbook · prediction market · combined, then breakdowns that each carry their sample', /Sportsbook · prediction market · combined/.test(t) && /Win rate/.test(t) && /By timing/.test(t) && /n=\d+/.test(t), t.slice(0, 400));
chk('…and every breakdown row drills into its positions', /data-act="drill" data-dim="timing" data-key="H1_6"/.test(h));

/* ═══ THE CALENDAR ══════════════════════════════════════════════════════ */
const days = [{ day: '2026-09-07', placed: 2, events: 1, settled: 2, pnl: '-40.00' }, { day: '2026-09-20', placed: 0, events: 0, settled: 1, pnl: '38.50' }, { day: '2026-09-09', placed: 0, events: 3, settled: 0, pnl: null }];
chk('September 2026 starts on a Tuesday: one blank before the 1st', J.monthDays('2026-09')[0] === null && J.monthDays('2026-09')[1] === '2026-09-01' && J.monthDays('2026-09').length % 7 === 0);
h = J.calendarView({ month: '2026-09', basis: 'placed', view: 'month', days, tz: 'America/New_York' }); t = strip(h);
rendered.push(h);
chk('by entry day: what was entered, and the P&L on the day it settled', /2 in/.test(t) && /−\$40\.00/.test(t) && /\+\$38\.50/.test(t) && !/3 ev/.test(t) && /America\/New_York/.test(t));
h = J.calendarView({ month: '2026-09', basis: 'settled', view: 'month', days }); t = strip(h);
chk('by settlement day: only the P&L that settled', !/\d in\b/.test(t) && /−\$40\.00/.test(t));
h = J.calendarView({ month: '2026-09', basis: 'event', view: 'month', days }); t = strip(h);
chk('by event day: the events, not the P&L', /3 ev/.test(t) && !/−\$40\.00/.test(t));
h = J.calendarView({ month: '2026-09', basis: 'placed', view: 'week', selected: '2026-09-09', days, dayList: [] });
chk('the week view is the seven days around the selected day, Monday first', (h.match(/data-act="cal-day"/g) || []).length === 7 && /data-v="2026-09-07"/.test(h) && /data-v="2026-09-13"/.test(h));
chk('each day cell names its counts for a screen reader', /aria-label="Mon Sep 7, 2026: 2 entered, 1 events, 2 settled, P&amp;L −\$40\.00"/.test(J.calendarView({ month: '2026-09', basis: 'placed', days })));
const dw = days.map((d) => Object.assign({ wins: 0, losses: 0, pushes: 0 }, d));
dw[0].wins = 1; dw[0].losses = 1; dw[1].wins = 1;
t = strip(J.calendarView({ month: '2026-09', basis: 'placed', view: 'month', days: dw }));
chk('the month line: what settled in it, exactly, with the record and the up and down days', /Settled in September −\$1\.50 · 3 positions · 2-1-0 · 1 up \/ 1 down days/.test(t), t.slice(0, 400));
chk('a month with nothing settled says so', /Nothing settled in October 2026\./.test(strip(J.calendarView({ month: '2026-10', basis: 'placed', view: 'month', days: [] }))));
chk('the month line counts only the month on screen (a week view can load days around it)', J.monthSettled(dw.concat([{ day: '2026-10-01', settled: 4, pnl: '500', wins: 4 }]), '2026-09').pnl === '-1.5');
h = J.calendarView({ month: '2026-10', basis: 'placed', view: 'month', days: [], loading: true }); t = strip(h);
chk('while a month loads, its heading, arrows and grid stay, marked busy', /October 2026/.test(t) && (h.match(/data-act="cal-move"/g) || []).length === 2 && /class="pfo-cal" role="grid" aria-label="October 2026" aria-busy="true"/.test(h)
  && /Loading October 2026…/.test(t) && !/Nothing settled/.test(t));
h = J.calendarView({ month: '2026-09', basis: 'settled', view: 'month', days: dw });
chk('a cell carries the exact P&L and, for a phone, a short one that is never an ellipsis', /<span class="pfo-cal-full">−\$40\.00<\/span><span class="pfo-cal-short" aria-hidden="true">−\$40<\/span>/.test(h));
chk('short amounts: cents under a dollar, dollars, then thousands', JSON.stringify(['0', '0.4', '45.2', '-999.4', '999.6', '1234.5', '-12345', '999960', '-0.001'].map(J.compactMoney))
  === JSON.stringify(['$0', '+$0.40', '+$45', '−$999', '+$1k', '+$1.2k', '−$12k', '+$1M', '<$0.01']));
const CSS = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'lib', 'edgedesk_portfolio.css'), 'utf8');
chk('a phone shows the short amount and a wider screen the exact one', /\.pfo-cal-short\{display:none\}/.test(CSS) && /@media\(max-width:420px\)\{[^@]*\.pfo-cal-full\{display:none\}\.pfo-cal-short\{display:inline\}/.test(CSS));
h = J.dayDetail('2026-09-07', [ROW(), ROW({ id: 'a2', placed_day: '2026-09-05', settled_day: '2026-09-07', event_day: '2026-09-07', pnl: '60.00', status: 'WON', event_name: 'Jets @ Giants' })], 'placed'); t = strip(h);
rendered.push(h);
chk('a day groups what was entered, the events, and what settled, with the settled P&L', /Entered this day 1/.test(t) && /Events this day 2/.test(t) && /Settled this day 2 · −\$40\.00/.test(t), t.slice(0, 300));

/* ═══ ONE POSITION'S JOURNAL ════════════════════════════════════════════ */
h = J.journalCard(ROW({ event_name: XSS, selection: XSS, journal: { thesis: XSS } }));
chk('nothing the reader typed becomes markup', h.indexOf('<img') < 0 && (h.match(/&lt;img/g) || []).length === 3);
h = J.journalCard(ROW({ source: 'CSV', evidence: 'RESULT_ONLY', process_score: null }));
rendered.push(h);
chk('an imported bet: "Historical import · No pre-entry journal available." — and nothing invented', /Historical import · No pre-entry journal available\./.test(strip(h)) && !/PLANNED|Process/.test(strip(h)));
chk('a manual bet with no journal does not claim to be an import', !/Historical import/.test(strip(J.journalCard(ROW({ evidence: 'RESULT_ONLY', process_score: null })))));
t = strip(J.journalCard(ROW({ stake_type: 'BONUS', rules_broken: ['No position larger than 1 units'], journal: { planned: true, decision_tags: ['MODEL'], thesis: 'Number is -140', would_repeat: 'YES' } })));
chk('the card shows the process, CLV, bonus stake, tags, thesis, rules broken and the review',
  /Process 97\.1 \(A\+\)/.test(t) && /CLV \+7\.91%/.test(t) && /Bonus bet/.test(t) && /PLANNED/.test(t) && /Number is -140/.test(t) && /Outside your rule: No position larger than 1 units/.test(t) && /Would make it again/.test(t), t);
const J0 = { closing_odds_american: -130, closing_recorded_at: '2026-09-07T20:00:00Z', closing_source: 'USER', model_probability: '0.55', model_recorded_at: '2026-09-07T12:00:00Z', planned: false };
h = J.journalEditor(J0, ROW()); t = strip(h);
rendered.push(h);
chk('recorded values are shown locked, with when, and "never rewritten"', /-130 recorded 2026-09-07 20:00 — never rewritten/.test(t) && /0\.55 recorded 2026-09-07 12:00/.test(t) && /UNPLANNED/.test(t), t.slice(0, 600));
chk('…and have no input to change them', !/name="closing_odds_american"/.test(h) && !/name="model_probability"/.test(h) && !/name="planned"/.test(h));
chk('what is not recorded can be recorded once; a sportsbook editor shows no contract-price fields', /name="research_odds_american"/.test(h) && /name="closing_line"/.test(h) && !/name="closing_price"/.test(h) && /name="tag:MODEL"/.test(h));
chk('a prediction-market editor asks for contract prices, not American odds', /name="closing_price"/.test(J.journalEditor({}, ROW({ platform_type: 'PREDICTION_MARKET' }))) && !/name="closing_odds_american"/.test(J.journalEditor({}, ROW({ platform_type: 'PREDICTION_MARKET' }))));
let patch = J.journalPatch({ closing_odds_american: '-105', research_odds_american: '-105', thesis: '  ', 'tag:MODEL': true, 'tag:LIVE_READ': false, would_repeat: 'NO', library: 'MISTAKE', review_note: 'Too late.' }, J0);
chk('the editor sends only what is new: never a recorded field, never a blank', patch.closing_odds_american === undefined && patch.research_odds_american === '-105' && patch.thesis === undefined
  && JSON.stringify(patch.decision_tags) === '["MODEL"]' && patch.would_repeat === 'NO' && patch.library === 'MISTAKE' && patch.review_note === 'Too late.', patch);
chk('the review stays editable: clearing it sends null', J.journalPatch({ review_note: '' }, { review_note: 'old' }).review_note === null && J.journalPatch({ review_note: 'old' }, { review_note: 'old' }).review_note === undefined);
chk('bad entries are named, not stored', J.journalIssues({ closing_odds_american: '-50' }).length === 1 && J.journalIssues({ closing_price: '1.4' }).length === 1
  && J.journalIssues({ model_probability: '55' }).length === 1 && J.journalIssues({ closing_line: 'abc' }).length === 1 && J.journalIssues({ closing_odds_american: '+150', closing_price: '0.4', model_probability: '0.55' }).length === 0);

/* ═══ THE JOURNAL'S FOLDERS ═════════════════════════════════════════════ */
const top = [{ level: 'year', year: 2026, placed: 5, settled: 4, pnl: '-23.50', wins: 2, losses: 2, process: '97.1', graded: 1 }, { level: 'year', year: 2025, placed: 1, settled: 1, pnl: '10.00' }];
const yr = [{ level: 'month', year: 2026, month: 9, placed: 4, settled: 4, pnl: '-23.50' }, { level: 'week', year: 2026, month: 9, week: '2026-09-07', placed: 3, settled: 3, pnl: '-62.00' },
  { level: 'day', year: 2026, month: 9, week: '2026-09-07', day: '2026-09-07', placed: 2, settled: 2, pnl: '-40.00' }];
h = J.journalView({ top, tz: 'UTC' }); t = strip(h);
chk('years first, newest as given, with their totals', /2026 5 entered · 4 settled · −\$23\.50 · 2–2 · process 97\.1 n=1/.test(t) && /2025/.test(t) && !/September/.test(t), t);
h = J.journalView({ top, openYear: 2026, yearRows: yr, opened: { 'm:2026-9': true } });
chk('an open year shows months → weeks → days, and a folder the reader opened stays open', /data-r="fold" data-v="m:2026-9"/.test(h) && /<details class="pfo-fold" open data-r="fold" data-v="m:2026-9"/.test(h)
  && /data-v="w:2026-9:2026-09-07"/.test(h) && !/open data-r="fold" data-v="w:/.test(h) && /data-act="journal-day" data-v="2026-09-07"/.test(h));
chk('an empty journal says so plainly', /No history yet/.test(strip(J.journalView({ top: [] }))));

/* ═══ PROCESS: what matters first, the reports behind it ═══════════════ */
const NOW = Date.parse('2026-09-15T12:00:00Z');
const EXPS = [{ id: 'e1', title: 'Enter a day early', hypothesis: 'CLV improves', metric: 'CLV', starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-09-29T00:00:00Z', min_sample: 20, status: 'ACTIVE' }];
const EXPR = { e1: X.evaluateExperiment(EXPS[0], [], []) };
const pst = (sub, extra) => Object.assign({ sub, summary: SUM, cells: CELLS, analysis: ANALYSIS, filter: { chips: [] }, now: NOW, experiments: EXPS, expResults: EXPR }, extra || {});
const BUILDING = Object.assign({}, SUM, { process: Object.assign({}, SUM.process, { n: 7, graded: 1, score: '81.0', letter: 'A-', confidence: 'BUILDING',
  components: { clv: { n: 1, avg: '80' }, model: { n: 0, avg: null }, price: { n: 1, avg: '90' }, sizing: { n: 0, avg: null }, timing: { n: 0, avg: null }, rules: { n: 0, avg: null }, market: { n: 1, avg: '80' } } }) });

/* 1. three places, not eight */
h = J.processView(pst('overview')); t = strip(h);
rendered.push(h);
const navHtml = h.slice(h.indexOf('<nav class="pcx-nav"'), h.indexOf('</nav>', h.indexOf('<nav class="pcx-nav"')));
chk('Process navigation is Overview · Film Room · Explore — nothing else is peer-level', (navHtml.match(/data-act="coach"/g) || []).length === 3
  && /data-v="overview" aria-current="page">Overview/.test(navHtml) && /data-v="film"/.test(navHtml) && /data-v="explore"/.test(navHtml) && !/data-v="leaks"/.test(navHtml));
chk('one Filter control, "All activity" until a filter is applied, and no chip rows on the page', /data-act="filter-open"/.test(h) && /All activity/.test(t)
  && !/pfo-plats/.test(h) && !/data-act="platform"/.test(h) && !/data-act="period"/.test(h));
const chipped = J.processView(pst('overview', { filter: { chips: [{ k: 'platform', label: 'Sportsbooks' }, { k: 'period', label: 'Last 30 days' }] } }));
chk('applied filters show as compact chips, each removable', /data-act="filter-clear" data-v="platform"[^>]*>Sportsbooks/.test(chipped) && /data-act="filter-clear" data-v="period"/.test(chipped)
  && !/All activity/.test(strip(chipped)) && /Filter <span class="pcx-count">2/.test(chipped));
const sheetH = J.filterSheet({ source: 'SPORTSBOOK', platform: '', period: 'CUSTOM', from: '2026-09-01', to: '2026-09-30' },
  [{ key: 'draftkings', label: 'DraftKings', type: 'SPORTSBOOK' }, { key: 'kalshi', label: 'Kalshi', type: 'PREDICTION_MARKET' }, { key: 'evil', label: XSS, type: 'SPORTSBOOK' }]);
chk('inside Filter: source type, the platforms of that type, and time with a custom range', /Source type/.test(sheetH) && /value="SPORTSBOOK" data-f="filter" checked/.test(sheetH)
  && /DraftKings/.test(sheetH) && !/Kalshi/.test(sheetH) && /Last 7 days[\s\S]*Last 30 days[\s\S]*This year[\s\S]*All time[\s\S]*Custom/.test(strip(sheetH))
  && /name="from" value="2026-09-01"/.test(sheetH) && sheetH.indexOf(XSS) < 0);

/* 2. how is my process? */
chk('the Overview answers first: Process score and letter, its sample and confidence', /How is my process\? Process score 58 C\+/.test(t) && /380 graded positions of 410 · confidence High/.test(t), t.slice(0, 300));
chk('dimension grades only where a dimension has 10 graded positions — never a letter for price quality on 0', /Timing C /.test(t) && /Sizing A /.test(t) && /Rule discipline A\+/.test(t)
  && !/Price quality [A-F]/.test(t) && /Price quality 0\/10 graded — each dimension is graded from 10/.test(t), t.slice(0, 500));
chk('every grade on the Overview has its WHY', ['score', 'dim:timing', 'dim:sizing', 'dim:rules'].every((k) => h.indexOf('data-act="why" data-id="' + k + '"') >= 0) && h.indexOf('data-id="dim:price"') < 0);
h = J.processView(pst('overview', { summary: BUILDING })); t = strip(h);
rendered.push(h);
chk('with too few graded positions: PROCESS PROFILE · BUILDING, the count, and the engine\'s own threshold — no score, no letter',
  /Process profile Building/.test(t) && /1 eligible position of 7 in this period/.test(t) && /from 10 graded positions/.test(t) && !/Process score/.test(strip(h.slice(0, h.indexOf('</section>')))) && !/pcx-letter/.test(h.slice(0, h.indexOf('</section>'))) && !/n=0/.test(strip(h.slice(0, h.indexOf('</section>')))), t.slice(0, 500));
chk('a dimension under 10 shows its progress, not a grade', /Price quality 1\/10/.test(t) && !/Price quality A/.test(t));

/* 3–4. what is working, what needs attention — from evidence, never an instruction */
h = J.processView(pst('overview')); t = strip(h);
const good = X.headlines(ANALYSIS, { limit: 1 }).working[0], bad = X.headlines(ANALYSIS, { limit: 1 }).not_working[0];
chk('WHAT\'S WORKING: the strongest supported pattern, its process grade, positions and average CLV', good && /What's working NFL · Spread/.test(t) && /Process grade B− Positions 260 Avg CLV \+1\.\d\d% n=260/.test(t), t.slice(t.indexOf('What\'s working'), t.indexOf('What\'s working') + 260));
chk('NEEDS ATTENTION: the weakest, the same way', bad && /Needs attention CFB · Spread/.test(t) && /Process grade C Positions 140 Avg CLV −1\.\d\d% n=140/.test(t));
chk('each pattern has its WHY and its positions', h.indexOf('data-id="f:' + good.id + '"') >= 0 && h.indexOf('data-id="f:' + bad.id + '"') >= 0 && /data-act="drill" data-dim="sport_type" data-key="CFB · SPREAD">See the 140 positions/.test(h));
chk('no wagering instruction anywhere on the Overview', !/stop betting|don'?t bet|bet earlier|avoid betting|bet more|bet less/i.test(t));
const noPat = strip(J.processView(pst('overview', { cells: [cell('all', 'all', population(12, { ps: 60, clv: 0, ret: 0 }))], analysis: X.analyze([cell('all', 'all', population(12, { ps: 60, clv: 0, ret: 0 }))], {}) })));
chk('with no pattern strong enough, one quiet line instead of empty cards — and how much more data it needs', /No pattern is strong enough to call yet/.test(noPat) && /more positions would let most groups qualify/.test(noPat)
  && !/What's working NFL/.test(noPat));

/* 5. the current experiment, or a focus to measure */
chk('CURRENT EXPERIMENT: its title, week of its length, during against before, and that it never promises a result', /Current experiment Enter a day early/.test(t) && /Week 3 of 4 · measured on closing line value/.test(t)
  && /During — n=0 Before — n=0/.test(t) && /Needs more positions: 0 during and 0 before; each side needs 20/.test(t) && /never promises a result/.test(t) && /data-act="coach" data-v="experiments">View experiment/.test(h) && /data-id="exp:e1"/.test(h));
h = J.processView(pst('overview', { experiments: [] })); t = strip(h);
chk('no experiment running: CURRENT FOCUS proposes something to measure, from the weakest pattern — the decision stays the reader\'s',
  /Current focus CFB · Spread/.test(t) && /Something to measure, not an instruction/.test(t) && /What you change is your decision/.test(t) && /data-act="exp-setup" data-v="CFB · Spread" data-metric="PROCESS"/.test(h)
  && !/don'?t bet|bet earlier|stop/i.test(t));

/* 6. Explore: the depth, one step down */
h = J.processView(pst('explore', { rules: [] })); t = strip(h);
rendered.push(h);
chk('EXPLORE lists the reports with a figure each: Leaks, Strengths, Timing, Edge capture, Rules, Experiments, Process vs outcome',
  ['leaks', 'strengths', 'timing', 'edge', 'rules', 'experiments', 'outcome'].every((k) => h.indexOf('data-act="coach" data-v="' + k + '"') >= 0)
  && /Edge capture .*Avg CLV \+0\.42% · n=350/.test(t) && /Rules .*570 of 600 checks kept/.test(t) && /Process vs outcome .*30 bad wins · 70 good losses/.test(t) && /Experiments .*1 running/.test(t), t.slice(0, 900));
chk('Explore is the current place in the nav while a report is open', /data-v="explore" aria-current="page"/.test(J.processView(pst('leaks'))));
const CMP = X.compare(SUM, Object.assign({}, SUM, { process: Object.assign({}, SUM.process, { ps_sum: 20000 }) }));
for (const sub of ['leaks', 'strengths', 'timing', 'edge', 'outcome']) {
  const hh = J.processView(pst(sub, { compare: CMP })); rendered.push(hh);
  chk('Explore › ' + sub + ' renders with its way back, and its WHY', /data-act="coach" data-v="explore">‹ Explore/.test(hh) && /data-act="why"/.test(hh) && strip(hh).length > 300, strip(hh).slice(0, 200));
}
chk('Leaks names the tests it ran and corrects for them', /pre-specified comparisons only \(\d+ tests/i.test(strip(J.processView(pst('leaks')))) && /CFB · Spread/.test(strip(J.processView(pst('leaks')))));
chk('Edge capture: model edge, CLV, beat-the-close, and the capture rate labelled an estimate',
  /Model edge at entry \+2\.10%/.test(strip(J.processView(pst('edge')))) && /190 of 350/.test(strip(J.processView(pst('edge')))) && /An estimate/.test(strip(J.processView(pst('edge')))));
h = J.processView(pst('outcome', { compare: CMP })); t = strip(h);
chk('Process vs outcome keeps the matrix with its bad wins and good losses, the variance and the change since last period',
  /30 bad wins/.test(t) && /70 good losses/.test(t) && /the prices you took implied 198\.4/.test(t) && /Last 30 days vs the 30 before/.test(t) && /data-act="matrix" data-process="POOR" data-result="WIN"/.test(h));
h = J.processView(pst('rules', { rules: [{ id: 'r1', label: XSS, active_from: '2026-09-01T00:00:00Z' }, { id: 'r2', label: 'No live positions', active_from: '2026-08-01', active_until: '2026-09-01T00:00:00Z' }] })); t = strip(h);
rendered.push(h);
chk('Rules: adherence this period, retire an active rule, history of retired ones', /570 of 600 rule checks followed/.test(t) && /data-act="rule-retire" data-id="r1"/.test(h) && !/data-act="rule-retire" data-id="r2"/.test(h) && /retired 2026-09-01/.test(t) && h.indexOf(XSS) < 0);
chk('a rule is built from the form, or refused with a reason', J.ruleFromForm({ kind: 'MAX_STAKE_UNITS', a: '2' }).row.label === 'No position larger than 2 units'
  && !!J.ruleFromForm({ kind: 'MAX_STAKE_UNITS', a: '' }).error && JSON.stringify(J.ruleFromForm({ kind: 'ONLY_SPORTS', b: 'nfl, cfb' }).row.params) === '{"sports":["NFL","CFB"]}'
  && !!J.ruleFromForm({ kind: 'ODDS_BETWEEN' }).error && !!J.ruleFromForm({ kind: 'NOPE' }).error);
h = J.processView(pst('experiments', { expDraft: { title: 'Focus: CFB · Spread', hypothesis: 'My process score improves', metric: 'PROCESS' } })); t = strip(h);
rendered.push(h);
chk('Experiments: what is measured and for how long, "not enough positions yet" rather than a guess, and each result\'s WHY', /Measured on closing line value · 2026-09-01 to 2026-09-29 · at least 20 positions each side/.test(t) && /Not enough positions yet/.test(t) && /data-act="exp-end"/.test(h) && /data-id="exp:e1"/.test(h));
chk('a focus carried into the form: prefilled, still the reader\'s to edit or start', /name="title" maxlength="120" value="Focus: CFB · Spread"/.test(h) && /<option value="PROCESS" selected>/.test(h));

/* 7–13. the Film Room */
const W = (o) => Object.assign({}, SUM, o);
const proc = (o) => Object.assign({}, SUM.process, o);
const FILM = { week: '2026-09-07', summary: SUM, prior: SUM,
  best: [ROW({ id: 'g1', selection: 'Iowa +7.5', process_score: '91.0', grade: 'A+' })], worst: [ROW({ id: 'p1', selection: 'Over 47.5', process_score: '31.0', grade: 'D', clv_pct: '-0.012' })],
  badWins: [ROW({ id: 'bw', selection: 'Chiefs -7', status: 'WON', result: 'WIN', pnl: '90.91', process_score: '33.0', grade: 'D', clv_pct: null, clv_points: '-3', line: '-7',
    journal: { closing_line: '-4' }, s_price: '28', s_timing: '35', s_sizing: '100' })],
  goodLosses: [ROW({ id: 'gl', selection: 'Iowa +7.5', status: 'LOST', result: 'LOSS', pnl: '-100.00', process_score: '86.0', grade: 'A', clv_pct: null, clv_points: '2.5', line: '7.5',
    journal: { closing_line: '5' }, s_price: '100', s_timing: '92' })],
  broken: [ROW({ id: 'rb' })],
  settledList: [ROW({ id: 'bw', selection: 'Chiefs -7', status: 'WON', result: 'WIN', pnl: '90.91', grade: 'D', journal: { thesis: 'Line value after the injury news' } }), ROW({ id: 'gl', selection: 'Iowa +7.5', grade: 'A', journal: {} }),
    ROW({ id: 'r3', journal: { would_repeat: 'YES', review_note: 'Same again' } })] };
h = J.processView(pst('film', { film: FILM })); t = strip(h);
rendered.push(h);
chk('FILM ROOM leads with the week: result, process grade, rules followed, average CLV', /Film Room Week of Sep 7–13/.test(t) && /Financial result −\$1,520\.50 400 settled positions/.test(t)
  && /Process grade C\+ 380 graded/.test(t) && /Rules followed 570 \/ 600/.test(t) && /Avg CLV \+0\.42% n=350/.test(t), t.slice(0, 500));
chk('one sentence, from the figures, with its WHY', /You finished down \$1,520\.50; the process graded C\+\./.test(t) && /data-id="week"/.test(h));
chk('WHAT WORKED / WHAT HURT: the strongest and weakest decisions, each graded, with CLV and a WHY', /What worked Iowa \+7\.5 .*Process A\+/.test(t) && /What hurt Over 47\.5 .*Process D CLV −1\.20%/.test(t)
  && /data-id="pos:g1"/.test(h) && /data-id="pos:p1"/.test(h));
chk('WON ON A POOR DECISION: the result, the grade, and why — from what was recorded', /Won on a poor decision Chiefs -7 .*Result Win \+\$90\.91 Process D/.test(t)
  && /The position won \(\+\$90\.91\), but the line closed at -4 against your -7 \(−3 pts against you\), and its price quality scored 28 and its entry timing scored 35 out of 100\./.test(t) && /data-id="pos:bw"/.test(h), t.slice(t.indexOf('Won on a poor'), t.indexOf('Won on a poor') + 400));
chk('LOST ON A GOOD DECISION: the same, and that the grade held despite the loss', /Lost on a good decision Iowa \+7\.5 .*Result Loss −\$100\.00 Process A/.test(t)
  && /The position lost \(−\$100\.00\), but the line closed at 5 against your 7\.5 \(\+2\.5 pts in your favour\), and its price quality scored 100 and its entry timing scored 92 out of 100\. EdgeDesk graded the entry positively despite the loss\./.test(t));
chk('outcome is not decision quality, said once', /Outcome and decision quality are different things/.test(t));
chk('REVIEW: would you make it again — YES / NO / UNSURE and why — beside what was recorded before the bet', /Would you make this bet again\? YES NO UNSURE Why\?/.test(t)
  && /Before the bet “Line value after the injury news”/.test(t) && /data-act="review-pick" data-id="bw" data-v="NO"/.test(h) && /data-review="bw"/.test(h)
  && /which never changes/.test(t) && !/data-review="r3"/.test(h) && /1 already reviewed/.test(t));
chk('the bad win and the good loss are asked first', h.indexOf('data-review="bw"') < h.indexOf('data-review="gl"') || h.indexOf('data-review="gl"') < 0);
chk('NEXT WEEK: a focus and an experiment to measure — never an instruction', /Next week Focus CFB · Spread Experiment Measure it/.test(t) && /what you do is your decision/.test(t)
  && !/don'?t bet|bet earlier|stop betting/i.test(t) && /data-act="exp-setup"/.test(h));
chk('no "None this week" cards anywhere', !/None this week/.test(t));
chk('rules broken this week: one line, not a card', /1 position outside your rules this week\. List them/.test(t));

/* the sentence says only what the figures support */
const S1 = (sum, prior) => J.filmSentence({ summary: sum, prior: prior || null });
chk('strong results, strong process', S1(W({ settled: { n: 12, pnl: '184.00' }, process: proc({ graded: 12, score: '74.0', letter: 'B+' }) })) === 'Strong results. Strong process (B+).');
chk('bad results, good process', S1(W({ settled: { n: 12, pnl: '-90.00' }, process: proc({ graded: 12, score: '70.0', letter: 'B+' }) })) === 'The results were bad. The process wasn’t (B+).');
chk('a win while the grade fell against the four weeks before', S1(W({ settled: { n: 12, pnl: '184.00' }, process: proc({ graded: 12, score: '56.0', letter: 'C+' }) }), W({ process: proc({ graded: 40, letter: 'B' }) })) === 'You won this week, but your process grade fell (B → C+).');
chk('too few graded to judge: says so instead of a verdict', S1(W({ settled: { n: 2, pnl: '40.00' }, process: proc({ graded: 3, score: '90.0', letter: 'A+' }) })) === 'You finished up $40.00. Too few graded positions (3) to judge the process yet.');

/* 15. sparse and empty weeks collapse */
const sparse = { week: '2026-09-07', summary: W({ settled: { n: 1, pnl: '-100.00' }, placed: { n: 1 }, process: proc({ n: 1, graded: 1, score: '81.0', letter: 'A-', rules: { applicable: 0 }, clv: { n: 0 } }) }),
  prior: null, best: [], worst: [], badWins: [], goodLosses: [], broken: [], settledList: [ROW({ id: 's1', process_score: '81.0', grade: 'A-' })] };
h = J.processView(pst('film', { film: sparse })); t = strip(h);
rendered.push(h);
chk('a sparse week: "Only 1 eligible position", why a reliable Film Room needs more, and the position itself — no empty sections',
  /Only 1 eligible position this week\. EdgeDesk needs more activity before it can build a reliable Film Room/.test(t) && /Process grade Building 1 of 10 graded/.test(t)
  && /This week's positions Chiefs -2\.5/.test(t) && !/What worked|What hurt|Won on a poor|Lost on a good/.test(t), t.slice(0, 700));
h = J.processView(pst('film', { film: { week: '2026-09-14', summary: W({ settled: { n: 0 }, placed: { n: 2 }, process: proc({ n: 2, graded: 0, rules: { applicable: 0 }, clv: { n: 0 } }) }),
  best: [], worst: [], badWins: [], goodLosses: [], broken: [], settledList: [], placedList: [ROW({ id: 'o1', status: 'OPEN', selection: 'Bills ML', process_score: null, grade: null })] } })); t = strip(h);
chk('a week with nothing graded says so once, and still shows what was entered', /Nothing settled this week\. No position this week has a price to judge the decision by yet\./.test(t)
  && !/Only 0/.test(t) && /This week's positions Bills ML/.test(t) && /Process not graded/.test(t), t.slice(0, 700));
h = J.processView(pst('film', { film: { week: '2026-09-14', summary: W({ settled: { n: 0 }, placed: { n: 0 }, process: proc({ n: 0, graded: 0 }) }) } })); t = strip(h);
chk('an empty week is one line', /Nothing was entered or settled this week\./.test(t) && !/Financial result/.test(t));

/* 14. WHY: every figure opens its evidence */
const WCTX = { summary: SUM, cells: CELLS, analysis: ANALYSIS, film: FILM, experiments: EXPS, expResults: EXPR, periodText: 'Aug 16 – Sep 15, 2026 (last 30 days, your time zone)',
  rows: Object.fromEntries([].concat(FILM.best, FILM.worst, FILM.badWins, FILM.goodLosses).map((x) => [x.id, x])) };
const NEED = ['Sample size', 'Positions', 'Date range', 'Comparison group', 'CLV', 'P&L', 'ROI', 'Confidence', 'Methodology', 'Limitations'];
for (const id of ['score', 'dim:price', 'dim:timing', 'dim:sizing', 'dim:rules', 'tests', 'exp:e1', 'pos:bw', 'pos:gl', 'week', 'matrix', 'variance', 'compare', 'edge', 'table:timing', 'f:' + bad.id]) {
  const it = J.whyItem(id, WCTX), w = it ? strip(J.whyPanel(it)) : '';
  rendered.push(it ? J.whyPanel(it) : '');
  chk('WHY ' + id + ' shows sample size, positions, date range, comparison group, CLV, P&L, ROI, confidence, methodology and limitations', !!it && NEED.every((k) => w.indexOf(k) >= 0), [id, NEED.filter((k) => w.indexOf(k) < 0)]);
}
let wy = strip(J.whyPanel(J.whyItem('score', Object.assign({}, WCTX, { summary: BUILDING }))));
chk('the Building WHY names the threshold and that no score is given below it', /Why the Process profile is still building/.test(wy) && /No score or letter below 10 graded positions/.test(wy) && /1 graded of 7 positions/.test(wy));
wy = strip(J.whyPanel(J.whyItem('pos:bw', WCTX)));
chk('a decision\'s WHY: its components, its close, its rules — and a way to its journal', /Price quality 28/.test(wy) && /Entry timing 35/.test(wy) && /−3 pts on the line/.test(wy) && /data-act="journal" data-id="bw"/.test(J.whyPanel(J.whyItem('pos:bw', WCTX))));
wy = strip(J.whyPanel(J.whyItem('exp:e1', WCTX)));
chk('an experiment\'s WHY: both windows, the minimum sample, and that it is before-and-after, never a promise', /2026-09-01 to 2026-09-29 \(during\), against 2026-08-04 to 2026-09-01 \(before\)/.test(wy) && /each side needs 20/.test(wy) && /never promises a result/.test(wy));
chk('a dimension\'s WHY says how it is scored and what it needs', /10 points off for each 1% given up/.test(strip(J.whyPanel(J.whyItem('dim:price', WCTX)))) && /0 positions with a price \(or line\) you researched/.test(strip(J.whyPanel(J.whyItem('dim:price', WCTX)))));

/* ═══ BEFORE YOU ENTER ══════════════════════════════════════════════════ */
const ctx = { model_ev: '0.0633', timing_bucket: 'D1_3', units: '2.4', max_single_units: '2', max_daily_units: '6', today_units: '3.5', today_count: 3,
  rules: [{ label: 'No position larger than 2 units', verdict: 'BROKEN' }, { label: 'No live positions', verdict: 'FOLLOWED' }],
  history: [{ dim: 'all', key: 'all', settled: 400 }, { dim: 'sport', key: 'NFL', settled: 45, pnl: '-120', staked: '4500', clv_n: 40, clv_sum: 0.4, ps_n: 40, ps_sum: 2400 },
    { dim: 'odds', key: 'PLUS_150_250', settled: 6, pnl: '300', staked: '600' }] };
h = J.preBetPanel(ctx, { edgedesk: { fair: '−140', market: '−120' } }); t = strip(h);
rendered.push(h);
chk('BEFORE YOU ENTER: EdgeDesk fair vs market, the model\'s EV, timing, size against the cap, today\'s exposure, a broken rule',
  /EdgeDesk fair price −140 against the market −120/.test(t) && /expected value of \+6\.3% per \$1/.test(t) && /Timing: 1–3 days before the start/i.test(t)
  && /2\.40 units against your 2-unit cap/.test(t) && /Already entered today: 3\.50 units in 3 positions · daily cap 6 units/.test(t) && /Outside your rule: No position larger than 2 units/.test(t) && !/No live positions/.test(t), t);
chk('…the reader\'s own record in this context, with its sample and confidence — groups under 10 are not shown',
  /Your last 12 months in this sport \(NFL\): 45 settled positions, ROI −2\.7%, average CLV \+1\.00% \(n=40\), process 60\.0 \(n=40\) · confidence MEDIUM/.test(t) && !/price range/.test(t), t);
chk('…and it is context, never a verdict: no BET, DON\'T BET, LOCK or GUARANTEED', !VERDICT.test(t) && /the decision is yours/.test(t));
chk('with no comparable history it says so', /No history yet in a context like this one/.test(strip(J.preBetPanel({ history: [] }))));
const exPanel = strip(J.preBetPanel({}, { exposure: { n: 2, risk: '160', platforms: ['DraftKings', 'Kalshi'], picks: ['Chiefs -2.5', 'YES'] } }));
chk('existing exposure on the same event, across platforms, is stated as a fact — never as advice', /Already open on this event: 2 positions\s*,\s*\$160\.00\s*at risk on DraftKings, Kalshi \(Chiefs -2\.5; YES\)/.test(exPanel)
  && !/\b(BET|DON'T BET|LOCK|GUARANTEED)\b/.test(exPanel), exPanel);

/* ═══ THE FORM'S DECISION FIELDS ════════════════════════════════════════ */
chk('decision fields → the journal: planned, thesis, a model probability strictly between 0 and 1',
  JSON.stringify(U.decisionPatch({ planned: 'true', thesis: '  Number is -140  ', model_probability_j: '0.58' })) === '{"planned":true,"thesis":"Number is -140","model_probability":"0.58"}'
  && JSON.stringify(U.decisionPatch({ planned: '', thesis: '', model_probability_j: '58' })) === '{}');
chk('the new-bet form asks for the decision; editing a bet does not reopen it', /name="thesis"/.test(U.render.wagerForm({}, {})) && !/name="thesis"/.test(U.render.wagerForm({}, { edit: true })));
chk('…and records the stake type and when the event starts, apart from when it was placed', /name="stake_type"/.test(U.render.wagerForm({}, {})) && /name="event_start_at"/.test(U.render.wagerForm({}, {})));
const w = U.wagerFromForm({ platform: 'draftkings', event_name: 'A @ B', selection: 'A', odds: '+150', stake: '25', stake_type: 'BONUS', placed_at: '2026-09-07T13:00', event_start_at: '2026-09-08T13:00', status: 'OPEN' }, []);
chk('a bonus bet and an event start are carried to the row', w.row.stake_type === 'BONUS' && w.row.event_start_at && w.row.event_start_at !== w.row.placed_at);

/* ═══ COPY ══════════════════════════════════════════════════════════════ */
const all = rendered.map(strip).join(' \n ');
const bannedHit = all.split(/(?<=[.!?])\s+/).filter((s) => !X.clean(s));
chk('no rendered sentence uses a banned word (tilt, FOMO, chasing, deposit, lock, guaranteed, "bet more", "hot streak" …)', bannedHit.length === 0, bannedHit.slice(0, 3));
chk('no rendered page gives a BET / DON\'T BET verdict', !VERDICT.test(all), (all.match(VERDICT) || [])[0]);

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'portfolio journal UI — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
