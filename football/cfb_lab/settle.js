/* ============================================================================
   CFB Model Lab — settlement, closes, grading and miss reviews.

   After games finish (run hourly; heavy work only touches newly final games):

     1. results   ESPN scoreboard (completed flag, period count for overtime,
                  postponed/canceled status) and the cfbfastR schedule, the two
                  sources the football record already trusts. A FINAL is written
                  only when every source that carries the game agrees; a later
                  disagreement writes a superseding row, never an edit.
                  SETTLEMENT SAFETY (docs/cfb-production/SETTLEMENT.md): a FINAL
                  reading needs a final state and a valid score — two integers,
                  0-150, not a tie; suspended / delayed games are not final; an
                  invalid final is refused and logged, and the game waits.
                  Overtime is part of the result: margin, ATS and totals are
                  graded on the final score including overtime.
     2. lines     openers and closes (market.deriveLines, METRICS §4).
     3. grade     one evaluation per snapshot per (result, close) — append-only;
                  a corrected result or a newly derived close adds a row.
     4. reviews   every OFFICIAL snapshot missing by 10+ points gets a miss
                  review with its evidence and an automatic classification that
                  needs positive evidence for "high variance" (METRICS §17).

     node football/cfb_lab/settle.js [--season 2026] [--now ISO] [--offline]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lab_core.js');
const G = require('./ledger.js');
const MK = require('./market.js');
const I = require('./integrity.js');
const SRC = require(path.join(G.REPO, 'tools', 'record', 'football_record_sources.js'));
const P = require('./providers.js');

const U = L.util;

/* ------------------------------------------------------------ readings */
/* ESPN scoreboard payloads -> { game_id: {status, home, away, overtime} }.
   `refused` (optional array) collects every reading that is not a trustworthy
   result: a "final" without a final state or a valid score. */
function espnReadings(payloads, refused) {
  const out = {};
  (payloads || []).forEach((json) => ((json && json.events) || []).forEach((ev) => {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const st = (comp.status && comp.status.type) || {};
    const name = String(st.name || '');
    const home = (comp.competitors || []).find((c) => c.homeAway === 'home') || {};
    const away = (comp.competitors || []).find((c) => c.homeAway === 'away') || {};
    const period = U.num(comp.status && comp.status.period);
    let status = null;
    if (/POSTPONED/i.test(name)) status = 'POSTPONED';
    else if (/CANCEL/i.test(name)) status = 'CANCELED';
    else if (/FORFEIT|NO_CONTEST/i.test(name)) status = 'NO_CONTEST';
    else if (st.completed === true) status = 'FINAL';
    if (!status) return;
    const hs = I.num(home.score), as = I.num(away.score);
    const kick = U.iso(comp.date || ev.date);
    const rd = { source: 'espn', status, home_points: status === 'FINAL' ? hs : null, away_points: status === 'FINAL' ? as : null,
      overtime: status === 'FINAL' && U.isNum(period) ? period > 4 : null, name };
    if (kick) rd.kickoff_ts = kick;
    const bad = status === 'FINAL' ? I.finalProblem(rd) : null;
    if (bad) { if (refused) refused.push({ game_id: String(ev.id), source: 'espn', reason: bad, reading: rd }); return; }
    out[String(ev.id)] = rd;
  }));
  return out;
}
function cfbfastrReadings(csvText, season, refused) {
  const parsed = SRC.parseCfbSchedule(csvText, season);
  const out = {};
  Object.keys(parsed).forEach((id) => {
    const f = parsed[id].final; if (!f) return;
    const rd = { source: 'cfbfastR', status: 'FINAL', home_points: f.home_score, away_points: f.away_score, overtime: null };
    const bad = I.finalProblem(rd);
    if (bad) { if (refused) refused.push({ game_id: id, source: 'cfbfastR', reason: bad, reading: rd }); return; }
    out[id] = rd;
  });
  return out;
}
/* the football record's own finals (it reads the same two feeds hourly) — used
   only when the direct feeds could not be read, and labelled as such */
function recordReadings(season) {
  const out = {};
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(G.REPO, 'record', 'football', 'cfb_' + season + '.json'), 'utf8'));
    Object.values(rec.games || {}).forEach((g) => { if (g.final && U.isNum(g.final.home_score)) out[String(g.game_id)] = { source: 'record:' + (g.final.source || 'unknown'), status: 'FINAL', home_points: g.final.home_score, away_points: g.final.away_score, overtime: null }; });
  } catch (e) { /* no record file */ }
  return out;
}

/* Combine readings into result rows (METRICS §5). */
function resultsFrom(readingSets, existing, now, gameIds) {
  const cur = currentResults(existing);
  const out = [], disagreements = [];
  const ids = new Set(gameIds || []);
  readingSets.forEach((set) => Object.keys(set).forEach((k) => ids.add(k)));
  for (const gid of ids) {
    const rs = readingSets.map((s) => s[gid]).filter(Boolean);
    if (!rs.length) continue;
    /* a source that says FINAL without a valid final is a disagreement: nothing is settled */
    const invalid = rs.filter((r) => r.status === 'FINAL' && I.finalProblem(r));
    if (invalid.length) { disagreements.push({ game_id: gid, readings: rs, invalid_final: invalid.map((r) => r.source + ': ' + I.finalProblem(r)) }); continue; }
    const finals = rs.filter((r) => r.status === 'FINAL');
    const voids = rs.filter((r) => r.status !== 'FINAL');
    let row = null;
    if (finals.length && !voids.length) {
      const agree = finals.every((r) => r.home_points === finals[0].home_points && r.away_points === finals[0].away_points);
      if (!agree) { disagreements.push({ game_id: gid, readings: finals }); continue; }
      const ot = finals.map((r) => r.overtime).find((x) => x === true || x === false);
      row = { game_id: gid, status: 'FINAL', home_points: finals[0].home_points, away_points: finals[0].away_points,
        final_margin: finals[0].home_points - finals[0].away_points, final_total: finals[0].home_points + finals[0].away_points,
        overtime: ot === undefined ? null : ot, sources: rs.map(srcOf), sources_agree: true };
    } else if (voids.length && !finals.length) {
      row = { game_id: gid, status: voids[0].status, home_points: null, away_points: null, final_margin: null, final_total: null, overtime: null,
        sources: rs.map((r) => { const o = { source: r.source, status: r.status }; if (r.kickoff_ts) o.kickoff_ts = r.kickoff_ts; return o; }), sources_agree: voids.every((v) => v.status === voids[0].status) };
      if (!row.sources_agree) { disagreements.push({ game_id: gid, readings: rs }); continue; }
    } else { disagreements.push({ game_id: gid, readings: rs }); continue; }
    const prev = cur.get(gid);
    if (prev && prev.status === row.status && prev.home_points === row.home_points && prev.away_points === row.away_points) continue;
    row.season = null; row.week = null;
    row.supersedes = prev ? prev.result_id : null;
    row.reason = prev ? 'correction: sources now read ' + row.status + ' ' + (row.home_points ?? '') + '-' + (row.away_points ?? '') : null;
    row.recorded_at = U.iso(now);
    row.result_id = G.ids.result(row);
    out.push(row);
  }
  return { rows: out, disagreements };
}
/* a source entry of a result row; the kickoff the source reported rides along
   (used to anchor closes and to void a snapshot of a game that was moved) */
function srcOf(r) {
  const o = { source: r.source, status: r.status, home_points: r.home_points, away_points: r.away_points };
  if (r.kickoff_ts) o.kickoff_ts = r.kickoff_ts;
  return o;
}
function currentResults(results) {
  const m = new Map();
  (results || []).slice().sort((a, b) => U.ms(a.recorded_at) - U.ms(b.recorded_at)).forEach((r) => m.set(r.game_id, r));
  return m;
}
function consensusLines(lines) {
  const m = new Map();
  (lines || []).filter((l) => l.book === 'CONSENSUS' && l.market_type === 'spread').forEach((l) => {
    const e = m.get(l.game_id) || {}; e[l.kind === 'OPEN' ? 'open' : 'close'] = l; m.set(l.game_id, e);
  });
  return m;
}

/* ------------------------------------------------------------- grading */
/* The kickoff the game was actually played at: the result's own source
   kickoff (ESPN at settlement), else the newest kickoff a LIVE snapshot of the
   game was taken against. */
function actualKickoffs(preds, cur) {
  const m = new Map();
  for (const p of preds) if (p.origin === 'LIVE') { const c = m.get(p.game_id); if (!c || U.ms(p.prediction_ts) > U.ms(c.at)) m.set(p.game_id, { kickoff: p.kickoff_ts, at: p.prediction_ts }); }
  const out = new Map();
  m.forEach((v, gid) => out.set(gid, v.kickoff));
  cur.forEach((r, gid) => { const k = (r.sources || []).map((x) => x.kickoff_ts).filter(Boolean)[0]; if (k) out.set(gid, k); });
  return out;
}
function gradeAll(preds, results, lines, existingEvals, now) {
  const cur = currentResults(results);
  const cl = consensusLines(lines);
  const have = new Set((existingEvals || []).map((e) => e.evaluation_id));
  const kicks = actualKickoffs(preds, cur);
  const out = [];
  for (const p of preds) {
    const res0 = cur.get(p.game_id);
    if (!res0) continue;
    /* a snapshot of a game that was then moved by more than 36 h predicted a
       game that did not happen at its time: VOID (the POSTPONED grading), never
       a win or a loss (SETTLEMENT.md §4) */
    const res = (res0.status === 'FINAL' && I.rescheduled(p.kickoff_ts, kicks.get(p.game_id))) ? Object.assign({}, res0, { status: 'POSTPONED' }) : res0;
    const ln = cl.get(p.game_id) || {};
    if (res.status === 'FINAL' && !ln.close && !L.closeDue(p.kickoff_ts, now)) continue;   // wait for the close grace
    const e = L.evaluate(p, res, ln);
    Object.assign(e, { season: p.season, week: p.week, kickoff_ts: p.kickoff_ts, model_label: p.model_label, model_role: p.model_role,
      hours_to_kickoff: p.hours_to_kickoff, is_first_snapshot: p.is_first_snapshot,
      football_confidence: p.football_confidence, edge_quality: p.edge_quality, ensemble_disagreement: p.ensemble_disagreement,
      model_market_gap: p.model_market_gap, near_miss: p.near_miss, data_quality_status: p.data_quality_status,
      evaluated_at: U.iso(now) });
    e.evaluation_id = G.ids.evaluation(e);
    if (have.has(e.evaluation_id)) continue;
    have.add(e.evaluation_id); out.push(e);
  }
  return out;
}

/* ---------------------------------------------------------- miss review */
function learningEvidence(season) {
  const m = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(G.REPO, 'football', 'cfb_v2', 'learning', season + '_misses.json'), 'utf8'));
    (j.rows || []).forEach((r) => { if (r.evidence) m.set(String(r.game_id), Object.assign({ classification_v2: r.classification }, r.evidence)); });
  } catch (e) { /* none */ }
  return m;
}
/* who actually started each team's most recent game, from the board's own
   "started the last game" evidence for the team's next game */
function observedStarters(slate) {
  const m = new Map();
  ((slate && slate.games) || []).forEach((g) => ['home', 'away'].forEach((s) => {
    const x = g[s + '_starter'];
    if (x && /PREVIOUS_GAME/i.test(String(x.status || '')) && x.player_id) m.set(String(g[s + '_team'] || '').toLowerCase(), { player_id: String(x.player_id), player_name: x.player_name, published_at: x.published_at });
  }));
  return m;
}
function missReviews(preds, evals, existingReviews, ctx) {
  ctx = ctx || {};
  const byPred = new Map(preds.map((p) => [p.prediction_id, p]));
  const done = new Set((existingReviews || []).map((r) => r.prediction_id));
  const learn = ctx.learning || new Map(), starters = ctx.starters || new Map();
  const out = [];
  for (const e of evals) {
    if (!e.official || e.void || done.has(e.prediction_id)) continue;
    const sev = L.missSeverity(e.abs_margin_error);
    if (!sev) continue;
    const p = byPred.get(e.prediction_id); if (!p) continue;
    const ev = learn.get(String(p.game_id)) || null;
    const exp = p.inputs_ref && p.inputs_ref.qb_expected;
    let qbChanged = null;
    if (exp) {
      const chk = (side) => {
        const x = exp[side], seen = starters.get(String(side === 'home' ? p.home_team : p.away_team).toLowerCase());
        if (!x || !x.player_id || !seen || !seen.published_at) return null;
        if (Math.abs(U.ms(seen.published_at) - U.ms(p.kickoff_ts)) > 12 * 3600000) return null;   // not this game's starter
        return String(seen.player_id) !== String(x.player_id);
      };
      const hc = chk('home'), ac = chk('away');
      qbChanged = (hc === true || ac === true) ? true : ((hc === false || ac === false) ? false : null);
    }
    const moveTowardResult = U.isNum(e.move_since_snapshot) && U.isNum(e.margin_error) && e.margin_error !== 0
      ? U.r((e.close_home_line != null && U.isNum(p.current_spread) ? (L.conv.bookToMargin(e.close_home_line) - L.conv.bookToMargin(p.current_spread)) : 0) * Math.sign(e.margin_error), 2) : null;
    const evidence = {
      data_quality_status: p.data_quality_status, data_quality_issues: p.data_quality_issues,
      components: p.components, drivers: [p.primary_edge, p.secondary_edge].filter(Boolean), primary_uncertainty: p.primary_uncertainty,
      qb_expected: exp || null, qb_changed_from_expected: qbChanged, qb_certainty: p.qb_certainty, injury_certainty: p.injury_certainty,
      turnover_margin_abs: ev && U.isNum(ev.turnover_margin_home) ? Math.abs(ev.turnover_margin_home) : null,
      special_teams_swing_abs: ev && U.isNum(ev.st_net_home) ? Math.abs(ev.st_net_home) : null,
      explosive_diff_abs: ev && U.isNum(ev.explosive_diff_home) ? Math.abs(ev.explosive_diff_home) : null,
      garbage_time: ev && U.isNum(ev.garbage_share) ? ev.garbage_share >= 0.25 : null,
      v2_learning_class: ev ? ev.classification_v2 : null,
      move_since_snapshot_toward_result: moveTowardResult, market_close_home_line: e.close_home_line,
      abs_error: e.abs_margin_error, close_abs_error: e.close_abs_error, result_sources_disagree: false, team_mapping_fault: (p.data_quality_issues || []).some((c) => c.check === 'team_mapping' && c.status === 'RED'),
    };
    const cls = L.classifyMiss(evidence);
    const row = { prediction_id: p.prediction_id, game_id: p.game_id, model_version: p.model_version, severity: sev,
      predicted_margin: p.pure_home_margin, actual_margin: e.final_margin, market_close_home_line: e.close_home_line,
      abs_error: e.abs_margin_error, close_abs_error: e.close_abs_error, evidence,
      classification: cls.classification, classified_by: 'auto:' + L.RULES.miss, rationale: cls.rationale,
      created_at: U.iso(ctx.now), supersedes: null };
    row.review_id = G.ids.review(row);
    out.push(row); done.add(p.prediction_id);
  }
  return out;
}

/* ------------------------------------------------------------------ run */
async function run(opts) {
  opts = opts || {};
  const now = U.iso(opts.now || new Date());
  const season = opts.season || new Date(U.ms(now)).getUTCFullYear();
  const store = new G.Store(season, opts.storeOpts);
  const log = { now, season };
  /* 1. results */
  const sets = [];
  const refused = [];
  if (!opts.offline) {
    const payloads = opts.espnPayloads || await MK.fetchEspn(now, { back: 10, fwd: 0, breakerState: opts.espnBreakerState });
    const schema = payloads.filter((p) => !p.error).map((p) => P.validateEspnScoreboard(p, { use: 'results' }));
    log.espn_schema = { rejected_payloads: schema.filter((v) => !v.ok).length, rejected_events: schema.reduce((a, v) => a + v.rejected.length, 0),
      problems: schema.flatMap((v) => v.problems.concat(v.rejected.slice(0, 5).map((x) => 'event ' + x.id + ': ' + x.problems.join('; ')))).slice(0, 20) };
    sets.push(espnReadings(schema.filter((v) => v.ok).map((v) => ({ events: v.events })), refused));
    const cf = await P.guarded('cfbfastr_schedule', (signal) => (opts.cfbfastrCsv != null ? Promise.resolve(opts.cfbfastrCsv) : P.httpText(SRC.URL_CFB_SCHED(season), signal)), { now, breakerState: opts.cfbfastrBreakerState });
    if (cf.ok) {
      const missing = P.validateCfbfastrHeader(cf.value);
      if (missing.length) log.cfbfastr_error = 'SCHEMA: cfbfastR schedule lacks ' + missing.join(', ');
      else sets.push(cfbfastrReadings(cf.value, season, refused));
    } else log.cfbfastr_error = (cf.class || 'UNKNOWN') + ': ' + cf.error;
    log.breakers = { cfbfastr_schedule: cf.breaker, espn_scoreboard: payloads.breaker || null };
    log.readings = sets.map((s) => Object.keys(s).length);
  }
  if (opts.readings) sets.push(...opts.readings);
  if (!sets.some((s) => Object.keys(s).length) && opts.useRecord !== false) { sets.push(recordReadings(season)); log.used_record_fallback = true; }
  const preds = store.predictions();
  const predGames = new Set(preds.map((p) => p.game_id));
  /* only games the lab predicted are settled here */
  const filtered = sets.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => predGames.has(k))));
  const byGame = new Map(preds.map((p) => [p.game_id, p]));
  const rs = resultsFrom(filtered, store.results(), now);
  rs.rows.forEach((r) => { const p = byGame.get(r.game_id); if (p) { r.season = p.season; r.week = p.week; } r.result_id = G.ids.result(r); });
  log.results = store.append('results', rs.rows, 'result_id').written;
  log.result_disagreements = rs.disagreements;
  log.results_refused = refused.filter((x) => predGames.has(x.game_id));
  /* 2. lines */
  log.lines = MK.lines(season, now, { storeOpts: opts.storeOpts });
  /* 3. grading */
  const evals = gradeAll(preds, store.results(), store.lines(), store.evaluations(), now);
  log.evaluations = store.append('evaluations', evals, 'evaluation_id').written;
  /* 4. miss reviews */
  let slate = null; try { slate = JSON.parse(fs.readFileSync(path.join(G.REPO, 'football', 'fbs', 'slate.json'), 'utf8')); } catch (e) { /* none */ }
  const reviews = missReviews(preds, store.evaluations(), store.missReviews(), { now, learning: learningEvidence(season), starters: observedStarters(slate) });
  log.miss_reviews = store.append('miss_reviews', reviews, 'review_id').written;
  return log;
}

module.exports = { espnReadings, cfbfastrReadings, recordReadings, resultsFrom, currentResults, consensusLines, gradeAll, actualKickoffs, missReviews, observedStarters, learningEvidence, run };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  run({ now: arg('--now', null), season: arg('--season', null) ? Number(arg('--season')) : null, offline: a.includes('--offline') })
    .then((log) => console.log(JSON.stringify(log))).catch((e) => { console.error(e); process.exit(1); });
}
