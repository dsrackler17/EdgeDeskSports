/* ============================================================================
   EdgeDesk CFB research terminal — MARKET RESILIENCE, the build side.
   docs/market-resilience/README.md

   The terminal build (build.js) calls this once per game, after the research
   object exists. It reads what the build already loaded, and adds:

     market_state   lib/edgedesk_market_state.js classify(): LIVE / CACHED /
                    HISTORICAL / MANUAL / UNAVAILABLE / FAULT, with the
                    integrity checks, the provider status and what each state
                    may feed
     resilience     lib/edgedesk_research_engine.js build(), stored compact:
                    the three axes (research visibility, market integrity,
                    betting validation), the disagreement, the sensitivity
                    panel, the model-only research priority and the research
                    verdict. The page rebuilds the full six sections from the
                    same inputs (and in research-only mode) with the same code.
     carryover      the champion's prior-season share per team, from the
                    slate's own rating_detail and the learned prior-weight
                    curve — the input the sensitivity panel re-weights

   and keeps an APPEND-ONLY ledger of what EdgeDesk said and what market it
   saw, once per change (football/cfb_terminal/history/<season>/
   research_snapshots.jsonl): never rewritten, so what EdgeDesk predicted at
   the time stays apart from anything learned afterwards.

   Nothing here fetches anything. The market is whatever the Model Lab ledger
   already holds; an unreachable provider shows up as an ageing market and a
   provider status, never as a missing research page.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const MKS = require(path.join(ROOT, 'lib', 'edgedesk_market_state.js'));
const RENG = require(path.join(ROOT, 'lib', 'edgedesk_research_engine.js'));

function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
function ms(t) { const x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
function sha(x) { return crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex'); }
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch (e) { return dflt === undefined ? null : dflt; } }
function readJsonl(p) {
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

/* ------------------------------------------------------------ switches */
function heartbeatsConfirm() { return process.env.TERMINAL_HEARTBEATS_CONFIRM !== '0'; }
/* RESEARCH ONLY: --mode research-only, or EDGEDESK_MODE=RESEARCH_ONLY */
function mode(argv) {
  argv = argv || process.argv;
  const i = argv.indexOf('--mode');
  const m = String(i > 0 ? argv[i + 1] : (process.env.EDGEDESK_MODE || '')).toUpperCase().replace(/-/g, '_');
  return m === 'RESEARCH_ONLY' ? 'RESEARCH_ONLY' : 'FULL';
}

/* ------------------------------------------------------ provider status
   The terminal's market comes from the Model Lab's hourly capture (ESPN →
   DraftKings, CFBD) and, when configured, the Odds API via the capture
   function. The status explains an ageing market; it never makes a quote
   fresh or stale. */
function providerStatus(season, now) {
  const ph = readJson('football/cfb_lab/reports/' + season + '/provider_health.json', null);
  const q = readJson('football/markets/odds_quota_status.json', null);
  const out = { status: 'UNKNOWN', checked_at: null, detail: null, providers: {} };
  if (q && q.status && q.status !== 'OK') {
    out.status = String(q.status).toUpperCase(); out.checked_at = q.checked_at || null; out.detail = q.detail || 'odds quota state';
  }
  if (ph && ph.breakers) {
    const b = ph.breakers.espn_scoreboard || null;
    Object.keys(ph.breakers).forEach((k) => { const x = ph.breakers[k]; out.providers[k] = { state: x.state, last_success_at: x.last_success_at, last_error_class: x.last_error_class || null }; });
    if (b && out.status === 'UNKNOWN') {
      out.checked_at = b.last_success_at && (!b.last_failure_at || ms(b.last_success_at) >= ms(b.last_failure_at)) ? b.last_success_at : (b.last_failure_at || b.last_success_at);
      if (b.state === 'OPEN') { out.status = 'OUTAGE'; out.detail = 'ESPN scoreboard circuit open' + (b.last_error ? ': ' + String(b.last_error).slice(0, 120) : ''); }
      else if ((b.consecutive_failures || 0) > 0) {
        const cls = String(b.last_error_class || '').toUpperCase();
        out.status = /TIMEOUT/.test(cls) ? 'TIMEOUT' : (/RATE|429/.test(cls) ? 'RATE_LIMITED' : 'OUTAGE');
        out.detail = b.consecutive_failures + ' consecutive failure(s): ' + (b.last_error || cls || 'unknown');
      } else out.status = 'OK';
      /* a capture that last succeeded long ago is an outage whatever the breaker says */
      if (out.status === 'OK' && now != null && b.last_success_at && (now - ms(b.last_success_at)) > 6 * 3600e3) { out.status = 'OUTAGE'; out.detail = 'no successful capture for ' + Math.round((now - ms(b.last_success_at)) / 3600e3) + ' h'; }
    }
  }
  return out;
}

/* ---------------------------------------------------------- manual entries
   football/markets/manual/cfb_<season>.jsonl, append-only, written by
   tools/football/manual_market.js. Always labelled MANUAL; never LIVE. */
function manualEntries(season) {
  const by = new Map();
  readJsonl('football/markets/manual/cfb_' + season + '.jsonl').forEach((r) => {
    if (!r || r.game_id == null || r.withdrawn) return;
    const k = String(r.game_id);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  });
  /* a later withdrawal row removes the entry it names */
  readJsonl('football/markets/manual/cfb_' + season + '.jsonl').filter((r) => r && r.withdraws).forEach((w) => {
    by.forEach((list, k) => by.set(k, list.filter((r) => r.entry_id !== w.withdraws)));
  });
  return by;
}

/* ------------------------------------------------------------ carryover
   The champion's team strength is w·carried + (1−w)·this_season
   (football/cfb_p4/engine.js blendedRating). The slate publishes carried and
   this-season per side (disagreement_inputs.projection.rating_detail); the
   weight per side is the regime curve's when it fired, else the learned curve
   at that side's games played. `reconstructed` re-adds them so the panel can
   say whether its re-weighting is exact or approximate. */
function carryoverOf(row, params) {
  const di = row && row.disagreement_inputs, rd = di && di.projection && di.projection.rating_detail;
  if (!rd || num(rd.home_carried) == null || num(rd.away_carried) == null || num(rd.home_fresh) == null || num(rd.away_fresh) == null) return null;
  const curve = params && params.blend && params.blend.prior_weight_by_week;
  const wAt = (g) => { if (!curve || g == null) return null; const k = String(Math.max(0, Math.min(15, Math.round(g)))); return num(curve[k]) != null ? curve[k] : num(curve['15']); };
  const reg = row.regime || {};
  const side = (s) => {
    const gp = num(rd[s + '_gp']) != null ? rd[s + '_gp'] : null, r = reg[s];
    const regimeApplied = !!(r && r.regime_change && r.applied && num(r.weight) != null);
    const w = regimeApplied ? r.weight : wAt(gp);
    return { carried: rd[s + '_carried'], this_season: rd[s + '_fresh'], weight: w, standard_weight: regimeApplied ? r.standard_weight : w,
      games_played: gp, regime: regimeApplied, regime_reason: regimeApplied ? r.reason : null };
  };
  const home = side('home'), away = side('away');
  if (home.weight == null || away.weight == null) return null;
  const floor = curve ? Math.min.apply(null, Object.keys(curve).map((k) => curve[k]).filter((x) => num(x) != null)) : 0.6;
  const val = (x) => x.weight * x.carried + (1 - x.weight) * x.this_season;
  return { home, away, curve_floor: floor, rating_term: di.projection.components ? num(di.projection.components.rating) : null,
    reconstructed: Math.round((val(home) - val(away)) * 1000) / 1000, source: 'football/fbs/slate.json disagreement_inputs.projection.rating_detail · football/cfb_p4/params.js blend.prior_weight_by_week' };
}

/* --------------------------------------------------------- market quotes
   Every captured main-line spread and total for the game up to the build's
   clock, in the market-state layer's shape. A heartbeat confirms the change
   row before it (same values), so a steady line keeps its first-seen time
   AND says when it was last seen. */
function quotesFor(ledger, gid, row, now) {
  const out = [];
  const take = (list, type) => {
    const sorted = (list || []).filter((q) => ms(q.observed_at) != null && ms(q.observed_at) <= now).slice().sort((a, b) => ms(a.observed_at) - ms(b.observed_at));
    const last = {};
    sorted.forEach((q) => {
      const key = String(q.source) + '|' + String(q.book);
      const vals = type === 'total' ? [q.total_points, q.price_home, q.price_away, q.price_over, q.price_under] : [q.home_line, q.price_home, q.price_away];
      const prev = last[key];
      if (q.is_heartbeat && prev && JSON.stringify(prev.vals) === JSON.stringify(vals)) { prev.raw.confirmed_at = q.observed_at; return; }
      const raw = { book: q.book, source: q.source, market_type: type, game_id: q.game_id != null ? String(q.game_id) : gid, season: num(q.season),
        kickoff_ts: q.kickoff_ts || null, home_team: q.home_team || null, away_team: q.away_team || null,
        home_line: type === 'spread' ? q.home_line : null, total: type === 'total' ? q.total_points : null,
        price_home: type === 'spread' ? num(q.price_home) : null, price_away: type === 'spread' ? num(q.price_away) : null,
        /* the Lab stores a total's over/under prices in price_over/price_under (or, in older rows, price_home/price_away) */
        price_over: type === 'total' ? (num(q.price_over) != null ? q.price_over : num(q.price_home)) : null,
        price_under: type === 'total' ? (num(q.price_under) != null ? q.price_under : num(q.price_away)) : null,
        observed_at: q.observed_at, confirmed_at: q.observed_at, quote_id: q.quote_id || null, is_pregame: q.is_pregame !== false };
      last[key] = { vals, raw };
      out.push(raw);
    });
  };
  take(ledger.quotes.get(gid), 'spread');
  take(ledger.totals ? ledger.totals.get(gid) : null, 'total');
  return out;
}

/* ------------------------------------------------------------ per game */
function buildFor(o, row, ctx) {
  const gid = String(o.game_id), g = o.game || {}, A = o.edgedesk || {};
  const snap = MKS.classify({
    game: { game_id: gid, season: o.season, kickoff: o.kickoff, home: g.home, away: g.away },
    now: ctx.now, quotes: quotesFor(ctx.ledger, gid, row, ctx.now), manual: (ctx.manual.get(gid) || []),
    provider: ctx.provider, model: { home_margin: A.available ? A.home_margin : null, fair_total: A.available ? A.fair_total : null },
    config: { live_minutes: ctx.cfg.stale_minutes, sport: 'cfb' }
  });
  const carry = carryoverOf(row, ctx.params);
  const full = RENG.build(o, snap, { now: ctx.now, mode: ctx.mode, betting_enabled: ctx.betting_enabled, carryover: carry });
  return { market_state: snap, carryover: carry, resilience: compact(full), full };
}
/* what games.json keeps: the decisions and the explanation; the page
   rebuilds the six sections from the research object with the same engine */
function compact(r) {
  return { version: r.version, generated_at: r.generated_at, mode: r.mode, axes: r.axes, disagreement: r.disagreement,
    verdict: r.sections.verdict, market: r.sections.market, sensitivity: r.sensitivity, research_priority: r.research_priority,
    market_state: r.market_state, rules: r.rules };
}
function boardFields(o, x) {
  const r = x.resilience, ms0 = x.market_state, A = (o && o.edgedesk) || {};
  return { research_priority: { score: r.research_priority.score, reasons: r.research_priority.reasons.map((k) => k.label + ': ' + k.text), components: r.research_priority.components },
    market_state: { state: ms0.state, label: ms0.label, age_text: ms0.age_text, captured_at: ms0.captured_at, verified: ms0.verified, integrity: ms0.integrity.status,
      spread: ms0.spread.available ? ms0.spread.value : null, total: ms0.total.available ? ms0.total.value : null, provider: ms0.provider.status },
    verdict: { key: r.verdict.key, headline: r.verdict.headline, tone: r.verdict.tone },
    axes: { research_visibility: r.axes.research_visibility.key, market_integrity: r.axes.market_integrity.key, betting_validation: r.axes.betting_validation.key },
    research_disagreement: r.disagreement.available ? { key: r.disagreement.key, points: r.disagreement.points, toward_team: r.disagreement.toward_team, market_basis: r.disagreement.market_basis } : null,
    /* the projection itself on the fast board, so a market-less row still reads as research */
    fair_total: A.available && num(A.fair_total) != null ? A.fair_total : null,
    projected_score: A.available && A.projected_score ? { home: A.projected_score.home, away: A.projected_score.away } : null,
    win_prob: A.available ? { home: A.home_win_prob, away: A.away_win_prob } : null };
}

/* ---------------------------------------------- research snapshot ledger
   APPEND-ONLY, once per change. A snapshot holds what EdgeDesk projected,
   with which model and inputs, and exactly which market it saw (source,
   capture time, validation status, integrity failures) — the record that
   lets a later grade separate "what we said then" from "what we learned". */
function snapshotPath(season) { return path.join(__dirname, 'history', String(season), 'research_snapshots.jsonl'); }
function loadSnapshots(season) {
  const p = snapshotPath(season), m = new Map();
  if (!fs.existsSync(p)) return m;
  fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).forEach((l) => { try { const r = JSON.parse(l); const k = String(r.game_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } catch (e) { /* a torn line is skipped, never rewritten */ } });
  return m;
}
function snapshotRow(o, x, meta) {
  const A = o.edgedesk || {}, S = x.market_state, R = x.resilience;
  const content = {
    game_id: String(o.game_id), season: o.season, week: o.week, kickoff: o.kickoff,
    model_version: A.available ? A.model_version : null, prediction_ts: A.available ? A.prediction_ts : null, input_version: meta.inputs_sha256,
    projection: A.available ? { home_margin: A.home_margin, fair_text: A.fair_text, fair_total: num(A.fair_total), home_win_prob: A.home_win_prob, sigma: A.sigma,
      football_confidence: A.football_confidence ? A.football_confidence.score : null } : null,
    market: { state: S.state, sources: S.sources, captured_at: S.captured_at, spread_home_line: S.spread.available ? S.spread.value : null,
      total: S.total.available ? S.total.value : null, verified: S.verified, integrity_status: S.integrity.status,
      integrity_failures: S.integrity.failures.map((f) => ({ book: f.book, source: f.source, codes: f.codes })),
      held: S.integrity.held.map((h) => ({ book: h.book, total: h.total, codes: h.codes })), provider: S.provider.status },
    research_visibility: R.axes.research_visibility.key, market_integrity: R.axes.market_integrity.key, betting_validation: R.axes.betting_validation.key,
    research_disagreement: R.disagreement.available ? { key: R.disagreement.key, points: R.disagreement.points, toward_team: R.disagreement.toward_team } : null,
    research_verdict: R.verdict.key, research_priority: R.research_priority.score,
    engine: { market_state: MKS.VERSION, research_engine: RENG.VERSION }
  };
  const id = 'cfbr_' + sha(content).slice(0, 24);
  return Object.assign({ snapshot_id: id, observed_at: new Date(meta.now).toISOString(), schema: 'edgedesk_research_snapshot_v1' }, content);
}
/* the rows to append: a game whose content is unchanged since its last row writes nothing */
function newSnapshots(prior, rows) {
  const out = [];
  rows.forEach((r) => {
    const list = prior.get(r.game_id) || [];
    const last = list.slice().sort((a, b) => ms(a.observed_at) - ms(b.observed_at)).pop();
    if (last && last.snapshot_id === r.snapshot_id) return;
    out.push(r);
  });
  return out;
}

module.exports = { heartbeatsConfirm, mode, providerStatus, manualEntries, carryoverOf, quotesFor, buildFor, compact, boardFields,
  snapshotPath, loadSnapshots, snapshotRow, newSnapshots };
