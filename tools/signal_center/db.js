/* ===========================================================================
   SIGNAL CENTER — the worker's database: PostgREST with the service role.

   SB_URL and SB_SERVICE_ROLE come from the job's environment (GitHub Actions
   secrets), never from a file, a log line or an error message: every error
   text is scrubbed of the key before it is thrown.

   Writes go only to the sc_* job doors (supabase/signal_center.sql). Reads of
   other layers (the Simulator's published runs, the NBA injury reports, the
   Kalshi card, the men's college basketball forecast runs) are plain GETs; a
   layer that is not installed, or answers an error, removes only its own
   signals: it is recorded and the run goes on.

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
      if (!/^(sim_published|sim_runs|sim_team_results|nba_injury_report_snapshots|nba_injury_reports|kalshi_card_current|ncaam_fc_runs|ncaam_fc_forecasts|ncaaw_fc_runs|ncaaw_fc_forecasts)\?/.test(path)) throw new Error('the worker reads only the published layers it needs, not ' + path.split('?')[0]);
      return call('GET', path);
    }
  };
}

/* ------------------------------------------------ the database sources */
const SIM_OUTCOMES = require('../../lib/edgedesk_signal_engine.js').SIM_OUTCOMES;
/* the Simulator's key for a sport where Signal Center's differs */
const SIM_SPORT = { ufc: 'mma' };
/* PostgREST answers at most this many rows (Supabase's max-rows default): a
   page that full may be cut short, so it is read again outcome by outcome */
const PAGE = 1000;

/* the Simulator: each competition's published run and the run it replaced */
async function simPairs(db, log) {
  const out = [];
  let pub;
  try { pub = await db.get('sim_published?select=sport,competition,season,run_id,previous_run_id,published_at'); }
  catch (e) { log('sim', 'the Simulator is not readable here: ' + e.message); return out; }
  for (const p of pub || []) {
    const sport = SIM_SPORT[p.sport] || p.sport;
    if (!p.previous_run_id || !SIM_OUTCOMES[sport]) continue;
    const runs = {};
    for (const id of [p.previous_run_id, p.run_id]) {
      const r = await db.get('sim_runs?select=run_id,sport,competition,season,status,model_version,rules_version,engine_version,n_sims,input_snapshot_at,completed_at,validation_summary&run_id=eq.' + id);
      if (r && r[0]) runs[id] = r[0];
    }
    if (!runs[p.previous_run_id] || !runs[p.run_id]) { log('sim', p.sport + ': a run of the published pair is missing'); continue; }
    const results = { previous: [], current: [] };
    const outcomes = Object.keys(SIM_OUTCOMES[sport]);
    const cols = 'sim_team_results?select=entity_id,entity_name,outcome,probability,mcse,provenance,applicable&run_id=eq.';
    for (const [side, id] of [['previous', p.previous_run_id], ['current', p.run_id]]) {
      /* one request per run for every outcome compared; a full page is read
         again one outcome at a time rather than compared short */
      let rows = await db.get(cols + id + '&outcome=in.(' + outcomes.join(',') + ')&limit=' + PAGE);
      if ((rows || []).length >= PAGE) {
        rows = [];
        for (const oc of outcomes) ((await db.get(cols + id + '&outcome=eq.' + oc + '&limit=' + PAGE)) || []).forEach((x) => rows.push(x));
      }
      (rows || []).forEach((x) => results[side].push(x));
    }
    const cur = Object.assign({}, runs[p.run_id], { published_at: p.published_at });
    out.push({ pair: { sport, sim_sport: p.sport, competition: p.competition, season: p.season, previous: runs[p.previous_run_id], current: cur }, results });
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

/* college basketball, men's (ncaam_fc_*) and women's (ncaaw_fc_*): the daily
   pregame runs that were published (a run is 'completed' only when it took the
   published pointer; a run that lost the race is 'superseded' and was never
   shown), oldest first, and each run's forecasts for D-I games that have not
   started. One game appears in every daily run inside the 48-hour horizon:
   consecutive runs are its history. The two leagues are separate systems with
   separate tables and champions; nothing is shared but this reader's shape. */
const FC_RUNS = 6;
const FC_SETTLES = 'game winner, overtime included (the published forecast’s home probability)';
const FC_LEAGUES = {
  ncaam: { prefix: 'ncaam_fc', key: 'NCAAM', who: 'men’s college basketball', href: '#simulator/ncaam', source: { id: 'ncaam_fc', label: 'EdgeDesk men’s college basketball forecasts (published daily runs)', ref: 'public.ncaam_fc_forecasts' } },
  ncaaw: { prefix: 'ncaaw_fc', key: 'NCAAW', who: 'women’s college basketball', href: '#simulator/ncaaw', source: { id: 'ncaaw_fc', label: 'EdgeDesk women’s college basketball forecasts (published daily runs)', ref: 'public.ncaaw_fc_forecasts' } }
};
async function fcGames(league, db, now, log) {
  const L = FC_LEAGUES[league];
  let runs;
  try { runs = await db.get(L.prefix + '_runs?select=run_id,model_key,as_of,completed_at&scope=eq.pregame&status=eq.completed&order=as_of.desc&limit=' + FC_RUNS); }
  catch (e) { log(league, 'the ' + L.who + ' forecasts are not readable here: ' + e.message); return []; }
  const byGame = new Map();
  for (const r of (runs || []).slice().reverse()) {
    let rows;
    try { rows = await db.get(L.prefix + '_forecasts?select=game_id,start_utc,home_id,away_id,home_name,away_name,neutral,available,p_home,games_played,data_quality,availability_assumption&run_id=eq.' + r.run_id + '&regime=eq.D1_D1&start_utc=gt.' + new Date(now).toISOString() + '&order=game_id.asc&limit=' + PAGE); }
    catch (e) { log(league, 'run ' + r.run_id + ': forecasts not readable: ' + e.message); return []; }
    if ((rows || []).length >= PAGE) log(league, 'run ' + r.run_id + ': ' + PAGE + ' forecasts or more; the rest were not compared');
    (rows || []).forEach((f) => {
      if (!byGame.has(f.game_id)) byGame.set(f.game_id, { last: f, series: [] });
      const g = byGame.get(f.game_id), gp = f.games_played || {};
      g.last = f;
      g.series.push({
        snapshot_id: r.run_id, at: r.completed_at, built_at: r.as_of,
        p_home: f.available && typeof f.p_home === 'number' ? f.p_home : null,
        model_id: r.model_key, model_version: r.model_key,
        data_status: !f.available ? 'UNAVAILABLE' : ((f.data_quality || []).length ? 'LIMITED' : 'OK'),
        consistent: true,
        inputs: { home_games: gp.home == null ? null : gp.home, away_games: gp.away == null ? null : gp.away, availability: f.availability_assumption || null, built_at: r.as_of, flags: (f.data_quality || []).join(', ') || null }
      });
    });
  }
  const out = [];
  byGame.forEach((g, id) => {
    const f = g.last;
    out.push({
      game: {
        sport: league, league, season: (String(f.start_utc || '').slice(0, 4) | 0) || null, event_key: L.key + '|' + id, event_at: f.start_utc,
        home: { name: f.home_name, abbr: null }, away: { name: f.away_name, abbr: null }, neutral: !!f.neutral, settles: FC_SETTLES,
        /* the forecasts are read in the Simulator's college basketball Games tab */
        research_href: null, simulator_href: L.href,
        source: Object.assign({}, L.source)
      },
      series: g.series
    });
  });
  return out;
}
const ncaamGames = (db, now, log) => fcGames('ncaam', db, now, log);
const ncaawGames = (db, now, log) => fcGames('ncaaw', db, now, log);

module.exports = { client, simPairs, nbaInjuries, kalshiMids, ncaamGames, ncaawGames, MAX_REQUESTS };
