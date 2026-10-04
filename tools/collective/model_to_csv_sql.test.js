#!/usr/bin/env node
/* ===========================================================================
   model_predictions -> model_to_csv.sql -> CSV -> the uploader's own parser.

   tools/collective/model_to_csv.sql turns what the NFL model wrote into the
   slate CSV the Collective uploader reads. The exporter is one SQL file and
   the uploader is inline in collective/index.html; neither references the
   other, and the only place they have to agree is the CSV in between. A pick
   string the exporter is happy to write and the uploader refuses to read
   produces an empty board and no error anywhere.

   So the LIVE layer runs the shipped SQL against a real server and hands the
   resulting bytes to the real parser, pulled out of the real HTML.

   WHAT THIS FILE IS ACTUALLY GUARDING: three sign conventions meet in that
   CSV and every one of them looks reasonable when it is wrong.

       an away favourite's pick reads  "CHI -2.5"
       the same game's home line is         "+2.5"
       and the model's own margin is        "-3.2"   (home minus away)

   Get one backwards and every game on the board inverts while still
   rendering perfectly. It surfaces months later as a record that grades
   backwards, which is the one failure this whole product cannot absorb.

   If no postgres binary is available the LIVE layer says so and the static
   layer still runs. A skipped check that announces itself is honest.

   Run: node tools/collective/model_to_csv_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { findPgBin, startCluster } = require('./pg_harness');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; }
  }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done(extra) {
  failures.forEach((f) => console.log('FAIL | ' + f.name
    + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
  if (extra) console.log(extra);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const ROOT = path.join(__dirname, '..', '..');
const EXPORTER = path.join(__dirname, 'model_to_csv.sql');
const FIXTURE = path.join(__dirname, 'sql', 'model_predictions_fixture.sql');
const MINIMAL = path.join(__dirname, 'sql', 'model_predictions_minimal.sql');
const SQL = fs.readFileSync(EXPORTER, 'utf8');

/* ═══ STATIC ══════════════════════════════════════════════════════════════ */
{
  const live = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const params = SQL.slice(SQL.indexOf('with params as'), SQL.indexOf('-- EVERY COLUMN'));
  const activeParams = params.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  /* This file shipped once with `date '2026-09-08'` in it. The moment that
     week was played the export returned zero rows -- which is exactly what
     "the model has not run" looks like, and sends you debugging the wrong
     thing entirely. */
  chk('the window is anchored on now(), not a calendar date',
    /now\(\)/.test(activeParams)
    && !/\b(date|timestamptz)\s*'\d{4}-\d{2}-\d{2}/.test(activeParams),
    activeParams.slice(0, 400));

  /* An NFL season is NAMED FOR THE YEAR IT STARTS, so a January playoff game
     belongs to the previous season. A hardcoded year files it under the wrong
     one and it gets graded against the wrong slate. */
  const seasonExpr = (() => {
    const i = SQL.indexOf('case\n    when extract(month');
    return i === -1 ? '' : SQL.slice(i, SQL.indexOf('as season', i));
  })();
  chk('the season is derived from the kickoff', seasonExpr.length > 0);
  chk('no literal year survives in the season expression',
    seasonExpr.length > 0 && !/\b20\d\d\b/.test(seasonExpr), seasonExpr);

  /* public.model_predictions is not the same shape in every project -- the
     live one has no model_detail -- and naming a column directly makes the
     whole export fail with `column "..." does not exist`: no file at all,
     rather than a file with a couple of columns blank. */
  chk('optional columns are read through to_jsonb, never named directly',
    /to_jsonb\(mp\)/.test(live)
    && !/\bmp\.model_detail\b/.test(live)
    && !/\bmp\.model_edge\b/.test(live), 
    (live.match(/mp\.[a-z_]+/g) || []).join(','));

  /* "spread" and "line" are the two headers that could mean either the
      model's number or the book's. Emitting one of those as a header makes
      the uploader stop and ask, and a creator who guesses wrong measures
      their margin error against the market. */
  const headers = (live.match(/as ([a-z_]+),?\s*$/gm) || [])
    .map((s) => s.replace(/^as\s+/, '').replace(/,$/, '').trim());
  chk('no emitted header is one of the ambiguous ones',
    !headers.includes('spread') && !headers.includes('line'), headers.join(','));

  chk('the pick side is chosen by model_edge, with a deterministic tiebreak',
    /coalesce\(model_edge, -1\) desc/.test(live) && /selection\s*$/m.test(live));
}

/* ═══ LIVE ════════════════════════════════════════════════════════════════ */
const BIN = findPgBin();
if (!BIN) {
  done('NOTE | no postgres binary available — the LIVE layer did not run.\n'
     + '     | The static layer holds the conventions; only a real server can hold the\n'
     + '     | sign conventions, and only the real HTML can hold the round trip.');
}
const pg = startCluster(BIN, 'mtc');
if (!pg.ok) {
  done('NOTE | could not start a local postgres (' + pg.why + ')\n'
     + '     | The LIVE layer did not run; the static layer above did.');
}

const fExp = pg.stage(EXPORTER);
const fFix = pg.stage(FIXTURE);
const fMin = pg.stage(MINIMAL);

pg.psql('-d postgres -q -c "create database mtc"');
let r = pg.psql(`-d mtc -q -v ON_ERROR_STOP=1 -f ${fFix}`);
chk('the model_predictions fixture builds', r.status === 0, r.out.slice(-600));
if (r.status !== 0) done();

r = pg.psql(`-d mtc -q --csv -v ON_ERROR_STOP=1 -f ${fExp}`);
chk('the exporter runs against a real server', r.status === 0, r.out.slice(-600));
if (r.status !== 0) done();
const csv = r.out.trim() + '\n';

/* ---- the uploader, out of the shipped HTML ------------------------------ */
const html = fs.readFileSync(path.join(ROOT, 'collective', 'index.html'), 'utf8');
function block(startsWith, opener, closer) {
  opener = opener || '{'; closer = closer || '}';
  const start = html.indexOf(startsWith);
  if (start === -1) throw new Error(startsWith + ' is not in collective/index.html');
  let i = html.indexOf(opener, start), depth = 0, end = -1;
  for (; i < html.length; i++) {
    if (html[i] === opener) depth++;
    else if (html[i] === closer) { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error('could not find the end of ' + startsWith);
  return html.slice(start, end);
}

/* Some of what the uploader leans on is a top-level constant rather than a
   function (AMBIGUOUS_SCORE, WEEK_NAMES). Scan to the terminating semicolon
   at bracket depth zero, stepping over quoted strings so a ';' inside one
   cannot end the declaration early. */
function varBlock(name) {
  const re = new RegExp('(?:^|\\n)\\s*var\\s+' + name + '\\s*=');
  const m = re.exec(html);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 0, quote = null;
  for (; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.indexOf(c) >= 0) depth++;
    else if (')]}'.indexOf(c) >= 0) depth--;
    else if (c === ';' && depth === 0) break;
  }
  return 'var ' + name + html.slice(m.index + m[0].length - 1, i + 1);
}

let P = null, built = null, rows = [], problems = [], byHome = {};

/* RESOLVE THE DEPENDENCY CLOSURE, rather than hardcoding a list of helper
   names. The uploader is inline script in a page under active development:
   parseCSV has already grown a delimiter sniffer and slateBuildRows a
   final-score guard since this test was written. A fixed list goes stale and
   fails as "sniffDelim is not defined", which reads like a bug in the page
   instead of a stale list here. So: try it, and when the evaluator says a
   name is missing, pull that function out of the same HTML and try again. */
function buildUploader(seed, work) {
  const want = seed.slice();
  const consts = [];
  const added = {};
  for (let attempt = 0; attempt < 60; attempt++) {
    let api;
    try {
      api = (new Function([
        block('var SLATE_FIELDS=', '[', ']') + ';',
        'var SLATE={cols:[],rows:[],map:{}};',
        'function esc(s){return String(s==null?"":s);}',
      ].concat(consts)
       .concat(want.map((n) => block('function ' + n + '(')))
       .concat(['return {' + want.join(',') + ', SLATE:SLATE, setSlate:function(s){'
                + 'SLATE.cols=s.cols;SLATE.rows=s.rows;SLATE.map=s.map;}};'])
       .join('\n')))();
      /* Construction alone proves nothing, and neither does a toy CSV: an
         undefined helper only surfaces when the branch that calls it runs,
         and the pick branch is reached only by a file that has a pick in it.
         So the closure is resolved against the REAL work. */
      const value = work(api);
      return { api: api, value: value, added: Object.keys(added) };
    } catch (e) {
      const m = /([A-Za-z_$][\w$]*) is not defined/.exec(String((e && e.message) || e));
      if (!m) throw e;
      const name = m[1];
      if (added[name]) throw new Error('could not resolve ' + name);
      if (html.indexOf('function ' + name + '(') !== -1) {
        added[name] = true;
        want.push(name);
      } else {
        const v = varBlock(name);
        if (!v) {
          throw new Error(name + ' is referenced but is neither a function nor '
            + 'a top-level var in collective/index.html (a DOM global, or a '
            + 'new dependency this test cannot supply)');
        }
        added[name] = true;
        consts.push(v);
      }
    }
  }
  throw new Error('the uploader dependency closure did not settle');
}

function upload(api, text) {
  const parsed = api.parseCSV(text);
  api.setSlate({ cols: parsed[0], rows: parsed, map: {} });
  api.slateGuessMap();
  const b = api.slateBuildRows();
  return { rows: b.rows || b, problems: b.problems || [] };
}

try {
  const r0 = buildUploader(['parseCSV', 'slateGuessMap', 'slateBuildRows',
                            'slateKick', 'slateNum', 'slatePick', 'slateSide',
                            'slateDetectWeek'],
                           (api) => upload(api, csv));
  P = r0.api;
  chk('the uploader loads out of collective/index.html', true);
  if (r0.added.length) {
    console.log('NOTE | pulled in ' + r0.added.length + ' helper(s)/constant(s) the '
      + 'uploader has grown since: ' + r0.added.join(', '));
  }
  built = r0.value;
  rows = built.rows;
  problems = built.problems;
  rows.forEach((x) => { byHome[x.home_team] = x; });
} catch (e) {
  chk('the uploader loads out of collective/index.html', false,
    { threw: String((e && e.message) || e) });
  done();
}

/* ---- the export itself -------------------------------------------------- */
chk('one row per game, not one per market',
  csv.trim().split('\n').length - 1 === 5, csv);
chk('a game beyond the window is excluded', !csv.includes('Green Bay'));
chk('another sport inside the window is excluded', !csv.includes('Red Sox'));
chk('no row is rejected by the uploader', problems.length === 0 && rows.length === 5,
  { problems: problems, n: rows.length });

['home_team', 'away_team', 'kickoff', 'pick_side', 'line_at_submission',
 'projected_spread', 'projected_total', 'home_win_probability',
 'cover_probability', 'proj_home_score', 'proj_away_score', 'week',
 'season', 'game_ref', 'kickoff_tz'].forEach((f) => {
  chk('the uploader auto-maps ' + f,
    P.SLATE.map[f] !== undefined && P.SLATE.map[f] !== null,
    csv.split('\n')[0]);
});

/* ---- the signs ---------------------------------------------------------- */
chk('home favourite: pick, home line and margin all agree', () => {
  const x = byHome['Seattle Seahawks'];
  return x.pick_side === 'home' && x.line_at_submission === -3.5
      && x.projected_spread === -4.8;
}, byHome['Seattle Seahawks']);

/* The one that inverts a whole board. */
chk('away favourite: the pick is -2.5 but the home line is +2.5', () => {
  const x = byHome['Carolina Panthers'];
  return x.pick_side === 'away' && x.line_at_submission === 2.5
      && x.projected_spread === 3.2;
}, byHome['Carolina Panthers']);

chk('the exported side is the one with the larger edge',
  csv.includes('Chicago Bears -2.5') && !csv.includes('Carolina Panthers +2.5'), csv);

chk("pick'em is written PK and reads back as zero", () => {
  const x = byHome['Houston Texans'];
  return x.pick_side === 'away' && x.line_at_submission === 0;
}, byHome['Houston Texans']);

/* to_char(7,'FM999990.9') is "7.", and the uploader refuses "NO +7." --- a
   trailing dot with no digit after it is not a number. Half points never
   reach that branch, so both signs are pinned. */
chk('a whole-number point survives the round trip, both signs', () => {
  const a = byHome['Detroit Lions'], h = byHome['Kansas City Chiefs'];
  return csv.includes('New Orleans Saints +7,') && csv.includes('Kansas City Chiefs -6,')
      && a.pick_side === 'away' && a.line_at_submission === -7
      && h.pick_side === 'home' && h.line_at_submission === -6;
}, { det: byHome['Detroit Lions'], kc: byHome['Kansas City Chiefs'] });

/* ---- the rest of the model's numbers ------------------------------------ */
chk('a game with no moneyline row still exports, with that column blank',
  byHome['Houston Texans']
  && byHome['Houston Texans'].home_win_probability === undefined,
  byHome['Houston Texans']);

/* Taking whichever h2h row sorts highest files the AWAY team's win
   probability under the home team's name. Carolina is the underdog and both
   rows exist, so a wrong query returns Chicago's 0.59 and looks fine. */
chk('home_win_probability is the HOME side\'s number',
  byHome['Seattle Seahawks'].home_win_probability === 0.63
  && byHome['Carolina Panthers'].home_win_probability === 0.41,
  { sea: byHome['Seattle Seahawks'].home_win_probability,
    car: byHome['Carolina Panthers'].home_win_probability });

chk('cover probability follows the exported side',
  byHome['Seattle Seahawks'].cover_probability === 0.56
  && byHome['Carolina Panthers'].cover_probability === 0.58);

chk('scores and totals ride along', () => {
  const x = byHome['Seattle Seahawks'];
  return x.projected_total === 44.1 && x.proj_home_score === 24.45
      && x.proj_away_score === 19.65;
}, byHome['Seattle Seahawks']);

chk('the kickoff carries a time and a declared zone', () => {
  const head = csv.split('\n')[0].split(',');
  const row = csv.split('\n')[1].split(',');
  return /T\d\d:\d\d:\d\d/.test(row[head.indexOf('kickoff')])
      && row[head.indexOf('kickoff_tz')] === 'America/New_York';
}, csv.split('\n').slice(0, 2));

chk('the game id is unique per game and built from the kickoff date', () => {
  const head = csv.split('\n')[0].split(',');
  const i = head.indexOf('game_id');
  const ids = csv.trim().split('\n').slice(1).map((l) => l.split(',')[i]);
  return new Set(ids).size === ids.length && ids.every((x) => /^\d{4}_\d{2}_\d{2}_/.test(x));
});

/* ---- the price-discrepancy columns ------------------------------------- */
chk('the edge columns are present and expressed as percentages', () => {
  const head = csv.split('\n')[0].split(',');
  const need = ['model_edge_pct', 'model_ev_pct', 'market_prob_pct', 'best_price'];
  if (!need.every((c) => head.includes(c))) return false;
  const bears = csv.split('\n').find((l) => l.includes('Chicago Bears'));
  return bears.split(',')[head.indexOf('model_edge_pct')] === '6.10';
}, csv.split('\n')[0]);

/* The uploader must ignore what it does not recognise rather than guess. */
chk('the context columns are not POSTed',
  rows.every((x) => !('model_edge_pct' in x) && !('model_ev_pct' in x)
                 && !('market_prob_pct' in x) && !('best_price' in x)));

/* Only finished numbers leave the project: no weights, no feature values, no
   source table names, no model version. */
chk('nothing proprietary reaches the CSV',
  !['epa', 'source_table', 'nfl_game_v1', 'feature', 'basis']
    .some((s) => csv.toLowerCase().includes(s)), csv.split('\n')[0]);

/* ---- the season rule, against the dates that break naive versions ------ */
{
  const i = SQL.indexOf('case\n    when extract(month');
  const probe = SQL.slice(i, SQL.indexOf('as season', i))
    .replace(/d\.commence_time/g, 'k.ts').replace(/\s+/g, ' ').trim();
  [['2026-09-09 20:15-04', 2026], ['2026-12-28 13:00-05', 2026],
   ['2027-01-10 15:00-05', 2026], ['2027-02-07 18:30-05', 2026],
   ['2027-03-01 12:00-05', 2027]].forEach(([ts, want]) => {
    const got = pg.psql(`-d mtc -tAq -c "select ${probe} from `
      + `(select timestamptz '${ts}' as ts) k"`).out.trim();
    chk('season of a kickoff at ' + ts + ' is ' + want, Number(got) === want, got);
  });
}

/* ---- a table missing the optional columns entirely --------------------- */
pg.psql('-d postgres -q -c "create database mtc_min"');
r = pg.psql(`-d mtc_min -q -v ON_ERROR_STOP=1 -f ${fMin}`);
chk('the reduced model_predictions fixture builds', r.status === 0, r.out.slice(-600));
if (r.status === 0) {
  const out = pg.psql(`-d mtc_min -q --csv -v ON_ERROR_STOP=1 -f ${fExp}`);
  chk('the export survives a table with no model_detail', out.status === 0,
    out.out.slice(-600));
  if (out.status === 0) {
    const b2 = upload(P, out.out.trim() + '\n');
    const got = b2.rows;
    const by2 = {}; got.forEach((x) => { by2[x.home_team] = x; });
    chk('both games still come through on the reduced shape',
      b2.problems.length === 0 && got.length === 2,
      { problems: b2.problems, n: got.length });
    chk('the sign still holds without model_edge',
      by2['Seattle Seahawks'] && by2['Seattle Seahawks'].line_at_submission === -3.5
      && by2['Carolina Panthers'] && by2['Carolina Panthers'].line_at_submission === 2.5,
      by2);
    /* A zero projected spread is a claim. A blank is the truth. */
    chk('the numbers that lived in model_detail are absent, not zero',
      by2['Seattle Seahawks'].projected_spread === undefined
      && by2['Seattle Seahawks'].projected_total === undefined);
    chk('model_prob still yields the probabilities',
      by2['Seattle Seahawks'].home_win_probability === 0.63
      && by2['Seattle Seahawks'].cover_probability === 0.56);
    /* coalesce(model_edge,-1) ties every row, so the tiebreak has to carry
       it, or the same table exports either side on different runs. */
    const again = pg.psql(`-d mtc_min -q --csv -v ON_ERROR_STOP=1 -f ${fExp}`);
    chk('two runs of the same table produce the same file', again.out === out.out);
  }
}

/* ---- an empty table ---------------------------------------------------- */
pg.psql('-d mtc -q -c "truncate public.model_predictions"');
{
  const empty = pg.psql(`-d mtc -q --csv -v ON_ERROR_STOP=1 -f ${fExp}`).out.trim();
  chk('an empty table exports headers and nothing else',
    empty.split('\n').filter(Boolean).length <= 1, empty);
}

done();
