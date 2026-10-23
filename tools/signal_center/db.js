/* ===========================================================================
   SIGNAL CENTER — the worker's database: PostgREST with the service role.

   SB_URL and SB_SERVICE_ROLE come from the job's environment (GitHub Actions
   secrets), never from a file, a log line or an error message: every error
   text is scrubbed of the key before it is thrown.

   Writes go only to the sc_* job doors (supabase/signal_center.sql). Reads of
   other layers (the Simulator's published runs, the NBA injury reports, the
   Kalshi card) are plain GETs; a layer that is not installed, or answers an
   error, removes only its own signals: it is recorded and the run goes on.

   Transient failures (network, 5xx, 429) are retried at most 3 times with
   exponential backoff; a 4xx is a deterministic refusal and is not retried.
   A run makes at most MAX_REQUESTS calls (the budget guard): a runaway loop
   stops itself rather than load the database.
   =========================================================================== */
'use strict';

const MAX_REQUESTS = 400;

function client(env, opts) {
  env = env || process.env;
  opts = opts || {};
  const url = String(env.SB_URL || '').replace(/\/+$/, ''), key = env.SB_SERVICE_ROLE || '';
  if (!opts.fetchImpl && !/^https:\/\/[a-z0-9.-]+$/i.test(url)) throw new Error('SB_URL is not set to an https Supabase URL');
  if (key.length < 8) throw new Error('SB_SERVICE_ROLE is not set');
  const f = opts.fetchImpl || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retries = opts.retries == null ? 3 : opts.retries;
  const scrub = (s) => String(s).split(key).join('[redacted]');
  let used = 0;
  async function call(method, path, body) {
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (++used > (opts.maxRequests || MAX_REQUESTS)) throw new Error('request budget exhausted (' + (opts.maxRequests || MAX_REQUESTS) + ' calls): the run stops rather than load the database');
      let res;
      try {
        res = await f((url || 'http://standin') + '/rest/v1/' + path, { method, headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        last = Object.assign(new Error('network error on ' + path.split('?')[0] + ': ' + scrub(e && e.message || e)), { transient: true });
        if (attempt < retries) { await sleep(400 * Math.pow(2, attempt)); continue; }
        throw last;
      }
      const text = await res.text();
      if (res.ok) { try { return text ? JSON.parse(text) : null; } catch (_) { return text; } }
      const transient = res.status >= 500 || res.status === 429;
      last = Object.assign(new Error(path.split('?')[0] + ' answered ' + res.status + ': ' + scrub(text).slice(0, 400)), { status: res.status, transient });
      if (transient && attempt < retries) { await sleep(400 * Math.pow(2, attempt)); continue; }
      throw last;
    }
    throw last;
  }
  return {
    get used() { return used; },
    rpc(name, args) {
      if (!/^sc_[a-z_]+$/.test(name)) throw new Error('the worker calls Signal Center doors only, not ' + name);
      return call('POST', 'rpc/' + name, args || {});
    },
    get(path) {
      if (!/^(sim_published|sim_runs|sim_team_results|nba_injury_report_snapshots|nba_injury_reports|kalshi_card_current)\?/.test(path)) throw new Error('the worker reads only the published layers it needs, not ' + path.split('?')[0]);
      return call('GET', path);
    }
  };
}

/* ------------------------------------------------ the database sources */
const SIM_OUTCOMES = require('../../lib/edgedesk_signal_engine.js').SIM_OUTCOMES;

/* the Simulator: each competition's published run and the run it replaced */
async function simPairs(db, log) {
  const out = [];
  let pub;
  try { pub = await db.get('sim_published?select=sport,competition,season,run_id,previous_run_id,published_at'); }
  catch (e) { log('sim', 'the Simulator is not readable here: ' + e.message); return out; }
  for (const p of pub || []) {
    if (!p.previous_run_id || !SIM_OUTCOMES[p.sport]) continue;
    const runs = {};
    for (const id of [p.previous_run_id, p.run_id]) {
      const r = await db.get('sim_runs?select=run_id,sport,competition,season,status,model_version,rules_version,engine_version,n_sims,input_snapshot_at,completed_at,validation_summary&run_id=eq.' + id);
      if (r && r[0]) runs[id] = r[0];
    }
    if (!runs[p.previous_run_id] || !runs[p.run_id]) { log('sim', p.sport + ': a run of the published pair is missing'); continue; }
    const results = { previous: [], current: [] };
    for (const oc of Object.keys(SIM_OUTCOMES[p.sport])) {
      for (const [side, id] of [['previous', p.previous_run_id], ['current', p.run_id]]) {
        const rows = await db.get('sim_team_results?select=entity_id,entity_name,outcome,probability,mcse,provenance,applicable&run_id=eq.' + id + '&outcome=eq.' + oc);
        (rows || []).forEach((x) => results[side].push(x));
      }
    }
    const cur = Object.assign({}, runs[p.run_id], { published_at: p.published_at });
    out.push({ pair: { sport: p.sport, competition: p.competition, season: p.season, previous: runs[p.previous_run_id], current: cur }, results });
  }
  return out;
}

/* NBA official injury designations (the NBA's own report, with its
   publication time) for games that have not started */
async function nbaInjuries(db, now, log) {
  let rows;
  try {
    rows = await db.get('nba_injury_report_snapshots?select=report_id,game_id,game_start_utc,matchup,team_abbr,player_id,player_name,status,reason,report_published_at,captured_at,source&source=eq.nba_official&game_start_utc=gt.' + new Date(now - 6 * 3600e3).toISOString() + '&order=captured_at.desc&limit=5000');
  } catch (e) { log('nba_injury', 'the NBA injury layer is not readable here: ' + e.message); return []; }
  return (rows || []).filter((r) => r.player_id && r.report_published_at).map((r) => ({
    sport: 'nba', season: null, team: { name: r.team_abbr, abbr: r.team_abbr },
    player: { id: r.player_id, name: r.player_name, position: null },
    status: r.status,
    report: { id: String(r.report_id), type: 'official injury', published_at: r.report_published_at, retrieved_at: r.captured_at, source_url: null, source: 'NBA official injury report' },
    game: { event_key: 'NBA|' + r.game_id, event_at: r.game_start_utc, label: r.matchup, research_href: '#research/nba/' + encodeURIComponent(r.game_id) }
  }));
}

/* Kalshi's game-winner mid for the HOME team, two-sided quotes only (the
   card's own rule), by the football card's game key */
async function kalshiMids(db, log) {
  const m = new Map();
  let rows;
  try { rows = await db.get('kalshi_card_current?select=sport,game_key,yes_team,home_team,away_team,state,snapshot_at,yes_mid,pregame,market_ticker&state=eq.OK'); }
  catch (e) { log('kalshi', 'the Kalshi card is not readable here: ' + e.message); return m; }
  (rows || []).forEach((r) => {
    if (!r.pregame || r.yes_mid == null || !r.game_key || r.yes_team !== r.home_team) return;
    m.set(r.game_key, { p_home: Number(r.yes_mid), captured_at: r.snapshot_at, ticker: r.market_ticker });
  });
  return m;
}

module.exports = { client, simPairs, nbaInjuries, kalshiMids, MAX_REQUESTS };
