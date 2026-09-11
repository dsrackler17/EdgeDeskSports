#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — keep the draw on file, by itself, every few hours.

   WHAT THIS DOES, in order, and what it refuses to do:

     1  discovers ATP and WTA tournaments in a window from ESPN's public
        scoreboard and stores each with its provider id, so a tournament that
        moves is an update to the same row, never a second one;
     2  stores every match with its provider id, round, best-of, court and
        scoreline; a match that has left the provider's draw and had not
        finished is marked cancelled, and named in the log — never deleted,
        never left looking live;
     3  resolves each side to the licensed player record through the provider
        id, an exact name, a name-order swap, a first-and-last pair, an
        initial-and-surname, or a unique surname — and stops there. A surname
        two players share is an unresolved side, not a guess. A DOUBLES pair is
        a team: it is stored whole and never resolved to one of its players;
     4  links each match to its odds fixture ONLY when both of the fixture's
        participants are the match's two sides. A doubles fixture may link only
        to a doubles match. Everything the linker refuses goes to
        tennis.market_rejections with its reason;
     5  writes the pre-match price history (tennis.market_captures) for linked
        matches, every row tagged PRE or LIVE against that match's own first
        point as known at the time it was written;
     6  marks a tournament long past its last match and still open as stale, so
        a poller that died cannot leave a draw reading LIVE for a month;
     7  heartbeats tennis.pipeline_runs and the tennis.meta ledger.

   It writes nothing without --commit. The default run says what it would do.

     node tools/tennis/sync_events.js                  # dry run
     node tools/tennis/sync_events.js --verify         # prove ESPN answers
     node tools/tennis/sync_events.js --commit         # write
   =========================================================================== */
'use strict';

const fs = require('fs');
const R = require('../../lib/tennis_research.js');
const E = require('./espn.js');
const D = require('./db.js');

const SIGNAL_COLS = 'sig_key,event_id,sport_key,market,selection,point,commence_time,home_team,away_team,best_dec,best_book,first_best_dec,first_seen_at,sharp_fair,consensus_fair,n_books,has_sharp,last_seen_at';

function log(...a) { if (!process.env.TENNIS_QUIET) console.log('[tennis-sync]', ...a); }

function parseArgs(argv) {
  const o = { commit: false, verify: false, fromDays: 3, toDays: 21, fixture: null, market: true, tours: null, now: null, stale: true, tournament: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--from-days') o.fromDays = Number(next());
    else if (a === '--to-days') o.toDays = Number(next());
    else if (a === '--fixture') o.fixture = next();
    else if (a === '--no-market') o.market = false;
    else if (a === '--no-stale') o.stale = false;
    else if (a === '--tour') o.tours = [String(next()).toLowerCase()];
    else if (a === '--tournament') o.tournament = next();
    else if (a === '--now') o.now = next();
  }
  return o;
}

/* ---- pure pieces, exported for the tests --------------------------------- */

function tournamentId(providerId) { return 'espn:' + String(providerId); }
function matchId(providerId) { return 'espn:' + String(providerId); }

function tournamentRows(t, nowIso) {
  const tid = tournamentId(t.provider_tournament_id);
  const tournament = {
    tournament_id: tid, provider: 'espn', provider_tournament_id: String(t.provider_tournament_id),
    tour: t.tour, name: t.name, short_name: t.short_name, level: t.level, surface: t.surface,
    venue: t.venue, city: t.city, country: t.country,
    start_date: t.start_date, end_date: t.end_date, draw_size: t.draw_size,
    state: t.state,
    matches_total: t.matches.length,
    matches_completed: t.matches.filter(m => m.status === 'final' || m.status === 'walkover').length,
    matches_live: t.matches.filter(m => m.status === 'live').length,
    source: 'espn', source_url: E.scoreboardDayUrl(String(t.tour).toLowerCase(), Date.parse(t.start_date) || Date.now()),
    source_updated_at: nowIso
  };
  const matches = t.matches.map(m => {
    const row = {
      match_id: matchId(m.provider_match_id), tournament_id: tid, provider: 'espn', provider_match_id: String(m.provider_match_id),
      tour: t.tour, round: m.round, match_order: m.match_order, court: m.court,
      is_doubles: !!m.is_doubles, best_of: m.best_of, scheduled_at: m.scheduled_at,
      home_provider_id: m.home_provider_id, away_provider_id: m.away_provider_id,
      home_name: m.home_name, away_name: m.away_name,
      home_seed: m.home_seed, away_seed: m.away_seed, home_rank: m.home_rank, away_rank: m.away_rank,
      side_source: 'provider_order',
      status: m.status, status_detail: m.status_detail,
      current_set: m.current_set, sets_home: m.sets_home, sets_away: m.sets_away,
      games_home: m.games_home, games_away: m.games_away,
      set_scores: m.set_scores, server_side: m.server_side,
      source_updated_at: nowIso
    };
    if (m.status === 'final' || m.status === 'walkover') {
      row.winner_side = m.winner_side; row.result_type = m.result_type; row.result_detail = m.result_detail;
    }
    return row;
  });
  return { tournament, matches };
}

/* Existing matches of a tournament against the incoming draw. A match the
   provider no longer lists, and that had not ended, is cancelled — in place,
   keeping its id and everything attached to it. A finished match is never
   reopened. */
function reconcileMatches(existing, incoming, nowIso) {
  const seen = new Set(incoming.map(m => m.match_id));
  const byId = {};
  (existing || []).forEach(m => { byId[m.match_id] = m; });
  const cancelled = [];
  (existing || []).forEach(m => {
    if (seen.has(m.match_id)) return;
    if (['final', 'walkover', 'cancelled'].includes(m.status)) return;
    cancelled.push({ match_id: m.match_id, tournament_id: m.tournament_id, provider: m.provider || 'espn', provider_match_id: m.provider_match_id,
      status: 'cancelled', status_detail: 'absent from provider draw', source_updated_at: nowIso });
  });
  const upserts = incoming.map(m => {
    const prev = byId[m.match_id];
    if (prev && (prev.status === 'final' || prev.status === 'walkover') && (m.status === 'scheduled' || m.status === 'unknown')) {
      const keep = Object.assign({}, m);
      ['status', 'current_set', 'games_home', 'games_away', 'server_side', 'status_detail'].forEach(k => { delete keep[k]; });
      return keep;
    }
    return m;
  });
  return { upserts, cancelled };
}

/* Fill home/away_player_id and collect the alias rows a resolution earns. */
function resolveMatches(matches, index, aliases) {
  const aliasRows = [], unmatched = [], seen = new Set();
  matches.forEach(m => {
    if (m.is_doubles) { m.home_player_id = null; m.away_player_id = null; return; }
    [['home', m.home_name, m.home_provider_id], ['away', m.away_name, m.away_provider_id]].forEach(p => {
      const side = p[0], name = p[1], pid = p[2];
      const r = R.resolvePlayer(name, pid, index, aliases);
      m[side + '_player_id'] = r.player_id || null;
      if (r.method === 'doubles') return;
      if (!r.player_id) {
        const k = (pid || '') + '|' + R.normName(name);
        if (!seen.has(k)) { seen.add(k); unmatched.push({ name, provider_id: pid, reason: r.method === 'ambiguous' ? 'ambiguous' : 'no_match', candidates: r.candidates }); }
        return;
      }
      const conf = ['exact', 'provider_id', 'name_order', 'first_last', 'initial_last', 'surname'].indexOf(r.method) >= 0 ? r.method : 'exact';
      if (pid && r.method !== 'provider_id')
        aliasRows.push({ alias_key: 'espn:' + String(pid), player_id: r.player_id, display_name: name, tour: m.tour || null, source: 'sync', confidence: conf });
      const nk = R.normName(name);
      if (nk && r.method !== 'exact' && r.method !== 'alias')
        aliasRows.push({ alias_key: 'name:' + nk, player_id: r.player_id, display_name: name, tour: m.tour || null, source: 'sync', confidence: conf });
    });
  });
  const dedup = {};
  aliasRows.forEach(a => { dedup[a.alias_key] = a; });
  return { aliasRows: Object.keys(dedup).map(k => dedup[k]), unmatched };
}

/* Fixtures from the odds feed against the matches on file. */
function linkMarkets(signalRows, matches, resolve, nowIso) {
  const links = [], rejections = [], fixtures = R.groupFixtures(signalRows);
  fixtures.forEach(f => {
    const n = R.normalizeFixture(f);
    n.rejections.forEach(rj => rejections.push({ signal_event_id: f.signal_event_id, sig_key: rj.sig_key || '', sport_key: f.sport_key,
      home_team: f.home_team, away_team: f.away_team, selection: rj.selection || null, market: rj.sig_key ? 'h2h' : null, reason: rj.reason, detail: rj.detail, last_seen_at: nowIso }));
    if (!n.ok) return;
    const res = R.linkFixture(n, matches, resolve);
    if (!res.ok) {
      rejections.push({ signal_event_id: f.signal_event_id, sig_key: '', sport_key: f.sport_key, home_team: f.home_team, away_team: f.away_team,
        selection: null, market: 'h2h', reason: res.reason, detail: res.detail, last_seen_at: nowIso });
      return;
    }
    const L = res.link;
    links.push({ match_id: L.match_id, tournament_id: L.tournament_id, signal_event_id: L.signal_event_id, sport_key: L.sport_key || 'tennis',
      home_team: L.home_team, away_team: L.away_team, home_selection: L.home_selection, away_selection: L.away_selection,
      home_sig_key: L.home_sig_key, away_sig_key: L.away_sig_key, other_sig_keys: L.other_sig_keys,
      commence_time: L.commence_time, link_method: L.link_method });
  });
  const byMatch = {};
  links.forEach(l => { const p = byMatch[l.match_id]; if (!p || String(l.commence_time || '') > String(p.commence_time || '')) byMatch[l.match_id] = l; });
  return { links: Object.keys(byMatch).map(k => byMatch[k]), rejections, fixtures: fixtures.length };
}

/* Price observations for linked matches, tagged against the match's own first
   point as it is known at the moment of writing. */
function captureRows(links, signalRows, matchesById) {
  const bySig = {};
  (signalRows || []).forEach(r => { if (r.sig_key) bySig[r.sig_key] = r; });
  const out = [], seen = new Set();
  function add(link, side, sigKey, at, row, source) {
    if (!sigKey || !at) return;
    const key = sigKey + '|' + at;
    if (seen.has(key)) return; seen.add(key);
    const match = matchesById[link.match_id] || {};
    const state = R.marketStateAt(at, match);
    out.push({ match_id: link.match_id, tournament_id: link.tournament_id, sig_key: sigKey, side, book: row.best_book || null,
      capture_at: at, market_state: state,
      set_number: state === 'LIVE' ? (match.current_set != null ? match.current_set : null) : null,
      score: state === 'LIVE' ? (R.scoreLine(match) || null) : null,
      best_dec: row.best_dec != null ? +row.best_dec : null, sharp_fair: row.sharp_fair != null ? +row.sharp_fair : null,
      consensus_fair: row.consensus_fair != null ? +row.consensus_fair : null, n_books: row.n_books != null ? +row.n_books : null,
      has_sharp: row.has_sharp == null ? null : !!row.has_sharp, source });
  }
  links.forEach(link => {
    [['home', link.home_sig_key], ['away', link.away_sig_key]].forEach(p => {
      const side = p[0], sk = p[1];
      if (!sk) return;
      const row = bySig[sk];
      if (!row) return;
      if (row.first_seen_at && row.first_best_dec != null)
        add(link, side, sk, row.first_seen_at, { best_dec: row.first_best_dec, sharp_fair: null, consensus_fair: null, n_books: null, has_sharp: null, best_book: null }, 'signals_open');
      if (row.last_seen_at) add(link, side, sk, row.last_seen_at, row, 'signals');
    });
  });
  return out;
}

/* Tournaments long past their last match that never closed. */
const STALE_AFTER_MS = 3 * 86400000;
function staleTournaments(tournaments, nowMs, liveIds) {
  return (tournaments || []).filter(t => {
    if (!['scheduled', 'live'].includes(t.state)) return false;
    if (liveIds && liveIds.has(t.tournament_id)) return false;
    const end = Date.parse(t.end_date || t.start_date);
    return isFinite(end) && nowMs - end > STALE_AFTER_MS;
  }).map(t => t.tournament_id);
}

/* Alias rows are a cache of a resolution the resolver repeats every run, so a
   refused alias write must never end the sync. */
const KNOWN_CONFIDENCE = ['exact', 'provider_id', 'name_order', 'first_last', 'initial_last', 'surname', 'curated', 'manual'];
async function writeAliases(db, rows, summary) {
  try { await db.upsert('tennis', 'player_aliases', rows, 'alias_key', { returning: false }); return rows.length; }
  catch (e) {
    const msg = String(e && e.message || e);
    if (/23514|check constraint/.test(msg)) {
      summary.errors.push('schema lag: tennis.player_aliases refuses a confidence value this resolver produces — re-run supabase/tennis_live_center.sql');
      log('  alias write refused by an older check constraint; skipped until the migration is re-run');
      return 0;
    }
    summary.errors.push('aliases: ' + msg.slice(0, 200));
    log('  alias write failed (non-fatal): ' + msg.slice(0, 200));
    return 0;
  }
}

/* ---- the run --------------------------------------------------------------- */

async function run(o, deps) {
  deps = deps || {};
  const now = o.now ? new Date(o.now) : new Date();
  const nowIso = now.toISOString(), nowMs = now.getTime();
  const src = deps.source || E.source({ fetchImpl: deps.fetchImpl });
  const summary = { tournaments: 0, matches: 0, doubles: 0, cancelled: 0, resolved: 0, unmatched: [], aliases: 0,
    fixtures: 0, links: 0, rejections: 0, captures: 0, stale: 0, byTour: null, errors: [] };

  /* 1. discover */
  let parsed;
  if (o.fixture) {
    const raw = JSON.parse(fs.readFileSync(o.fixture, 'utf8'));
    parsed = E.parseScoreboard(raw, 'atp');
  } else {
    const fromMs = nowMs - o.fromDays * 86400000, toMs = nowMs + o.toDays * 86400000;
    if (o.verify && typeof src.probe === 'function') {
      const probe = await src.probe(fromMs, toMs);
      probe.forEach(p => log(`  probe ${String(p.tour).toUpperCase()} ${p.via.padEnd(6)} ${p.status == null ? 'ERR ' : p.status} ${p.status === 200 ? p.tournaments + ' tournaments, ' + p.matches + ' matches, ' + p.latency + 'ms' : (p.error || '')}  ${p.url}`));
      summary.probe = probe;
    }
    const r = await src.allTours(fromMs, toMs, o.tours);
    parsed = r.tournaments; summary.source_latency_ms = r.latency; summary.byTour = r.byTour;
    (r.errors || []).forEach(e => { summary.errors.push(`${e.tour}: ${e.error}`); log(`  ${e.tour} did not answer: ${e.error}`); });
    if (r.byTour) Object.keys(r.byTour).forEach(t => log(`${t.toUpperCase()} answered via ${r.byTour[t].via} (${r.byTour[t].totalSeen} tournaments seen, ${r.byTour[t].tournaments} in window)`));
  }
  if (o.tournament) parsed = parsed.filter(t => String(t.provider_tournament_id) === String(o.tournament));
  summary.tournaments = parsed.length;
  summary.matches = parsed.reduce((n, t) => n + t.matches.length, 0);
  summary.doubles = parsed.reduce((n, t) => n + t.matches.filter(m => m.is_doubles).length, 0);
  log(`${parsed.length} tournament(s), ${summary.matches} match(es) in the window (${summary.doubles} doubles)`);
  parsed.forEach(t => log(`  ${t.provider_tournament_id}  ${t.tour}  ${t.start_date || '—'}  ${t.name}  [${t.state}] ${t.matches.length} matches${t.surface ? ' · ' + t.surface : ''}`));
  if (o.verify) return summary;

  const db = deps.db;
  if (!db) { summary.errors.push('no database credential'); return summary; }

  /* 2. players and aliases, once */
  const players = await db.selectAll('tennis', 'players', 'select=player_id,full_name,tour&order=player_id.asc');
  const index = R.buildPlayerIndex(players);
  const aliases = {};
  (await db.selectAll('tennis', 'player_aliases', 'select=alias_key,player_id&order=alias_key.asc')).forEach(a => { aliases[a.alias_key] = String(a.player_id); });
  log(`${players.length} players on file, ${Object.keys(aliases).length} aliases`);

  /* 3. tournaments and matches */
  const allMatches = [], matchesById = {}, tournamentsById = {}, liveIds = new Set();
  for (const t of parsed) {
    const rows = tournamentRows(t, nowIso);
    const existing = await db.select('tennis', 'live_matches', `select=match_id,tournament_id,provider,provider_match_id,status,status_detail,first_point_at,scheduled_at&tournament_id=eq.${encodeURIComponent(rows.tournament.tournament_id)}`);
    const rec = reconcileMatches(existing, rows.matches, nowIso);
    const res = resolveMatches(rec.upserts, index, aliases);
    summary.resolved += rec.upserts.filter(m => !m.is_doubles && m.home_player_id && m.away_player_id).length;
    summary.unmatched.push(...res.unmatched.map(u => Object.assign({ tournament: rows.tournament.name }, u)));
    summary.cancelled += rec.cancelled.length;
    const prev = (await db.select('tennis', 'tournaments', `select=tournament_id,state&tournament_id=eq.${encodeURIComponent(rows.tournament.tournament_id)}`))[0];
    if (prev && prev.state === 'final' && rows.tournament.state === 'scheduled') rows.tournament.state = 'final';
    if (rows.tournament.state === 'live') liveIds.add(rows.tournament.tournament_id);
    tournamentsById[rows.tournament.tournament_id] = rows.tournament;
    rec.upserts.forEach(m => { matchesById[m.match_id] = Object.assign({}, (existing || []).find(x => x.match_id === m.match_id) || {}, m); });
    if (o.commit) {
      await db.upsert('tennis', 'tournaments', [rows.tournament], 'tournament_id', { returning: false });
      if (rec.upserts.length) await db.upsert('tennis', 'live_matches', rec.upserts, 'match_id', { returning: false });
      if (rec.cancelled.length) await db.upsert('tennis', 'live_matches', rec.cancelled, 'match_id', { returning: false });
      if (res.aliasRows.length) { summary.aliases += await writeAliases(db, res.aliasRows, summary); res.aliasRows.forEach(a => { aliases[a.alias_key] = a.player_id; }); }
    } else {
      summary.aliases += res.aliasRows.length;
      rec.cancelled.forEach(c => log(`  would cancel ${c.match_id} (${c.status_detail})`));
    }
    allMatches.push(...rec.upserts);
  }
  summary.unmatched.slice(0, 40).forEach(u => log(`  unresolved: ${u.name} (${u.provider_id || 'no id'}) — ${u.reason}${u.candidates && u.candidates.length ? ' ' + u.candidates.slice(0, 4).join(',') : ''}`));
  if (summary.unmatched.length > 40) log(`  …and ${summary.unmatched.length - 40} more unresolved names`);

  /* 4. markets */
  if (o.market) {
    try {
      const from = new Date(nowMs - 2 * 86400000).toISOString(), to = new Date(nowMs + (o.toDays + 1) * 86400000).toISOString();
      const signals = await db.selectAll('public', 'signals', `select=${SIGNAL_COLS}&sport_key=like.tennis_*&commence_time=gte.${from}&commence_time=lte.${to}&order=commence_time.asc`);
      const resolve = name => R.resolvePlayer(name, null, index, aliases);
      const lm = linkMarkets(signals, allMatches, resolve, nowIso);
      summary.fixtures = lm.fixtures; summary.links = lm.links.length; summary.rejections = lm.rejections.length;
      log(`${signals.length} signal rows, ${lm.fixtures} fixtures, ${lm.links.length} linked, ${lm.rejections.length} rejected`);
      lm.rejections.slice(0, 25).forEach(r => log(`  rejected ${r.signal_event_id} ${r.home_team} vs ${r.away_team}${r.selection ? ' [' + r.selection + ']' : ''}: ${r.reason}`));
      if (lm.rejections.length > 25) log(`  …and ${lm.rejections.length - 25} more rejections`);
      if (o.commit) {
        if (lm.links.length) await db.upsert('tennis', 'match_markets', lm.links, 'match_id', { returning: false });
        if (lm.rejections.length) {
          const ids = Array.from(new Set(lm.rejections.map(r => r.signal_event_id)));
          const prevR = [];
          for (let i = 0; i < ids.length; i += 40)
            prevR.push(...await db.select('tennis', 'market_rejections', `select=signal_event_id,sig_key,reason,first_seen_at,seen_count&signal_event_id=in.${D.inList(ids.slice(i, i + 40))}`));
          const pk = {}; prevR.forEach(p => { pk[p.signal_event_id + '|' + p.sig_key + '|' + p.reason] = p; });
          const rows = lm.rejections.map(r => { const p = pk[r.signal_event_id + '|' + r.sig_key + '|' + r.reason]; return Object.assign({}, r, { first_seen_at: p ? p.first_seen_at : nowIso, seen_count: p ? (p.seen_count || 0) + 1 : 1 }); });
          await db.upsert('tennis', 'market_rejections', rows, 'signal_event_id,sig_key,reason', { returning: false });
        }
      }
      const caps = captureRows(lm.links, signals, matchesById);
      summary.captures = caps.length;
      if (o.commit && caps.length) await db.upsert('tennis', 'market_captures', caps, 'sig_key,capture_at', { ignoreDuplicates: true, returning: false });
    } catch (e) {
      summary.errors.push('market: ' + e.message);
      log('market step failed: ' + e.message);
    }
  }

  /* 5. stale */
  if (o.stale) {
    const open = await db.select('tennis', 'tournaments', 'select=tournament_id,state,start_date,end_date&state=in.(scheduled,live)&order=start_date.asc&limit=300');
    const stale = staleTournaments(open, nowMs, liveIds);
    summary.stale = stale.length;
    if (stale.length) {
      log(`marking ${stale.length} open tournament(s) stale: ${stale.slice(0, 8).join(', ')}${stale.length > 8 ? '…' : ''}`);
      if (o.commit) for (const id of stale) await db.patch('tennis', 'tournaments', `tournament_id=eq.${encodeURIComponent(id)}`, { state: 'stale', source_updated_at: nowIso });
    }
  }
  return summary;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cfg = D.config();
  const db = cfg ? D.client(cfg) : null;
  if (!o.verify && !db) { console.error('No service credential (EDGD_SB_SERVICE + EDGD_SB_URL). Run with --verify to check the source only.'); process.exit(1); }
  const ledger = (db && o.commit) ? D.runLedger(db, 'tennis_sync') : null;
  if (ledger) await ledger.start({ from_days: o.fromDays, to_days: o.toDays });
  let code = 0;
  try {
    const s = await run(o, { db });
    const status = s.errors.length ? 'warn' : 'ok';
    const msg = `${s.tournaments} tournaments, ${s.matches} matches, ${s.resolved} fully resolved, ${s.unmatched.length} unresolved names, ${s.links} market links, ${s.rejections} rejections`;
    log(msg);
    if (ledger) {
      await ledger.finish(status, msg, { last_success_at: new Date().toISOString(), last_source_at: new Date().toISOString(), source_latency_ms: s.source_latency_ms || null,
        details: Object.assign({}, s, { unmatched: s.unmatched.slice(0, 60) }) });
      await D.writeMeta(db, { tennis_sync_last_run: new Date().toISOString(), tennis_sync_last_status: status,
        row_count_tennis_sync: s.matches, tennis_live_tournaments: s.tournaments });
    }
    if (o.verify && !s.tournaments) { console.error('The source answered but carried no tournament in the window.'); code = 2; }
  } catch (e) {
    console.error('[tennis-sync] failed: ' + (e && e.stack || e));
    if (ledger) { await ledger.finish('error', String(e && e.message || e).slice(0, 400)); await D.writeMeta(db, { tennis_sync_last_run: new Date().toISOString(), tennis_sync_last_status: 'error' }); }
    code = 1;
  }
  process.exit(code);
}

module.exports = { parseArgs, tournamentRows, reconcileMatches, resolveMatches, linkMarkets, captureRows, staleTournaments,
  writeAliases, run, tournamentId, matchId, STALE_AFTER_MS, KNOWN_CONFIDENCE };
if (require.main === module) main();
