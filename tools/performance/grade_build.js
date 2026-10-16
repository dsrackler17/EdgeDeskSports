'use strict';
/* ===========================================================================
   THE RESEARCH GRADE ARTIFACTS — what the boards, the game views and
   /performance/grades/ read, built from the ledger and nothing else.

     performance/data/grades/live.json         every UPCOMING game's current grade:
                                               letter, score, caps, flags, the five
                                               dimension scores and the plain-English
                                               explanation (the badges and filters)
     performance/data/grades/live_detail.json  …and every sub-factor with its reason
                                               (the Grade Breakdown, loaded on open)
     performance/data/grades/games/<sport>-<season>.json
                                               every STARTED game's designated pregame
                                               grade and its settled outcome
     performance/data/grades/summary.json      the dashboard: totals, coverage, the
                                               distribution, performance by letter,
                                               by sport and by grade version, the
                                               ordering evidence, exclusions, rules

   An upcoming game's grade carries no model number: the badge needs only the
   letter and the reasons. Every number on the dashboard is recomputed by the
   page from the game rows with the same kernel (EDGRADE.performance).
   =========================================================================== */
const P = require('../../lib/edgedesk_performance.js');
const G = require('../../lib/edgedesk_research_grade.js');
const S = require('./sources.js');
const PL = require('./pipeline.js');

const PAGE = '/performance/grades/';

function latestSnapshots(state) {
  const m = new Map();
  (state.research_grades || []).forEach((s) => { const p = m.get(s.event_key); if (!p || P.toMs(s.captured_at) >= P.toMs(p.captured_at)) m.set(s.event_key, s); });
  return m;
}
function historyOf(snaps) {
  return snaps.slice().sort((a, b) => P.toMs(a.captured_at) - P.toMs(b.captured_at)).map((s) => [s.captured_at, (s.grade || {}).letter || G.INSUFFICIENT, (s.grade || {}).score == null ? null : s.grade.score]);
}
/** The full breakdown of a stored snapshot, regenerated from its own inputs and version (byte-identical by
    construction). Compact: a sub-factor is [id, status, score, points, reason]; its label is in the file's
    sub_labels once; only the gates that failed are listed. */
function breakdownOf(s) {
  const g = G.score(s.inputs, G.configFor((s.versions || {}).grade));
  const dims = {};
  G.DIMENSIONS.forEach((d) => {
    const D = g.dimensions[d.id];
    dims[d.id] = { weight: D.weight, score: D.score, points: D.points == null ? null : Math.round(D.points * 10) / 10, status: D.status,
      sub: D.items.map((x) => [x.id, x.status, x.score, Math.round((x.points || 0) * 100) / 100, x.detail]) };
  });
  return { dims, gates: g.gates.filter((x) => !x.pass).map((x) => ({ id: x.id, detail: x.detail })) };
}

/* ---------------------------------------------------------------- live */
function live(state, nowMs) {
  const latest = latestSnapshots(state), by = PL.byEvent(state.research_grades || []);
  const games = {}, detail = {}, alias = {};
  const counts = {};
  latest.forEach((s, key) => {
    if (!(P.toMs(s.start_utc) > nowMs)) return; /* started: the board shows the game's result now, the dashboard its grade */
    const g = s.grade || {};
    const letter = g.state === 'GRADED' ? g.letter : G.INSUFFICIENT;
    counts[letter] = (counts[letter] || 0) + 1;
    const dims = {};
    G.DIMENSIONS.forEach((d) => { const D = (g.dimensions || {})[d.id]; if (D) dims[d.id] = [D.score, D.status]; });
    games[key] = P.compact({
      sport: s.sport, league: s.league, start_utc: s.start_utc, home: (s.home || {}).name, away: (s.away || {}).name,
      letter, score: g.score, state: g.state, cap: g.cap ? g.cap.letter : null, caps: g.caps, gates: g.failed_gates && g.failed_gates.length ? g.failed_gates : null,
      flags: g.flags && g.flags.length ? g.flags : null, dims, explanation: g.explanation, captured_at: s.captured_at, model: (s.versions || {}).model_id,
      market: (s.market || {}).status, revisions: (by.get(key) || []).length,
      history: historyOf(by.get(key) || []).slice(-8)
    });
    if (s.capture && s.capture.slate_id) alias[s.capture.slate_id] = key;
    detail[key] = breakdownOf(s);
  });
  const base = { generated_at: new Date(nowMs).toISOString(), grade_version: G.DEFAULT_VERSION, weights_version: G.configFor(G.DEFAULT_VERSION).weights_version, kernel: G.VERSION };
  return {
    live: Object.assign({ schema: 'edgedesk_research_grade_live_v1' }, base, {
      what: 'The current A–F Research Grade of every upcoming game: the quality and reliability of EdgeDesk\'s pregame research, not a win probability or a pick.',
      tooltip: G.TOOLTIP, letters: G.LETTER_MEANING, counts, games, alias, dashboard: PAGE }),
    detail: Object.assign({ schema: 'edgedesk_research_grade_live_detail_v1' }, base, { dimensions: G.DIMENSIONS, sub_labels: G.SUB_LABEL, games: detail })
  };
}

/* ---------------------------------------------------------------- rows */
function publicRows(state, nowMs) {
  const sx = PL.byEvent(state.research_grades || []), rx = PL.byEvent(state.results), ox = PL.byEvent(state.grade_outcomes || []);
  const rows = [], undesignated = [];
  sx.forEach((snaps, key) => {
    const res = PL.latest(rx.get(key));
    const start = P.toMs(res && res.start_utc) != null ? P.toMs(res.start_utc) : Math.max.apply(null, snaps.map((s) => P.toMs(s.start_utc) || 0));
    if (!(start <= nowMs)) return; /* never an upcoming game */
    const d = G.designate(snaps, res ? res.start_utc : new Date(start).toISOString());
    if (!d.snapshot) { undesignated.push({ event_key: key, ineligible: d.ineligible.slice(0, 5) }); return; }
    const o = PL.latest(ox.get(key));
    const usable = o && o.snapshot_hash === d.snapshot.hash ? o : null;
    rows.push(G.publicRow(d.snapshot, usable, { revisions: d.revisions, history: historyOf(snaps.filter((s) => P.toMs(s.captured_at) < start)) }));
  });
  rows.sort((a, b) => P.toMs(b.start_utc) - P.toMs(a.start_utc) || (a.event_key < b.event_key ? -1 : 1));
  return { rows, undesignated };
}

function gameFiles(rows, nowMs) {
  const by = {};
  rows.forEach((x) => { const k = x.sport + '-' + (x.season != null ? x.season : S.seasonLabel(x.sport, x.start_utc)); (by[k] = by[k] || []).push(x); });
  const files = {}, index = [];
  Object.keys(by).sort().forEach((k) => {
    const sport = k.slice(0, k.lastIndexOf('-')), season = +k.slice(k.lastIndexOf('-') + 1);
    const rel = 'performance/data/grades/games/' + k + '.json';
    files[rel] = { schema: 'edgedesk_research_grade_games_v1', generated_at: new Date(nowMs).toISOString(), sport, season,
      note: 'Started games only: the latest research grade locked before kickoff and its settled outcome. Upcoming grades are in live.json.', rows: by[k] };
    index.push({ sport, season, path: '/' + rel, rows: by[k].length });
  });
  return { files, index };
}

/* ------------------------------------------------------------- summary */
function coverage(state, rows, nowMs, epochMs) {
  /* every started game the performance ledger captured a forecast for since the grade ledger began */
  const fx = PL.byEvent(state.forecasts);
  const byRow = new Map(rows.map((x) => [x.event_key, x]));
  const sports = {};
  fx.forEach((snaps, key) => {
    const sp = snaps[0].sport;
    const st = Math.max.apply(null, snaps.map((s) => P.toMs(s.start_utc) || 0));
    if (epochMs == null || !(st <= nowMs) || st < epochMs) return;
    if (!snaps.some((s) => (s.capture || {}).method === 'ledger_capture')) return;
    const c = sports[sp] = sports[sp] || { sport: sp, eligible_games: 0, with_pregame_grade: 0, graded: 0, ungraded: 0, settled: 0, void: 0, awaiting: 0 };
    c.eligible_games++;
    const r = byRow.get(key);
    if (!r) return;
    c.with_pregame_grade++;
    if (r.letter === G.INSUFFICIENT) c.ungraded++; else c.graded++;
    const o = r.outcome;
    if (o && o.eligible) c.settled++; else if (o && /^VOID/.test(o.why || '')) c.void++; else c.awaiting++;
  });
  return Object.keys(sports).sort().map((k) => sports[k]);
}
function buildSummary(state, rows, nowMs, meta) {
  meta = meta || {};
  let epoch = null, last = null;
  (state.research_grades || []).forEach((s) => { const t = P.toMs(s.captured_at); if (t == null) return; if (epoch == null || t < epoch) epoch = t; if (last == null || t > last) last = t; });
  const settled = rows.filter((x) => x.outcome && x.outcome.eligible);
  const period = settled.length ? { from: new Date(Math.min.apply(null, settled.map((x) => P.toMs(x.start_utc)))).toISOString(), to: new Date(Math.max.apply(null, settled.map((x) => P.toMs(x.start_utc)))).toISOString() } : null;
  const sports = Array.from(new Set(rows.map((x) => x.sport))).sort();
  const bySport = {}; sports.forEach((sp) => { bySport[sp] = G.performance(rows.filter((x) => x.sport === sp)); });
  const versions = Array.from(new Set(rows.map((x) => x.grade_version).filter(Boolean))).sort();
  const byVersion = {}; versions.forEach((v) => { byVersion[v] = G.performance(rows.filter((x) => x.grade_version === v)); });
  const overall = G.performance(rows);
  const cfg = G.configFor(G.DEFAULT_VERSION);
  return {
    schema: 'edgedesk_research_grade_summary_v1', kernel: G.VERSION, grade_version: G.DEFAULT_VERSION, weights_version: cfg.weights_version, weights: cfg.weights, caps: cfg.caps,
    generated_at: new Date(nowMs).toISOString(),
    what: 'How EdgeDesk\'s A–F Research Grades have held up on completed games. A grade measures the quality and reliability of the pregame research, not the chance a side wins. Research, not picks.',
    ledger: { epoch: epoch == null ? null : new Date(epoch).toISOString(), last_capture_at: last == null ? null : new Date(last).toISOString(),
      snapshots: (state.research_grades || []).length, outcomes: (state.grade_outcomes || []).length, chains: meta.chains || null },
    evaluation_period: period, min_n: G.MIN_N,
    insufficient: settled.filter((x) => x.letter !== G.INSUFFICIENT).length < G.MIN_N,
    overall, by_sport: bySport, by_grade_version: byVersion,
    coverage: coverage(state, rows, nowMs, epoch),
    exclusions: {
      no_pregame_grade: (meta.no_pregame_grade || []).length,
      no_pregame_grade_note: 'Completed games with no grade locked before kickoff (most started before the grade ledger began). They are never graded afterwards.',
      result_conflicts: (meta.conflicts || []).length, missing_finals: (meta.pending || []).length,
      void: overall.exclusions.void, by_why: overall.exclusions.by_why
    },
    filters: {
      sports: sports, leagues: Array.from(new Set(rows.map((x) => x.league).filter(Boolean))).sort(), seasons: Array.from(new Set(rows.map((x) => x.season).filter((v) => v != null))).sort(),
      models: Array.from(new Set(rows.map((x) => x.model_id).filter(Boolean))).sort(), grade_versions: versions,
      markets: [{ id: 'winner', label: 'Winner (win probability)' }, { id: 'spread', label: 'Margin' }, { id: 'total', label: 'Total' },
        { id: 'ats', label: 'Against the spread (side saved pregame)' }, { id: 'ou', label: 'Over/under (side saved pregame)' }]
    },
    letters: G.LETTER_MEANING, tooltip: G.TOOLTIP,
    rules: [
      'A grade is computed only before kickoff, from what was on file at that moment, and locked in an append-only, hash-chained ledger. Every change is kept.',
      'A game is judged by its latest valid pregame grade: the last one locked before the actual start. A grade made for a start that moved by more than 36 hours is not used.',
      'No game is ever given a grade afterwards. Completed games with no pregame grade are counted and excluded, never backfilled.',
      'Finals come from the performance ledger: sources must agree; canceled, forfeited and long-postponed games are void; overtime counts; NHL finals include the shootout goal; a corrected final is a new revision.',
      'Against-the-spread and over/under records use only the side and the named-book line saved with the grade before kickoff. No side is ever chosen from the final.',
      'Closing-line value appears only against a close from the same source family as the line the grade saw. No price is ever assumed.',
      'A rate, Brier score or error is printed only from ' + G.MIN_N + ' settled games, an interval only from 50. Below that the counts are shown.',
      'The weights are provisional. No grade is claimed to predict results until settled games show it, pair by pair, with intervals that exclude zero.'
    ]
  };
}

/* -------------------------------------------------------------- health */
function healthItems(state, steps, nowMs) {
  const items = [];
  const add = (level, check, detail, list) => items.push({ level, check, detail, count: list ? list.length : null, sample: list ? list.slice(0, 12) : undefined });
  const snap = steps.snapshot;
  if (snap && snap.reproduce_failures.length) add('ERROR', 'grade_reproducibility', snap.reproduce_failures.length + ' research grade(s) did not reproduce from their own inputs and were not written', snap.reproduce_failures);
  let last = null; (state.research_grades || []).forEach((s) => { const t = P.toMs(s.captured_at); if (t != null && (last == null || t > last)) last = t; });
  const upcoming = state.forecasts.some((s) => { const t = P.toMs(s.start_utc); return t > nowMs && t < nowMs + 24 * 3600e3; });
  if (last != null && upcoming && nowMs - last > 6 * 3600e3) add('ALERT', 'grade_capture_stale', 'no research grade written for ' + Math.round((nowMs - last) / 3600e3) + ' hours while games start within a day');
  const down = snap ? (snap.odds.SLATE_STALE || 0) + (snap.odds.NO_SLATE || 0) : 0;
  if (down) add('WARN', 'odds_feed', 'the scoreboard feed that carries sportsbook lines is unavailable or stale: ' + down + ' grade(s) had no market cross-check and were capped at B');
  const st = steps.settle;
  if (st && st.no_pregame_grade.length) add('INFO', 'no_pregame_grade', st.no_pregame_grade.length + ' completed game(s) had no research grade locked before kickoff (excluded, never backfilled)');
  return items;
}

module.exports = { PAGE, live, publicRows, gameFiles, buildSummary, coverage, healthItems, breakdownOf, latestSnapshots };
