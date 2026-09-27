#!/usr/bin/env node
/* ============================================================================
   CURRENT-SLATE MAJOR-DISAGREEMENT RETEST + the weekly report.

   Prices the current slate EXACTLY the way the board and the slate artifact
   do (football/fbs/build_coverage.js: the same rating replay, the same
   efficiency join, the same shared input contract football/matchup/inputs.js
   -> E.projectGame on the BASELINE request), joins the Model Lab's captured
   quotes for the week as the market, the V2 shadow's submodels as the
   independent football opinions, and runs every game through the integrity
   gate (lib/cfb_disagreement.js).

   For every raw 7+ gap it prints OLD FAIR, NEW PURE FAIR, MARKET, OLD GAP, NEW
   GAP, ROOT CAUSE, INTEGRITY STATUS and FINAL LABEL — the pure fair spread is
   NOT changed by this work, so OLD FAIR and NEW PURE FAIR are equal by
   construction and the table proves it.

   The weekly report adds: raw 7+/10+/15+ counts against their historical
   frequency (the circuit breaker), favourite flips, the components behind
   each gap, market movement since the opener, and — for weeks already
   played — the eventual results from the forensic replay.

     node tools/football/disagreement_slate.js [--season 2026] [--week 5]
          [--offline] [--now ISO] [--replay DIR/out/disagreement_replay.jsonl]
   Writes football/validation/disagreement/slate_<season>_week_<NN>.{json,md}
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const P = global.window.EDCfbP4Params;
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const IN = require(path.join(ROOT, 'football', 'matchup', 'inputs.js'));
const COV = require(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'));
const D = require(path.join(ROOT, 'lib', 'cfb_disagreement.js'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const SEASON = +arg('season', 2026);
const OFFLINE = !!arg('offline', false);
const NOW = arg('now', null) ? Date.parse(arg('now')) : Date.now();
const REPLAY = arg('replay', null);
const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;
const r1 = x => x == null ? null : Math.round(x * 10) / 10;
const r2 = x => x == null ? null : Math.round(x * 100) / 100;
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function readJsonl(f) { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } }
const median = a => { a = a.filter(x => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/* ------------------------------------------------------------ the market: the lab's captured quotes */
function marketFor(quotes, gid, now) {
  const rows = quotes.filter(q => String(q.game_id) === String(gid) && q.market_type === 'spread' && q.is_pregame !== false
    && num(q.home_line) != null && Date.parse(q.observed_at || q.retrieved_at) <= now);
  if (!rows.length) return null;
  const latest = {}, first = {};
  rows.forEach(q => {
    const k = q.source + '|' + q.book, t = Date.parse(q.observed_at || q.retrieved_at);
    if (!latest[k] || t > latest[k].t) latest[k] = { t, q };
    if (!first[k] || t < first[k].t || q.is_provider_open) first[k] = { t, q };
  });
  const cur = Object.values(latest).map(o => -o.q.home_line);
  const opn = Object.values(first).map(o => -o.q.home_line);
  const asOf = Math.max.apply(null, Object.values(latest).map(o => o.t));
  const any = Object.values(latest)[0].q;
  return {
    spread: median(cur), open_spread: median(opn), books: cur.length,
    range: cur.length > 1 ? Math.max.apply(null, cur) - Math.min.apply(null, cur) : null,
    as_of: new Date(asOf).toISOString(), stale: false,
    home_team: any.home_team, away_team: any.away_team, kickoff: any.kickoff_ts,
    sources: Object.keys(latest), source: 'cfb_lab quotes (' + Object.keys(latest).join(', ') + ')'
  };
}

/* ------------------------------------------------------------ V2 submodels (independent football opinions) */
function submodelsFor(v2rows, gid) {
  const row = v2rows[String(gid)];
  if (!row || row.ens_pred == null) return null;
  const pr = {};
  Object.keys(row.components || {}).forEach(k => { pr['v2.1 ' + k] = row.components[k]; });
  const c1 = row.shadow && row.shadow.candidate_001;
  if (c1 && num(c1.ens_pred) != null) pr['v2 candidate 001 ensemble'] = c1.ens_pred;
  return { source: 'football/cfb_v2/current.json (' + (row.state || 'shadow') + ')', projections: pr, ensemble: row.ens_pred, ensemble_sd: row.ens_sd };
}

function contractState(asm, field, side) {
  const f = (asm && asm.contract || []).find(x => x.field === field && (side == null || x.side === side));
  return f ? f.state : null;
}

function oldLabel(gapAbs) {
  if (gapAbs == null) return 'NO MARKET';
  if (gapAbs > 21) return 'LOW RELIABILITY (guard) / board DATA FAULT';
  if (gapAbs >= 7) return 'MAJOR DISAGREEMENT (board: INVESTIGATE)';
  if (gapAbs >= 2) return 'WORTH RESEARCHING';
  return 'MARKET ALIGNED';
}

async function main() {
  /* ---------------- the rating state, exactly as build_coverage replays it */
  const rowsBySeason = {};
  let target = null;
  for (let y = P.trained_through_season + 1; y <= SEASON; y++) {
    let text = null;
    try { text = await COV.loadSeason(y, OFFLINE); } catch (e) { console.error('[slate] ' + y + ': ' + e.message); }
    if (!text) continue;
    rowsBySeason[y] = COV.normRows(COV.parseCsv(text));
    if (y === SEASON) target = rowsBySeason[y];
  }
  if (!target) { console.error('[slate] no ' + SEASON + ' schedule'); return 2; }
  const universe = FBS.buildUniverse({ rows: target, season: SEASON, source: 'cfbfastR-data schedules ' + SEASON, params: P,
    knownFbs: (P.rating && P.rating.seed_ratings) || null });
  const eff = readJson(path.join(ROOT, 'football', 'rankings', 'engine_efficiency.json'), null);
  const { st } = COV.buildState(rowsBySeason, SEASON, eff && +eff.season === SEASON ? eff : null);
  const canon = readJson(path.join(ROOT, 'football', 'rating', 'current.json'), null);
  if (canon && +canon.season === SEASON) E.ingest.setCanonicalRatings(st, canon, { strip_availability: true, source: 'EdgeDesk national ETSR (research)' });
  const built = FBS.buildSlate({ rows: target, universe, now: NOW, lookaheadDays: 10 });
  const ctx = IN.load({ season: SEASON, params: P, normKey: FBS.normKey });
  const ratingIndex = Object.assign({}, st.r);
  Object.keys(st.canonicalRatings || {}).forEach(k => { ratingIndex[k] = st.canonicalRatings[k].value; });
  const si = IN.scheduleIndex(target, ratingIndex);

  const week = +arg('week', built.items.length ? Math.min.apply(null, built.items.map(it => +it.g.week || 99)) : 0);
  const pad = String(week).padStart(2, '0');
  const quotes = readJsonl(path.join(ROOT, 'football', 'cfb_lab', 'ledger', String(SEASON), 'quotes', 'week_' + pad + '.jsonl'));
  const v2 = readJson(path.join(ROOT, 'football', 'cfb_v2', 'current.json'), { rows: [] });
  const v2rows = {};
  (v2.rows || []).forEach(r => { v2rows[String(r.game_id)] = r; });
  const slateArt = readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'), { games: [] });
  const relBy = {};
  (slateArt.games || []).forEach(g => { relBy[String(g.game_id)] = g.reliability_score; });

  const games = [];
  for (const it of built.items) {
    const g = it.g;
    if (+g.week !== week) continue;
    let asm, p;
    try {
      asm = IN.buildRequest(ctx, { game: g, meta: it.meta, state: st, schedule_index: si, now: NOW });
      p = E.projectGame(asm.baseline);
    } catch (e) { games.push({ game_id: String(g.game_id), home: g.home_team, away: g.away_team, error: String(e && e.message) }); continue; }
    if (!p || p.status !== 'PREDICTED') { games.push({ game_id: String(g.game_id), home: g.home_team, away: g.away_team, status: p && p.status }); continue; }
    const mkt = marketFor(quotes, g.game_id, NOW);
    const fault = mkt ? E.market.orientationFault(p.model.fair_spread, mkt.spread, { bound: 21, reconcile: 7 }) : null;
    /* PURITY: the same request with a market attached must price the same */
    const withMkt = E.projectGame(Object.assign({}, asm.baseline, { market: mkt ? { spread_line: mkt.spread } : {} }));
    const pureOk = withMkt.status === 'PREDICTED' && withMkt.model.fair_spread === p.model.fair_spread;
    const sh = asm.starters || {};
    function qbSide(rec) {
      if (!rec) return null;
      return { status: rec.status, player: rec.player_name, availability: rec.availability && rec.availability.state, change: false };
    }
    const proj = D.fromEngine(p);
    const input = {
      now_ms: NOW,
      game: { game_id: String(g.game_id), home: g.home_team, away: g.away_team, kickoff: g.start_date, neutral_site: !!g.neutral_site,
        venue: g.venue, home_fbs: it.meta ? it.meta.home.is_fbs !== false : true, away_fbs: it.meta ? it.meta.away.is_fbs !== false : true },
      mapping: { teams_resolved: true },
      projection: proj,
      market: mkt ? Object.assign({}, mkt, { fault: !!fault }) : { spread: null, fault: !!fault },
      submodels: submodelsFor(v2rows, g.game_id),
      qb: { home: qbSide(sh.home), away: qbSide(sh.away) },
      roster: { home: { feed_state: contractState(asm, 'availability', 'home') }, away: { feed_state: contractState(asm, 'availability', 'away') } },
      reliability: num(relBy[String(g.game_id)]),
      long_term_vs_current_delta: (function () {
        const rd = proj.rating_detail;
        if (Math.min(rd.home_gp || 0, rd.away_gp || 0) < 3) return null;
        return (rd.home_carried - rd.away_carried) - (rd.home_fresh - rd.away_fresh);
      })(),
      state: { season: SEASON, fresh: true }
    };
    if (fault) { input.market.spread = null; }
    const ev = D.evaluate(input);
    ev.week = week;
    const gap = mkt && !fault ? p.model.fair_spread - mkt.spread : null;
    games.push({
      game_id: String(g.game_id), home: g.home_team, away: g.away_team, kickoff: g.start_date, neutral_site: !!g.neutral_site,
      home_conference: g.home_conference, away_conference: g.away_conference,
      old_fair: r2(p.model.fair_spread), new_pure_fair: r2(p.model.fair_spread), pure_invariant_to_market: pureOk,
      calibrated_shadow: ev.calibrated ? ev.calibrated.margin : null,
      market: mkt ? r2(mkt.spread) : null, market_open: mkt ? r2(mkt.open_spread) : null, market_books: mkt ? mkt.books : 0,
      market_sources: mkt ? mkt.sources : [], market_as_of: mkt ? mkt.as_of : null,
      old_gap: gap == null ? null : r2(gap), new_gap: gap == null ? null : r2(gap), calibrated_gap: ev.calibrated ? ev.calibrated.gap : null,
      old_label: oldLabel(gap == null ? null : Math.abs(gap)),
      final_label: ev.status_label || (gap == null ? 'NO MARKET' : null), status: ev.status || null,
      verified: !!ev.verified, verified_market_gap: ev.verified_market_gap || null,
      root_cause: ev.root_cause ? ev.root_cause.primary : null, integrity: ev.groups || null,
      failed: ev.failed || [], incomplete: ev.incomplete || [], warnings: ev.warnings || [],
      favorite_flip: !!ev.favorite_flip, flags: ev.flags || [], tier: ev.tier || null,
      decomposition: ev.decomposition || null, cross_model: ev.cross_model || null, explanation: ev.explanation || null,
      checks: ev.checks || [], movement: mkt && mkt.open_spread != null && gap != null ? D.movement({ raw_market_gap: gap, market_line: mkt.open_spread, verified: ev.verified }, { spread: mkt.spread, books: mkt.books }) : null,
      evaluation: { raw_gap_abs: ev.raw_gap_abs, raw_market_gap: ev.raw_market_gap, available: ev.available, week }
    });
  }

  const evals = games.filter(g => g.evaluation && g.evaluation.available).map(g => g.evaluation);
  const cb = D.circuitBreaker(evals);
  const major = games.filter(g => g.old_gap != null && Math.abs(g.old_gap) >= 7);
  const report = {
    schema: 'edgedesk_cfb_disagreement_slate_v1', season: SEASON, week, generated_at: new Date(NOW).toISOString(),
    gate: D.version, engine: P.model_version, pure_fair_changed: games.some(g => g.old_fair !== g.new_pure_fair),
    purity_check: { games: games.filter(g => g.pure_invariant_to_market != null).length, all_invariant: games.every(g => g.pure_invariant_to_market !== false) },
    counts: {
      games: games.length, with_market: evals.length,
      raw_7plus: major.length, raw_10plus: games.filter(g => g.old_gap != null && Math.abs(g.old_gap) >= 10).length,
      raw_15plus: games.filter(g => g.old_gap != null && Math.abs(g.old_gap) >= 15).length,
      favorite_flips_7plus: major.filter(g => g.favorite_flip).length,
      by_status: games.reduce((o, g) => { const k = g.status || (g.old_gap == null ? 'NO_MARKET' : 'n/a'); o[k] = (o[k] || 0) + 1; return o; }, {}),
      verified: games.filter(g => g.verified).length
    },
    circuit_breaker: cb,
    former_major_disagreements: major.map(g => ({ game: g.away + ' @ ' + g.home, game_id: g.game_id, old_fair: g.old_fair, new_pure_fair: g.new_pure_fair,
      market: g.market, old_gap: g.old_gap, new_gap: g.new_gap, calibrated_gap: g.calibrated_gap, root_cause: g.root_cause,
      integrity: g.integrity, failed: g.failed, incomplete: g.incomplete, final_label: g.final_label, survived: g.verified })),
    components_behind_7plus: major.map(g => ({ game: g.away + ' @ ' + g.home, decomposition: g.decomposition })),
    games
  };

  /* completed weeks this season: eventual results from the forensic replay */
  if (REPLAY && fs.existsSync(REPLAY)) {
    const rows = readJsonl(REPLAY).filter(x => x.season === SEASON && x.completed && x.home_fbs && x.away_fbs && x.mkt && x.mkt.close_home_line != null);
    const byWeek = {};
    rows.forEach(x => {
      const close = -x.mkt.close_home_line, gap = x.fair - close;
      if (Math.abs(gap) < 7) return;
      const w = byWeek[x.week] || (byWeek[x.week] = { raw_7plus: 0, edgedesk_closer_than_close: 0, side_covered: 0, games: [] });
      w.raw_7plus++;
      if (Math.abs(x.fair - x.final_margin) < Math.abs(close - x.final_margin)) w.edgedesk_closer_than_close++;
      if (Math.sign(x.final_margin - close) === Math.sign(gap)) w.side_covered++;
      w.games.push({ game: x.away + ' @ ' + x.home, fair: x.fair, close, gap: r2(gap), final: x.final_margin });
    });
    report.completed_weeks = byWeek;
  }

  const dir = path.join(ROOT, 'football', 'validation', 'disagreement');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, 'slate_' + SEASON + '_week_' + pad);
  fs.writeFileSync(base + '.json', JSON.stringify(report, null, 1) + '\n');
  fs.writeFileSync(base + '.md', markdown(report));
  console.error('[slate] week ' + week + ': ' + games.length + ' games, ' + evals.length + ' with a market, raw 7+ ' + major.length
    + ', verified ' + report.counts.verified + ' -> ' + base + '.{json,md}');
  return 0;
}

function markdown(R) {
  const L = [];
  const t = (rows, head) => { L.push('| ' + head.join(' | ') + ' |'); L.push('|' + head.map(() => '---').join('|') + '|'); rows.forEach(r => L.push('| ' + r.map(v => v == null ? '—' : String(v).replace(/\|/g, '/')).join(' | ') + ' |')); L.push(''); };
  L.push('# CFB ' + R.season + ' week ' + R.week + ' — major-disagreement retest and weekly report');
  L.push('');
  L.push('GENERATED by `tools/football/disagreement_slate.js` at ' + R.generated_at + '. Engine ' + R.engine + ', gate ' + R.gate + '. The pure fair spread was '
    + (R.pure_fair_changed ? '**CHANGED — this is a defect**' : 'not changed (OLD FAIR = NEW PURE FAIR on every game)') + '; pricing every game again WITH its market attached gave '
    + (R.purity_check.all_invariant ? 'the identical fair spread on all ' + R.purity_check.games + ' games' : '**a different number — a purity defect**') + '.');
  L.push('');
  const C = R.counts;
  L.push('Games ' + C.games + ', with a market ' + C.with_market + '. Raw gaps: 7+ **' + C.raw_7plus + '**, 10+ **' + C.raw_10plus + '**, 15+ **' + C.raw_15plus + '**; favourite flips at 7+: ' + C.favorite_flips_7plus + '. VERIFIED: **' + C.verified + '**.');
  L.push('');
  L.push('Statuses: ' + Object.keys(C.by_status).map(k => k + ' ' + C.by_status[k]).join(', ') + '.');
  L.push('');
  const cb = R.circuit_breaker;
  L.push('Circuit breaker: observed 7+/10+/15+ = ' + cb.observed.g7 + '/' + cb.observed.g10 + '/' + cb.observed.g15 + ' against a historical expectation of ' + cb.expected.g7 + '/' + cb.expected.g10 + '/' + cb.expected.g15
    + ' (P(at least) ' + cb.p_at_least.g7 + '/' + cb.p_at_least.g10 + '/' + cb.p_at_least.g15 + '). ' + (cb.alert ? '**' + cb.alert + '** — ' + cb.alert_why : 'No MODEL_SCALE_ALERT.')
    + ' Mean signed gap ' + cb.mean_signed_gap + (cb.zero_center_alert ? ' — ' + cb.zero_center_alert : '') + '.');
  L.push('');
  L.push('## Every former MAJOR DISAGREEMENT');
  L.push('');
  t(R.former_major_disagreements.map(g => [g.game, g.old_fair, g.new_pure_fair, g.market, g.old_gap, g.new_gap, g.calibrated_gap, g.root_cause,
    g.integrity ? Object.keys(g.integrity).map(k => k + ':' + g.integrity[k]).join(' ') : '', g.final_label, g.survived ? 'SURVIVED' : 'no']),
    ['game (away @ home)', 'OLD FAIR (home margin)', 'NEW PURE FAIR', 'MARKET', 'OLD GAP', 'NEW GAP', 'calibrated gap', 'ROOT CAUSE', 'INTEGRITY', 'FINAL LABEL', 'survived']);
  L.push('## Why each one failed or passed');
  L.push('');
  R.games.filter(g => g.old_gap != null && Math.abs(g.old_gap) >= 7).forEach(g => {
    const X = g.explanation || {};
    L.push('### ' + g.away + ' @ ' + g.home + ' — ' + g.final_label);
    L.push('');
    L.push('EdgeDesk ' + (X.edgedesk || g.old_fair) + ' · market ' + (X.market || g.market) + ' · raw gap ' + X.raw_gap + ' toward ' + X.toward + ' · calibrated gap ' + X.calibrated_gap
      + (X.favorite_flip ? ' · FAVOURITE FLIP' : '') + ' · base-rating gap ' + X.base_rating_gap + ' · market ' + X.market_summary + ' · submodels ' + X.ensemble + '.');
    L.push('');
    (X.sources || []).forEach(s => L.push('- ' + s.text));
    L.push('- ' + X.equation);
    (X.submodels || []).forEach(s => L.push('- submodel ' + s));
    L.push('');
    t((g.checks || []).map(c => [c.group, c.id, c.status, c.detail, c.cause]), ['group', 'check', 'status', 'detail', 'cause if failed']);
  });
  if (R.completed_weeks) {
    L.push('## Weeks already played this season (raw 7+ gaps vs the close)');
    L.push('');
    t(Object.keys(R.completed_weeks).map(w => { const x = R.completed_weeks[w]; return [w, x.raw_7plus, x.edgedesk_closer_than_close, x.side_covered]; }), ['week', 'raw 7+', 'EdgeDesk closer than close', 'EdgeDesk side covered']);
  }
  return L.join('\n') + '\n';
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error(e && e.stack || e); process.exit(2); });
}
module.exports = { marketFor, submodelsFor };
