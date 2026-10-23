#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The live (in-game) writer. SHIPPED DISABLED: it refuses to start while
   config/live.json says enabled = false, and the database refuses its writes
   while ncaam_fc_config.live_enabled is not 'true' (ncaam_fc_put_live).

     node basketball/ncaam_forecast/live_writer.js [--once] [--interval 45] [--max-minutes 240] [--dry-run]

   WHERE IT RUNS. On an always-on host an operator runs (CBB_MODEL_NOTES.md
   §8), never in GitHub Actions: a scheduled workflow is not a real-time
   service, and the writer refuses to start when GITHUB_ACTIONS is set.

   EACH CYCLE
     1 observations: ncaam_fc_live_observations() — the slate poller's NCAAM
       rows (tools/slate/live_poll.js -> public.slate_live): score, period,
       display clock, status and the FETCH time (no possession, no event time)
     2 pregame: the newest publishable refresh document in out/forecasts made
       by the CURRENT champion (refresh.js; its live_inputs per game). A game
       without one, or not D1 v D1 (the backtest's scope), gets no live row.
     3 feed checks (live.js checkFeed): stale, contradictory or incomplete
       observations are written as SUPPRESSED (no live probability), so the
       audit shows why nothing was shown
     4 the live probability (live.js liveProb, config/live.json model_params)
     5 one append-only row per NEW observation (ncaam_fc_put_live); an
       unchanged observation writes nothing
   The upset label's hysteresis (live.js alertState) is kept per game in
   memory and reported; it never changes a probability.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const L = require('./live');
const RG = require('./registry');

const MIN_INTERVAL_S = 30;

function liveConfig() { return JSON.parse(fs.readFileSync(C.PATHS.liveConfig, 'utf8')); }

/** why the writer may not start (empty: it may) */
function refusals(cfg, env) {
  const r = [];
  if (!cfg || cfg.enabled !== true) r.push('live forecasts are disabled (config/live.json enabled = false): ' + ((cfg && cfg.blockers) || []).join(' | '));
  if ((env || process.env).GITHUB_ACTIONS === 'true') r.push('refusing to run in GitHub Actions: a scheduled workflow is not a real-time service');
  return r;
}

/** "12:34" / "0:45.3" -> seconds left in the period (null when unreadable) */
function parseClock(s) {
  const m = /^\s*(\d{1,2}):(\d{2})(?:\.\d+)?\s*$/.exec(String(s == null ? '' : s));
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const t = /^\s*(\d{1,2}(?:\.\d+)?)\s*$/.exec(String(s == null ? '' : s));   // under a minute ESPN may send seconds only
  return t ? Math.floor(Number(t[1])) : null;
}

/** the newest publishable refresh document of the current champion */
function latestPregame(dir, championKey) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /\.json$/.test(f)).sort().reverse();
  for (const f of files) {
    let doc; try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (doc && doc.schema === 'edgedesk_ncaam_fc_forecasts_v1' && doc.publishable && doc.model && doc.model.key === championKey) return doc;
  }
  return null;
}

/** one slate row -> the observation live.js reads (home/away as the forecast lists them) */
function observationFrom(row, fc) {
  if (!row || !fc) return null;
  let home = row.home_score, away = row.away_score;
  if (String(row.home_id) === String(fc.away_id) && String(row.away_id) === String(fc.home_id)) { home = row.away_score; away = row.home_score; }
  else if (!(String(row.home_id) === String(fc.home_id) && String(row.away_id) === String(fc.away_id))) return { mismatch: true };
  const period = Number(row.period);
  return { period: Number.isFinite(period) ? period : null, clock_s: parseClock(row.clock), home_score: home == null ? null : Number(home), away_score: away == null ? null : Number(away),
    observed_at: row.updated_at, status: row.status === 'FINAL' ? 'final' : 'in' };
}

/**
 * One cycle. state: { last: Map(game_id -> observation), alert: Map(game_id -> bool) }.
 * Returns what was written (or would be, with dryRun).
 */
async function cycle(o) {
  const { db, pregame, cfg, state, nowMs } = o;
  const params = Object.assign({}, cfg.model_params || {});
  const byGame = new Map((pregame.forecasts || []).filter((f) => f.available && f.live_inputs).map((f) => [String(f.game_id), f]));
  const rows = await db.rpc('ncaam_fc_live_observations', { p_max_age_minutes: 30 });
  const out = { written: [], skipped: {} };
  const skip = (k) => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  for (const row of rows || []) {
    const fc = byGame.get(String(row.game_id));
    if (!fc) { skip('no_pregame_forecast'); continue; }
    if (fc.regime !== 'D1_D1') { skip('not_d1_v_d1'); continue; }
    const obs = observationFrom(row, fc);
    if (!obs || obs.mismatch) { skip('team_mismatch'); continue; }
    const prev = state.last.get(fc.game_id) || null;
    if (prev && prev.observed_at === obs.observed_at && prev.home_score === obs.home_score && prev.away_score === obs.away_score && prev.clock_s === obs.clock_s && prev.period === obs.period) { skip('unchanged'); continue; }
    const chk = L.checkFeed(obs, prev, nowMs, { max_age_s: (cfg.feed && cfg.feed.max_age_s) || 120 });
    const li = fc.live_inputs;
    let pLive = null;
    if (chk.ok) {
      const r = L.liveProb({ mu: li.mu, sd: li.sd }, { kappa: li.kappa, ot: { sd: li.ot_sd } }, obs, params);
      pLive = r && Number.isFinite(r.p_home) ? r.p_home : null;
    }
    const feedOk = chk.ok && pLive != null;
    const rec = { game_id: String(fc.game_id), model_key: pregame.model.key, observed_at: obs.observed_at, period: obs.period, clock_s: obs.clock_s, home_score: obs.home_score, away_score: obs.away_score,
      feed_age_s: chk.age_s, feed_ok: feedOk, suppressed_reasons: feedOk ? [] : (chk.reasons.length ? chk.reasons : ['no live probability for this state']), p_home_pregame: fc.p_home,
      p_home_live: feedOk ? pLive : null, live_model: params.model || 'score_time' };
    /* the database requires every field of a stored row; an incomplete observation is reported, not written */
    if (![rec.period, rec.clock_s, rec.home_score, rec.away_score].every(Number.isFinite) || !rec.observed_at) { skip('incomplete_observation'); state.last.set(fc.game_id, obs); continue; }
    const dogP = feedOk ? Math.min(pLive, 1 - pLive) : null;
    const on = feedOk ? L.alertState(!!state.alert.get(fc.game_id), dogP, cfg.alert_hysteresis) : !!state.alert.get(fc.game_id);
    state.alert.set(fc.game_id, on);
    if (!o.dryRun) await db.rpc('ncaam_fc_put_live', { p: rec });
    state.last.set(fc.game_id, obs);
    out.written.push(Object.assign({ upset_label_on: on }, rec));
  }
  return out;
}

async function main(argv, env) {
  const a = argv; const val = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const cfg = liveConfig();
  const why = refusals(cfg, env);
  if (why.length) { console.error('[ncaam live] not started:\n  ' + why.join('\n  ')); return 2; }
  const interval = Math.max(MIN_INTERVAL_S, Number(val('interval', 45)));
  const stopAt = Date.now() + Number(val('max-minutes', 240)) * 60000;
  const ptr = RG.readPointer();
  if (!ptr) { console.error('[ncaam live] no champion pointer'); return 2; }
  const db = require('./db').postgrestDb(env);
  const state = { last: new Map(), alert: new Map() };
  for (;;) {
    const pregame = latestPregame(path.join(C.PATHS.out, 'forecasts'), ptr.current.key);
    if (!pregame) console.error('[ncaam live] no publishable pregame document of ' + ptr.current.key + ' in out/forecasts (run refresh.js): nothing written');
    else {
      try { const r = await cycle({ db, pregame, cfg, state, nowMs: Date.now(), dryRun: a.includes('--dry-run') }); console.log('[ncaam live] wrote ' + r.written.length + ' skipped ' + JSON.stringify(r.skipped)); }
      catch (e) { console.error('[ncaam live] cycle failed (nothing half-written: one row per call): ' + e.message); }
    }
    if (a.includes('--once') || Date.now() + interval * 1000 > stopAt) return 0;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

module.exports = { MIN_INTERVAL_S, refusals, parseClock, latestPregame, observationFrom, cycle, main };
if (require.main === module) main(process.argv, process.env).then((c) => process.exit(c), (e) => { console.error('[ncaam live] ' + e.message); process.exit(3); });
