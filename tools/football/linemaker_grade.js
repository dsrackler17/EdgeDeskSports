#!/usr/bin/env node
/* ===========================================================================
   GRADING THE PUBLISHED FAIR LINES — every sheet EdgeDesk froze before
   kickoff (football/linemaker/ledger/<season>/sheets.jsonl), scored against
   the result and the closing number once both exist.

   Per game the LAST record before kickoff is graded (what EdgeDesk said when
   the game started), and the FIRST is kept beside it for the movement read.
   Nothing is re-derived: every probability graded is the one frozen in the
   record (`at_lines`, `moneyline`), so a later calibration record can never
   rewrite how an old sheet did.

   Scored, by league, market, calibration status, method, model version and
   calibration record:
     moneyline     Brier and log loss of the home-win probability (a tie scores as half)
     spread        Brier and log loss at the CLOSING number (cover given no push)
     total         the same at the closing total
     team total    the same at the published fair half point
     centres       MAE and RMSE of the fair margin, total and team points
     movement      points the market moved TOWARD the fair line between the
                   reference on file at publication and the close
                   (|fair - reference| - |fair - close|; positive = toward)
   Every figure carries n and the sample state (lib/edgedesk_validation.js
   labels: under 50 too early, 50-199 early signal, 200-499 developing, 500+
   meaningful). No profit, ROI or record is computed: nothing here was a bet.

   Results and closes:
     NFL  football/pricing/lines_nfl.json (scores, consensus close)
     CFB  football/cfb_lab/ledger/<season>/results.jsonl and lines.jsonl (CLOSE consensus)

   Run: node tools/football/linemaker_grade.js [--write] [--dir football/linemaker]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const RC = require(path.join(ROOT, 'lib', 'research_core.js'));
const { writeIfChanged } = require(path.join(__dirname, 'write_if_changed.js'));
const { readLedger } = require(path.join(__dirname, 'build_fair_lines.js'));

const SCHEMA = 'edgedesk_fair_line_grades_v1';
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }
function r4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function sampleState(n) { return n < 50 ? 'too early' : n < 200 ? 'early signal' : n < 500 ? 'developing' : 'meaningful'; }

/* --------------------------------------------------------- outcomes */
function nflOutcomes() {
  const out = {};
  try {
    const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'pricing', 'lines_nfl.json'), 'utf8'));
    (a.games || []).forEach((g) => {
      if (g.home_score == null || g.away_score == null) return;
      out[g.id] = { home: g.home_score, away: g.away_score, close_home_line: g.close ? num(g.close.home_line) : null, close_total: g.close ? num(g.close.total) : null };
    });
  } catch (_) { /* no archive: nothing graded */ }
  return out;
}
function cfbOutcomes(season) {
  const out = {}, dir = path.join(ROOT, 'football', 'cfb_lab', 'ledger', String(season));
  const read = (f, fn) => { const p = path.join(dir, f); if (!fs.existsSync(p)) return; fs.readFileSync(p, 'utf8').split('\n').forEach((l) => { if (!l.trim()) return; try { fn(JSON.parse(l)); } catch (_) { /* skip */ } }); };
  read('results.jsonl', (r) => { if (r.status === 'FINAL' && r.home_points != null && r.away_points != null) out[r.game_id] = Object.assign(out[r.game_id] || {}, { home: r.home_points, away: r.away_points }); });
  read('lines.jsonl', (r) => {
    if (r.kind !== 'CLOSE' || r.quality === 'MISSING') return;
    const o = out[r.game_id] = out[r.game_id] || {};
    if (r.market_type === 'spread' && r.home_line != null) o.close_home_line = num(r.home_line);
    if (r.market_type === 'total' && r.total_points != null) o.close_total = num(r.total_points);
  });
  return out;
}

/* ----------------------------------------------------------- scoring */
function acc() { return { n: 0, brier: 0, ll: 0 }; }
function add(a, p, y) { if (p == null || y == null) return; const e = 1e-6, q = Math.min(1 - e, Math.max(e, p)); a.n++; a.brier += (p - y) ** 2; a.ll += -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); }
function fin(a) { return a.n ? { n: a.n, brier: r4(a.brier / a.n), log_loss: r4(a.ll / a.n), sample_state: sampleState(a.n) } : { n: 0, brier: null, log_loss: null, sample_state: sampleState(0) }; }
function err() { return { n: 0, abs: 0, sq: 0 }; }
function addErr(e, pred, act) { if (pred == null || act == null) return; e.n++; e.abs += Math.abs(act - pred); e.sq += (act - pred) ** 2; }
function finErr(e) { return e.n ? { n: e.n, mae: r3(e.abs / e.n), rmse: r3(Math.sqrt(e.sq / e.n)), sample_state: sampleState(e.n) } : { n: 0, mae: null, rmse: null, sample_state: sampleState(0) }; }
function mov() { return { n: 0, sum: 0, toward: 0 }; }
function addMov(m, fair, ref, close) { if (fair == null || ref == null || close == null) return; const t = Math.abs(fair - ref) - Math.abs(fair - close); m.n++; m.sum += t; if (t > 0) m.toward++; }
function finMov(m) { return m.n ? { n: m.n, mean_points_toward_fair: r3(m.sum / m.n), share_toward: r4(m.toward / m.n), wilson: RC.wilson(m.toward, m.n), sample_state: sampleState(m.n) } : { n: 0, sample_state: sampleState(0) }; }

/** P(event) given no push, from a frozen [win, push, lose] triple */
function noPush(tr) { if (!tr) return null; const w = num(tr[0]), l = num(tr[2]); return w != null && l != null && w + l > 0 ? w / (w + l) : null; }

function grade(opts) {
  opts = opts || {};
  const dir = opts.dir || path.join(ROOT, 'football', 'linemaker');
  const ld = path.join(dir, 'ledger');
  const seasons = fs.existsSync(ld) ? fs.readdirSync(ld).filter((s) => /^\d{4}$/.test(s)).sort() : [];
  const nfl = opts.nflOutcomes || nflOutcomes();
  const groups = {};
  const G = (k) => (groups[k] = groups[k] || { ml: acc(), spread: acc(), total: acc(), team_total: acc(), margin: err(), total_err: err(), team: err(), mv_spread: mov(), mv_total: mov() });
  let records = 0, games = 0, graded = 0, awaiting = 0;
  seasons.forEach((season) => {
    const file = path.join(ld, season, 'sheets.jsonl'); if (!fs.existsSync(file)) return;
    const led = readLedger(file); records += led.rows.length;
    const cfb = opts.cfbOutcomes ? opts.cfbOutcomes(season) : cfbOutcomes(season);
    const last = {}, first = {};
    led.rows.forEach((r) => { if (!(Date.parse(r.recorded_at) < Date.parse(r.kickoff))) return; const k = r.sport + '|' + r.game_id; if (!first[k]) first[k] = r; last[k] = r; });
    Object.keys(last).forEach((k) => {
      games++;
      const r = last[k], f = first[k];
      const o = r.league === 'NFL' ? nfl[r.game_id] : cfb[r.game_id];
      if (!o || o.home == null || o.away == null) { awaiting++; return; }
      graded++;
      const M = o.home - o.away, T = o.home + o.away;
      const keys = ['all', r.league, r.league + '|v' + (r.model_version || '?')];
      keys.forEach((key) => {
        const g = G(key);
        if (r.moneyline) add(g.ml, r.moneyline.home_win + 0.5 * (r.moneyline.tie || 0), M > 0 ? 1 : M < 0 ? 0 : 0.5);
        if (o.close_home_line != null && r.at_lines && r.at_lines.spread) { const tr = r.at_lines.spread[String(o.close_home_line)]; const p = noPush(tr); if (p != null && M + o.close_home_line !== 0) add(g.spread, p, M + o.close_home_line > 0 ? 1 : 0); }
        if (o.close_total != null && r.at_lines && r.at_lines.total) { const tr = r.at_lines.total[String(o.close_total)]; const p = noPush(tr); if (p != null && T !== o.close_total) add(g.total, p, T > o.close_total ? 1 : 0); }
        if (r.team_total && r.at_lines) {
          [['home_team_total', o.home, r.team_total.home_fair], ['away_team_total', o.away, r.team_total.away_fair]].forEach(([kk, pts, fair]) => {
            if (fair == null) return; const L = Math.round(fair * 2) / 2; const tr = r.at_lines[kk] && r.at_lines[kk][String(L)]; const p = noPush(tr); if (p != null && pts !== L) add(g.team_total, p, pts > L ? 1 : 0);
          });
          addErr(g.team, r.team_total.home_fair, o.home); addErr(g.team, r.team_total.away_fair, o.away);
        }
        if (r.spread) addErr(g.margin, -r.spread.fair_home_line, M);
        if (r.total) addErr(g.total_err, r.total.fair_total, T);
        /* movement: from the reference on file at the FIRST record to the close */
        const ref = f.reference;
        if (r.spread && ref && ref.spread && o.close_home_line != null) addMov(g.mv_spread, r.spread.fair_home_line, ref.spread.home_line, o.close_home_line);
        if (r.total && ref && ref.total && o.close_total != null) addMov(g.mv_total, r.total.fair_total, ref.total.line, o.close_total);
      });
      /* by calibration status, the confidence category every market carries */
      [['spread', r.spread], ['total', r.total], ['moneyline', r.moneyline]].forEach(([mk, m]) => {
        if (!m) return; const g = G(r.league + '|' + mk + '|' + m.status + '|' + m.method);
        if (mk === 'moneyline') add(g.ml, m.home_win + 0.5 * (m.tie || 0), M > 0 ? 1 : M < 0 ? 0 : 0.5);
        if (mk === 'spread' && o.close_home_line != null) { const p = noPush(r.at_lines.spread[String(o.close_home_line)]); if (p != null && M + o.close_home_line !== 0) add(g.spread, p, M + o.close_home_line > 0 ? 1 : 0); }
        if (mk === 'total' && o.close_total != null) { const p = noPush(r.at_lines.total[String(o.close_total)]); if (p != null && T !== o.close_total) add(g.total, p, T > o.close_total ? 1 : 0); }
      });
    });
  });
  const out = {};
  Object.keys(groups).sort().forEach((k) => {
    const g = groups[k];
    out[k] = { moneyline: fin(g.ml), spread_at_close: fin(g.spread), total_at_close: fin(g.total), team_total_at_fair: fin(g.team_total),
      margin_error: finErr(g.margin), total_error: finErr(g.total_err), team_points_error: finErr(g.team),
      movement_spread: finMov(g.mv_spread), movement_total: finMov(g.mv_total) };
  });
  return {
    schema: SCHEMA, generated_at: new Date().toISOString(), source: 'tools/football/linemaker_grade.js',
    counts: { records, games, graded, awaiting_result: awaiting },
    groups: out,
    note: 'Every probability graded is the one frozen before kickoff. Nothing here is a bet, a profit or a record of one; a sample under 50 is too early to read.'
  };
}

function main() {
  const a = process.argv.slice(2);
  const dir = a.includes('--dir') ? path.resolve(a[a.indexOf('--dir') + 1]) : path.join(ROOT, 'football', 'linemaker');
  const g = grade({ dir });
  console.log('fair-line grades: ' + g.counts.records + ' records, ' + g.counts.games + ' games, ' + g.counts.graded + ' graded, ' + g.counts.awaiting_result + ' awaiting a result');
  const all = g.groups.all; if (all) console.log('  all: moneyline ' + JSON.stringify(all.moneyline) + ' | spread@close ' + JSON.stringify(all.spread_at_close));
  if (a.includes('--write')) console.log(writeIfChanged(path.join(dir, 'grades.json'), g, { pretty: false }) + ' ' + path.relative(ROOT, path.join(dir, 'grades.json')));
}
module.exports = { grade, sampleState, noPush, nflOutcomes, cfbOutcomes, SCHEMA };
if (require.main === module) main();
