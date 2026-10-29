#!/usr/bin/env node
/* ============================================================================
   SP+ tracking — which number tracks the close: EdgeDesk's or SP+'s?
   football/sp_plus/README.md (D)

   Run hourly by the CFB Model Lab job (.github/workflows/cfb-lab.yml), the
   only writer of football/sp_plus/ledger and football/sp_plus/reports:

     capture   for every upcoming CFB game on the slate, the three numbers at
               this moment: EdgeDesk's published fair line
               (football/fbs/slate.json), the SP+ projected line as a card
               shows it (football/sp_plus/lines.json through
               lib/cfb_sp_plus.js rowFor, unavailable included) and the
               market (the Model Lab's consensus of every book's latest
               pregame quote, lab_core marketAt). A row is appended for a
               game's first capture and whenever one of the three changes.
     grade     once per game, after the Lab has the final and its consensus
               close (cfb_lab_close_v1): the last pregame capture of each
               source against the close and against the final margin. Written
               once and never rewritten; a later result correction does not
               edit it.
     report    reports/<season>/week_NN.{json,md} and season.{json,md},
               rebuilt from the graded rows

   THE METRICS (per source: EdgeDesk, SP+; and the close itself as the
   benchmark against the final)
     MAE vs close       |source home line − closing home line|
     MAE vs final       |source home margin − final margin|
     right side of the close (ATS vs the close)
                        side = home when the source's line is below the
                        closing home line (it likes the home side more than
                        the close did), away when above; right when the final
                        covered the close on that side; a push or no side is
                        not counted
     close moved toward from the market at the game's FIRST capture to the
                        close: toward the side the source leaned against that
                        market, away from it, or no move

   Append-only: `verify` holds every committed ledger file to be a prefix of
   the working file, every id unique and every row's id its content's.

     node football/sp_plus/track.js run [--write] [--now ISO]
     node football/sp_plus/track.js verify [--base HEAD]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const SP = require('../../lib/cfb_sp_plus.js');

const REPO = path.resolve(__dirname, '..', '..');
const CAPTURE_RULE = 'cfb_sp_track_v1';
const GRADE_RULE = 'cfb_sp_grade_v1';
const SOURCES = ['edgedesk', 'sp_plus'];

function h(...parts) { return crypto.createHash('sha256').update(parts.map((x) => (x == null ? '' : String(x))).join('|'), 'utf8').digest('hex').slice(0, 24); }
function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function r2(x) { return isNum(x) ? (Math.round(x * 100) / 100) || 0 : null; }
function ms(t) { const v = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(v) ? v : null; }
function iso(t) { return new Date(ms(t)).toISOString(); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function readJsonl(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
function weekKey(season, seasonType, week) { return season + ':' + (seasonType === 'postseason' ? 1 : 0) + ':' + String(week).padStart(2, '0'); }

function paths(season, root) {
  const r = root || REPO;
  const led = path.join(r, 'football', 'sp_plus', 'ledger', String(season));
  return { ledger: led, captures: path.join(led, 'captures.jsonl'), grades: path.join(led, 'grades.jsonl'),
    reports: path.join(r, 'football', 'sp_plus', 'reports', String(season)) };
}

/* ---------------------------------------------------------------- capture */
function sig(c) {
  return JSON.stringify([c.edgedesk ? c.edgedesk.home_line : null, c.sp_plus.state, c.sp_plus.home_line, c.market ? c.market.home_line : null]);
}
/* inputs: { slate, lines (doc), quotes (Lab quotes), lab (lab_core) }; prior: existing capture rows */
function capture(nowIso, inputs, prior) {
  const L = inputs.lab;
  const now = ms(nowIso);
  const last = {};
  (prior || []).forEach((c) => { last[c.game_id] = c; });
  const qBy = {};
  (inputs.quotes || []).forEach((q) => { if (q.game_id) (qBy[q.game_id] = qBy[q.game_id] || []).push(q); });
  const out = [];
  ((inputs.slate && inputs.slate.games) || []).forEach((g) => {
    const k = ms(g.kickoff);
    if (k === null || k <= now || g.model_status !== 'PREDICTED') return;
    const season = Number.isInteger(g.season) ? g.season : inputs.slate.season;
    const ed = isNum(g.model_home_line) ? { home_line: r2(g.model_home_line), home_margin: r2(-g.model_home_line), model_version: g.model_version || null,
      source: 'football/fbs/slate.json', built_at: inputs.slate.generated_at || null } : null;
    const row = SP.rowFor(g.game_id, { doc: inputs.lines || null, now, home: g.home_team, away: g.away_team });
    const sp = row.state === 'AVAILABLE'
      ? { state: 'AVAILABLE', home_line: row.home_line, home_margin: row.home_margin, week_key: row.week_key, sp_captured_at: row.captured_at, source_version: row.source_version, reason: null }
      : { state: 'UNAVAILABLE', home_line: null, home_margin: null, week_key: null, sp_captured_at: null, source_version: null, reason: row.reason };
    const m = L.marketAt(qBy[g.game_id] || [], nowIso, g.kickoff);
    const mk = isNum(m.current_spread) ? { home_line: m.current_spread, n_books: m.sportsbook_count, as_of: m.market_as_of, stale: !!m.market_stale,
      source: 'Model Lab consensus (lab_core marketAt: each book’s latest pregame quote, median)' } : null;
    const c = { game_id: String(g.game_id), season, week: g.week, week_key: weekKey(season, g.season_type, g.week), home: g.home_team, away: g.away_team,
      kickoff: g.kickoff, captured_at: iso(now), rule: CAPTURE_RULE, edgedesk: ed, sp_plus: sp, market: mk };
    if (last[c.game_id] && sig(last[c.game_id]) === sig(c)) return;
    c.capture_id = 'spt_' + h(c.game_id, c.captured_at, CAPTURE_RULE);
    out.push(c);
    last[c.game_id] = c;
  });
  return out;
}

/* ------------------------------------------------------------------ grade */
function coverSide(finalMargin, closeLine) {
  const v = finalMargin + closeLine;
  return v > 0 ? 'home' : (v < 0 ? 'away' : 'push');
}
function gradeSource(src, first, close, final) {
  if (!src || !isNum(src.home_line)) return null;
  const side = src.home_line < close.home_line ? 'home' : (src.home_line > close.home_line ? 'away' : null);
  const cov = coverSide(final.margin, close.home_line);
  let moved = null;
  if (first && first.market && isNum(first.market.home_line) && first.src && isNum(first.src.home_line)) {
    const lean = first.src.home_line < first.market.home_line ? 'home' : (first.src.home_line > first.market.home_line ? 'away' : null);
    const d = close.home_line - first.market.home_line;
    moved = lean === null ? null : (d === 0 ? 'none' : (((lean === 'home') === (d < 0)) ? 'toward' : 'away'));
  }
  return { home_line: src.home_line, abs_err_close: r2(Math.abs(src.home_line - close.home_line)), abs_err_final: r2(Math.abs(-src.home_line - final.margin)),
    side_vs_close: side, right_side_of_close: side === null || cov === 'push' ? null : side === cov, close_moved: moved };
}
/* inputs: { lines: Lab line rows, results: Lab result rows }; captures: every capture; prior: graded rows */
function grade(nowIso, inputs, captures, prior) {
  const done = new Set((prior || []).map((g) => g.game_id));
  const close = {}, final = {};
  (inputs.lines || []).forEach((l) => {
    if (l.kind === 'CLOSE' && l.book === 'CONSENSUS' && l.market_type === 'spread' && l.quality !== 'MISSING' && isNum(l.home_line)) close[l.game_id] = l;
  });
  (inputs.results || []).forEach((r) => { if (r.status === 'FINAL' && isNum(r.home_points) && isNum(r.away_points)) final[r.game_id] = r; });
  const byGame = {};
  (captures || []).forEach((c) => { (byGame[c.game_id] = byGame[c.game_id] || []).push(c); });
  const out = [];
  Object.keys(byGame).sort().forEach((gid) => {
    if (done.has(gid) || !close[gid] || !final[gid]) return;
    const cs = byGame[gid].filter((c) => ms(c.captured_at) < ms(c.kickoff)).sort((a, b) => ms(a.captured_at) - ms(b.captured_at));
    if (!cs.length) return;
    const first = cs[0], lastC = cs[cs.length - 1], C = close[gid], F = final[gid];
    const fin = { home_points: F.home_points, away_points: F.away_points, margin: F.home_points - F.away_points, result_id: F.result_id || null };
    const cl = { home_line: C.home_line, quality: C.quality, n_books: C.n_books, line_id: C.line_id || null };
    const firstOf = (key) => {
      const c = cs.find((x) => x[key] && isNum(x[key].home_line));
      return c ? { src: c[key], market: c.market } : null;
    };
    const g = { game_id: gid, season: lastC.season, week: lastC.week, week_key: lastC.week_key, home: lastC.home, away: lastC.away, kickoff: lastC.kickoff,
      graded_at: iso(nowIso), rule: GRADE_RULE, final: fin, close: cl,
      captures: { first: first.capture_id, last: lastC.capture_id, n: cs.length },
      sources: {
        edgedesk: gradeSource(lastC.edgedesk, firstOf('edgedesk'), cl, fin),
        sp_plus: gradeSource(lastC.sp_plus && lastC.sp_plus.state === 'AVAILABLE' ? lastC.sp_plus : null, firstOf('sp_plus'), cl, fin)
      },
      close_abs_err_final: r2(Math.abs(-cl.home_line - fin.margin)) };
    g.grade_id = 'spg_' + h(gid, GRADE_RULE);
    out.push(g);
  });
  return out;
}

/* ----------------------------------------------------------------- report */
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function summarize(grades) {
  const src = {};
  SOURCES.forEach((k) => {
    const rows = grades.map((g) => g.sources[k]).filter(Boolean);
    const ats = rows.map((x) => x.right_side_of_close).filter((x) => x !== null);
    const mv = rows.map((x) => x.close_moved).filter((x) => x !== null);
    src[k] = { n: rows.length, mae_vs_close: r2(mean(rows.map((x) => x.abs_err_close))), mae_vs_final: r2(mean(rows.map((x) => x.abs_err_final))),
      right_side_of_close: { right: ats.filter(Boolean).length, wrong: ats.filter((x) => !x).length, rate: ats.length ? r2(ats.filter(Boolean).length / ats.length) : null },
      close_moved: { toward: mv.filter((x) => x === 'toward').length, away: mv.filter((x) => x === 'away').length, none: mv.filter((x) => x === 'none').length,
        toward_rate: mv.length ? r2(mv.filter((x) => x === 'toward').length / mv.length) : null } };
  });
  const common = grades.filter((g) => SOURCES.every((k) => g.sources[k]));
  const onCommon = {};
  SOURCES.forEach((k) => {
    const ats = common.map((g) => g.sources[k].right_side_of_close).filter((x) => x !== null);
    onCommon[k] = { mae_vs_close: r2(mean(common.map((g) => g.sources[k].abs_err_close))), mae_vs_final: r2(mean(common.map((g) => g.sources[k].abs_err_final))),
      right_side_rate: ats.length ? r2(ats.filter(Boolean).length / ats.length) : null };
  });
  return { games: grades.length, sources: src,
    common: { n: common.length, close_mae_vs_final: r2(mean(common.map((g) => g.close_abs_err_final))), sources: onCommon } };
}
function md(title, s) {
  const pct = (x) => (x == null ? '—' : Math.round(100 * x) + '%');
  const v = (x) => (x == null ? '—' : x.toFixed(2));
  const L = ['# ' + title, '', s.games + ' graded games. Each source is graded on its last pregame number; the close is the Model Lab’s consensus close (cfb_lab_close_v1).', '',
    '| source | n | MAE vs close | MAE vs final | right side of the close | close moved toward it |', '|---|---|---|---|---|---|'];
  SOURCES.forEach((k) => {
    const x = s.sources[k];
    L.push('| ' + (k === 'edgedesk' ? 'EdgeDesk fair' : 'SP+ projected (external)') + ' | ' + x.n + ' | ' + v(x.mae_vs_close) + ' | ' + v(x.mae_vs_final) + ' | '
      + x.right_side_of_close.right + '–' + x.right_side_of_close.wrong + ' (' + pct(x.right_side_of_close.rate) + ') | '
      + x.close_moved.toward + ' toward, ' + x.close_moved.away + ' away, ' + x.close_moved.none + ' no move (' + pct(x.close_moved.toward_rate) + ') |');
  });
  L.push('', '**On the ' + s.common.n + ' games both sources priced:** close MAE vs final ' + v(s.common.close_mae_vs_final) + '; '
    + SOURCES.map((k) => (k === 'edgedesk' ? 'EdgeDesk' : 'SP+') + ' MAE vs close ' + v(s.common.sources[k].mae_vs_close) + ', vs final ' + v(s.common.sources[k].mae_vs_final)
      + ', right side ' + pct(s.common.sources[k].right_side_rate)).join('; ') + '.', '',
  'SP+ is ESPN’s rating (Bill Connelly), an external estimate: it is tracked here, never fed into EdgeDesk’s model, EV, rankings or grades. A small sample proves nothing either way.', '');
  return L.join('\n');
}
function reports(season, grades) {
  const files = {};
  const weeks = {};
  grades.forEach((g) => { (weeks[g.week_key] = weeks[g.week_key] || []).push(g); });
  const asOf = (gs) => gs.map((g) => g.graded_at).sort().slice(-1)[0] || null;
  Object.keys(weeks).sort().forEach((wk) => {
    const gs = weeks[wk], s = summarize(gs);
    const name = (wk.split(':')[1] === '1' ? 'post_' : 'week_') + wk.split(':')[2];
    const doc = Object.assign({ schema: 'edgedesk_cfb_sp_track_report_v1', season, week_key: wk, as_of: asOf(gs), grade_rule: GRADE_RULE }, s);
    files[name + '.json'] = JSON.stringify(doc, null, 1) + '\n';
    files[name + '.md'] = md('SP+ vs EdgeDesk · ' + season + ' ' + SP.weekText(wk), s);
  });
  const s = summarize(grades);
  files['season.json'] = JSON.stringify(Object.assign({ schema: 'edgedesk_cfb_sp_track_report_v1', season, week_key: null, as_of: asOf(grades), grade_rule: GRADE_RULE }, s), null, 1) + '\n';
  files['season.md'] = md('SP+ vs EdgeDesk · ' + season + ' season to date', s);
  return files;
}

/* ----------------------------------------------------------------- verify */
/* baseContent(rel) -> the committed content or null (untracked) */
function verify(season, opts) {
  opts = opts || {};
  const P = paths(season, opts.root);
  const problems = [];
  [[P.captures, 'capture_id', (c) => 'spt_' + h(c.game_id, c.captured_at, c.rule)], [P.grades, 'grade_id', (g) => 'spg_' + h(g.game_id, g.rule)]].forEach(([file, idf, idOf]) => {
    let rows = [];
    try { rows = readJsonl(file); } catch (e) { problems.push(path.basename(file) + ' does not parse: ' + e.message); return; }
    const seen = new Set();
    rows.forEach((r, i) => {
      if (!r[idf]) problems.push(path.basename(file) + ':' + (i + 1) + ' has no ' + idf);
      else if (seen.has(r[idf])) problems.push(path.basename(file) + ':' + (i + 1) + ' duplicates ' + r[idf]);
      else if (r[idf] !== idOf(r)) problems.push(path.basename(file) + ':' + (i + 1) + ' ' + idf + ' does not match its content');
      seen.add(r[idf]);
    });
    if (opts.baseContent) {
      const rel = path.relative(opts.root || REPO, file).split(path.sep).join('/');
      const before = opts.baseContent(rel);
      if (before != null) {
        if (!fs.existsSync(file)) problems.push(rel + ' was deleted (append-only)');
        else if (!fs.readFileSync(file, 'utf8').startsWith(before)) problems.push(rel + ' was rewritten: the committed content is not a prefix of the working file (append-only)');
      }
    }
  });
  return problems;
}
function gitBase(base, root) {
  return (rel) => { try { return execFileSync('git', ['show', base + ':' + rel], { cwd: root || REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }); } catch (e) { return null; } };
}

/* ------------------------------------------------------------------- run */
function loadInputs(season) {
  const G = require('../cfb_lab/ledger.js');
  const store = new G.Store(season);
  return { slate: readJson(path.join(REPO, 'football', 'fbs', 'slate.json')), lines: readJson(path.join(__dirname, 'lines.json')),
    quotes: store.quotes(), labLines: store.lines(), results: store.results(), lab: require('../cfb_lab/lab_core.js') };
}
function run(opts) {
  opts = opts || {};
  const now = iso(opts.now || new Date());
  const inputs = opts.inputs || loadInputs(opts.season);
  const season = opts.season || (inputs.slate && inputs.slate.season);
  if (!season) throw new Error('no season: football/fbs/slate.json has none');
  const P = paths(season, opts.root);
  const priorC = readJsonl(P.captures), priorG = readJsonl(P.grades);
  const newC = capture(now, inputs, priorC);
  const allC = priorC.concat(newC);
  const newG = grade(now, { lines: inputs.labLines, results: inputs.results }, allC, priorG);
  const allG = priorG.concat(newG);
  const files = reports(season, allG);
  if (opts.write) {
    fs.mkdirSync(P.ledger, { recursive: true });
    if (newC.length) fs.appendFileSync(P.captures, newC.map((x) => JSON.stringify(x)).join('\n') + '\n');
    if (newG.length) fs.appendFileSync(P.grades, newG.map((x) => JSON.stringify(x)).join('\n') + '\n');
    if (allG.length) {
      fs.mkdirSync(P.reports, { recursive: true });
      Object.keys(files).forEach((f) => { const p = path.join(P.reports, f); const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; if (cur !== files[f]) fs.writeFileSync(p, files[f]); });
    }
  }
  return { season, captured: newC.length, graded: newG.length, captures: allC.length, grades: allG.length, summary: summarize(allG), files: Object.keys(files) };
}

module.exports = { capture, grade, gradeSource, summarize, reports, verify, run, paths, gitBase, CAPTURE_RULE, GRADE_RULE };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const cmd = a[0];
  try {
    if (cmd === 'run') {
      const season = arg('--season') ? Number(arg('--season')) : undefined;
      const res = run({ now: arg('--now'), season, write: a.includes('--write') });
      console.log(JSON.stringify({ season: res.season, captured: res.captured, graded: res.graded, captures: res.captures, grades: res.grades }));
      if (a.includes('--write')) {
        /* append-only, checked against the checkout before anything is published; a
           violation restores the committed files and fails this step, never the Lab's publish */
        const base = arg('--base', 'HEAD');
        const problems = verify(res.season, { baseContent: gitBase(base) });
        if (problems.length) {
          const P = paths(res.season);
          [P.captures, P.grades].forEach((f) => { const rel = path.relative(REPO, f); const c = gitBase(base)(rel); if (c != null) fs.writeFileSync(f, c); });
          console.error('SP+ tracking refused its own write (append-only):\n' + problems.join('\n'));
          process.exit(1);
        }
      }
    } else if (cmd === 'verify') {
      const season = Number(arg('--season', new Date().getUTCFullYear()));
      const problems = verify(season, { baseContent: a.includes('--base') ? gitBase(arg('--base')) : null });
      problems.forEach((p) => console.error(p));
      console.log(problems.length ? 'FAILED ' + problems.length + ' problem(s)' : 'OK: the SP+ tracking ledger is intact');
      process.exit(problems.length ? 1 : 0);
    } else {
      console.log('usage: track.js run [--write] [--now ISO] [--season S] [--base REF] | verify [--season S] [--base REF]');
      process.exit(64);
    }
  } catch (e) { console.error(e && e.stack || e); process.exit(1); }
}
