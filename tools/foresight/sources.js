'use strict';
/* ===========================================================================
   MARKET FORESIGHT — the worker's sources, normalized for the engine.
   docs/market-foresight/README.md §Sources

   Committed (no credential needed):
     performance/ledger/forecasts/<sport>-<year>.jsonl   EdgeDesk's forecasts,
       hash-chained. A chain that does not verify is refused whole (fail
       closed). `ledger_capture` rows carry a live capture time; `import:*`
       rows carry one reconstructed from git and are labelled so.
     record/football/quotes/<sport>_<year>.jsonl         DraftKings via ESPN,
       write-on-change plus heartbeat, pregame only
     performance/ledger/results/<sport>-<year>.jsonl     finals and voids

   From the database (service role, read-only; tools/foresight/db.js):
     public.kalshi_game_links / kalshi_markets / kalshi_price_snapshots
     collective.games / teams / models / creators / projections

   Pure except the read*() functions. Never reads tools/foresight/fixtures.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const LEDGER = require(path.join(ROOT, 'tools', 'performance', 'ledger.js'));
const FI = require(path.join(ROOT, 'lib', 'football_identity.js'));

const SPORTS = ['nfl', 'cfb'];
const FIXTURES = path.join(ROOT, 'tools', 'foresight', 'fixtures');
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const ms = (t) => { const v = Date.parse(t || ''); return Number.isFinite(v) ? v : null; };
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function guard(file) {
  if (path.resolve(file).startsWith(FIXTURES + path.sep)) throw new Error('the worker never reads test fixtures: ' + file);
}
function filesMatching(dir, rx) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => rx.test(n)).sort(); } catch (_) { names = []; }
  return names.map((n) => path.join(dir, n));
}
function readJsonl(file) {
  guard(file);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return { rows: [], bad: 0, missing: true }; }
  const rows = []; let bad = 0;
  text.split('\n').forEach((l) => { if (!l.trim()) return; try { rows.push(JSON.parse(l)); } catch (_) { bad++; } });
  return { rows, bad, missing: false };
}

/* ---------------------------------------------------------------- EdgeDesk forecasts */
function modelLabel(id) {
  const m = /^edgedesk_(.+?)_v(\d[\w.]*)$/.exec(String(id || ''));
  if (!m) return String(id || 'EdgeDesk model');
  const name = m[1].split('_').map((w) => (/^(nfl|cfb|p4|fbs)$/i.test(w) ? w.toUpperCase() : w)).join(' ');
  return 'EdgeDesk ' + name + ' v' + m[2];
}
function forecastFromLedger(r, file, log) {
  const cap = r.capture || {}, model = r.model || {}, fc = r.forecast || {};
  let evidence, published;
  if (cap.method === 'ledger_capture') { evidence = 'ledger_captured'; published = cap.captured_at; }
  else if (/^import:/.test(String(cap.method || ''))) { evidence = 'reconstructed_from_git'; published = cap.recorded_at || model.predicted_at; }
  else { log.push({ level: 'warn', code: 'unknown_capture_method', source: 'edgedesk', message: 'capture method ' + cap.method + ' is not one mf-v1 names; the row is not read', ref: file + '#' + r.seq }); return null; }
  if (ms(published) === null) { log.push({ level: 'warn', code: 'publication_time_missing', source: 'edgedesk', ref: file + '#' + r.seq }); return null; }
  return {
    source: 'edgedesk', model_key: String(model.id), model_label: modelLabel(model.id), model_version: String(model.version || model.id),
    forecast_id: r.hash, sport: String(r.sport).toLowerCase(), event_id: String(r.event_id), published_at: new Date(ms(published)).toISOString(),
    predicted_at: model.predicted_at || null, evidence, settles: fc.settles || null,
    values: { spread: num(fc.fair_home_line), total: num(fc.fair_total), moneyline: num(fc.p_home) },
    start_utc: r.start_utc || null, home: r.home && r.home.name, away: r.away && r.away.name,
    market_inputs: Array.isArray(model.market_inputs) ? model.market_inputs : [], ledger: { file: path.relative(ROOT, file), seq: r.seq }
  };
}
function readEdgedesk(root, sport, log) {
  const files = filesMatching(path.join(root, 'performance', 'ledger', 'forecasts'), new RegExp('^' + sport + '-\\d{4}\\.jsonl$'));
  const out = [];
  let ok = true;
  files.forEach((f) => {
    guard(f);
    const rows = LEDGER.readRows(f), v = LEDGER.verifyRows(rows);
    if (!v.ok) { ok = false; log.push({ level: 'error', code: 'forecast_chain_broken', source: 'edgedesk', file: path.relative(root, f), message: v.errors.slice(0, 3).join('; ') }); return; }
    rows.forEach((r) => { const x = forecastFromLedger(r, f, log); if (x) out.push(x); });
  });
  return { forecasts: out, ok, files: files.map((f) => path.relative(root, f)) };
}

/* ---------------------------------------------------------------- DraftKings */
function readDraftKings(root, sport) {
  const files = filesMatching(path.join(root, 'record', 'football', 'quotes'), new RegExp('^' + sport + '_\\d{4}\\.jsonl$'));
  const byGame = {}; let n = 0, bad = 0;
  files.forEach((f) => {
    const r = readJsonl(f); bad += r.bad;
    r.rows.forEach((q) => {
      if (q.source !== 'espn' || q.book !== 'draftkings' || q.is_pregame === false) return;
      (byGame[String(q.game_id)] = byGame[String(q.game_id)] || []).push(q); n++;
    });
  });
  return { byGame, rows: n, bad, files: files.map((f) => path.relative(root, f)) };
}

/* ---------------------------------------------------------------- results */
function readResults(root, sport) {
  const files = filesMatching(path.join(root, 'performance', 'ledger', 'results'), new RegExp('^' + sport + '-\\d{4}\\.jsonl$'));
  const latest = {};
  files.forEach((f) => readJsonl(f).rows.forEach((r) => {
    const k = String(r.event_key || '');
    if (!latest[k] || (r.revision || 1) >= (latest[k].revision || 1)) latest[k] = r;
  }));
  return latest;
}

/* ---------------------------------------------------------------- events */
/* one event per id seen in a forecast or a quote; kickoff from the verified
   result, else the latest DraftKings row, else the latest forecast */
function buildEvents(sport, forecasts, dkByGame, results, log) {
  const ids = new Set();
  forecasts.forEach((f) => ids.add(f.event_id));
  Object.keys(dkByGame).forEach((g) => ids.add(g));
  const out = {};
  Array.from(ids).sort().forEach((id) => {
    const res = results[sport.toUpperCase() + '|' + id];
    const dk = (dkByGame[id] || []).slice().sort((a, b) => ms(a.observed_at) - ms(b.observed_at));
    const fs_ = forecasts.filter((f) => f.event_id === id).sort((a, b) => ms(a.published_at) - ms(b.published_at));
    const cands = [res && res.start_utc, dk.length ? dk[dk.length - 1].kickoff_ts : null, fs_.length ? fs_[fs_.length - 1].start_utc : null].filter((x) => ms(x) !== null);
    if (!cands.length) { log.push({ level: 'warn', code: 'kickoff_unknown', sport, event_id: id }); return; }
    const spread = Math.max.apply(null, cands.map(ms)) - Math.min.apply(null, cands.map(ms));
    if (spread > 36 * 3600000) log.push({ level: 'warn', code: 'kickoff_conflict', sport, event_id: id, message: 'kickoff sources disagree by ' + Math.round(spread / 3600000) + ' h; the verified result (then the latest quote) is used' });
    const last = dk.length ? dk[dk.length - 1] : null;
    out[id] = {
      sport, event_id: id, kickoff: new Date(ms(cands[0])).toISOString(),
      home: (last && last.home_team) || (fs_.length && fs_[fs_.length - 1].home) || null,
      away: (last && last.away_team) || (fs_.length && fs_[fs_.length - 1].away) || null,
      state: res ? res.state : 'UNVERIFIED', void_reason: res ? res.void_reason || null : null
    };
  });
  return out;
}

/* ---------------------------------------------------------------- Kalshi */
/* which side of the game a Kalshi market's YES pays on, by the same resolver
   the Kalshi sync and the Collective use; unresolved = not used */
function kalshiSide(link, ev) {
  const reg = FI.buildRegistry(ev.sport === 'nfl' ? 'NFL' : 'CFB', [{ id: 'home', name: ev.home }, { id: 'away', name: ev.away }]);
  const r = FI.resolveTeam(reg, link.yes_team);
  return r.team_id || null;
}
function kalshiForEvents(events, links, markets, snapsByTicker, verifications, log) {
  const mk = {};
  markets.forEach((m) => { mk[m.ticker] = m; });
  const out = {};
  links.forEach((l) => {
    const ev = events[l.game_id];
    if (!l.game_id || !ev || ev.sport !== l.sport) return;
    if (Math.abs(ms(l.kickoff_at) - ms(ev.kickoff)) > 36 * 3600000) { log.push({ level: 'warn', code: 'kalshi_kickoff_conflict', sport: ev.sport, event_id: ev.event_id, ticker: l.market_ticker }); return; }
    const side = kalshiSide(l, ev);
    if (!side) { log.push({ level: 'warn', code: 'kalshi_side_unresolved', sport: ev.sport, event_id: ev.event_id, ticker: l.market_ticker, message: 'YES team ' + l.yes_team + ' did not resolve to ' + ev.home + ' or ' + ev.away }); return; }
    if (side !== 'home') return;   /* P(home) is read only from the home team's own market, never derived from the other */
    const m = mk[l.market_ticker] || {};
    const digest = m.rules_primary ? sha256(m.rules_primary) : null;
    const ver = (verifications || []).filter((v) => v.series_ticker === (m.series_ticker || l.series_ticker) && v.rules_sha256 === digest && v.sport === ev.sport)
      .sort((a, b) => b.id - a.id)[0] || null;
    out[ev.event_id] = { market: { ticker: l.market_ticker, series_ticker: m.series_ticker || l.series_ticker, rules_sha256: digest, verification: ver }, snapshots: snapsByTicker[l.market_ticker] || [] };
  });
  return out;
}

/* ---------------------------------------------------------------- the Collective */
function collectiveTeams(teams) {
  return (teams || []).map((t) => ({ id: String(t.id), name: t.name || t.display_name || t.full_name || null, code: t.code || t.abbr || null, aliases: Array.isArray(t.aliases) ? t.aliases : [] }));
}
/* the Collective's games -> canonical events (football_identity matchEvent:
   provider id, then teams + kickoff, then swapped); unresolved are logged */
function linkCollectiveGames(sport, events, cgames, cteams, espnFor, log) {
  const lg = sport === 'nfl' ? 'NFL' : 'CFB';
  const reg = FI.buildRegistry(lg, collectiveTeams(cteams));
  const games = (cgames || []).filter((g) => FI.leagueOf(g.sport_code || g.sport) === lg).map((g) => ({
    game_id: String(g.id), sport: lg, season: g.season == null ? null : Number(g.season), home_team_id: String(g.home_team_id), away_team_id: String(g.away_team_id),
    kickoff_at: g.kickoff_at, external_ref: g.external_ref || null }));
  const links = {};
  Object.keys(events).forEach((id) => {
    const ev = events[id];
    const ref = sport === 'cfb' ? id : (espnFor[id] || null);
    const m = FI.matchEvent(reg, { source: 'mf', source_event_id: id, provider_ref: ref, sport: lg, home_name: ev.home, away_name: ev.away, kickoff_at: ev.kickoff }, games);
    if (m.game_id) {
      if (links[m.game_id]) { log.push({ level: 'warn', code: 'collective_game_claimed_twice', sport, collective_game: m.game_id, event_id: id }); delete links[m.game_id]; return; }
      links[m.game_id] = { event_id: id, orientation: m.orientation, method: m.method };
    }
  });
  const unlinked = games.filter((g) => !links[g.game_id] && ms(g.kickoff_at) !== null);
  if (unlinked.length) log.push({ level: 'note', code: 'collective_games_without_market_event', sport, count: unlinked.length, message: 'Collective games no DraftKings quote or EdgeDesk forecast covers (no market evidence to measure against)' });
  return links;
}
function collectiveForecasts(sport, links, projections, models, creators, log) {
  const mdl = {}, cr = {};
  (models || []).forEach((m) => { mdl[String(m.id)] = m; });
  (creators || []).forEach((c) => { cr[String(c.id)] = c; });
  const out = [];
  let unlinked = 0;
  (projections || []).forEach((p) => {
    const link = links[String(p.game_id)];
    if (!link) { unlinked++; return; }
    const m = mdl[String(p.model_id)];
    if (!m) { log.push({ level: 'warn', code: 'collective_model_missing', projection: p.id }); return; }
    const c = cr[String(m.creator_id)] || {};
    const sw = link.orientation === 'swapped';
    const sp = num(p.projected_spread), tot = num(p.projected_total), wp = num(p.home_win_prob);
    const status = String(c.status || c.account_status || 'active');
    out.push({
      source: 'collective', model_key: 'collective:' + m.id, model_label: (c.display_name || c.slug || 'Collective creator') + ' · ' + (m.name || m.slug || 'model'),
      model_version: 'unversioned', creator: c.slug || null, forecast_id: 'collective:' + p.id, sport, event_id: link.event_id,
      published_at: p.received_at, predicted_at: null, evidence: 'server_received', origin: p.data_origin || null, resolution: p.resolution_status || null,
      values: { spread: sp === null ? null : (sw ? -sp : sp), total: tot, moneyline: wp === null ? null : (sw ? 1 - wp : wp) },
      orientation: link.orientation, family: m.source_kind && m.source_ref ? String(m.source_kind) + ':' + String(m.source_ref) : null,
      publishable: m.is_listed === true && c.is_listed === true && !c.removed_at && status === 'active'
    });
  });
  if (unlinked) log.push({ level: 'note', code: 'collective_projections_without_market_event', sport, count: unlinked });
  return out;
}

/* ESPN id -> nflverse id, from the performance quote ledger's slate ids */
function nflEspnMap(root) {
  const map = {};
  filesMatching(path.join(root, 'performance', 'ledger', 'quotes'), /^nfl-\d{4}\.jsonl$/).forEach((f) => readJsonl(f).rows.forEach((r) => {
    const m = /^nfl:espn:(\d+)$/.exec(String(r.slate_id || ''));
    if (m && r.event_key) map[String(r.event_key).split('|')[1]] = m[1];
  }));
  return map;
}

function readLocal(root, log) {
  const out = { sports: {}, files: [] };
  SPORTS.forEach((sport) => {
    const ed = readEdgedesk(root, sport, log), dk = readDraftKings(root, sport), res = readResults(root, sport);
    const events = buildEvents(sport, ed.forecasts, dk.byGame, res, log);
    out.sports[sport] = { edgedesk: ed, dk, results: res, events };
    out.files = out.files.concat(ed.files, dk.files);
  });
  out.nflEspn = nflEspnMap(root);
  return out;
}

module.exports = { SPORTS, readLocal, readEdgedesk, readDraftKings, readResults, buildEvents, forecastFromLedger, modelLabel, kalshiSide, kalshiForEvents,
  linkCollectiveGames, collectiveForecasts, nflEspnMap, readJsonl, sha256 };
