'use strict';
/* ===========================================================================
   THE PUBLIC PERFORMANCE ARTIFACTS — everything /performance/, the articles
   and the social drafts read, built from the ledger and nothing else.

     performance/data/games.json     one row per STARTED game: the designated
                                     forecast, the verified result, the grade.
                                     An upcoming game is never published here.
     performance/data/summary.json   the metrics by tier, sport and model
                                     version, the coverage of every sport, the
                                     retrospective (walk-forward) evidence kept
                                     apart, and the ledger's own state
     performance/data/weekly.json    the last complete week, for the Weekend
                                     Model Review and the social drafts
     performance/data/health.json    what is missing, unmatched, in conflict
     performance/articles/postgame.json   the "Prediction vs. Actual Result"
                                     block for every published matchup article
     performance/social/<week>.json  the weekly summary drafts, written once
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const P = require('../../lib/edgedesk_performance.js');
const PL = require('./pipeline.js');
const S = require('./sources.js');

const SITE = 'https://edgedesksports.com';
const PAGE = '/performance/';
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function r1(v) { return v == null || !isFinite(v) ? null : Math.round(v * 10) / 10; }
function gameUrl(key) { return PAGE + '?g=' + encodeURIComponent(key); }

/* --------------------------------------------------------------- rows */
function publicRows(state, nowMs) {
  const fx = PL.byEvent(state.forecasts), rx = PL.byEvent(state.results), gx = PL.byEvent(state.grades), qx = PL.byEvent(state.quotes);
  const rows = [], undesignated = [];
  fx.forEach((snaps, key) => {
    const res = PL.latest(rx.get(key));
    const start = P.toMs(res && res.start_utc) != null ? P.toMs(res.start_utc) : Math.max.apply(null, snaps.map((s) => P.toMs(s.start_utc) || 0));
    if (!(start <= nowMs)) return; /* never publish an upcoming forecast */
    const d = P.designate(snaps, res ? res.start_utc : new Date(start).toISOString());
    if (!d.snapshot) { undesignated.push({ event_key: key, ineligible: d.ineligible.slice(0, 5) }); return; }
    const g = PL.latest(gx.get(key));
    const row = P.publicRow(d.snapshot, res, g, { revisions: d.revisions });
    delete row.week;
    const q = d.snapshot.quote;
    row.forecast.market = q ? { book: q.book, source: q.source, captured_at: q.captured_at, home_line: q.spread ? q.spread.home_point : null, total: q.total ? q.total.point : null } : null;
    /* the last named-book quote the ledger saw before the start (context, never called a close) */
    const lq = (qx.get(key) || []).filter((x) => P.toMs(x.captured_at) < start).sort((a, b) => P.toMs(a.captured_at) - P.toMs(b.captured_at)).pop();
    row.last_pregame_quote = lq ? { book: lq.book, captured_at: lq.captured_at, home_line: lq.spread ? lq.spread.home_point : null, total: lq.total ? lq.total.point : null } : null;
    rows.push(P.compact(row));
  });
  rows.sort((a, b) => P.toMs(b.start_utc) - P.toMs(a.start_utc) || (a.event_key < b.event_key ? -1 : 1));
  return { rows, undesignated };
}

/* ------------------------------------------------------------ summary */
function slim(m) {
  /* the summary keeps every figure; the page recomputes the full view from games.json */
  return m;
}
const NOT_RESEARCH = ['golf'];
function coverage(root, rows) {
  const EDPROJ = require(path.join(root, 'lib', 'edgedesk_projections.js'));
  let RET = null; try { RET = require(path.join(root, 'lib', 'edgedesk_sports.js')); } catch (_) { RET = null; }
  const out = [];
  Object.keys(EDPROJ.SPORTS).forEach((id) => {
    const sp = EDPROJ.SPORTS[id];
    const mine = rows.filter((x) => x.sport === id);
    const graded = (t) => mine.filter((x) => x.tier === t && x.grade && x.grade.eligible).length;
    let status, why = null;
    if (id === 'soccer' || (RET && RET.isRetiredKey && RET.isRetiredKey(id))) { status = 'RETIRED'; why = (sp.unsupported[0] || {}).why || 'retired from the platform'; }
    else if (!sp.adapter) { status = 'NO_FORECAST'; why = (sp.unsupported[0] || {}).why || 'no per-game forecast is published'; }
    else status = graded('VERIFIED') ? 'GRADED' : mine.length ? 'RECORDED_ONLY' : 'AWAITING_GAMES';
    if (status === 'RETIRED') return; /* a retired sport is not listed at all */
    if (NOT_RESEARCH.indexOf(id) >= 0) return; /* not an EdgeDesk research sport (golf.html is a partner referral page) */
    out.push({ sport: id, label: sp.label, league: sp.league, status, why, games: mine.length, verified_graded: graded('VERIFIED'), recorded_graded: graded('RECORDED'),
      models: Array.from(new Set(mine.map((x) => x.model_version).filter(Boolean))).sort() });
  });
  return out;
}
function retrospective(root) {
  const reg = readJson(path.join(root, 'engine', 'registry.json'));
  if (!reg || !Array.isArray(reg.sports)) return [];
  return reg.sports.filter((s) => s.product !== 'RETIRED' && S.SUPPORTED.indexOf(s.id) >= 0).map((s) => {
    const mk = (s.readiness && s.readiness.markets) || {};
    return { sport: s.id, label: s.label, state: s.readiness ? s.readiness.state : null,
      markets: Object.keys(mk).map((k) => ({ market: k, state: mk[k].state, n: mk[k].n == null ? null : mk[k].n, headline: mk[k].headline || null, file: mk[k].file || null })) };
  });
}
function buildSummary(root, state, rows, nowMs, meta) {
  const sports = Array.from(new Set(rows.map((x) => x.sport))).sort();
  const by = (list) => ({ verified: P.metrics(list.filter((x) => x.tier === 'VERIFIED')), recorded: P.metrics(list.filter((x) => x.tier === 'RECORDED')) });
  const bySport = {}; sports.forEach((s) => { bySport[s] = by(rows.filter((x) => x.sport === s)); });
  const models = {};
  rows.forEach((x) => { const k = x.sport + '|' + x.model_version + '|' + x.tier; (models[k] = models[k] || []).push(x); });
  const byModel = Object.keys(models).sort().map((k) => { const [sport, model, tier] = k.split('|'); const m = P.metrics(models[k]);
    return { sport, model_version: model, tier, graded: m.eligibility.graded, winner: { called: m.winner.called, correct: m.winner.correct, pct: m.winner.pct, brier: m.winner.brier, log_loss: m.winner.log_loss, sample_state: m.winner.sample_state },
      margin: m.margin, total: m.total }; });
  const epoch = PL.epochOf(state.forecasts);
  let lastCap = null; state.forecasts.forEach((s) => { const c = P.toMs((s.capture || {}).captured_at); if (c != null && (lastCap == null || c > lastCap)) lastCap = c; });
  return {
    schema: 'edgedesk_perf_summary_v1', version: P.VERSION, grader: P.GRADER_VERSION, generated_at: new Date(nowMs).toISOString(),
    what: 'Every eligible EdgeDesk pregame forecast, locked before the game and graded against the verified final, misses included. Research, not picks.',
    ledger: { epoch: epoch == null ? null : new Date(epoch).toISOString(), last_capture_at: lastCap == null ? null : new Date(lastCap).toISOString(),
      forecasts: state.forecasts.length, verified_forecasts: state.forecasts.filter((s) => (s.capture || {}).method === 'ledger_capture').length,
      recorded_forecasts: state.forecasts.filter((s) => (s.capture || {}).method !== 'ledger_capture').length,
      quotes: state.quotes.length, results: state.results.length, grades: state.grades.length, chains: meta && meta.chains || null },
    tiers: P.TIERS, min_n: P.MIN_N,
    headline: { verified: slim(P.metrics(rows.filter((x) => x.tier === 'VERIFIED'))), recorded: slim(P.metrics(rows.filter((x) => x.tier === 'RECORDED'))) },
    by_sport: bySport, by_model: byModel, coverage: coverage(root, rows), retrospective: retrospective(root),
    rules: [
      'A forecast is on the record only if it was captured or recorded before the game started. A later number is refused, never stored.',
      'The graded forecast is the last one the ledger captured before the actual start. Every earlier revision is kept, and none is ever overwritten.',
      'Verified pregame means the ledger itself captured the forecast from a public, committed EdgeDesk artifact before the start. Forecasts imported from EdgeDesk’s earlier records are labelled recorded pregame and never counted in the verified headline.',
      'A final is verified when every source that has the game agrees on integer scores. Sources that disagree settle nothing. A corrected final is a new revision, and the old one is kept.',
      'Canceled, forfeited and long-postponed games are void, never counted as wins or losses. A forecast made for a date that moved by more than 36 hours is not the forecast for the game that was played.',
      'A rate, Brier score or average error is printed only once ' + P.MIN_N + ' games stand behind it. Smaller samples show their counts.',
      'Market comparisons use only a named-book quote captured before the start. No price, no units. No legitimate close from the same source, no CLV. A fair-line gap is not a betting result.'
    ]
  };
}

/* ------------------------------------------------------------ weekly */
/* the Central Time week (Monday 00:00 to Monday 00:00), the Weekend Model Review's week */
function ctMidnight(y, m, d) {
  for (const off of [5, 6]) { const t = Date.UTC(y, m - 1, d, off); const p = ctParts(t); if (p.h === 0 && p.d === d) return t; }
  return Date.UTC(y, m - 1, d, 6);
}
function ctParts(t) {
  const o = {}; new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hour12: false })
    .formatToParts(new Date(t)).forEach((x) => { o[x.type] = x.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
function weekBounds(nowMs) {
  const p = ctParts(nowMs);
  const back = (p.wd + 6) % 7;
  const thisMon = ctMidnight(p.y, p.m, p.d) - back * 86400e3;
  const fix = (t) => { const q = ctParts(t + 12 * 3600e3); return ctMidnight(q.y, q.m, q.d); }; /* DST-safe */
  const from = fix(thisMon - 7 * 86400e3), to = fix(thisMon);
  const q = ctParts(from + 12 * 3600e3);
  return { id: q.y + '-' + String(q.m).padStart(2, '0') + '-' + String(q.d).padStart(2, '0'), from, to };
}
function weekly(rows, nowMs) {
  const W = weekBounds(nowMs);
  const inWeek = rows.filter((x) => { const t = P.toMs(x.start_utc); return t >= W.from && t < W.to; });
  const waiting = inWeek.filter((x) => !x.result || x.result.state === 'CONFLICT' || (!x.grade && x.result.state === 'FINAL'));
  /* complete once every game of the week is settled (from 06:00 CT Monday, before the
     Monday review's 07:00 slot), or 48 hours after the week ends whatever is still waiting */
  const complete = nowMs >= W.to + 6 * 3600e3 && (!waiting.length || nowMs >= W.to + 48 * 3600e3);
  const ver = inWeek.filter((x) => x.tier === 'VERIFIED');
  const sports = Array.from(new Set(ver.map((x) => x.sport))).sort();
  const bySport = sports.map((s) => { const m = P.metrics(ver.filter((x) => x.sport === s));
    return { sport: s, graded: m.eligibility.graded, winner: { called: m.winner.called, correct: m.winner.correct, pct: m.winner.pct, brier: m.winner.brier, sample_state: m.winner.sample_state },
      margin: { n: m.margin.n, mae: m.margin.mae }, total: { n: m.total.n, mae: m.total.mae }, market: m.market }; });
  /* the week's largest model–market disagreements on the spread, with what happened */
  const diffs = ver.filter((x) => x.grade && x.grade.eligible && x.grade.market && x.grade.market.spread && x.grade.market.spread.pick && x.grade.spread)
    .map((x) => ({ event_key: x.event_key, sport: x.sport, matchup: x.away + ' at ' + x.home, gap: x.grade.market.spread.pick.gap, side: x.grade.market.spread.pick.side,
      model_line: x.forecast.fair_home_line, market_line: x.grade.market.spread.line, book: x.grade.market.book,
      final: x.away + ' ' + x.result.away_score + ', ' + x.home + ' ' + x.result.home_score, model_abs_error: x.grade.spread.abs_error, market_abs_error: x.grade.market.spread.market_abs_error,
      result_at_market_line: x.grade.market.spread.pick.result, url: gameUrl(x.event_key) }))
    .sort((a, b) => b.gap - a.gap);
  const heldUp = diffs.filter((d) => d.model_abs_error < d.market_abs_error).slice(0, 3);
  const missed = diffs.filter((d) => d.model_abs_error > d.market_abs_error).slice(0, 3);
  const all = P.metrics(ver);
  const errs = ver.filter((x) => x.grade && x.grade.eligible && x.grade.spread).map((x) => ({ event_key: x.event_key, sport: x.sport, matchup: x.away + ' at ' + x.home,
    projected_margin: x.grade.spread.projected_margin, actual_margin: x.grade.spread.actual_margin, abs_error: x.grade.spread.abs_error, final: x.away + ' ' + x.result.away_score + ', ' + x.home + ' ' + x.result.home_score, url: gameUrl(x.event_key) }));
  return {
    schema: 'edgedesk_perf_weekly_v1', week_id: W.id, from: new Date(W.from).toISOString(), to: new Date(W.to).toISOString(), generated_at: new Date(nowMs).toISOString(),
    status: complete ? 'COMPLETE' : 'OPEN', waiting: waiting.length, tier: 'VERIFIED',
    games: inWeek.length, verified_graded: all.eligibility.graded, recorded_graded: P.metrics(inWeek.filter((x) => x.tier === 'RECORDED')).eligibility.graded,
    overall: { winner: all.winner, margin: all.margin, total: all.total, market: all.market, picks: all.picks },
    by_sport: bySport,
    market_differences: { rule: 'The verified games with the largest gap between EdgeDesk’s fair spread and the named-book line captured with it, and whether the final landed nearer EdgeDesk’s number or the book’s.', held_up: heldUp, missed, n: diffs.length },
    closest: errs.slice().sort((a, b) => a.abs_error - b.abs_error).slice(0, 3),
    biggest_misses: errs.slice().sort((a, b) => b.abs_error - a.abs_error).slice(0, 3),
    enough: all.eligibility.graded >= P.MIN_N,
    limitations: [
      'One week is a small sample. Read it next to the season record on ' + SITE + PAGE + '.',
      'Only verified pregame forecasts are counted here. Forecasts imported from earlier records are not.',
      'A fair-line gap is a research disagreement, not a bet, and a projected number is not a betting result.'
    ]
  };
}

/* ------------------------------------------------------------ social */
function tweetLength(s) { return String(s).replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length; }
function socialDraft(wk) {
  /* a week with too few verified games gets no draft at all: nothing thin, nothing unverified */
  if (!wk || wk.status !== 'COMPLETE' || !wk.enough) return null;
  const link = SITE + PAGE;
  const W = wk.overall.winner, M = wk.overall.margin;
  const parts = ['EdgeDesk model record, week of ' + wk.week_id + ':', wk.verified_graded + ' verified pregame forecasts graded'];
  if (W.pct != null) parts.push('right winner ' + W.correct + ' of ' + W.called);
  if (M.mae != null) parts.push('average margin miss ' + M.mae + ' pts');
  let text = parts[0] + ' ' + parts.slice(1).join(', ') + '. Misses included. Research, not picks. ' + link;
  while (tweetLength(text) > 280) text = text.replace(/, [^,]*\. Misses/, '. Misses');
  const items = wk.closest.slice(0, 1).concat(wk.biggest_misses.slice(0, 2)).map((x) => ({ matchup: x.matchup, final: x.final,
    text: x.matchup + ': EdgeDesk projected a ' + (x.projected_margin >= 0 ? 'home' : 'road') + ' margin of ' + Math.abs(r1(x.projected_margin)) + '; final ' + x.final + ' (off by ' + r1(x.abs_error) + '). ' + SITE + x.url,
    url: SITE + x.url }));
  items.forEach((it) => { if (tweetLength(it.text) > 280) it.text = it.text.slice(0, 250) + '… ' + it.url; });
  return {
    schema: 'edgedesk_perf_social_v1', week_id: wk.week_id, generated_at: wk.generated_at, status: 'DRAFT', autopost: false,
    note: 'Drafts only. EdgeDesk has no authenticated X integration; nothing here is posted automatically. Research, not picks.',
    summary: { text, length: tweetLength(text), link },
    card: { title: 'EdgeDesk Model Performance', subtitle: 'Week of ' + wk.week_id + ' · verified pregame forecasts', verified_graded: wk.verified_graded,
      lines: [
        { label: 'Right winner', value: W.pct != null ? W.correct + ' of ' + W.called : 'n=' + W.called + ' (too few)', n: W.called },
        { label: 'Average margin miss', value: M.mae != null ? M.mae + ' pts' : 'n=' + M.n + ' (too few)', n: M.n },
        { label: 'Brier score', value: W.brier != null ? String(W.brier) : 'n=' + W.scored + ' (too few)', n: W.scored }
      ], footer: 'Every forecast locked before kickoff. Misses included. Research, not picks.', link },
    comparisons: items,
    /* model vs market: the week's largest fair-line gaps against a captured line, and what happened (card data, not a pick) */
    market_recap: { n: wk.market_differences.n, rule: wk.market_differences.rule,
      held_up: wk.market_differences.held_up.map((d) => ({ matchup: d.matchup, gap: d.gap, book: d.book, final: d.final, model_abs_error: d.model_abs_error, market_abs_error: d.market_abs_error, url: SITE + d.url })),
      missed: wk.market_differences.missed.map((d) => ({ matchup: d.matchup, gap: d.gap, book: d.book, final: d.final, model_abs_error: d.model_abs_error, market_abs_error: d.market_abs_error, url: SITE + d.url })) }
  };
}

/* ------------------------------------------------------------ articles */
function articleSummaries(root, state, rows) {
  const pub = readJson(path.join(root, 'articles', 'data', 'published.json'));
  const out = {};
  if (!pub || !Array.isArray(pub.articles)) return out;
  const rowBy = new Map(rows.map((x) => [x.event_key, x]));
  const resBy = PL.byEvent(state.results);
  pub.articles.filter((a) => a.type === 'pregame').forEach((a) => {
    const sport = String(a.sport || '').toLowerCase();
    const id = sport + '-' + a.game_id;
    const rec = readJson(path.join(root, 'articles', 'data', 'records', id + '.json'));
    if (!rec || !rec.research || !rec.research.projection) return;
    const key = String(a.sport).toUpperCase() + '|' + a.game_id;
    const res = PL.latest(resBy.get(key));
    if (!res || res.state !== 'FINAL') return;
    const pj = rec.research.projection;
    /* graded from the raw projection: pj.total is the half-point display on a
       record built under football_half_point_v1, total_raw the model's own */
    const hm = P.num(pj.fair_spread), tot = P.num(pj.total_raw != null ? pj.total_raw : pj.total);
    const wp = pj.win_prob || {};
    const margin = res.home_score - res.away_score, total = res.home_score + res.away_score;
    const row = rowBy.get(key);
    const ledger = row && row.forecast ? { tier: row.tier, at: row.forecast.captured_at || row.forecast.recorded_at, fair_home_line: row.forecast.fair_home_line, fair_total: row.forecast.fair_total,
      p_home: row.forecast.p_home } : null;
    const differs = !!(ledger && ((ledger.fair_home_line != null && hm != null && Math.abs(-ledger.fair_home_line - hm) >= 0.05) || (ledger.fair_total != null && tot != null && Math.abs(ledger.fair_total - tot) >= 0.05)));
    out[id] = {
      article_id: id, slug: a.slug, event_key: key, sport: a.sport,
      published: { as_of: rec.generated_at || null, snapshot_id: rec.snapshot_id || null, fair_spread_text: pj.fair_spread_text || null, home_margin: hm == null ? null : r1(hm), total_text: pj.total == null ? null : String(pj.total),
        home: wp.home || rec.home_team, away: wp.away || rec.away_team, home_pct: P.num(wp.home_pct), away_pct: P.num(wp.away_pct), favourite: wp.favourite || null, favourite_pct: P.num(wp.favourite_pct),
        score: pj.score && pj.score.home && pj.score.away ? { home: String(pj.score.home.points), away: String(pj.score.away.points) } : null },
      final: { home: rec.home_team, away: rec.away_team, home_score: res.home_score, away_score: res.away_score, verified_at: res.verified_at, sources: (res.sources || []).map((x) => x.source), revision: res.revision || 1 },
      error: { margin: hm == null ? null : r1(margin - hm), margin_abs: hm == null ? null : r1(Math.abs(margin - hm)), total: tot == null ? null : r1(total - tot), total_abs: tot == null ? null : r1(Math.abs(total - tot)),
        favourite_won: wp.favourite && margin !== 0 ? (wp.favourite === (wp.home || rec.home_team)) === (margin > 0) : null },
      ledger: ledger ? Object.assign({ differs }, ledger) : null,
      record_url: gameUrl(key)
    };
  });
  return out;
}

/* ------------------------------------------------------------ health */
function health(state, steps, prevSummary, summary, nowMs, chains) {
  const items = [];
  const add = (level, check, detail, list) => items.push({ level, check, detail, count: list ? list.length : null, sample: list ? list.slice(0, 12) : undefined });
  if (chains && !chains.ok) add('ERROR', 'chain_integrity', 'a ledger file does not verify: ' + chains.files.filter((f) => !f.ok).map((f) => f.file + ' (' + f.errors[0] + ')').join('; '));
  const res = steps.results || { pending: [], conflicts: [], unmatched: [] };
  const all = res.pending.filter((x) => x.pending !== 'POSTPONED' && x.pending !== 'SUSPENDED');
  /* past the chase window a missing final stops alerting (and stops spending ESPN reads): it is listed for a person to resolve */
  const missing = all.filter((x) => x.hours_past_start <= PL.CHASE_DAYS * 24), abandoned = all.filter((x) => x.hours_past_start > PL.CHASE_DAYS * 24);
  if (missing.length) add(missing.some((x) => x.hours_past_start >= PL.ALERT_HOURS) ? 'ALERT' : 'WARN', 'missing_finals', missing.length + ' started game(s) with no verified final ' + PL.MISSING_FINAL_HOURS + '+ hours after the start', missing);
  if (abandoned.length) add('WARN', 'unresolved_finals', abandoned.length + ' game(s) with no final after ' + PL.CHASE_DAYS + ' days: no longer chased; never graded until a source has one', abandoned);
  const post = res.pending.filter((x) => x.pending === 'POSTPONED' || x.pending === 'SUSPENDED');
  if (post.length) add('INFO', 'postponed', post.length + ' postponed or suspended game(s) awaiting a new date (void after ' + P.POSTPONED_VOID_DAYS + ' days)', post);
  if (res.conflicts.length) add(res.conflicts.some((x) => x.hours_past_start >= PL.ALERT_HOURS) ? 'ALERT' : 'WARN', 'result_conflicts', res.conflicts.length + ' game(s) whose sources disagree on the final: nothing is settled until they agree', res.conflicts);
  if (res.unmatched.length) add(res.unmatched.some((x) => x.hours_past_start >= PL.ALERT_HOURS) ? 'ALERT' : 'WARN', 'unmatched_events', res.unmatched.length + ' forecast game(s) the scoreboard could not be matched to by team names and start', res.unmatched);
  const ng = (steps.grade || { no_snapshot: [] }).no_snapshot;
  if (ng.length) add('WARN', 'ungraded', ng.length + ' game(s) with a verified result but no eligible pregame forecast to grade', ng);
  const cap = steps.capture;
  if (cap) {
    const late = ['CAPTURED_AFTER_START', 'PREDICTED_AFTER_START', 'SLATE_SAYS_STARTED'].reduce((s, k) => s + (cap.refused[k] || 0), 0);
    if (late) add('INFO', 'late_forecasts_refused', late + ' forecast(s) refused because the game had started or the number was produced after the start');
  }
  /* the ledger stopped capturing while games are coming */
  let lastCap = null; state.forecasts.forEach((s) => { const c = P.toMs((s.capture || {}).captured_at); if (c != null && (lastCap == null || c > lastCap)) lastCap = c; });
  const upcoming = state.forecasts.some((s) => { const t = P.toMs(s.start_utc); return t > nowMs && t < nowMs + 24 * 3600e3; });
  if (lastCap != null && upcoming && nowMs - lastCap > 6 * 3600e3) add('ALERT', 'capture_stale', 'no forecast captured for ' + Math.round((nowMs - lastCap) / 3600e3) + ' hours while games start within a day');
  /* metrics that moved more than new games explain */
  const shifts = [];
  if (prevSummary && prevSummary.by_sport && summary.by_sport) {
    Object.keys(summary.by_sport).forEach((sp) => ['verified', 'recorded'].forEach((t) => {
      const a = prevSummary.by_sport[sp] && prevSummary.by_sport[sp][t], b = summary.by_sport[sp][t];
      if (!a || !b) return;
      const na = a.eligibility.graded, nb = b.eligibility.graded;
      if (nb < na) shifts.push({ sport: sp, tier: t, what: 'graded count fell', from: na, to: nb });
      const grew = nb - na;
      if (na >= P.MIN_N && grew <= Math.max(1, Math.round(na * 0.05))) {
        if (a.winner.brier != null && b.winner.brier != null && Math.abs(b.winner.brier - a.winner.brier) > 0.02) shifts.push({ sport: sp, tier: t, what: 'Brier moved', from: a.winner.brier, to: b.winner.brier, new_games: grew });
        if (a.margin.mae != null && b.margin.mae != null && Math.abs(b.margin.mae - a.margin.mae) > 1) shifts.push({ sport: sp, tier: t, what: 'margin MAE moved', from: a.margin.mae, to: b.margin.mae, new_games: grew });
      }
    }));
  }
  if (shifts.length) add('ALERT', 'metric_shift', 'a published metric moved more than the new games explain: review before it stands', shifts);
  if (steps.duplicates && steps.duplicates.length) add('WARN', 'duplicate_publication', steps.duplicates.length + ' attempt(s) to rewrite an already-published weekly draft were refused', steps.duplicates);
  if (steps.espn && steps.espn.log.some((x) => !x.ok)) add('WARN', 'source_read_failed', 'an ESPN scoreboard read failed (it is retried next run)', steps.espn.log.filter((x) => !x.ok));
  const worst = items.some((i) => i.level === 'ERROR') ? 'ERROR' : items.some((i) => i.level === 'ALERT') ? 'ALERT' : items.some((i) => i.level === 'WARN') ? 'WARN' : 'OK';
  return { schema: 'edgedesk_perf_health_v1', generated_at: new Date(nowMs).toISOString(), status: worst, items,
    counts: { forecasts: state.forecasts.length, results: state.results.length, grades: state.grades.length, quotes: state.quotes.length } };
}

/** The public game rows, one file per sport and season (the page loads them lazily). */
function gameFiles(rows, nowMs) {
  const by = {};
  rows.forEach((x) => { const k = x.sport + '-' + S.seasonLabel(x.sport, x.start_utc); (by[k] = by[k] || []).push(x); });
  const files = {}, index = [];
  Object.keys(by).sort().forEach((k) => {
    const [sport, season] = [k.slice(0, k.lastIndexOf('-')), k.slice(k.lastIndexOf('-') + 1)];
    const rel = 'performance/data/games/' + k + '.json';
    files[rel] = { schema: 'edgedesk_perf_games_v1', generated_at: new Date(nowMs).toISOString(), sport, season: +season,
      note: 'Started games only: the designated pregame forecast, the verified result and the grade. Upcoming forecasts are never published here.', rows: by[k] };
    index.push({ sport, season: +season, path: '/' + rel, rows: by[k].length });
  });
  return { files, index };
}

module.exports = { SITE, PAGE, publicRows, gameFiles, buildSummary, coverage, retrospective, weekly, weekBounds, socialDraft, tweetLength, articleSummaries, health, gameUrl };
