/* ============================================================================
   EdgeDesk CFB — LIVE VALIDATION, the pure functions.

   "Is the current version actually getting better?" This file answers from
   the Model Lab's append-only ledger and nothing else. It never trains,
   fits, re-prices or re-labels anything: every number here is a summary of a
   row that was written once, before kickoff, by the Lab
   (football/cfb_lab/checkpoint.js), graded after it by the Lab
   (football/cfb_lab/settle.js), and summarised with the Lab's own metric
   code (football/cfb_lab/lab_core.js). Definitions: docs/cfb-lab/METRICS.md
   and docs/cfb-validation/DELIVERABLE.md.

   THREE THINGS KEPT APART, ALWAYS
     FOOTBALL MODEL        margin error, probability calibration, intervals
     MARKET INTELLIGENCE   opener / close comparison, movement toward
                           EdgeDesk, closing-line value
     BETTING DECISIONS     qualified wagers only (the decision engine's BET);
                           research positions are shown apart and labelled
                           hypothetical, never as a record

   VERSION BOUNDARIES, NEVER BLENDED
     CURRENT      LIVE, OFFICIAL (T24) snapshots of the frozen champion taken
                  at or after the freeze (football/cfb_validation/champion.json)
                  under the frozen pricing fingerprint, or a declared patch
     PRE-FREEZE   LIVE snapshots taken before the freeze
     LEGACY       everything the Lab reconstructed (GIT_RECONSTRUCTED, REPLAY)
                  and the public record's board numbers — kept, never erased,
                  never mixed into CURRENT
   ============================================================================ */
'use strict';
const L = require('../cfb_lab/lab_core.js');
const U = L.util;

const ORDER = { OPEN: 0, WEEKLY_FREEZE: 1, T72: 2, T48: 3, T24: 4, T12: 5, T6: 6, T2: 7, FINAL: 8, ADHOC: 9 };
const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : null;
const r = (x, d) => { if (num(x) == null) return null; const f = Math.pow(10, d == null ? 3 : d); const v = Math.round(x * f) / f; return v === 0 ? 0 : v; };
const mean = (a) => { a = (a || []).filter((x) => num(x) != null); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
const sd = (a) => { a = (a || []).filter((x) => num(x) != null); if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const q = (a, p) => { a = (a || []).filter((x) => num(x) != null).sort((x, y) => x - y); if (!a.length) return null; const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
const ms = (t) => U.ms(t);
const sign = (x) => (x > 0 ? 1 : (x < 0 ? -1 : 0));
const settled = (e) => e && e.result_status === 'FINAL' && !e.void;
const byKick = (a, b) => (ms(a.kickoff_ts) || 0) - (ms(b.kickoff_ts) || 0);

/* ------------------------------------------------------------------ epochs */
/* the system version in force at an instant, from the append-only version log */
function versionAt(versions, ts, kind) {
  const t = ms(ts);
  let cur = null;
  (versions || []).filter((v) => !kind || v.kind === kind).forEach((v) => { if (ms(v.effective_at) <= t && (!cur || ms(v.effective_at) >= ms(cur.effective_at))) cur = v; });
  return cur;
}
function epochOf(e, freeze, versions) {
  if (!e) return null;
  if (e.origin !== 'LIVE') return 'LEGACY';
  if (!freeze || ms(e.prediction_ts || e.kickoff_ts) < ms(freeze.effective_at)) return 'PRE_FREEZE';
  if (e.model_version !== freeze.champion.model_version) return 'OTHER_MODEL';
  return 'CURRENT';
}

/* ------------------------------------------------------ the three sections */
function footballModel(evs) {
  const s = evs.filter(settled);
  const err = L.errorSummary(s), win = L.winCalibration(s), iv = L.intervalReport(s);
  return {
    what: 'how far the pure fair margin landed from the final margin, and whether the stated probabilities and ranges were honest',
    n: s.length,
    mae: err.mae, rmse: err.rmse, median_ae: err.median_ae, p90_ae: err.p90_ae, p95_ae: err.p95_ae, worst_ae: s.length ? r(Math.max.apply(null, s.map((e) => Math.abs(num(e.abs_margin_error) || 0))), 2) : null,
    bias: err.bias, favorite_bias: err.favorite_bias, winner_accuracy: err.winner_accuracy,
    brier: err.brier, log_loss: err.log_loss, calibration_error: win.ece != null ? win.ece : null,
    interval_coverage: { p50: iv.p50 ? iv.p50.coverage : null, p80: iv.p80 ? iv.p80.coverage : null, p95: iv.p95 ? iv.p95.coverage : null,
      n: iv.p80 ? iv.p80.n : 0, verdict_80: iv.p80 ? iv.p80.verdict : null },
    label: err.label || (s.length < 30 ? 'small sample' : null)
  };
}
function marketIntelligence(evs) {
  const s = evs.filter(settled);
  const m = L.marketComparison(s);
  const clv = s.filter((e) => num(e.move_since_snapshot) != null).map((e) => e.move_since_snapshot);
  return {
    what: 'the market, read after the projection: which number landed closer, and whether the market moved to EdgeDesk',
    n: s.length,
    opening_market_mae: m.vs_open ? m.vs_open.market_mae : null, edgedesk_mae_vs_open_set: m.vs_open ? m.vs_open.model_mae : null,
    edgedesk_closer_than_opener_pct: m.vs_open && m.vs_open.beat_share != null ? r(100 * m.vs_open.beat_share, 1) : null, n_open: m.vs_open ? m.vs_open.n : 0,
    closing_market_mae: m.vs_close ? m.vs_close.market_mae : null, edgedesk_mae_vs_close_set: m.vs_close ? m.vs_close.model_mae : null,
    edgedesk_closer_than_close_pct: m.vs_close && m.vs_close.beat_share != null ? r(100 * m.vs_close.beat_share, 1) : null, n_close: m.vs_close ? m.vs_close.n : 0,
    error_vs_close_ci: m.vs_close ? m.vs_close.diff_ci : null,
    market_moved_toward_edgedesk_pct: m.discovery && m.discovery.moved_toward_share != null ? r(100 * m.discovery.moved_toward_share, 1) : null,
    average_clv_points: clv.length ? r(mean(clv), 3) : (m.discovery ? m.discovery.mean_move_points : null),
    positive_clv_pct: clv.length ? r(100 * clv.filter((x) => x > 0).length / clv.length, 1) : null,
    n_clv: clv.length || (m.discovery ? m.discovery.n : 0),
    clv_basis: 'points the closing line moved toward EdgeDesk’s side from the market at the snapshot (move_since_snapshot)'
  };
}
function bettingDecisions(evs, policy) {
  const s = evs.filter(settled);
  const bets = s.filter((e) => e.decision_class === 'BET');
  const research = s.filter((e) => e.decision_class === 'LEAN');
  return {
    what: 'qualified wagers only: a BET the decision engine certified under an enabled policy',
    betting_enabled: !!(policy && policy.bet_enabled),
    qualified_wagers: L.betting(bets),
    research_positions_hypothetical: Object.assign(L.betting(research, { hypothetical: true }),
      { label: 'HYPOTHETICAL — research leans graded at an assumed −110, not wagers and not a record' })
  };
}
function sections(evs, policy) {
  return { football_model: footballModel(evs), market_intelligence: marketIntelligence(evs), betting_decisions: bettingDecisions(evs, policy) };
}

/* one row per game: the OFFICIAL snapshot for LIVE, the last pre-kickoff one
   for reconstructed history (report.js reconstructed) */
function lastPerGame(evs) {
  const by = new Map();
  evs.slice().sort((a, b) => ORDER[a.checkpoint_type] - ORDER[b.checkpoint_type]).forEach((e) => by.set(e.game_id + '|' + e.model_version, e));
  return [...by.values()];
}
const official = (e) => e.origin === 'LIVE' && e.checkpoint_type === 'T24';

/* ------------------------------------------------------------- the views */
function views(D, freeze, versions, policy, season) {
  const champ = freeze.champion.model_version;
  const champEvs = D.evals.filter((e) => e.model_version === champ);
  const offLive = champEvs.filter(official).sort(byKick);
  const current = offLive.filter((e) => epochOf(e, freeze, versions) === 'CURRENT');
  const legacy = lastPerGame(champEvs.filter((e) => e.origin !== 'LIVE'));
  const preFreeze = lastPerGame(champEvs.filter((e) => e.origin === 'LIVE' && epochOf(e, freeze, versions) === 'PRE_FREEZE'));
  const settledCurrent = current.filter(settled);
  const mk = (id, label, rows, note) => Object.assign({ id, label, note, n_rows: rows.length, n_settled: rows.filter(settled).length }, sections(rows, policy));
  const V = [
    mk('SINCE_UPGRADE', 'SINCE CURRENT MODEL VERSION', current,
      'LIVE official (T24) snapshots of ' + champ + ' taken at or after the freeze (' + freeze.effective_at + ') under the frozen pricing fingerprint. The only view that judges the current version.'),
    mk('CURRENT_CHAMPION', 'CURRENT CHAMPION ONLY', offLive,
      'every LIVE official snapshot of the champion, before and after the freeze'),
    mk('CURRENT_SEASON', 'CURRENT SEASON (' + season + ')', offLive.filter((e) => +e.season === +season),
      'LIVE official snapshots this season'),
    mk('LAST_25', 'LAST 25 GAMES', settledCurrent.slice(-25), 'the last 25 settled games since the freeze'),
    mk('LAST_50', 'LAST 50 GAMES', settledCurrent.slice(-50), 'the last 50 settled games since the freeze'),
    mk('LAST_100', 'LAST 100 GAMES', settledCurrent.slice(-100), 'the last 100 settled games since the freeze'),
    mk('LEGACY', 'LEGACY (RECONSTRUCTED)', legacy,
      'the champion’s numbers recovered from git history (GIT_RECONSTRUCTED) — the last pre-kickoff number per game. Evidence of method; never part of the current record.'),
    mk('ALL_HISTORICAL', 'ALL HISTORICAL', legacy.concat(preFreeze).concat(offLive),
      'everything on file for the champion: legacy reconstructed, pre-freeze LIVE and LIVE official. Mixed epochs, shown only beside the separated views.')
  ];
  return V;
}

/* ------------------------------------------------------------ north star */
function northStar(V, signals, freeze, liveCounts) {
  const cur = V.find((v) => v.id === 'SINCE_UPGRADE');
  const fm = cur.football_model, mi = cur.market_intelligence, bd = cur.betting_decisions;
  return {
    current_model_version: freeze.champion.model_version, release: freeze.release_id, frozen_at: freeze.effective_at,
    live_games: fm.n, live_snapshots_tracked: liveCounts ? liveCounts.champion_live_snapshots : null,
    model_mae: fm.mae, market_moved_toward_edgedesk_pct: mi.market_moved_toward_edgedesk_pct, average_clv: mi.average_clv_points,
    calibration_error: fm.calibration_error, interval_coverage_80: fm.interval_coverage.p80,
    verified_major_n: signals ? signals.verified.summary.n : null, qualified_bet_n: bd.qualified_wagers.decisions || 0,
    state: fm.n === 0 ? 'BUILDING — no settled official snapshot since the freeze yet' : (fm.n < 100 ? 'EARLY — ' + fm.n + ' settled games; read nothing into it yet' : 'MEASURING')
  };
}

/* --------------------------------------------------- divergence monitor */
function divergenceMonitor(teams, Canon, opts) {
  opts = opts || {};
  const rows = teams.filter((t) => num(t.current) != null && num(t.state) != null);
  const cCur = mean(rows.map((t) => t.current)), cSt = mean(rows.map((t) => t.state));
  const divs = rows.map((t) => (t.current - cCur) - (t.state - cSt));
  const absd = divs.map(Math.abs);
  const cut = { elevated: r(q(absd, 0.5), 2), large: r(q(absd, 0.9), 2) };
  const out = rows.map((t) => {
    const pair = Canon.ratingPair({ team: t.team, current: t.etsr, state: t.state_detail, centers: { current: cCur, state: cSt }, cut });
    return { key: t.key, team: t.team, conference: t.conference || null, current: r(t.current, 2), state: r(t.state, 2),
      carried: r(t.state_detail.carried, 2), this_season: r(t.state_detail.this_season, 2), prior_weight: t.state_detail.prior_weight,
      games_played: t.state_detail.games_played, difference: pair.difference, rating_state_divergence: pair.divergence, abs_divergence: r(Math.abs(pair.divergence), 2),
      band: pair.band, flagged: pair.band === 'LARGE', why: pair.why, expected_text: pair.expected_text };
  }).sort((a, b) => b.abs_divergence - a.abs_divergence);
  const missing = teams.filter((t) => num(t.current) == null || num(t.state) == null).map((t) => ({ key: t.key, team: t.team, missing: num(t.current) == null ? 'current rating' : 'pricing state' }));
  return {
    definition: 'rating_state_divergence = (current FBS power rating − its FBS mean) − (production pricing state − its FBS mean): how differently the two numbers see a team, after removing the two scales’ different averages',
    diagnostic_only: 'Nothing reads this back into a price. The ratings are never forced together.',
    n: out.length, expected: opts.expected_fbs || null, missing,
    centers: { current: r(cCur, 3), state: r(cSt, 3), scale_offset: r(cSt - cCur, 3) },
    median_abs: r(q(absd, 0.5), 3), p90_abs: r(q(absd, 0.9), 3), max_abs: r(absd.length ? Math.max.apply(null, absd) : null, 3),
    bands: Object.assign({ basis: 'this build’s own distribution: |divergence| p50 → ELEVATED, p90 → LARGE' }, cut),
    flagged: out.filter((t) => t.flagged).map((t) => t.team),
    largest: out.slice(0, 12),
    teams: out,
    state_source: opts.state_source || null, current_source: opts.current_source || null
  };
}

/* ------------------------------------------- verified / investigate / flip */
function signalRows(D) {
  /* every LIVE champion-engine snapshot that faced a market, per game, in time order */
  const evalByPred = new Map((D.evals || []).map((e) => [e.prediction_id, e]));
  const closeByGame = new Map();
  (D.evals || []).forEach((e) => { if (num(e.close_home_line) != null) closeByGame.set(e.game_id, e.close_home_line); });
  const finals = new Map();
  (D.results || []).forEach((x) => { if (x.status === 'FINAL' && num(x.final_margin) != null) finals.set(String(x.game_id), x.final_margin); });
  const by = new Map();
  (D.preds || []).forEach((p) => {
    if (p.origin !== 'LIVE' || p.engine_id !== 'edgedesk_cfb_p4' || num(p.model_market_gap) == null) return;
    (by.get(p.game_id) || by.set(p.game_id, []).get(p.game_id)).push(p);
  });
  const games = [];
  by.forEach((list, gid) => {
    list.sort((a, b) => ms(a.prediction_ts) - ms(b.prediction_ts));
    const first = list[0], last = list[list.length - 1];
    const verdicts = list.map((p) => p.disagreement_status || null);
    const final = finals.has(String(gid)) ? finals.get(String(gid)) : null;
    const closeL = closeByGame.has(gid) ? closeByGame.get(gid) : null;
    const close = closeL == null ? null : L.conv.bookToMargin(closeL);
    const grade = (p) => {
      if (!p) return null;
      const fair = p.pure_home_margin, mkt = L.conv.bookToMargin(p.current_spread), gap = fair - mkt, s = sign(gap);
      const o = { game_id: gid, game: p.away_team + ' @ ' + p.home_team, week: p.week, at: p.prediction_ts, checkpoint: p.checkpoint_type,
        edgedesk_fair: r(fair, 2), market_at_snapshot: r(mkt, 2), gap: r(Math.abs(gap), 2), toward: s > 0 ? p.home_team : (s < 0 ? p.away_team : null),
        books: p.sportsbook_count, verdict: p.disagreement_status || 'NOT_RUN', root_cause: p.disagreement_root_cause || null,
        favorite_flip: sign(fair) !== 0 && sign(mkt) !== 0 && sign(fair) !== sign(mkt) && Math.abs(fair) >= 0.5 && Math.abs(mkt) >= 0.5,
        closing_market: close == null ? null : r(close, 2), final_margin: final };
      if (close != null) { o.market_move_toward = r((close - mkt) * s, 2); o.moved_toward = Math.abs(close - mkt) < 0.25 ? null : (close - mkt) * s > 0; }
      if (final != null) {
        o.edgedesk_error = r(Math.abs(fair - final), 2); o.snapshot_market_error = r(Math.abs(mkt - final), 2);
        o.edgedesk_closer_than_snapshot_market = Math.abs(fair - final) < Math.abs(mkt - final);
        if (close != null) { o.close_error = r(Math.abs(close - final), 2); o.edgedesk_closer_than_close = Math.abs(fair - final) < Math.abs(close - final); }
        const m = final - mkt;
        o.ats_hypothetical = m === 0 ? 'PUSH' : (sign(m) === s ? 'WIN' : 'LOSS');
      }
      return o;
    };
    const firstV = list.find((p) => p.disagreement_status === 'VERIFIED_MAJOR_DISAGREEMENT');
    const firstI = list.find((p) => p.disagreement_status === 'INVESTIGATE' || p.disagreement_status === 'MARKET_FAULT');
    const firstFlip = list.find((p) => { const f = p.pure_home_margin, m = L.conv.bookToMargin(p.current_spread); return sign(f) && sign(m) && sign(f) !== sign(m) && Math.abs(f) >= 0.5 && Math.abs(m) >= 0.5; });
    games.push({ game_id: gid, first: grade(first), last: grade(last), verified: firstV ? grade(firstV) : null, investigate: firstI ? grade(firstI) : null,
      flip: firstFlip ? grade(firstFlip) : null, verdict_path: verdicts, settled: final != null,
      investigate_outcome: firstI ? investigateOutcome(list, firstI, close) : null, raw_major: list.some((p) => Math.abs(p.model_market_gap) >= 7) });
  });
  return games;
}
/* what became of an INVESTIGATE: later verified, failed on bad information,
   shrank because EdgeDesk moved, or explained by the market moving */
function investigateOutcome(list, firstI, close) {
  const after = list.filter((p) => ms(p.prediction_ts) >= ms(firstI.prediction_ts));
  const lastP = after[after.length - 1];
  const s = sign(firstI.model_market_gap);
  if (after.some((p) => p.disagreement_status === 'VERIFIED_MAJOR_DISAGREEMENT')) return 'LATER_VERIFIED';
  const INFO = ['QB_STATUS_ERROR', 'PLAYER_AVAILABILITY_ERROR', 'GAME_MAPPING_ERROR', 'HOME_AWAY_ERROR', 'MARKET_JOIN_ERROR', 'STALE_MARKET', 'THIN_MARKET', 'FCS_TRANSLATION_ERROR'];
  const mkt0 = L.conv.bookToMargin(firstI.current_spread), mkt1 = L.conv.bookToMargin(lastP.current_spread);
  const fair0 = firstI.pure_home_margin, fair1 = lastP.pure_home_margin;
  const marketCame = (mkt1 - mkt0) * s, modelCame = (fair0 - fair1) * s;
  if (close != null && (close - mkt0) * s >= 1.5) return 'MARKET_MOVED';
  if (marketCame >= 1.5) return 'MARKET_MOVED';
  if (Math.abs(lastP.model_market_gap) < 7 && modelCame > 0) return 'SHRANK_NATURALLY';
  if (INFO.indexOf(firstI.disagreement_root_cause) >= 0) return 'BAD_INFORMATION';
  return 'UNRESOLVED';
}
function signalSummary(rows) {
  const s = rows.filter(Boolean);
  const done = s.filter((x) => x.final_margin != null);
  const mv = s.filter((x) => x.moved_toward != null);
  const clv = s.filter((x) => num(x.market_move_toward) != null).map((x) => x.market_move_toward);
  const ats = done.filter((x) => x.ats_hypothetical && x.ats_hypothetical !== 'PUSH');
  return {
    n: s.length, settled: done.length, label: s.length < 30 ? 'small sample' : null,
    average_gap: r(mean(s.map((x) => x.gap)), 2),
    market_moved_toward_pct: mv.length ? r(100 * mv.filter((x) => x.moved_toward).length / mv.length, 1) : null,
    positive_clv_pct: clv.length ? r(100 * clv.filter((x) => x > 0).length / clv.length, 1) : null, average_clv: r(mean(clv), 2),
    edgedesk_closer_than_opener_pct: done.length ? r(100 * done.filter((x) => x.edgedesk_closer_than_snapshot_market).length / done.length, 1) : null,
    edgedesk_closer_than_close_pct: done.filter((x) => x.edgedesk_closer_than_close != null).length
      ? r(100 * done.filter((x) => x.edgedesk_closer_than_close).length / done.filter((x) => x.edgedesk_closer_than_close != null).length, 1) : null,
    edgedesk_mae: r(mean(done.map((x) => x.edgedesk_error)), 2),
    ats_hypothetical: ats.length ? { wins: ats.filter((x) => x.ats_hypothetical === 'WIN').length, losses: ats.filter((x) => x.ats_hypothetical === 'LOSS').length,
      label: 'hypothetical: EdgeDesk’s side at the snapshot market, not a wager' } : null
  };
}
function signals(D, historical) {
  const games = signalRows(D);
  const V = games.map((g) => g.verified).filter(Boolean);
  const I = games.map((g) => g.investigate).filter(Boolean);
  const F = games.map((g) => g.flip).filter(Boolean);
  const outcomes = {};
  games.filter((g) => g.investigate_outcome).forEach((g) => { outcomes[g.investigate_outcome] = (outcomes[g.investigate_outcome] || 0) + 1; });
  const sv = signalSummary(V), si = signalSummary(I);
  const enough = sv.settled >= 30 && si.settled >= 30;
  const notRun = games.filter((g) => g.raw_major && g.verdict_path.every((v) => v == null)).length;
  return {
    what: 'the rare large disagreements, from the gate verdict FROZEN on each LIVE snapshot (never re-judged after the fact)',
    verified: { summary: sv, games: V },
    investigate: { summary: si, games: I, outcomes,
      outcome_definitions: { LATER_VERIFIED: 'a later snapshot passed the gate', BAD_INFORMATION: 'the gate’s root cause was an information or data problem (QB, availability, mapping, thin or stale market)',
        SHRANK_NATURALLY: 'EdgeDesk’s own number moved toward the market until the gap was under 7', MARKET_MOVED: 'the market moved 1.5+ pts toward EdgeDesk (the market explained it)', UNRESOLVED: 'none of the above' } },
    comparison: {
      ready: enough, min_settled_each: 30,
      verified: sv, investigate: si,
      reading: enough
        ? ((sv.market_moved_toward_pct || 0) > (si.market_moved_toward_pct || 0) && (sv.average_clv || 0) > (si.average_clv || 0)
          ? 'The gate is separating: verified gaps show more market movement toward EdgeDesk and more CLV than investigate gaps.'
          : 'The gate is not separating on live data yet: verified gaps do not beat investigate gaps on movement and CLV.')
        : 'Building: ' + sv.settled + ' settled verified and ' + si.settled + ' settled investigate snapshots; 30 of each are needed before comparing.',
      historical_reference: historical || null
    },
    favorite_flips: { summary: signalSummary(F), games: F, note: 'EdgeDesk and the market favoured different teams at the snapshot' },
    verdict_not_run: { n: notRun, note: notRun ? notRun + ' raw 7+ gap game(s) have no gate verdict on file: the snapshot predates the gate wiring (2026-09-27 17:08 UTC) or its slate lacked the gate inputs. They are counted as NOT RUN, never judged in hindsight.' : null }
  };
}

/* ------------------------------------------------------------ postmortems */
const MATCHUP_P95 = 3.42;
function checklist(e, p, review) {
  const comp = (p && p.components) || {};
  const cOf = (k) => { const v = comp[k]; return num(v) != null ? v : (v && num(v.points) != null ? v.points : null); };
  const mt = cOf('matchup');
  const qbExpected = p && p.inputs_ref && p.inputs_ref.qb_expected ? p.inputs_ref.qb_expected : null;
  const yn = (v, src) => ({ answer: v === true ? 'YES' : (v === false ? 'NO' : 'UNKNOWN'), source: src });
  return {
    original_price_good: yn(num(e.cover_probability) != null && num(e.price_assumed) != null ? null : (num(e.edge_vs_open) != null ? Math.abs(e.edge_vs_open) >= 2 : null),
      'the snapshot’s model–market gap at the price then available (edge_vs_open)'),
    beat_closing_line: yn(num(e.clv_points) != null ? e.clv_points > 0 : (num(e.move_since_snapshot) != null ? e.move_since_snapshot > 0 : null), 'CLV from the snapshot price to the close'),
    market_moved_toward_edgedesk: yn(e.market_move_toward_model == null ? null : !!e.market_move_toward_model, 'open → close movement relative to EdgeDesk’s side'),
    qb_correct: yn(review && review.qb_changed_from_expected != null ? !review.qb_changed_from_expected : null, review && review.qb_changed_from_expected != null ? 'Model Lab miss review (expected vs actual starter)' : (qbExpected ? 'the expected starters are on the snapshot; no post-game starter record is joined to it' : 'no starter record on the snapshot')),
    roster_correct: yn(p && Array.isArray(p.data_quality_issues) ? !p.data_quality_issues.some((i) => i && /availability|roster|injur/i.test(String(i.check || '') + ' ' + String(i.detail || '')) && i.status === 'RED') : null, 'snapshot data-quality checks (availability / roster RED)'),
    team_state_correct: yn(review && review.team_state_ok != null ? !!review.team_state_ok : null, review && review.team_state_ok != null ? 'Model Lab miss review' : 'games played behind each rating are not stored on the Lab snapshot; unknown, never assumed'),
    matchup_adjustment_excessive: yn(mt == null ? null : Math.abs(mt) > MATCHUP_P95, 'matchup term vs its validated p95 (' + MATCHUP_P95 + ' pts)'),
    turnover_outlier: yn(review && review.turnover_margin_abs != null ? review.turnover_margin_abs >= 3 : null, review && review.turnover_margin_abs != null ? 'Model Lab miss review post-game factors (turnover margin ≥ 3)' : 'no per-game turnover series is joined to this game; unknown, never assumed'),
    data_failure: yn(e.data_quality_status ? e.data_quality_status === 'RED' : null, 'snapshot data-quality status')
  };
}
function classifyLoss(e, c, review) {
  if (c.data_failure.answer === 'YES' || (review && review.classification === 'DATA_FAILURE')) return 'BAD_DATA';
  if (review && review.classification === 'HIGH_VARIANCE_OUTCOME') return 'NORMAL_VARIANCE';
  if (c.beat_closing_line.answer === 'NO' && c.market_moved_toward_edgedesk.answer === 'NO') {
    if (num(e.close_abs_error) != null && num(e.abs_margin_error) != null && e.close_abs_error <= e.abs_margin_error - 7) return 'BAD_MODEL';
    return 'BAD_PRICE';
  }
  if (c.beat_closing_line.answer === 'YES') return 'GOOD_PROCESS_BAD_OUTCOME';
  if (review && review.classification === 'MODEL_FAILURE') return 'BAD_MODEL';
  if (num(e.close_abs_error) != null && num(e.abs_margin_error) != null && e.close_abs_error <= e.abs_margin_error - 7) return 'BAD_MODEL';
  if (num(e.close_abs_error) != null && num(e.abs_margin_error) != null && e.close_abs_error >= 0.8 * e.abs_margin_error) return 'NORMAL_VARIANCE';
  return 'UNRESOLVED';
}
function classifyWin(e, c) {
  const badProcess = c.beat_closing_line.answer === 'NO' || c.market_moved_toward_edgedesk.answer === 'NO' || (num(e.abs_margin_error) != null && e.abs_margin_error >= 14);
  const goodProcess = c.beat_closing_line.answer === 'YES' || c.market_moved_toward_edgedesk.answer === 'YES';
  if (badProcess && !goodProcess) return 'BAD_PROCESS_GOOD_OUTCOME';
  if (goodProcess && !badProcess) return 'GOOD_PROCESS_GOOD_OUTCOME';
  return badProcess ? 'BAD_PROCESS_GOOD_OUTCOME' : 'UNRESOLVED';
}
function postmortems(D, freeze, versions, opts) {
  opts = opts || {};
  const MISS = opts.miss_threshold || 21;
  const predById = new Map((D.preds || []).map((p) => [p.prediction_id, p]));
  const reviewByPred = new Map((D.reviews || []).map((x) => [x.prediction_id, x]));
  const champ = freeze.champion.model_version;
  const out = [];
  const add = (kind, e, cls) => {
    const p = predById.get(e.prediction_id) || null, rv = reviewByPred.get(e.prediction_id) || null;
    const c = checklist(e, p, rv);
    out.push({ kind, epoch: epochOf(e, freeze, versions), game_id: e.game_id, week: e.week, game: p ? p.away_team + ' @ ' + p.home_team : e.game_id,
      model_version: e.model_version, checkpoint: e.checkpoint_type, prediction_ts: p ? p.prediction_ts : null,
      edgedesk_fair: p ? p.fair_spread_display : null, final_margin: e.final_margin, error: e.abs_margin_error, close_error: e.close_abs_error,
      ats: e.ats_result || null, clv_points: num(e.clv_points) != null ? e.clv_points : (num(e.move_since_snapshot) != null ? e.move_since_snapshot : null),
      checklist: c, classification: cls(e, c, rv), lab_review: rv ? rv.classification : null });
  };
  const s = D.evals.filter(settled).filter((e) => e.model_version === champ);
  /* qualified wagers: the decision engine's BET only */
  s.filter((e) => e.decision_class === 'BET' && e.ats_result === 'LOSS').forEach((e) => add('QUALIFIED_LOSS', e, classifyLoss));
  s.filter((e) => e.decision_class === 'BET' && e.ats_result === 'WIN').forEach((e) => add('QUALIFIED_WIN', e, (x, c) => classifyWin(x, c)));
  /* large model misses: one row per game (official LIVE, else the last reconstructed number) */
  lastPerGame(s.filter((e) => e.origin === 'LIVE' ? e.checkpoint_type === 'T24' : true))
    .filter((e) => num(e.abs_margin_error) != null && e.abs_margin_error >= MISS).forEach((e) => add('LARGE_MISS', e, classifyLoss));
  /* research leans (hypothetical positions, not wagers): losses and wins, so a
     lucky research lean is never read as a good one */
  lastPerGame(s.filter((e) => e.decision_class === 'LEAN')).forEach((e) => {
    if (e.ats_result === 'LOSS') add('RESEARCH_LEAN_LOSS', e, classifyLoss);
    else if (e.ats_result === 'WIN') add('RESEARCH_LEAN_WIN', e, (x, c) => classifyWin(x, c));
  });
  const count = (k) => { const o = {}; out.filter((x) => !k || x.kind === k).forEach((x) => { o[x.classification] = (o[x.classification] || 0) + 1; }); return o; };
  return { threshold_points: MISS, rows: out.sort((a, b) => (ms(b.prediction_ts) || 0) - (ms(a.prediction_ts) || 0)),
    summary: { qualified_losses: count('QUALIFIED_LOSS'), qualified_wins: count('QUALIFIED_WIN'), large_misses: count('LARGE_MISS'),
      research_lean_losses: count('RESEARCH_LEAN_LOSS'), research_lean_wins: count('RESEARCH_LEAN_WIN') },
    rules: {
      loss: 'first match: BAD DATA (data failure) · NORMAL VARIANCE (Lab review: high-variance outcome) · BAD MODEL / BAD PRICE when the close neither came to EdgeDesk nor beat the price (BAD MODEL if the close missed by 7+ pts less) · GOOD PROCESS / BAD OUTCOME when EdgeDesk beat the close · NORMAL VARIANCE when the close missed nearly as badly · UNRESOLVED',
      win: 'GOOD PROCESS / GOOD OUTCOME when EdgeDesk beat the close or the market moved to it; BAD PROCESS / GOOD OUTCOME when it lost the close, the market moved away, or the projection missed by 14+ pts and the side still covered',
      scope: 'qualified wagers are the decision engine’s BET only (none exist while betting is disabled); research leans are hypothetical and labelled so; misses are |error| ≥ ' + MISS + ' pts'
    } };
}

/* ------------------------------------------------------ weekly scorecard */
function weekScorecard(D, week, freeze, versions, policy, season, gates) {
  const champ = freeze.champion.model_version;
  const champEvs = D.evals.filter((e) => e.model_version === champ);
  const cur = champEvs.filter((e) => official(e) && epochOf(e, freeze, versions) === 'CURRENT');
  const legacyAll = lastPerGame(champEvs.filter((e) => e.origin !== 'LIVE'));
  const useCurrent = cur.some((e) => +e.week === +week);
  const base = useCurrent ? cur : legacyAll;
  const inWeek = (e) => +e.week === +week && +e.season === +season;
  const rolling = (e) => +e.season === +season && +e.week <= +week && +e.week > +week - 4;
  const block = (rows) => {
    const s = rows.filter(settled);
    const fm = footballModel(s), mi = marketIntelligence(s), bd = bettingDecisions(s, policy);
    const decisions = { BET: rows.filter((e) => e.decision_class === 'BET').length, WAIT: rows.filter((e) => e.decision_class === 'WAIT').length,
      PASS: rows.filter((e) => e.decision_class !== 'BET' && e.decision_class !== 'WAIT').length };
    return {
      model_quality: { games_graded: fm.n, mae: fm.mae, median_error: fm.median_ae, worst_error: fm.worst_ae, interval_coverage_80: fm.interval_coverage.p80, calibration_error: fm.calibration_error },
      market_quality: { early_disagreements: rows.filter((e) => num(e.model_market_gap) != null && Math.abs(e.model_market_gap) >= 2).length,
        market_moved_toward_pct: mi.market_moved_toward_edgedesk_pct, average_clv: mi.average_clv_points },
      decisions: Object.assign(decisions, { qualified_wagers: bd.qualified_wagers.decisions || 0, ats: bd.qualified_wagers.decisions ? bd.qualified_wagers.wins + '-' + bd.qualified_wagers.losses + (bd.qualified_wagers.pushes ? '-' + bd.qualified_wagers.pushes : '') : '—',
        units: bd.qualified_wagers.decisions ? bd.qualified_wagers.units : null, betting_enabled: bd.betting_enabled })
    };
  };
  return {
    season, week, epoch: useCurrent ? 'CURRENT' : 'LEGACY',
    epoch_note: useCurrent ? 'LIVE official snapshots of the frozen champion' : 'LEGACY: no LIVE official snapshot for this week; reconstructed numbers (GIT_RECONSTRUCTED) — evidence of method, not the current record',
    this_week: block(base.filter(inWeek)),
    rolling_4_weeks: block(base.filter(rolling)),
    season_to_date: block(base.filter((e) => +e.season === +season && +e.week <= +week)),
    current_model_version: block(cur),
    research_gates: gates || null
  };
}

/* ------------------------------------------------------ research triggers */
function seOf(xs) { const s = sd(xs); return s == null ? null : s / Math.sqrt(xs.length); }
function triggers(D, freeze, versions, ctx) {
  ctx = ctx || {};
  const champ = freeze.champion.model_version;
  const cur = D.evals.filter((e) => e.model_version === champ && official(e) && settled(e) && epochOf(e, freeze, versions) === 'CURRENT').sort(byKick);
  const predById = new Map((D.preds || []).map((p) => [p.prediction_id, p]));
  const T = [];
  const add = (id, question, threshold, min_n, n, value, fired, evidence, source) => T.push({ id, question, threshold, min_n, n, value,
    status: n < min_n ? 'INSUFFICIENT_SAMPLE' : (fired ? 'FIRED' : 'QUIET'), evidence, source: source || 'LIVE' });
  /* 1 QB-change MAE */
  const UNRES = ['COMPETITION', 'UNKNOWN'];
  const qbState = (p) => { const x = p && p.inputs_ref && p.inputs_ref.qb_expected; if (!x || !x.home || !x.away) return null; return UNRES.indexOf(String(x.home.status)) >= 0 || UNRES.indexOf(String(x.away.status)) >= 0 ? 'UNRESOLVED' : 'RESOLVED'; };
  const qbUnsettled = cur.filter((e) => qbState(predById.get(e.prediction_id)) === 'UNRESOLVED');
  const qbSettled = cur.filter((e) => qbState(predById.get(e.prediction_id)) === 'RESOLVED');
  const a1 = qbUnsettled.map((e) => e.abs_margin_error), b1 = qbSettled.map((e) => e.abs_margin_error);
  const d1 = mean(a1) != null && mean(b1) != null ? mean(a1) - mean(b1) : null, se1 = a1.length > 1 && b1.length > 1 ? Math.sqrt(Math.pow(seOf(a1), 2) + Math.pow(seOf(b1), 2)) : null;
  add('QB_CHANGE_MAE', 'Is MAE persistently elevated when the quarterback is uncertain or changed?', 'MAE gap > 2 SE, n ≥ 30 in each group', 30, Math.min(a1.length, b1.length), r(d1, 2), d1 != null && se1 != null && d1 > 2 * se1,
    { uncertain_n: a1.length, settled_n: b1.length, mae_uncertain: r(mean(a1), 2), mae_settled: r(mean(b1), 2) });
  /* 2 favourite bias */
  const fb = cur.map((e) => { const p = predById.get(e.prediction_id); return p ? (p.pure_home_margin - e.final_margin) * (sign(p.pure_home_margin) || 1) : null; }).filter((x) => x != null);
  add('FAVORITE_BIAS', 'Does EdgeDesk persistently over-project its favourite?', '|mean favourite over-projection| > 2 SE, n ≥ 100', 100, fb.length, r(mean(fb), 2),
    fb.length > 1 && Math.abs(mean(fb)) > 2 * seOf(fb), { mean: r(mean(fb), 2), se: r(seOf(fb), 2) });
  /* 3 conference residual */
  const byConf = {};
  cur.forEach((e) => { const p = predById.get(e.prediction_id); if (!p) return; const c = (p.inputs_ref && p.inputs_ref.segment && p.inputs_ref.segment.home_conference) || null; if (!c) return; (byConf[c] = byConf[c] || []).push(e.final_margin - p.pure_home_margin); });
  const confHits = Object.keys(byConf).filter((c) => byConf[c].length >= 30 && Math.abs(mean(byConf[c])) > 2 * seOf(byConf[c]));
  const confMax = Object.keys(byConf).reduce((m, c) => Math.max(m, byConf[c].length), 0);
  add('CONFERENCE_RESIDUAL', 'Is there a conference-specific residual bias?', 'a home conference with n ≥ 30 and |mean residual| > 2 SE', 30, confMax, confHits.length, confHits.length > 0,
    { conferences: confHits.map((c) => ({ conference: c, n: byConf[c].length, mean_residual: r(mean(byConf[c]), 2) })) });
  /* 4 verified disagreements failing */
  const sv = ctx.signals ? ctx.signals.verified.summary : { settled: 0 };
  add('VERIFIED_FAILING', 'Are verified major disagreements failing systematically?', 'n ≥ 20 settled verified and the market moved toward EdgeDesk < 50% of the time', 20, sv.settled || 0, sv.market_moved_toward_pct,
    sv.market_moved_toward_pct != null && sv.market_moved_toward_pct < 50, { summary: sv });
  /* 5 calibration drift (the Lab's own alert rule) */
  const last100 = cur.slice(-100), fm = footballModel(last100);
  add('CALIBRATION_DRIFT', 'Has probability calibration or interval coverage drifted?', 'last-100 win ECE > 0.06, or 80% coverage outside 75–85%', 50, fm.n, fm.calibration_error,
    (fm.calibration_error != null && fm.calibration_error > 0.06) || (fm.interval_coverage.p80 != null && (fm.interval_coverage.p80 < 0.75 || fm.interval_coverage.p80 > 0.85)), { ece: fm.calibration_error, coverage_80: fm.interval_coverage.p80 });
  /* 6 CLV deterioration */
  const clv = cur.slice(-50).map((e) => e.move_since_snapshot).filter((x) => num(x) != null);
  add('CLV_DETERIORATION', 'Has closing-line value deteriorated?', 'last-50 mean CLV < 0 by more than 2 SE, n ≥ 50', 50, clv.length, r(mean(clv), 3), clv.length > 1 && mean(clv) < -2 * seOf(clv), { mean: r(mean(clv), 3), se: r(seOf(clv), 3) });
  /* 7 rating-state divergence linked to error: historical evidence + live check */
  const bt = ctx.backtest || null;
  if (bt) {
    add('DIVERGENCE_ERROR_HISTORICAL', 'Is large rating-state divergence linked to model error (historical walk-forward)?', 'holdout LARGE − LOW MAE difference, and a football-only correction clearing the 0.05 bar',
      30, bt.folds.HOLDOUT_2022_2025.LARGE.n, r(bt.folds.HOLDOUT_2022_2025.LARGE.mae - bt.folds.HOLDOUT_2022_2025.LOW.mae, 3),
      !!(bt.verdict.use_as_flag && bt.football_only_correction.clears_bar),
      { status: bt.verdict.status, holdout_ci: bt.mae_difference_large_minus_low_ci95.HOLDOUT_2022_2025, correction: bt.football_only_correction, seasons_large_worse: bt.fold_consistency.seasons_large_worse + ' of ' + bt.fold_consistency.seasons_scored },
      'HISTORICAL');
  }
  /* 8 MAE rising vs the pre-registered holdout reference (the Lab's rule) */
  const ref = ctx.reference_mae || null, l50 = cur.slice(-50).map((e) => e.abs_margin_error);
  add('MAE_RISING', 'Is the live MAE above the holdout reference?', 'last-50 MAE > reference + 2 SE (reference ' + (ref == null ? '—' : ref) + ')', 50, l50.length, r(mean(l50), 3),
    ref != null && l50.length > 1 && mean(l50) > ref + 2 * seOf(l50), { reference: ref, se: r(seOf(l50), 3) });
  const liveFired = T.filter((t) => t.status === 'FIRED' && t.source === 'LIVE');
  return { triggers: T, live_fired: liveFired.map((t) => t.id),
    state: liveFired.length ? 'RESEARCH TRIGGER: ' + liveFired.map((t) => t.id).join(', ') : 'NO STRUCTURAL MODEL ISSUE DETECTED',
    rule: 'A trigger opens research only when its threshold and minimum sample are both met. One ugly game never does. A fired trigger opens a research candidate; it never edits a model.' };
}

/* --------------------------------------------------- the research backlog */
function backlogEvents(existing, trig, now, bt) {
  const open = new Set((existing || []).filter((x) => x.event === 'OPENED').map((x) => x.candidate_id));
  const out = [];
  const openOne = (id, title, evidence, source) => {
    if (open.has(id)) return;
    open.add(id);
    out.push({ event: 'OPENED', candidate_id: id, created_at: now, title, evidence, source, stage: 'RESEARCH', next_stage: 'CHALLENGER',
      auto_implemented: false, governance: 'RESEARCH → CHALLENGER → WALK-FORWARD → SHADOW → PROMOTION (docs/cfb-validation/DELIVERABLE.md §24). Nothing here edits production.' });
  };
  (trig.triggers || []).filter((t) => t.status === 'FIRED').forEach((t) => {
    if (t.id === 'DIVERGENCE_ERROR_HISTORICAL' && bt) {
      openOne('rc_divergence_blend_v1', 'Large current-rating vs pricing-state divergence predicts margin error; a football-only blend of the divergence improves walk-forward MAE',
        { n_large_holdout: bt.folds.HOLDOUT_2022_2025.LARGE.n, mae_large_minus_low_holdout: r(bt.folds.HOLDOUT_2022_2025.LARGE.mae - bt.folds.HOLDOUT_2022_2025.LOW.mae, 3),
          holdout_ci: bt.mae_difference_large_minus_low_ci95.HOLDOUT_2022_2025, seasons_large_worse: bt.fold_consistency.seasons_large_worse + ' of ' + bt.fold_consistency.seasons_scored,
          longest_consecutive_run: bt.fold_consistency.longest_consecutive_run, favorite_overprojection_ci: bt.verdict.favorite_overprojection_difference_ci95,
          correction_beta: bt.football_only_correction.beta_fitted_on_dev, correction_holdout_mae_change: bt.football_only_correction.holdout_mae_change,
          correction_ci: bt.football_only_correction.holdout_change_ci, source_file: 'football/cfb_validation/divergence_backtest.json' }, 'HISTORICAL');
    } else {
      openOne('rc_' + t.id.toLowerCase(), t.question, { n: t.n, value: t.value, threshold: t.threshold, evidence: t.evidence }, t.source);
    }
  });
  return out;
}

/* ------------------------------------------------------- next 100 games */
function next100(plan, V) {
  const cur = V.find((v) => v.id === 'SINCE_UPGRADE');
  const n = cur.football_model.n;
  const measured = {
    margin_mae: cur.football_model.mae, calibration_error: cur.football_model.calibration_error, interval_coverage_80: cur.football_model.interval_coverage.p80,
    market_moved_toward_pct: cur.market_intelligence.market_moved_toward_edgedesk_pct, average_clv: cur.market_intelligence.average_clv_points,
    qualified_wagers: cur.betting_decisions.qualified_wagers.decisions || 0
  };
  return { plan_id: plan ? plan.plan_id : null, frozen_at: plan ? plan.frozen_at : null, target: 100, settled: n, progress_pct: Math.min(100, n),
    ready: n >= 100, measured, baselines: plan ? plan.baselines : null, monitored: plan ? plan.metrics : null,
    comparison: n >= 100 ? (plan ? plan.metrics.map((m) => ({ metric: m.id, current: measured[m.id] != null ? measured[m.id] : null,
      legacy: plan.baselines[m.id] ? plan.baselines[m.id].value : null, better_if: m.better_if })) : null) : null,
    note: n >= 100 ? 'Compared on identical definitions. A difference is read with its sample; nothing is changed to hit a number.' : 'Building: ' + n + ' of 100 settled official games since the freeze. No comparison is printed before 100.' };
}

/* ----------------------------------------------- the weekly executive report */
function executiveReport(sc, trig, signalsObj, season) {
  const w = sc.this_week, mq = w.model_quality, mk = w.market_quality, dc = w.decisions, g = sc.research_gates || {};
  const concern = (() => {
    if (sc.epoch === 'LEGACY') return 'No LIVE official snapshot graded this week: the numbers below are LEGACY (reconstructed). Nothing about the current version can be read from them.';
    if (mq.games_graded < 30) return 'Sample: ' + mq.games_graded + ' games graded — one week says little. Read the rolling and season lines.';
    if (mq.interval_coverage_80 != null && (mq.interval_coverage_80 < 0.7 || mq.interval_coverage_80 > 0.9)) return '80% interval coverage ' + Math.round(100 * mq.interval_coverage_80) + '% this week.';
    return 'None beyond ordinary weekly noise.';
  })();
  const lines = [
    'EDGEDESK CFB WEEK ' + sc.week + ' (' + season + ')' + (sc.epoch === 'LEGACY' ? ' — LEGACY NUMBERS' : ''),
    '',
    'Games: ' + mq.games_graded,
    'Margin MAE: ' + (mq.mae == null ? '—' : mq.mae) + ' (median ' + (mq.median_error == null ? '—' : mq.median_error) + ', worst ' + (mq.worst_error == null ? '—' : mq.worst_error) + ')',
    'Market movement toward early EdgeDesk: ' + (mk.market_moved_toward_pct == null ? '—' : mk.market_moved_toward_pct + '%'),
    'Average CLV: ' + (mk.average_clv == null ? '—' : mk.average_clv + ' pts'),
    'Verified major: ' + (g.verified == null ? '—' : g.verified),
    'Investigate: ' + (g.investigate == null ? '—' : g.investigate),
    'BET decisions: ' + dc.BET + (dc.betting_enabled ? '' : ' (betting disabled by policy)'),
    'Record: ' + dc.ats,
    'Primary concern: ' + concern,
    'Research trigger: ' + (trig.live_fired.length ? trig.live_fired.join(', ') : 'NONE — ' + trig.state),
    '',
    'Rolling 4 weeks: MAE ' + (sc.rolling_4_weeks.model_quality.mae == null ? '—' : sc.rolling_4_weeks.model_quality.mae) + ' on ' + sc.rolling_4_weeks.model_quality.games_graded + ' games · Season: MAE '
      + (sc.season_to_date.model_quality.mae == null ? '—' : sc.season_to_date.model_quality.mae) + ' on ' + sc.season_to_date.model_quality.games_graded + ' · Current version: '
      + sc.current_model_version.model_quality.games_graded + ' games graded.',
    'One week is never the verdict. No model change follows from this report; research triggers open candidates, promotions need walk-forward evidence.'
  ];
  return { text: lines.join('\n'), primary_concern: concern, research_trigger: trig.live_fired.length ? trig.live_fired : 'NONE', state: trig.state };
}

/* ------------------------------------------------- what changed since last week */
function systemDiff(prev, cur) {
  if (!prev) return { available: false, reason: 'no earlier system snapshot is on file', changes: [] };
  const ch = [];
  const cmp = (key, label, kind) => { if (JSON.stringify(prev[key]) !== JSON.stringify(cur[key])) ch.push({ what: label, kind, from: prev[key] == null ? null : prev[key], to: cur[key] == null ? null : cur[key] }); };
  cmp('champion', 'model version', 'SOFTWARE');
  cmp('pricing_fingerprint', 'pricing code', 'SOFTWARE');
  cmp('research_fingerprint', 'research-gate code', 'SOFTWARE');
  cmp('decision_policy', 'decision policy', 'SOFTWARE');
  cmp('calibration', 'calibration', 'SOFTWARE');
  cmp('modules', 'research modules / maturity', 'SOFTWARE');
  cmp('rating_week', 'current FBS power rating rebuilt', 'FOOTBALL');
  cmp('slate_generated_at', 'pricing slate rebuilt', 'FOOTBALL');
  cmp('qb_resolved_pct', 'QB coverage (% of slate games with both starters resolved)', 'FOOTBALL');
  cmp('market_multibook_pct', 'market coverage (% of slate games with 2+ fresh books)', 'MARKET');
  cmp('market_fresh_pct', 'market coverage (% of slate games with a fresh quote)', 'MARKET');
  return { available: true, since: prev.at, changes: ch,
    summary: ch.length ? ch.map((c) => c.kind + ': ' + c.what).join(' · ') : 'Nothing changed in software, football inputs or market coverage.' };
}

/* ------------------------------------------- projection-change attribution
   a, b: two terminal history snapshots of one game (football/cfb_terminal/
   history), a earlier. The pure fair line can only move for a football or a
   software reason: MARKET MOVEMENT IS NEVER AN ATTRIBUTION. A move that no
   stored input explains is UNATTRIBUTED — an integrity question, not a shrug. */
const TERM_CAUSE = { rating: 'TEAM_STATE_REFRESH', matchup: 'MATCHUP_UPDATE', hfa: 'HOME_VENUE_CORRECTION', injury: 'QB_ABSENCE_OR_AVAILABILITY',
  qb: 'QB_STATUS', conference: 'SCHEDULE_OR_CONFERENCE', schedule: 'SCHEDULE_OR_CONFERENCE', travel: 'TRAVEL', rivalry: 'RIVALRY' };
function attributeChange(a, b, threshold) {
  const th = num(threshold) != null ? threshold : 0.5;
  const d = num(a.home_margin) != null && num(b.home_margin) != null ? b.home_margin - a.home_margin : null;
  const out = { from_at: a.at, to_at: b.at, old_fair: a.home_margin, new_fair: b.home_margin, change: r(d, 2), material: d != null && Math.abs(d) >= th, causes: [] };
  if (d == null) { out.causes.push({ cause: 'UNAVAILABLE', detail: 'one of the two numbers is missing' }); return out; }
  if (a.model_version !== b.model_version) out.causes.push({ cause: 'MODEL_VERSION', detail: a.model_version + ' → ' + b.model_version });
  if (a.pricing_fingerprint && b.pricing_fingerprint && a.pricing_fingerprint !== b.pricing_fingerprint) out.causes.push({ cause: 'SOFTWARE_PATCH', detail: 'the pricing code changed between the two numbers (bug fix or patch)' });
  const gpA = a.games_played || {}, gpB = b.games_played || {};
  if ((num(gpB.home) || 0) > (num(gpA.home) || 0) || (num(gpB.away) || 0) > (num(gpA.away) || 0)) out.causes.push({ cause: 'NEW_GAME_ABSORBED', detail: 'a completed game was absorbed into a team state' });
  const qa = a.qb || {}, qb = b.qb || {};
  ['home', 'away'].forEach((s) => {
    const x = qa[s] || {}, y = qb[s] || {};
    if ((x.player || null) !== (y.player || null) || (x.status || null) !== (y.status || null)) out.causes.push({ cause: 'QB_STATUS', detail: s + ': ' + (x.player || '—') + ' (' + (x.status || '—') + ') → ' + (y.player || '—') + ' (' + (y.status || '—') + ')' });
  });
  /* a term split needs the components on BOTH numbers: against a snapshot
     that predates component capture, every term's full value would read as
     a "change" (a -1.6 move reported as a -12 team-state refresh) */
  const comps = (x) => { const c = x.components || x.terms; return c && typeof c === 'object' && Object.keys(c).length ? c : null; };
  const ta = comps(a), tb = comps(b);
  if (ta && tb) {
    let split = 0;
    Object.keys(Object.assign({}, ta, tb)).forEach((k) => {
      const x = num(ta[k]) || 0, y = num(tb[k]) || 0;
      if (Math.abs(y - x) >= 0.05) { out.causes.push({ cause: TERM_CAUSE[k] || 'OTHER_TERM', term: k, points: r(y - x, 2) }); split += y - x; }
    });
    out.unexplained = r(d - split, 2);
  } else if (Math.abs(d) >= 0.05) {
    out.causes.push({ cause: 'TERMS_NOT_RECORDED', detail: 'the ' + (ta ? 'later' : 'earlier') + ' snapshot carries no component split, so the move cannot be attributed by term' });
  }
  /* a rating change beside a new absorbed game is the absorption, not a separate refresh */
  if (out.causes.some((c) => c.cause === 'NEW_GAME_ABSORBED')) out.causes = out.causes.filter((c) => c.cause !== 'TEAM_STATE_REFRESH' || Math.abs(c.points || 0) < 0.05);
  if (!out.causes.some((c) => c.cause !== 'TERMS_NOT_RECORDED') && ta && tb && Math.abs(d) >= 0.05) out.causes.push({ cause: 'UNATTRIBUTED', detail: 'no stored input explains the move — checked as an integrity question; market movement cannot move the pure fair line' });
  return out;
}
function gameChanges(history, board, opts) {
  opts = opts || {};
  const rowsById = new Map(((board && board.rows) || []).map((x) => [String(x.game_id), x]));
  const by = new Map();
  (history || []).forEach((s) => { if (rowsById.has(String(s.game_id))) (by.get(s.game_id) || by.set(s.game_id, []).get(s.game_id)).push(s); });
  const out = [];
  by.forEach((list, gid) => {
    list.sort((a, b) => ms(a.at) - ms(b.at));
    if (list.length < 2) return;
    const a = list[0], b = list[list.length - 1], row = rowsById.get(String(gid));
    const ch = attributeChange(a, b, opts.threshold);
    out.push(Object.assign(ch, { game_id: gid, game: row.away + ' @ ' + row.home,
      market_then: a.market_home_line, market_now: b.market_home_line,
      market_change: num(a.market_home_line) != null && num(b.market_home_line) != null ? r(b.market_home_line - a.market_home_line, 2) : null,
      status_then: a.research_status || a.status || null, status_now: b.research_status || row.research_status || b.status || null,
      price_state: row.price_state_label || null }));
  });
  return out.sort((x, y) => Math.abs(y.change || 0) - Math.abs(x.change || 0));
}

module.exports = { attributeChange, gameChanges, versionAt, epochOf, footballModel, marketIntelligence, bettingDecisions, sections, views, lastPerGame, northStar,
  divergenceMonitor, signals, signalRows, signalSummary, investigateOutcome, postmortems, checklist, classifyLoss, classifyWin,
  weekScorecard, triggers, backlogEvents, next100, executiveReport, systemDiff, util: { num, r, mean, sd, q, ms } };
