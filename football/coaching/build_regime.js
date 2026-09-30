#!/usr/bin/env node
/* ============================================================================
   WHICH PROGRAMMES ARE IN A REGIME CHANGE THIS SEASON.

   THE DEFECT THIS SERVES (audit 2026-09-30). Iowa State (Matt Campbell to
   Penn State, Jimmy Rogers in, the roster out with Campbell) and North Texas
   (Eric Morris and the roster to Oklahoma State) were priced 12+ points off the
   market by a pricing state that was still 80% the long-run rating of the
   team that left. The engine now weights such a programme's long-run state on
   a separate, steeper curve (football/cfb_p4/regime_curve.js, fitted
   walk-forward), and the research gate blocks WORTH RESEARCHING / VERIFIED
   MAJOR for it until it has played enough games this season. This file
   decides, per team, whether the signal fires, from sources already in the
   repository, and writes the one artifact both the published build and the
   board read (through football/matchup/contract.js regimeFor):

     football/coaching/regime.json

   INPUTS, in the order they are trusted
     football/coaching/regime_overrides.json   hand-maintained, dated and sourced
                                               (wins over everything below)
     football/coaching/continuity.json         head coach and tenure (build_coaching.js)
     football/coaching/returning_production_<season>.json
                                               last season's production still on
                                               the roster (research/build_regime_history.py)
     football/rosters/fbs_<season>_espn.json   roster continuity and portal outflow,
     football/rosters/fbs_<season-1>_espn.json diffed on ESPN athlete ids
     football/cfb_p4/regime_curve.js           the fitted curve, the signal and N

   THE 2025 ROSTER FILE LISTS 2,298 ATHLETES ON TWO PROGRAMMES (it was synced in
   August 2026 and carries the current roster alongside the 2025 one: Preston
   Stone is under Northwestern AND SMU). An athlete listed twice last season is
   placed on the listing that is NOT his current team; one that cannot be
   placed is left out of both numerator and denominator rather than guessed.

   THE SIGNAL is football/coaching/regime_signal.js, the same function the
   walk-forward fit used, with the thresholds the curve artifact was fitted on.

     node football/coaching/build_regime.js [--season 2026] [--check]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'regime.json');
const SCHEMA = 'edgedesk_regime_change_v1';
const RS = require(path.join(__dirname, 'regime_signal.js'));
const normKey = require(path.join(ROOT, 'football', 'fbs', 'fbs.js')).normKey;

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function r4(x) { return isNum(x) ? Math.round(x * 10000) / 10000 : null; }
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function curveArtifact() {
  try { return require(path.join(ROOT, 'football', 'cfb_p4', 'regime_curve.js')); } catch (_) { return null; }
}
/* the v2 turnover magnitude (research/regime_magnitude_backtest.js): published
   for every programme; forwarded to the engine only when PROMOTED */
function magnitudeArtifact() {
  try { return require(path.join(ROOT, 'football', 'cfb_p4', 'regime_magnitude.js')); } catch (_) { return null; }
}
/* v2's QB input for the season in progress: the starter of the team's last
   game (football/starters/cfb_<season>.json, play attribution) against last
   season's primary QB (returning_production_<season>.json). Before a first
   game the roster answers: last season's QB on it or not. */
function qbChangeOf(p, st) {
  const prevQb = p && p.prev_primary_qb_id != null ? String(p.prev_primary_qb_id) : null;
  if (!prevQb) return { qb_change: null, basis: 'no primary quarterback last season on file' };
  if (st && st.player_id != null && (st.status === 'PREVIOUS_GAME' || st.status === 'ANNOUNCED' || st.status === 'EXPECTED' || st.status === 'DEPTH_CHART'))
    return { qb_change: String(st.player_id) !== prevQb, basis: 'starter ' + (st.player_name || st.player_id) + ' (' + st.status + ') vs last season\u2019s primary QB ' + prevQb };
  if (p.returning_qb == null) return { qb_change: null, basis: 'no starter observed and roster membership unknown' };
  return { qb_change: !p.returning_qb, basis: 'no starter observed yet: last season\u2019s primary QB is ' + (p.returning_qb ? '' : 'not ') + 'on the roster' };
}
function magnitudeOf(x, art) {
  const inputs = { new_hc: x.new_hc, returning_production_pct: x.returning_production_pct, qb_change: x.qb_change,
    incoming_production_pct: x.incoming_production_pct };
  const f = RS.magnitudeFeatures(inputs);
  const out = { version: art ? art.version : null, status: art ? art.status : 'UNAVAILABLE', priced: !!(art && art.promoted === true),
    family: art ? art.family : null, inputs, features: f, qb_basis: x.qb_basis || null };
  if (!art || !art.params) { out.why = 'football/cfb_p4/regime_magnitude.js is missing: no v2 magnitude'; return out; }
  const terms = {};
  let v = 0;
  RS.MAGNITUDE_INPUTS.forEach(k => { terms[k] = r4((art.params[k] || 0) * f[k]); v += terms[k]; });
  out.terms = terms;
  if (art.family === 'shift') { out.prior_shift = r4(v); out.shift_decay = art.params.lambda || 0; }
  else { out.magnitude = r4(Math.max(0, v)); out.weight_multiplier = r4(Math.exp(-Math.max(0, v))); }
  out.why = out.priced ? 'priced: v2 is promoted' : 'research only: v2 is a ' + art.status + ' (it did not beat the v1 curve on the 2024-2025 holdout; '
    + 'football/cfb_p4/research/report/regime_magnitude_backtest.json). The v1 REGIME CHANGE curve prices.';
  return out;
}

/* ---- the hand-maintained table ------------------------------------------
   Every entry must carry a source and a date; an entry without both is
   REFUSED and listed, because an undated, unsourced override is exactly the
   kind of quiet fact nobody can audit. `new_coach` true/false/null and
   `returning_production_pct` (0-100) override the automated reads for that
   team-season only. */
function loadOverrides(season) {
  const t = readJson(path.join(__dirname, 'regime_overrides.json'), { entries: [] });
  const ok = {}, refused = [];
  (t.entries || []).forEach((e, i) => {
    if (!e || +e.season !== +season) return;
    const why = !e.team ? 'no team' : (!e.source ? 'no source' : (!e.entered_at || !isFinite(Date.parse(e.entered_at)) ? 'no valid entered_at date' : null));
    if (why) { refused.push({ index: i, team: e && e.team, why }); return; }
    if (e.returning_production_pct != null && !(isNum(e.returning_production_pct) && e.returning_production_pct >= 0 && e.returning_production_pct <= 100)) {
      refused.push({ index: i, team: e.team, why: 'returning_production_pct must be a number from 0 to 100' }); return;
    }
    if (e.new_coach != null && typeof e.new_coach !== 'boolean') { refused.push({ index: i, team: e.team, why: 'new_coach must be true, false or null' }); return; }
    ok[normKey(e.team)] = e;
  });
  return { by_key: ok, refused };
}

/* ---- roster continuity, with last season's double listings placed ------- */
function rosterContinuity(cur, prev) {
  const teamOf = t => normKey(t.location || t.display_name || t.short_name || '');
  const now = {}, before = {};
  (cur.teams || []).forEach(t => { const k = teamOf(t); (t.players || []).forEach(p => { if (p.espn_id != null) now[String(p.espn_id)] = k; }); });
  (prev.teams || []).forEach(t => { const k = teamOf(t); (t.players || []).forEach(p => {
    if (p.espn_id == null) return; const a = String(p.espn_id); (before[a] = before[a] || []).push(k); }); });
  let doubled = 0, unplaced = 0;
  const lastTeam = {};
  Object.keys(before).forEach(a => {
    let L = before[a].filter((k, i, xs) => xs.indexOf(k) === i);
    if (L.length > 1) { doubled++; if (now[a]) L = L.filter(k => k !== now[a]); }
    if (L.length === 1) lastTeam[a] = L[0]; else unplaced++;
  });
  const out = {};
  (cur.teams || []).forEach(t => {
    const k = teamOf(t); let n = 0, ret = 0;
    (t.players || []).forEach(p => {
      if (p.espn_id == null) return; const a = String(p.espn_id);
      if (before[a] && !lastTeam[a]) return;            /* unplaced: out of both */
      n++; if (lastTeam[a] === k) ret++;
    });
    out[k] = { team: t.location || t.display_name, n: n, returning_share: n ? ret / n : null, transfers_out: 0 };
  });
  Object.keys(lastTeam).forEach(a => {
    const from = lastTeam[a], to = now[a];
    if (to && to !== from && out[from]) out[from].transfers_out++;
  });
  return { by_key: out, doubled_listings: doubled, unplaced: unplaced };
}

function build(season) {
  const curve = curveArtifact();
  const sig = (curve && curve.signal) || RS.DEFAULT;
  const N = curve && isNum(curve.min_games_for_research) ? curve.min_games_for_research : null;
  const coach = readJson(path.join(__dirname, 'continuity.json'), null);
  const rp = readJson(path.join(__dirname, 'returning_production_' + season + '.json'), null);
  const cur = readJson(path.join(ROOT, 'football', 'rosters', 'fbs_' + season + '_espn.json'), null);
  const prev = readJson(path.join(ROOT, 'football', 'rosters', 'fbs_' + (season - 1) + '_espn.json'), null);
  const problems = [];
  if (!coach || +coach.season !== +season) problems.push('football/coaching/continuity.json is missing or not for ' + season + ' — run build_coaching.js');
  if (!curve) problems.push('football/cfb_p4/regime_curve.js is missing — run research/regime_backtest.js --write');
  if (!rp || +rp.season !== +season) problems.push('returning_production_' + season + '.json is missing — returning production stays unmeasured');
  const mag = magnitudeArtifact();
  if (!mag) problems.push('football/cfb_p4/regime_magnitude.js is missing — the v2 turnover magnitude is not published');
  const starters = readJson(path.join(ROOT, 'football', 'starters', 'cfb_' + season + '.json'), null);
  const rc = (cur && prev) ? rosterContinuity(cur, prev) : null;
  if (!rc) problems.push('ESPN rosters for ' + season + '/' + (season - 1) + ' are missing — roster continuity stays unmeasured');
  const ov = loadOverrides(season);

  /* the season's FBS field: every team the roster sync or the coach table carries */
  const keys = {};
  if (coach && coach.by_team) Object.keys(coach.by_team).forEach(k => { keys[k] = 1; });
  if (rc) Object.keys(rc.by_key).forEach(k => { keys[k] = 1; });
  const rpBy = {};
  if (rp && rp.by_team) Object.keys(rp.by_team).forEach(n => { rpBy[normKey(n)] = rp.by_team[n]; });

  const rows = Object.keys(keys).sort().map(k => {
    const c = coach && coach.by_team ? coach.by_team[k] : null;
    const r = rc ? rc.by_key[k] : null;
    const p = rpBy[k] || null;
    const o = ov.by_key[k] || null;
    return {
      key: k, team: (c && c.team) || (r && r.team) || (p && p.team) || k,
      hc: c ? c.hc : null, previous_hc: c ? c.previous_hc : null,
      new_hc: o && o.new_coach != null ? o.new_coach : (c ? c.new_hc : null),
      new_hc_basis: o && o.new_coach != null ? 'override: ' + o.source : (c ? (c.new_hc_basis || null) : null),
      returning_share: r ? r4(r.returning_share) : null, transfers_out: r ? r.transfers_out : null,
      returning_production: o && isNum(o.returning_production_pct) ? r4(o.returning_production_pct / 100) : (p ? p.returning_production : null),
      returning_production_source: o && isNum(o.returning_production_pct) ? 'override: ' + o.source : (p ? 'returning_production_' + season + '.json' : null),
      incoming_production: p && isNum(p.incoming_production) ? p.incoming_production : null,
      prev_primary_qb_id: p && p.prev_primary_qb_id != null ? String(p.prev_primary_qb_id) : null,
      override: o ? { new_coach: o.new_coach == null ? null : o.new_coach, returning_production_pct: o.returning_production_pct == null ? null : o.returning_production_pct,
        source: o.source, note: o.note || null, entered_at: o.entered_at } : null
    };
  });
  const pRS = RS.percentiles(rows.map(x => x.returning_share));
  const pTO = RS.percentiles(rows.map(x => x.transfers_out));
  const pRP = RS.percentiles(rows.map(x => x.returning_production));
  const pIN = RS.percentiles(rows.map(x => x.incoming_production));
  const byTeam = {};
  let fired = 0;
  rows.forEach(x => {
    x.returning_share_pct = r4(pRS(x.returning_share));
    x.transfers_out_pct = r4(pTO(x.transfers_out));
    x.returning_production_pct = r4(pRP(x.returning_production));
    x.incoming_production_pct = r4(pIN(x.incoming_production));
    const q = qbChangeOf(rpBy[x.key] || null, starters && starters.teams ? starters.teams[x.key] : null);
    x.qb_change = q.qb_change; x.qb_basis = q.basis;
    x.magnitude = magnitudeOf(x, mag);
    const f = RS.fires(x, sig);
    x.regime_change = f.fires;
    x.reason = f.reason;
    x.min_games_for_research = f.fires ? N : null;
    if (f.fires) fired++;
    byTeam[x.key] = x;
  });
  return {
    schema: SCHEMA, season, generated_at: new Date().toISOString(),
    signal: sig, curve_version: curve ? curve.version : null, min_games_for_research: N,
    magnitude: mag ? { version: mag.version, status: mag.status, promoted: mag.promoted === true, family: mag.family, params: mag.params,
      fitted_on: mag.fitted_on, report: mag.report } : null,
    sources: {
      coaching: coach ? { file: 'football/coaching/continuity.json', generated_at: coach.generated_at || null } : null,
      returning_production: rp ? { file: 'football/coaching/returning_production_' + season + '.json', generated_at: rp.generated_at || null, source: rp.source || null } : null,
      rosters: rc ? { files: ['football/rosters/fbs_' + season + '_espn.json', 'football/rosters/fbs_' + (season - 1) + '_espn.json'],
        doubled_last_season_listings: rc.doubled_listings, unplaced_athletes: rc.unplaced } : null,
      overrides: { file: 'football/coaching/regime_overrides.json', applied: Object.keys(ov.by_key).length, refused: ov.refused },
      starters: starters ? { file: 'football/starters/cfb_' + season + '.json', generated_at: starters.generated_at || null, week: starters.week || null } : null
    },
    counts: { teams: rows.length, regime_change: fired, new_hc: rows.filter(x => x.new_hc === true).length,
      new_hc_unknown: rows.filter(x => x.new_hc == null).length },
    problems, by_team: byTeam
  };
}

function main() {
  const season = +(arg('season', defaultSeason()));
  const out = build(season);
  out.problems.forEach(p => console.error('[regime] ' + p));
  const list = Object.values(out.by_team).filter(x => x.regime_change).map(x => x.team).join(', ');
  console.error('[regime] ' + out.counts.regime_change + ' of ' + out.counts.teams + ' programmes in a regime change: ' + list);
  if (arg('check', false)) return 0;
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.error('[regime] wrote ' + path.relative(ROOT, OUT));
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { build, rosterContinuity, loadOverrides, qbChangeOf, magnitudeOf, SCHEMA };
