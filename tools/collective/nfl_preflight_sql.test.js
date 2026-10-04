#!/usr/bin/env node
/* ===========================================================================
   nfl_preflight.sql — the diagnostic, against hostile database shapes.

   tools/collective/nfl_preflight.sql answers one question: why has the NFL
   model not produced a row? It is meant to be pasted into the Supabase SQL
   editor, so the one thing it must never do is fail. A diagnostic that errors
   out on a database missing the very tables it is checking for is worse than
   no diagnostic: it reports a broken query where the honest answer was "that
   table does not exist, and that is your blocker".

   So the shapes below are deliberately hostile and deliberately partial:
   nothing exists; the features table exists but is a column short; it has
   every column and no rows; a whole season is captured but every game is past
   the model's look-ahead; model_predictions exists without the optional
   columns the export wants. Every one of them has to come back with an
   answer, and the answer has to name the thing to fix.

   If no postgres binary is available this suite says so and passes on the
   static layer alone. A skipped check that announces itself is honest.

   Run: node tools/collective/nfl_preflight_sql.test.js
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

const SQL_PATH = path.join(__dirname, 'nfl_preflight.sql');
const SQL = fs.readFileSync(SQL_PATH, 'utf8');

/* ═══ STATIC ══════════════════════════════════════════════════════════════ */
{
  /* It reads. Full stop. This file gets pasted into a production SQL editor
     by a creator who is already frustrated that nothing works. */
  const stripped = SQL.replace(/--[^\n]*/g, ' ');
  chk('it writes nothing',
    !/\b(insert|update|delete|truncate|alter|drop|grant|revoke)\b/i.test(stripped),
    (stripped.match(/\b(insert|update|delete|truncate|alter|drop|grant|revoke)\b/gi) || []).join(','));

  /* A function in pg_temp disappears with the session, so pasting this does
     not leave anything behind in the user's schema. */
  chk('the helper lives in pg_temp, leaving nothing behind',
    /create or replace function pg_temp\./.test(SQL));

  /* Every table it looks at may be absent. to_regclass returns null instead
     of raising, which is the whole reason the file can run at all. */
  chk('every table is probed with to_regclass before being read',
    ['public.nfl_team_features', 'public.game_stats', 'public.signals',
     'public.model_predictions'].every((t) => SQL.includes("to_regclass('" + t + "')")));

  /* The registry routes by PREFIX: americanfootball_nfl_preseason is the same
     model. Matching on equality silently under-reports the capture. */
  chk('NFL is matched by prefix, so preseason counts',
    /like 'americanfootball_nfl%'/.test(SQL));

  chk('it names the three columns the model actually requires',
    ['off_epa_play', 'def_epa_play', 'plays_per_game'].every((c) => SQL.includes(c)));
}

/* ═══ LIVE ════════════════════════════════════════════════════════════════ */
const BIN = findPgBin();
if (!BIN) {
  done('NOTE | no postgres binary available — the LIVE layer did not run.\n'
     + '     | The static layer holds the read-only and to_regclass conventions;\n'
     + '     | only a real server can hold the verdicts.');
}
const pg = startCluster(BIN, 'pfl');
if (!pg.ok) {
  done('NOTE | could not start a local postgres (' + pg.why + ')\n'
     + '     | The LIVE layer did not run; the static layer above did.');
}
const fSql = pg.stage(SQL_PATH);

let dbN = 0;
/* Rows come back as step|verdict|detail so a verdict can be asserted without
   parsing the prose around it. */
function shape(setup) {
  const db = 'pfl' + (++dbN);
  pg.psql(`-d postgres -q -c "create database ${db}"`);
  if (setup) {
    const r = pg.psql(`-d ${db} -q -v ON_ERROR_STOP=1 -c ${JSON.stringify(setup)}`);
    if (r.status !== 0) return { err: r.out.slice(-400) };
  }
  const r = pg.psql(`-d ${db} -q -tAF'|' -v ON_ERROR_STOP=1 -f ${fSql}`);
  if (r.status !== 0) return { err: r.out.slice(-400) };
  const rows = r.out.trim().split('\n').filter(Boolean).map((l) => {
    const parts = l.split('|');
    return { step: parts[0], verdict: parts[1], detail: parts.slice(2).join('|') };
  });
  return { rows: rows, at: (frag) => rows.find((x) => x.step.indexOf(frag) !== -1) };
}

const FEATURES = 'create table public.nfl_team_features(team text primary key, '
  + 'off_epa_play numeric, def_epa_play numeric)';
const PLAYS = '; alter table public.nfl_team_features add column plays_per_game numeric';
const PREDS = 'create table public.model_predictions(model_version text, event_id text, '
  + 'commence_time timestamptz, home_team text, away_team text, market text, '
  + 'selection text, point numeric, model_prob numeric)';

/* ---- nothing exists ---------------------------------------------------- */
{
  const s = shape(null);
  chk('an empty database answers instead of erroring', !s.err && s.rows.length >= 3, s.err);
  if (!s.err) {
    chk('the missing features table is the blocker, and it names the columns',
      s.at('nfl_team_features').verdict === 'BLOCKED'
      && /off_epa_play/.test(s.at('nfl_team_features').detail),
      s.at('nfl_team_features'));
    chk('a missing signals table is a blocker too',
      s.at('signals').verdict === 'BLOCKED', s.at('signals'));
  }
}

/* ---- the features table, three ways ----------------------------------- */
{
  /* "something is wrong with nfl_team_features" is not actionable. */
  const s = shape(FEATURES);
  const f = s.err ? null : s.at('nfl_team_features');
  chk('a features table short one column names only that column',
    f && f.verdict === 'BLOCKED' && /missing: plays_per_game/.test(f.detail)
    && !/off_epa_play/.test(f.detail), s.err || f);
}
{
  const s = shape(FEATURES + PLAYS);
  const f = s.err ? null : s.at('nfl_team_features');
  chk('every column present but no rows is still blocked',
    f && f.verdict === 'BLOCKED' && /empty/.test(f.detail), s.err || f);
}
{
  const s = shape(FEATURES + PLAYS + "; insert into public.nfl_team_features values ('KC',0.12,-0.05,63)");
  const f = s.err ? null : s.at('nfl_team_features');
  chk('a populated features table passes, and counts in the singular',
    f && f.verdict === 'ok' && /1 row,/.test(f.detail), s.err || f);
}

/* ---- the look-ahead --------------------------------------------------- */
{
  /* THE REAL FAILURE, and the quiet one. A whole season captured, every game
     past NFL_WINDOW_AHEAD_H, and a run that reports success while writing
     nothing. The only useful output is the number to raise the setting to. */
  const s = shape('create table public.signals(event_id text, sport_key text, '
    + "commence_time timestamptz); insert into public.signals values "
    + "('e1','americanfootball_nfl', now()+interval '18 days'),"
    + "('e2','americanfootball_nfl', now()+interval '140 days')");
  const w = s.err ? null : s.at('model window');
  chk('nothing reachable is BLOCKED, and says how far to reach',
    w && w.verdict === 'BLOCKED' && /NOTHING is reachable/.test(w.detail)
    && /at least 43[0-9]/.test(w.detail) && /or 33[0-9]{2} /.test(w.detail),
    s.err || w);
}
{
  /* One check counted distinct events and the other counted rows, so a real
     database reported "0 of 2950" one line under "272 events". Two numbers
     for the same thing reads as two separate bugs. */
  const s = shape('create table public.signals(event_id text, sport_key text, '
    + 'commence_time timestamptz, book text); '
    + "insert into public.signals select 'e'||g, 'americanfootball_nfl', "
    + "now()+interval '20 days', b from generate_series(1,4) g, "
    + "unnest(array['dk','fd','mgm']) b");
  chk('the window counts events, not snapshot rows',
    !s.err && /4 events/.test(s.at('signals').detail)
    && /\b0 of 4 /.test(s.at('model window').detail),
    s.err || { signals: s.at('signals'), window: s.at('model window') });
}
{
  const s = shape('create table public.signals(event_id text, sport_key text, '
    + "commence_time timestamptz); insert into public.signals values "
    + "('e1','americanfootball_nfl_preseason', now()+interval '2 days')");
  chk('a preseason sport_key counts as NFL',
    !s.err && s.at('signals').verdict === 'ok' && /1 events/.test(s.at('signals').detail),
    s.err || s.at('signals'));
}
{
  const s = shape('create table public.signals(event_id text, sport_key text, commence_time timestamptz)');
  chk('no captured NFL events points at where the feed writes',
    !s.err && s.at('signals').verdict === 'BLOCKED' && /odds schema/.test(s.at('signals').detail),
    s.err || s.at('signals'));
}

/* ---- the fallback ----------------------------------------------------- */
{
  const s = shape('create table public.game_stats(team text, wins int)');
  const g = s.err ? null : s.at('game_stats');
  chk('a game_stats table without the points columns reads unavailable',
    g && g.verdict === 'unavailable' && /none/.test(g.detail), s.err || g);
}

/* ---- model_predictions ------------------------------------------------ */
{
  /* This is the live shape. A missing optional column costs four CSV columns,
     not the export, and the difference has to be stated or the creator
     assumes the whole file is wrong. */
  const s = shape(PREDS);
  const req = s.err ? null : s.at('columns (required)');
  const opt = s.err ? null : s.at('columns (optional)');
  chk('a table missing model_detail is PARTIAL, not broken',
    req && req.verdict === 'ok' && opt && opt.verdict === 'PARTIAL'
    && /model_detail/.test(opt.detail)
    && /projected spread, total and scores/.test(opt.detail)
    && /pick, the market line and the probabilities are unaffected/.test(opt.detail),
    s.err || { req: req, opt: opt });

  /* Distinct from BLOCKED: nothing is broken, the model simply never ran. */
  chk("an empty predictions table reads 'empty' and names the exporter",
    !s.err && s.at('(nfl_game_v1)').verdict === 'empty'
    && /model_to_csv/.test(s.at('(nfl_game_v1)').detail),
    s.err || s.at('(nfl_game_v1)'));

  /* model_predict sending a column the table does not have makes PostgREST
     reject the entire insert. An empty table plus a missing optional column
     together ARE that failure, and it is invisible from either one alone. */
  chk('an empty table for every model points at the likely cause',
    !s.err && s.at('all models').verdict === 'empty'
    && /PostgREST rejects the whole insert/.test(s.at('all models').detail),
    s.err || s.at('all models'));
}
{
  const s = shape('create table public.model_predictions(model_version text, '
    + 'event_id text, commence_time timestamptz, home_team text, away_team text, '
    + 'market text, model_prob numeric)');
  const req = s.err ? null : s.at('columns (required)');
  chk('a table missing a required column is BLOCKED and names it',
    req && req.verdict === 'BLOCKED' && /selection/.test(req.detail)
    && /point/.test(req.detail) && !/model_prob/.test(req.detail), s.err || req);
}
{
  const s = shape(PREDS.replace(/\)$/, ', model_detail jsonb, model_edge numeric, '
    + 'model_ev numeric, market_prob_at_pred numeric, best_am_at_pred int)'));
  chk('a complete table reports both column checks ok',
    !s.err && s.at('columns (required)').verdict === 'ok'
    && s.at('columns (optional)').verdict === 'ok',
    s.err || s.rows);
}
{
  const s = shape(PREDS + "; insert into public.model_predictions(model_version) "
    + "select 'mlb_runs_v1.2' from generate_series(1,7); "
    + "insert into public.model_predictions(model_version) values ('ufc_fight_v1')");
  const a = s.err ? null : s.at('all models');
  chk('a table with other sports in it lists them, busiest first',
    a && a.verdict === 'ok' && /mlb_runs_v1\.2 \(7\)/.test(a.detail)
    && /ufc_fight_v1 \(1\)/.test(a.detail), s.err || a);
}

done();
