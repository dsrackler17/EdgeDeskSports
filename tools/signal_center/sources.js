/* ===========================================================================
   SIGNAL CENTER — the source adapters. Each one reads a record EdgeDesk
   already keeps and normalises it for lib/edgedesk_signal_engine.js. None of
   them computes a forecast, fills a missing value or calls the network; the
   database adapters (db.js) are separate and need the service role.

   Committed sources (no credentials):
     football/game_research/history/<season>.jsonl   NFL and CFB forecasts
     football/game_research/current.json             the snapshot now served
     performance/ledger/forecasts/<sport>-<y>.jsonl  NBA, NHL, WNBA forecasts
     performance/ledger/quotes/<sport>-<y>.jsonl     named-book quotes, timed
     performance/data/summary.json                   the live graded record
     engine/registry.json                            the backtest evidence
     football/availability/reports/*.json            CFB availability reports
     football/injuries/history/nfl_<season>.jsonl    NFL designations, dated
                                                     by EdgeDesk's first sight
     today/slate.json                                feed health per sport
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function readJson(rel, root) {
  const f = path.join(root || ROOT, rel);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(path.relative(ROOT, file) + ' line ' + (i + 1) + ' does not parse'); }
  });
}
function listFiles(dir, re) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
}
const lc = (s) => String(s == null ? '' : s).toLowerCase();

/* ------------------------------------------------ football game research */
const FOOTBALL_SETTLES = 'game winner as the model prices it, overtime included (home and away sum to 1)';
function footballGames(root) {
  root = root || ROOT;
  const dir = path.join(root, 'football', 'game_research', 'history');
  const files = listFiles(dir, /^\d{4}\.jsonl$/);
  const byGame = new Map();
  files.forEach((f) => readJsonl(f).forEach((r) => {
    if (r.schema !== 'edgedesk_game_research_history_v1' || !r.game_key) return;
    if (!byGame.has(r.game_key)) byGame.set(r.game_key, []);
    byGame.get(r.game_key).push(r);
  }));
  const out = [];
  byGame.forEach((rows, key) => {
    const last = rows[rows.length - 1];
    const spec = last.spec || {};
    const sp = (r) => r.spec || {};
    const series = rows.map((r) => {
      const s = sp(r), m = s.model || {};
      const sum = r.summary || {};
      const p = typeof sum.home_win === 'number' ? sum.home_win : null;
      const wp = m.win_prob || {};
      return {
        snapshot_id: r.snapshot_id, at: r.recorded_at, built_at: m.built_at || null,
        p_home: p, model_id: sum.version || m.version || null, model_version: sum.version || m.version || null,
        data_status: r.data_status || (s.data && s.data.status) || null,
        consistent: p === null || (typeof wp.home === 'number' && Math.abs(wp.home - p) < 1e-9 && Math.abs(wp.home + wp.away - 1) < 1e-6),
        inputs: {
          home_record: s.home ? s.home.record : null, away_record: s.away ? s.away.record : null,
          home_rank: s.home ? s.home.poll_rank : null, away_rank: s.away ? s.away.poll_rank : null,
          home_overall_rank: s.overall_rank ? s.overall_rank.home : null, away_overall_rank: s.overall_rank ? s.overall_rank.away : null,
          kickoff: s.kickoff || r.kickoff || null, venue: s.venue || null, built_at: m.built_at || null,
          fair_home_line: sum.fair_home_line === undefined ? null : sum.fair_home_line, total: sum.total === undefined ? null : sum.total
        }
      };
    });
    const league = last.league;
    out.push({
      game: {
        sport: league, league, season: last.season, event_key: key, event_at: last.kickoff,
        /* the colours the research graphic already draws (no logo exists) */
        home: { name: (spec.home && spec.home.name) || null, abbr: (spec.home && spec.home.abbr) || null, color: (spec.home && spec.home.color) || null, alt: (spec.home && spec.home.alt_color) || null, on: (spec.home && spec.home.on_color) || null },
        away: { name: (spec.away && spec.away.name) || null, abbr: (spec.away && spec.away.abbr) || null, color: (spec.away && spec.away.color) || null, alt: (spec.away && spec.away.alt_color) || null, on: (spec.away && spec.away.on_color) || null },
        neutral: !!spec.neutral_site, settles: FOOTBALL_SETTLES,
        research_href: '#game/' + league + '/' + encodeURIComponent(last.game_id),
        simulator_href: '#simulator/' + league,
        source: { id: 'game_research', label: 'EdgeDesk game research snapshots', ref: 'football/game_research/history/' + last.season + '.jsonl' }
      },
      series
    });
  });
  return out;
}

/* the snapshot each game is served with right now (for divergence) */
function footballCurrent(root) {
  const cur = readJson('football/game_research/current.json', root);
  if (!cur) return { generated_at: null, games: [] };
  return {
    generated_at: cur.generated_at,
    games: (cur.games || []).filter((g) => !g.started && g.model && g.model.available).map((g) => ({
      event_key: g.game_key, league: g.league,
      model: { p_home: g.model.win_prob ? g.model.win_prob.home : null, at: cur.generated_at, snapshot_id: g.snapshot_id, model_id: g.model.version, model_version: g.model.version, built_at: g.model.built_at, data_status: g.data ? g.data.status : null },
      /* what the snapshot itself records about each starting quarterback:
         a sourced input the model read, never a cause */
      context: { qb: ['home', 'away'].map((side) => {
        const q = g.qb && g.qb[side];
        return q && q.name ? { side, team: g[side] && g[side].name, name: q.name, status: q.status || null, basis: q.basis || null, source: q.source || null, as_of: q.as_of || null } : null;
      }).filter(Boolean) }
    }))
  };
}

/* ------------------------------------------------ the performance ledger */
const PERF_SPORTS = ['nba', 'nhl', 'wnba'];
const RESEARCH_HREF = { nba: (id) => '#research/nba/' + encodeURIComponent(id), nhl: (id) => '#research/nhl/' + encodeURIComponent(id), wnba: () => null };
function perfForecastGames(root, sports) {
  root = root || ROOT;
  const dir = path.join(root, 'performance', 'ledger', 'forecasts');
  const out = [];
  (sports || PERF_SPORTS).forEach((sport) => {
    const byEvent = new Map();
    listFiles(dir, new RegExp('^' + sport + '-\\d{4}\\.jsonl$')).forEach((f) => readJsonl(f).forEach((r) => {
      if (r.schema !== 'edgedesk_perf_forecast_v1' || !r.event_key) return;
      if (!byEvent.has(r.event_key)) byEvent.set(r.event_key, []);
      byEvent.get(r.event_key).push(r);
    }));
    byEvent.forEach((rows, key) => {
      const last = rows[rows.length - 1];
      const series = rows.map((r) => {
        const fc = r.forecast || {}, m = r.model || {}, cap = r.capture || {}, rd = r.readiness || {};
        const sum = (fc.p_home || 0) + (fc.p_away || 0) + (fc.p_draw || 0);
        return {
          snapshot_id: cap.projection_id || r.hash, at: cap.captured_at, built_at: m.predicted_at || null,
          p_home: typeof fc.p_home === 'number' ? fc.p_home : null,
          /* the summary grades by model.id; the distribution version rides along */
          model_id: m.id || null, model_version: m.id ? m.id + (m.version ? '@' + m.version : '') : null,
          data_status: rd.invalidated ? 'UNAVAILABLE' : 'OK',
          consistent: Math.abs(sum - 1) < 1e-3,
          inputs: { availability: rd.availability || null, built_at: m.artifact_generated_at || null, fair_home_line: fc.fair_home_line === undefined ? null : fc.fair_home_line, total: fc.fair_total === undefined ? null : fc.fair_total },
          validation: rd.validation && rd.validation.moneyline ? { state: rd.validation.moneyline.state, market_test: rd.validation.moneyline.market_test, value_claims: rd.validation.moneyline.value_claims } : null
        };
      });
      out.push({
        game: {
          sport, league: sport, season: (String(last.start_utc || '').slice(0, 4) | 0) || null, event_key: key, event_at: last.start_utc,
          home: { name: last.home && last.home.name, abbr: last.home && last.home.abbr }, away: { name: last.away && last.away.name, abbr: last.away && last.away.abbr },
          neutral: !!last.neutral, settles: (last.forecast && last.forecast.settles) || 'game winner',
          research_href: RESEARCH_HREF[sport] ? RESEARCH_HREF[sport](last.event_id) : null,
          simulator_href: '#simulator/' + sport,
          source: { id: 'perf_forecasts', label: 'EdgeDesk performance ledger (forecasts)', ref: 'performance/ledger/forecasts/' + sport + '-' + String(last.start_utc || '').slice(0, 4) + '.jsonl' }
        },
        series
      });
    });
  });
  return out;
}

/* named-book quotes per event, every capture, from the performance ledger */
function perfQuotes(root, sports) {
  root = root || ROOT;
  const dir = path.join(root, 'performance', 'ledger', 'quotes');
  const byEvent = new Map();
  (sports || ['nfl', 'cfb', 'nba', 'nhl']).forEach((sport) => {
    listFiles(dir, new RegExp('^' + sport + '-\\d{4}\\.jsonl$')).forEach((f) => readJsonl(f).forEach((q) => {
      if (q.schema !== 'edgedesk_perf_quote_v1' || !q.event_key || !q.moneyline) return;
      if (!byEvent.has(q.event_key)) byEvent.set(q.event_key, []);
      byEvent.get(q.event_key).push({ book: q.book, source: q.source, captured_at: q.captured_at, observed_at: q.observed_at, moneyline: q.moneyline, ref: path.relative(root, f) + '#' + q.seq, start_utc: q.start_utc, slate_id: q.slate_id || null, sport });
    }));
  });
  return byEvent;
}
/* the team names ESPN printed for each slate event, so a quote's home and
   away can be checked against the model's (orientation) */
function slateTeams(root) {
  const slate = readJson('today/slate.json', root);
  const m = new Map();
  ((slate && slate.events) || []).forEach((e) => { if (e && e.id && e.home && e.away) m.set(e.id, { home: { name: e.home.name, abbr: e.home.abbr }, away: { name: e.away.name, abbr: e.away.abbr } }); });
  return m;
}
/* the football game_key and the performance ledger's event key name the same game */
function perfKeyFor(eventKey) {
  const m = /^(nfl|cfb)\|(.+)$/.exec(eventKey);
  return m ? m[1].toUpperCase() + '|' + m[2] : eventKey;
}

/* ------------------------------------------------------------ audits */
function audits(root) {
  return { registry: readJson('engine/registry.json', root), perf: readJson('performance/data/summary.json', root) };
}

/* ------------------------------------------------ CFB availability reports */
function cfbAvailability(root, games) {
  root = root || ROOT;
  const dir = path.join(root, 'football', 'availability', 'reports');
  const gameBy = new Map((games || []).map((g) => [g.game.event_key, g.game]));
  const rows = [];
  listFiles(dir, /\.json$/).forEach((f) => {
    let r;
    try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return; }
    if (r.schema !== 'edgedesk_availability_report_v1' || !r.ok || !r.published_at) return; /* refused at ingest stays refused */
    const ek = 'cfb|' + r.game_id, g = gameBy.get(ek) || null;
    (r.rows || []).forEach((x) => {
      rows.push({
        sport: 'cfb', season: Number(String(r.kickoff || '').slice(0, 4)) || null,
        team: { name: r.team, abbr: null },
        player: { id: x.player_id || null, name: x.player_name, position: x.position || null },
        status: x.status,
        report: { id: (r.report_id || path.basename(f, '.json')) + ':' + r.team, type: r.report_type || 'availability', published_at: r.published_at, retrieved_at: r.retrieved_at, source_url: r.source_url, source: r.conference + ' availability report' },
        game: { event_key: ek, event_at: r.kickoff, label: g ? g.away.name + ' at ' + g.home.name : null, home: g ? g.home : null, away: g ? g.away : null, research_href: g ? g.research_href : '#game/cfb/' + r.game_id }
      });
    });
  });
  return rows;
}

/* ------------------------------------------------ NFL injury observations
   football/injuries/fetch_injuries.js appends each game designation new or
   changed since its last row for that player-week. nflverse's copy of the
   league's report carries no publication time, so the row is dated by the
   sync's own retrieval (observed_at): Signal Center says "first seen by
   EdgeDesk", never "published". The game is the team's game that week. */
const NFL_STATUS = { Out: 'OUT', Doubtful: 'DOUBTFUL', Questionable: 'QUESTIONABLE' };
const NFL_OBS_NOTE = 'The time shown is when EdgeDesk’s injury sync (every six hours) first saw the designation in nflverse’s copy of the league’s official report, not when the team published it.';
function nflInjuries(root, games) {
  root = root || ROOT;
  const dir = path.join(root, 'football', 'injuries', 'history');
  /* the team's game in a week: game research names it <season>_<week>_<away>_<home> */
  const byTeamWeek = new Map();
  (games || []).forEach((g) => {
    const m = /^nfl\|(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(g.game.event_key || '');
    if (!m) return;
    [m[3], m[4]].forEach((t) => byTeamWeek.set(m[1] + '|' + (+m[2]) + '|' + t, g.game));
  });
  const rows = [];
  listFiles(dir, /^nfl_\d{4}\.jsonl$/).forEach((f) => readJsonl(f).forEach((r) => {
    if (r.schema !== 'edgedesk_nfl_injury_observation_v1' || !NFL_STATUS[r.status] || !r.observed_at) return;
    const g = byTeamWeek.get(r.season + '|' + r.week + '|' + r.team) || null;
    const side = g ? (g.home.abbr === r.team ? 'home' : 'away') : null;
    rows.push({
      sport: 'nfl', season: r.season, team: { name: g ? g[side].name : r.team, abbr: r.team },
      player: { id: r.gsis_id || null, name: r.name, position: r.position || null },
      status: NFL_STATUS[r.status],
      report: { id: 'nfl-obs:' + r.key + ':' + r.observed_at, type: 'NFL official injury', published_at: null, observed_at: r.observed_at, retrieved_at: r.observed_at, baseline: r.baseline === true,
        source_url: 'https://github.com/nflverse/nflverse-data/releases/tag/injuries', source: 'NFL official injury report (nflverse copy)', observed_note: NFL_OBS_NOTE },
      game: { event_key: g ? g.event_key : null, event_at: g ? g.event_at : null, label: g ? g.away.name + ' at ' + g.home.name : null, home: g ? g.home : null, away: g ? g.away : null, research_href: g ? g.research_href : null }
    });
  }));
  return rows;
}

/* ------------------------------------------------ source freshness */
/* the slate's key for a sport where Signal Center's differs, and the name a reader knows */
const SLATE_SPORT = { ncaabase: 'college_baseball' };
const SLATE_LABEL = { ncaabase: 'college baseball', ncaam: 'men’s college basketball', mma: 'UFC' };
function sourceStates(root, now) {
  const out = [];
  const cur = readJson('football/game_research/current.json', root);
  out.push({ id: 'game_research_current', label: 'Football research snapshots', sport: 'football', state: cur ? 'ok' : 'failed', generated_at: cur ? cur.generated_at : null, max_age_minutes: 180, ref: 'football/game_research/current.json' });
  const perf = readJson('performance/data/summary.json', root);
  out.push({ id: 'performance_ledger', label: 'Performance ledger', sport: 'all', state: perf ? 'ok' : 'failed', generated_at: perf && perf.ledger ? perf.ledger.last_capture_at : null, max_age_minutes: 360, ref: 'performance/data/summary.json' });
  const slate = readJson('today/slate.json', root);
  if (slate && slate.sports) {
    Object.keys(slate.sports).forEach((k) => {
      const s = slate.sports[k], sport = SLATE_SPORT[k] || k;
      if (s.state !== 'ok') out.push({ id: 'slate_' + k, label: 'Today’s ' + (SLATE_LABEL[k] || k.toUpperCase()) + ' schedule feed', sport, state: s.state, generated_at: s.last_success_at || null, max_age_minutes: 120, note: s.note || null, ref: 'today/slate.json' });
    });
  }
  return out;
}

module.exports = { ROOT, readJson, readJsonl, footballGames, footballCurrent, perfForecastGames, perfQuotes, perfKeyFor, slateTeams, audits, cfbAvailability, nflInjuries, sourceStates, PERF_SPORTS, FOOTBALL_SETTLES };
