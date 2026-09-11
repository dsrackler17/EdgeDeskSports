#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the player baseline builder.

   The Match Center compares what a player is doing on court right now with
   what they normally do. "Normally" has to be counted from the licensed
   record already in the tennis schema, and it must not be counted in a
   phone's browser from thousands of rows on every refresh. So this job does
   it once, here, deterministically (lib/tennis_research.js buildBaseline),
   and writes one row per player to tennis.player_baselines with the sample
   behind every rate.

   TWO KINDS OF BASELINE live on the row and are never mixed:

     * the licensed record's — career win/loss, surface splits by season,
       dated form, ranking. These are counts over published facts;
     * EdgeDesk's own OBSERVED serve and return baselines (obs_*) —
       accumulated only from matches this pipeline itself watched. The
       licensed record carries NO point-level serve data, so nothing here is
       backfilled from it, these fields start empty, and the row always
       carries obs_matches beside them so the page can say how thin they are.

   A style label follows the same rule: a serve label needs observed matches,
   so a player EdgeDesk has never watched gets no serve label rather than a
   guessed one.

     node tools/tennis/build_baselines.js --upcoming --commit   # players in the draw window
     node tools/tennis/build_baselines.js --all --commit        # every player on file (weekly)
     node tools/tennis/build_baselines.js --players atp:1234    # named players
   =========================================================================== */
'use strict';

const R = require('../../lib/tennis_research.js');
const D = require('./db.js');

function log(...a) { if (!process.env.TENNIS_QUIET) console.log('[tennis-baselines]', ...a); }

function parseArgs(argv) {
  const o = { commit: false, all: false, upcoming: false, players: null, now: null, days: 21, back: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--all') o.all = true;
    else if (a === '--upcoming') o.upcoming = true;
    else if (a === '--players') o.players = String(next()).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--now') o.now = next();
    else if (a === '--days') o.days = Number(next());
    else if (a === '--back') o.back = Number(next());
  }
  if (!o.all && !o.upcoming && !o.players) o.upcoming = true;
  return o;
}

/* Observed serve/return baselines from this pipeline's own finished matches.
   A doubles match contributes nothing: its sides are teams, and a team's
   serve numbers are not a player's. */
function observedRows(matches, states, sets) {
  const byMatch = {};
  (states || []).forEach(s => { (byMatch[s.match_id] = byMatch[s.match_id] || {})[s.side] = s; });
  const setsByMatch = {};
  (sets || []).forEach(r => { ((setsByMatch[r.match_id] = setsByMatch[r.match_id] || {})[r.side] = setsByMatch[r.match_id][r.side] || []).push(r); });
  const perPlayer = {};
  (matches || []).forEach(m => {
    if (m.is_doubles) return;
    const st = byMatch[m.match_id];
    if (!st || !st.home || !st.away) return;
    [['home', m.home_player_id], ['away', m.away_player_id]].forEach(p => {
      const side = p[0], pid = p[1];
      if (!pid) return;
      const opp = side === 'home' ? 'away' : 'home';
      if (!st[side].stats_available) return;
      (perPlayer[String(pid)] = perPlayer[String(pid)] || []).push({
        side, match: m, state: st[side], oppState: st[opp],
        sets: ((setsByMatch[m.match_id] || {})[side] || []).filter(r => r.set_status === 'complete')
      });
    });
  });
  const out = {};
  Object.keys(perPlayer).forEach(pid => { out[pid] = R.observedBaseline(perPlayer[pid]); });
  return out;
}

/* Pure: every input row -> the baseline rows to write. */
function buildAll(input) {
  const now = input.now != null ? (typeof input.now === 'number' ? input.now : Date.parse(input.now)) : Date.now();
  const byId = {};
  (input.players || []).forEach(p => { byId[String(p.player_id)] = p; });
  const careers = {};
  (input.careers || []).forEach(c => { careers[String(c.player_id)] = c; });
  const ranks = {};
  (input.ranks || []).forEach(r => { ranks[String(r.player_id)] = r; });
  const surfaceBy = {}, formBy = {};
  (input.surface || []).forEach(r => { if (r && r.player_id != null) (surfaceBy[String(r.player_id)] = surfaceBy[String(r.player_id)] || []).push(r); });
  (input.form || []).forEach(r => { if (r && r.player_id != null) (formBy[String(r.player_id)] = formBy[String(r.player_id)] || []).push(r); });
  const observed = input.observed || {};
  const ids = input.ids ? input.ids.map(String) : Object.keys(byId);
  const rows = [];
  ids.forEach(id => {
    const p = byId[id];
    if (!p) return;
    rows.push(R.buildBaseline({ player: p, career: careers[id] || null, surface: surfaceBy[id] || [], form: formBy[id] || [],
      rank: ranks[id] || null, observed: observed[id] || null, now }));
  });
  rows.sort((a, b) => (a.player_id < b.player_id ? -1 : 1));
  return rows;
}

async function selectIn(db, schema, rel, cols, col, ids, chunk, order) {
  chunk = chunk || 60;
  const out = [];
  for (let i = 0; i < ids.length; i += chunk)
    out.push(...await db.selectAll(schema, rel, `select=${cols}&${col}=in.${D.inList(ids.slice(i, i + chunk))}&order=${order || col + '.asc'}`));
  return out;
}

async function run(o, deps) {
  const db = deps.db;
  const now = o.now ? new Date(o.now) : new Date();
  const summary = { players: 0, directory_players: 0, rows: 0, observed_players: 0, unresolved_sides: 0, errors: [] };

  let ids = null;
  if (o.players) ids = o.players;
  else if (o.upcoming) {
    const from = new Date(now.getTime() - o.back * 86400000).toISOString(), to = new Date(now.getTime() + o.days * 86400000).toISOString();
    const ms = await db.selectAll('tennis', 'live_matches',
      `select=home_player_id,away_player_id,is_doubles,home_name,away_name&scheduled_at=gte.${from}&scheduled_at=lte.${to}&status=in.(scheduled,live,final)&order=match_id.asc`);
    const set = new Set();
    ms.forEach(m => {
      if (m.is_doubles) return;
      if (m.home_player_id) set.add(String(m.home_player_id)); else summary.unresolved_sides++;
      if (m.away_player_id) set.add(String(m.away_player_id)); else summary.unresolved_sides++;
    });
    ids = Array.from(set);
    log(`${ids.length} resolved player(s) across ${ms.length} match(es) in the window (${summary.unresolved_sides} unresolved singles side(s))`);
    if (!ids.length) return summary;
  }

  const pooled = await D.playerPool(db, R, log,
    { columns: 'player_id,full_name,tour,country,plays,height_cm,birth_date',
      directoryColumns: 'player_id,full_name,tour,country,plays,height_cm,birth_date,current_rank,rank_points,rank_as_of',
      ids });
  const players = pooled.pool;
  summary.players = players.length;
  summary.directory_players = pooled.directory.length;
  if (ids && players.length < ids.length) log(`${ids.length - players.length} of the ${ids.length} id(s) have no player row in either source — skipped rather than invented`);

  const wanted = players.map(p => String(p.player_id));
  const careers = await readSafe(db, 'player_career', 'player_id,wins,losses,matches,win_pct,first_match,last_match', wanted, summary);
  const surface = await readSafe(db, 'player_surface', 'player_id,surface,season,wins,losses,matches,win_pct', wanted, summary, 'player_id.asc');
  const form = await readSafe(db, 'player_form', 'player_id,match_date,opponent_id,won,surface,tourney_name,round', wanted, summary, 'player_id.asc');
  const ranks = await readSafe(db, 'rankings_current', 'player_id,rank,points,as_of', wanted, summary);

  /* The licensed ranking table is the authority. Where it has no row for a
     player, the directory's own ranking stands in — same shape, marked by
     its source so nothing downstream mistakes one for the other. A player
     with neither stays unranked rather than being given a number. */
  const ranked = new Set(ranks.map(r => String(r.player_id)));
  let borrowed = 0;
  pooled.directory.forEach(p => {
    const id = String(p.player_id);
    if (ranked.has(id) || !wanted.includes(id)) return;
    if (p.current_rank == null) return;
    ranks.push({ player_id: id, rank: p.current_rank, points: p.rank_points == null ? null : p.rank_points,
                 as_of: p.rank_as_of || null, source: 'directory' });
    borrowed++;
  });
  if (borrowed) log(`${borrowed} ranking(s) came from the provider directory because the licensed table has no row for them`);

  /* observed, from what this pipeline watched */
  let observed = {};
  try {
    const finals = await db.selectAll('tennis', 'live_matches',
      'select=match_id,is_doubles,home_player_id,away_player_id,best_of,set_scores,winner_side,status&status=in.(final,walkover)&order=match_id.asc');
    const keep = finals.filter(m => !m.is_doubles && (!ids || wanted.includes(String(m.home_player_id)) || wanted.includes(String(m.away_player_id))));
    const mids = keep.map(m => m.match_id);
    const states = mids.length ? await selectIn(db, 'tennis', 'match_live_state', '*', 'match_id', mids, 40) : [];
    const sets = mids.length ? await selectIn(db, 'tennis', 'match_set_stats', '*', 'match_id', mids, 40) : [];
    observed = observedRows(keep, states, sets);
    summary.observed_players = Object.keys(observed).length;
  } catch (e) {
    summary.errors.push('observed: ' + e.message);
    log('observed serve baselines skipped: ' + e.message);
  }

  const rows = buildAll({ players, careers, surface, form, ranks, observed, ids: wanted, now: now.getTime() });
  summary.rows = rows.length;
  const withObs = rows.filter(r => r.obs_matches > 0).length;
  log(`${rows.length} baseline row(s) from ${careers.length} career rows, ${surface.length} surface rows, ${form.length} form rows`);
  log(`${withObs} row(s) carry an observed serve baseline; the other ${rows.length - withObs} say so rather than borrowing one`);
  if (o.commit && rows.length) {
    const payload = rows.map(r => Object.assign({}, r, { notes: r.notes || [], surface_splits: r.surface_splits || {}, style_labels: r.style_labels || [] }));
    await db.upsert('tennis', 'player_baselines', payload, 'player_id', { returning: false, chunk: 200 });
  }
  return summary;
}

/* A licensed view that is not present in this deployment is a missing input,
   not a crash: the baseline is built from what IS there and says what was
   missing. */
async function readSafe(db, rel, cols, ids, summary, order) {
  try {
    if (ids && ids.length) return await selectIn(db, 'tennis', rel, cols, 'player_id', ids, 60, order);
    return await db.selectAll('tennis', rel, `select=${cols}&order=${order || 'player_id.asc'}`);
  } catch (e) {
    summary.errors.push(`${rel}: ${String(e && e.message || e).slice(0, 160)}`);
    log(`tennis.${rel} not readable (${String(e && e.message || e).slice(0, 120)}) — that input is missing, not zero`);
    return [];
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cfg = D.config();
  if (!cfg) { console.error('No service credential (EDGD_SB_SERVICE + EDGD_SB_URL).'); process.exit(1); }
  const db = D.client(cfg);
  const ledger = o.commit ? D.runLedger(db, 'tennis_baselines') : null;
  if (ledger) await ledger.start({ mode: o.all ? 'all' : (o.players ? 'players' : 'upcoming') });
  let code = 0;
  try {
    const s = await run(o, { db });
    const msg = `${s.rows} baselines (${s.observed_players} with observed serve data) from ${s.players} players`;
    log(msg);
    if (ledger) {
      const status = s.errors.length ? 'warn' : 'ok';
      await ledger.finish(status, msg, { last_success_at: new Date().toISOString(), details: s });
      await D.writeMeta(db, { tennis_baselines_last_run: new Date().toISOString(), tennis_baselines_last_status: status, row_count_tennis_baselines: s.rows });
    }
  } catch (e) {
    D.reportFailure('tennis-baselines', e);
    console.error('[tennis-baselines] failed: ' + (e && e.stack || e));
    if (ledger && !D.explain(e)) {
      try {
        await ledger.finish('error', String(e && e.message || e).slice(0, 400));
        await D.writeMeta(db, { tennis_baselines_last_run: new Date().toISOString(), tennis_baselines_last_status: 'error' });
      } catch (_) {}
    }
    code = 1;
  }
  process.exit(code);
}

module.exports = { parseArgs, buildAll, observedRows, run };
if (require.main === module) main();
