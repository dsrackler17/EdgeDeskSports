#!/usr/bin/env node
/* ============================================================================
   THE CLOSING-LINE-VALUE SCORECARD — did the desk's number beat the close?

   Reads rows in the shape of the `research_packet_pricing` view (exported to
   JSON) and, for the NFL, joins the closing-line archive
   (football/pricing/lines_nfl.json) by game_id to grade the quoted line in
   POINTS against the consensus close and the result:

     clv_points     the points the quoted side got beyond the close
                    (positive) or short of it (negative), from the
                    selection's side: quoted_line - close_sel_line
     beat_close     clv_points > 0
     result         WIN / LOSS / PUSH of the quoted side at the quoted line,
                    from the archive's final margin

   Then it groups by sport, tier and status with the sample floor beside every
   figure. A CLV record is evidence about the pricing process; a win-loss
   record at this sample size is variance, and the report says so in words
   whatever the numbers are. Nothing here is a claim of profit.

   Usage
     node tools/intelligence/clv.js pricing_rows.json            # prints the scorecard
     node tools/intelligence/clv.js pricing_rows.json --json     # machine-readable
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SAMPLE_FLOOR = 50;

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r2(v) { const n = num(v); return n == null ? null : Math.round(n * 100) / 100; }
function r3(v) { const n = num(v); return n == null ? null : Math.round(n * 1000) / 1000; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

/** Grade one pricing row against a close in points and a final home margin (both optional). */
function grade(row, close) {
  const side = row.quoted_side === 'away' ? 'away' : row.quoted_side === 'home' ? 'home' : null;
  const q = num(row.quoted_line);
  const out = { packet_id: row.packet_id, sport: row.sport, game_id: row.game_id, tier: row.pricing_tier || null, status: row.quoted_status || null, side, quoted_line: q, quoted_odds: num(row.quoted_odds_american), fair_home_line: num(row.fair_home_line), close_home_line: null, clv_points: null, beat_close: null, result: 'UNGRADED', margin: null, why: null };
  if (!side || q == null) { out.why = 'no quoted side or line on the packet'; return out; }
  if (!close || num(close.home_line) == null) { out.why = 'no close on file for this game'; return out; }
  const sgn = side === 'home' ? 1 : -1;
  out.close_home_line = num(close.home_line);
  const closeSel = sgn * out.close_home_line;
  out.clv_points = r2(q - closeSel); /* the line the desk quoted minus the selection's line at the close: positive = the desk got more points than the close gave (home -4.5 that closed -6: +1.5; away +6.5 that closed +6: +0.5) */
  out.beat_close = out.clv_points > 0 ? true : out.clv_points < 0 ? false : null;
  if (num(close.margin) != null) { out.margin = num(close.margin); const cover = sgn * out.margin + q; out.result = cover > 0 ? 'WIN' : cover < 0 ? 'LOSS' : 'PUSH'; }
  else out.why = 'the game has no result on file';
  /* open-to-close on the desk's OWN opener capture: did the market move toward the desk's fair line? */
  if (num(close.open_home_line) != null && out.fair_home_line != null) { const o = num(close.open_home_line), c = out.close_home_line, f = out.fair_home_line; out.open_home_line = o; out.open_to_close_points = r2(c - o); out.moved_toward_fair = c === o ? null : (Math.sign(c - o) === Math.sign(f - o)); }
  else { out.open_home_line = null; out.open_to_close_points = null; out.moved_toward_fair = null; }
  return out;
}

function loadArchive(file) {
  const p = file || path.join(ROOT, 'football', 'pricing', 'lines_nfl.json');
  if (!fs.existsSync(p)) return { byId: {}, error: 'no closing-line archive at ' + path.relative(ROOT, p) };
  const a = JSON.parse(fs.readFileSync(p, 'utf8')); const byId = {};
  (a.games || []).forEach((g) => { byId[g.id] = { home_line: g.close.home_line, margin: g.margin, total: g.close.total, open_home_line: g.open ? g.open.home_line : null, open_seen_at: g.open ? g.open.seen_at : null }; });
  return { byId, error: null, games: (a.games || []).length };
}

function report(rows, opts) {
  opts = opts || {};
  const arch = opts.archive || loadArchive(opts.archive_file);
  const graded = rows.map((r) => grade(r, r.sport === 'americanfootball_nfl' ? arch.byId[String(r.game_id)] : (opts.closes && opts.closes[String(r.game_id)]) || null));
  const groups = {};
  graded.forEach((g) => {
    const keys = ['all', g.sport || 'unknown', (g.sport || 'unknown') + '|tier ' + (g.tier || 'none'), (g.sport || 'unknown') + '|status ' + (g.status || 'none')];
    keys.forEach((k) => {
      const e = (groups[k] = groups[k] || { n: 0, with_close: 0, clv: [], beat: 0, missed: 0, wins: 0, losses: 0, pushes: 0 });
      e.n++; if (g.clv_points != null) { e.with_close++; e.clv.push(g.clv_points); if (g.beat_close === true) e.beat++; else if (g.beat_close === false) e.missed++; }
      if (g.moved_toward_fair != null) { e.with_open = (e.with_open || 0) + 1; if (g.moved_toward_fair) e.toward = (e.toward || 0) + 1; }
      if (g.result === 'WIN') e.wins++; else if (g.result === 'LOSS') e.losses++; else if (g.result === 'PUSH') e.pushes++;
    });
  });
  const table = {};
  Object.keys(groups).forEach((k) => { const e = groups[k]; table[k] = { packets: e.n, with_close: e.with_close, mean_clv_points: r3(mean(e.clv)), beat_close_rate: e.beat + e.missed ? r3(e.beat / (e.beat + e.missed)) : null, with_opener: e.with_open || 0, moved_toward_fair_rate: e.with_open ? r3((e.toward || 0) / e.with_open) : null, wins: e.wins, losses: e.losses, pushes: e.pushes, sufficient_sample: e.with_close >= SAMPLE_FLOOR, reading: e.with_close >= SAMPLE_FLOOR ? (mean(e.clv) > 0 ? 'the desk’s quotes have beaten the close on average; this is evidence about the pricing process, not a profit' : 'the desk’s quotes have not beaten the close on average') : 'below the sample floor of ' + SAMPLE_FLOOR + ' closed packets: no reading' }; });
  return { schema: 'edgedesk_clv_scorecard_v1', generated_at: new Date().toISOString(), rows: graded.length, archive: arch.error ? { error: arch.error } : { games: arch.games }, sample_floor: SAMPLE_FLOOR, groups: table, graded,
    note: 'Closing-line value measures whether the number the desk quoted was better than the number the market closed at. It is the honest scorecard for a pricer. A win-loss record at this sample size is variance, and neither figure is a claim of profit.' };
}

function main() {
  const args = process.argv.slice(2); const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node tools/intelligence/clv.js <pricing_rows.json> [--json]'); process.exit(2); }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); const rows = Array.isArray(raw) ? raw : raw.rows || [];
  const rep = report(rows);
  if (args.includes('--json')) { console.log(JSON.stringify(rep, null, 1)); return; }
  console.log(`clv scorecard: ${rep.rows} packets` + (rep.archive.error ? ' (' + rep.archive.error + ')' : ''));
  Object.keys(rep.groups).forEach((k) => { const g = rep.groups[k]; console.log(`  ${k.padEnd(40)} n ${g.packets} closed ${g.with_close} mean CLV ${g.mean_clv_points == null ? '—' : g.mean_clv_points} beat ${g.beat_close_rate == null ? '—' : g.beat_close_rate} W-L-P ${g.wins}-${g.losses}-${g.pushes} ${g.sufficient_sample ? '' : '(below floor)'}`); });
  console.log('  ' + rep.note);
}
module.exports = { grade, report, loadArchive, SAMPLE_FLOOR };
if (require.main === module) main();
