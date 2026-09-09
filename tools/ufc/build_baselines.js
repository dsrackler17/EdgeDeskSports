#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk UFC — the fighter baseline builder.

   The Fight Center compares what a fighter is doing tonight with what they
   normally do. "Normally" has to be computed from the fight history and the
   career microstats already in the ufc schema, and it must not be computed
   in a phone's browser from thousands of rows on every refresh. So this job
   does it once, here, deterministically (lib/ufc_research.js buildBaseline),
   and writes one row per fighter to ufc.fighter_baselines with the sample
   behind every rate. A rate with two fights behind it is stored with "2",
   and the page draws it that way.

   Two kinds of baseline live on the row and are never mixed:

     * the dataset's: UFCStats career averages (pace, accuracy, takedowns)
       and everything derivable from the fight list (finish rates, streaks,
       layoff, five-round depth, opponent quality);
     * EdgeDesk's own OBSERVED baselines — target and position shares, attempt
       rates, per-round pace — accumulated from the fights this pipeline has
       itself watched. They start empty. Nothing is backfilled from a source
       that does not carry them, and the row says how many fights they rest on.

     node tools/ufc/build_baselines.js --upcoming --commit   # fighters on cards in the window
     node tools/ufc/build_baselines.js --all --commit        # every fighter on file (weekly)
   =========================================================================== */
'use strict';

const R = require('../../lib/ufc_research.js');
const D = require('./db.js');

function log(...a) { if (!process.env.UFC_QUIET) console.log('[ufc-baselines]', ...a); }

function parseArgs(argv) {
  const o = { commit: false, all: false, upcoming: false, fighters: null, now: null, days: 45 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--all') o.all = true;
    else if (a === '--upcoming') o.upcoming = true;
    else if (a === '--fighters') o.fighters = String(next()).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--now') o.now = next();
    else if (a === '--days') o.days = Number(next());
  }
  if (!o.all && !o.upcoming && !o.fighters) o.upcoming = true;
  return o;
}

/* Observed baselines from this pipeline's own finished bouts. */
function observedRows(bouts, states, rounds) {
  const byBout = {};
  (states || []).forEach(s => { (byBout[s.bout_id] = byBout[s.bout_id] || {})[s.corner] = s; });
  const roundsByBout = {};
  (rounds || []).forEach(r => { ((roundsByBout[r.bout_id] = roundsByBout[r.bout_id] || {})[r.corner] = roundsByBout[r.bout_id][r.corner] || []).push(r); });
  const perFighter = {};
  (bouts || []).forEach(b => {
    const st = byBout[b.bout_id]; if (!st || !st.red || !st.blue) return;
    const elapsed = R.elapsedAtEnd(b) != null ? R.elapsedAtEnd(b) : (st.red.elapsed_seconds || st.blue.elapsed_seconds || null);
    [['red', b.red_fighter_id], ['blue', b.blue_fighter_id]].forEach(p => {
      const corner = p[0], fid = p[1]; if (!fid) return;
      const opp = corner === 'red' ? 'blue' : 'red';
      if (!st[corner].stats_available) return;
      (perFighter[String(fid)] = perFighter[String(fid)] || []).push({ state: st[corner], oppState: st[opp], elapsed,
        rounds: ((roundsByBout[b.bout_id] || {})[corner] || []).filter(r => r.round_status === 'complete') });
    });
  });
  const out = {};
  Object.keys(perFighter).forEach(fid => { out[fid] = R.observedBaseline(perFighter[fid]); });
  return out;
}

/* Pure: everything -> baseline rows. */
function buildAll(input) {
  const now = input.now != null ? (typeof input.now === 'number' ? input.now : Date.parse(input.now)) : Date.now();
  const byId = {};
  (input.fighters || []).forEach(f => { byId[String(f.fighter_id)] = f; });
  const careers = {};
  (input.careers || []).forEach(c => { careers[String(c.fighter_id)] = c; });
  const fightsBy = {};
  (input.fights || []).forEach(f => { if (f && f.fighter_id != null) (fightsBy[String(f.fighter_id)] = fightsBy[String(f.fighter_id)] || []).push(f); });
  const observed = input.observed || {};
  const ids = input.ids ? input.ids.map(String) : Object.keys(byId);
  const rows = [];
  ids.forEach(id => {
    const f = byId[id]; if (!f) return;
    const b = R.buildBaseline({ fighter: f, fights: fightsBy[id] || [], career: careers[id] || null, byId, observed: observed[id] || null, now });
    b.built_at = new Date(now).toISOString();
    rows.push(b);
  });
  rows.sort((a, b) => (a.fighter_id < b.fighter_id ? -1 : 1));
  return rows;
}

async function run(o, deps) {
  const db = deps.db;
  const now = o.now ? new Date(o.now) : new Date();
  const summary = { fighters: 0, rows: 0, observed_fighters: 0, errors: [] };
  let ids = null;
  if (o.fighters) ids = o.fighters;
  else if (o.upcoming) {
    const from = new Date(now.getTime() - 2 * 86400000).toISOString(), to = new Date(now.getTime() + o.days * 86400000).toISOString();
    const evs = await db.select('ufc', 'events', `select=event_id&scheduled_at=gte.${from}&scheduled_at=lte.${to}&event_state=in.(scheduled,live,final)&limit=100`);
    const eids = evs.map(e => e.event_id);
    const bouts = eids.length ? await db.select('ufc', 'bouts', `select=red_fighter_id,blue_fighter_id&event_id=in.${D.inList(eids)}&limit=2000`) : [];
    const set = new Set();
    bouts.forEach(b => { if (b.red_fighter_id) set.add(String(b.red_fighter_id)); if (b.blue_fighter_id) set.add(String(b.blue_fighter_id)); });
    ids = Array.from(set);
    log(`${ids.length} fighters on ${eids.length} card(s) in the window`);
    if (!ids.length) return summary;
  }
  /* opponent quality needs every fighter's record, so the fighter table is read whole either way */
  const fighters = await db.selectAll('ufc', 'fighters', 'select=fighter_id,full_name,wins,losses,draws,age,reach_inches,height_inches,stance,division&order=fighter_id.asc');
  summary.fighters = fighters.length;
  const careers = ids
    ? await selectIn(db, 'ufc', 'fighter_career_stats', 'fighter_id,slpm,sapm,striking_accuracy,striking_defense,takedown_avg,takedown_accuracy,takedown_defense,submission_avg,knockdown_avg,control_time_avg', 'fighter_id', ids)
    : await db.selectAll('ufc', 'fighter_career_stats', 'select=fighter_id,slpm,sapm,striking_accuracy,striking_defense,takedown_avg,takedown_accuracy,takedown_defense,submission_avg,knockdown_avg,control_time_avg&order=fighter_id.asc');
  const fights = ids
    ? await selectIn(db, 'ufc', 'fighter_fights', 'fighter_id,opponent_id,date,weight_class,winner,method,round,time,went_distance,title_fight', 'fighter_id', ids)
    : await db.selectAll('ufc', 'fighter_fights', 'select=fighter_id,opponent_id,date,weight_class,winner,method,round,time,went_distance,title_fight&order=fighter_id.asc,date.asc', 1000, 200);
  /* observed */
  let observed = {};
  try {
    const finals = await db.selectAll('ufc', 'bouts', 'select=bout_id,red_fighter_id,blue_fighter_id,method,end_round,end_time,scheduled_rounds,elapsed_seconds&status=in.(final,no_contest)&order=bout_id.asc');
    const keep = ids ? finals.filter(b => ids.includes(String(b.red_fighter_id)) || ids.includes(String(b.blue_fighter_id))) : finals;
    const bids = keep.map(b => b.bout_id);
    const states = bids.length ? await selectIn(db, 'ufc', 'fight_live_state', '*', 'bout_id', bids) : [];
    const rounds = bids.length ? await selectIn(db, 'ufc', 'fight_round_stats', '*', 'bout_id', bids) : [];
    observed = observedRows(keep, states, rounds);
    summary.observed_fighters = Object.keys(observed).length;
  } catch (e) { summary.errors.push('observed: ' + e.message); log('observed baselines skipped: ' + e.message); }

  const rows = buildAll({ fighters, careers, fights, observed, ids, now: now.getTime() });
  summary.rows = rows.length;
  log(`${rows.length} baseline row(s) built from ${fights.length} fights and ${careers.length} career rows`);
  if (o.commit && rows.length) {
    const payload = rows.map(r => { const c = Object.assign({}, r); c.notes = r.notes || []; c.round_finish_dist = r.round_finish_dist || {}; return c; });
    await db.upsert('ufc', 'fighter_baselines', payload, 'fighter_id', { returning: false, chunk: 300 });
  }
  return summary;
}

async function selectIn(db, schema, rel, cols, col, ids, chunk) {
  chunk = chunk || 60;
  const out = [];
  for (let i = 0; i < ids.length; i += chunk) {
    out.push(...await db.selectAll(schema, rel, `select=${cols}&${col}=in.${D.inList(ids.slice(i, i + chunk))}&order=${col}.asc`));
  }
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cfg = D.config();
  if (!cfg) { console.error('No service credential (EDGD_SB_SERVICE + EDGD_SB_URL).'); process.exit(1); }
  const db = D.client(cfg);
  const ledger = o.commit ? D.runLedger(db, 'ufc_baselines') : null;
  if (ledger) await ledger.start({ mode: o.all ? 'all' : (o.fighters ? 'fighters' : 'upcoming') });
  let code = 0;
  try {
    const s = await run(o, { db });
    const msg = `${s.rows} baselines (${s.observed_fighters} with observed live data) from ${s.fighters} fighters`;
    log(msg);
    if (ledger) {
      await ledger.finish(s.errors.length ? 'warn' : 'ok', msg, { last_success_at: new Date().toISOString(), details: s });
      await D.writeMeta(db, { ufc_baselines_last_run: new Date().toISOString(), ufc_baselines_last_status: s.errors.length ? 'warn' : 'ok', row_count_ufc_baselines: s.rows });
    }
  } catch (e) {
    console.error('[ufc-baselines] failed: ' + (e && e.stack || e));
    if (ledger) { await ledger.finish('error', String(e && e.message || e).slice(0, 400)); await D.writeMeta(db, { ufc_baselines_last_run: new Date().toISOString(), ufc_baselines_last_status: 'error' }); }
    code = 1;
  }
  process.exit(code);
}

module.exports = { parseArgs, buildAll, observedRows, run };
if (require.main === module) main();
