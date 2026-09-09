#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk UFC — keep the card on file, by itself, every few hours.

   WHAT THIS DOES, in order, and what it refuses to do:

     1  discovers UFC events in a window (three days back, thirty ahead)
        from ESPN's public scoreboard and stores each with its provider id,
        so a card that moves is an update to the same row, never a second one;
     2  stores every bout on each card with its provider id, order, segment,
        weight class and scheduled rounds; a bout that has left the provider's
        card and had not finished is marked cancelled, and named in the log —
        it is never deleted, and never left looking live;
     3  resolves each participant to the fighter dataset through the provider
        id, an exact name, a name-order swap or a unique surname — and stops
        there. A surname two fighters share is an unresolved participant, not
        a guess. Unresolved names are counted and listed for the operator;
     4  links each bout to its odds-feed fixture ONLY when both of the
        fixture's participants are the bout's two corners. A "Draw" is a
        market outcome; it is stored under draw_sig_key and can never sit in
        a corner. Everything the linker refuses goes to ufc.market_rejections
        with its reason, which is where "Jean Silva vs Draw" now lives;
     5  writes the pre-fight price history (ufc.market_captures) for linked
        bouts, every row tagged PRE or LIVE against that bout's own first bell
        as known at the time it was written;
     6  marks an event that is long past its start and still open as stale,
        so a poller that died cannot leave a card reading LIVE for a month;
     7  heartbeats ufc.pipeline_runs and the ufc.meta ledger the shell reads.

   It writes nothing without --commit. The default run says what it would do.

     node tools/ufc/sync_events.js                  # dry run
     node tools/ufc/sync_events.js --verify         # prove ESPN answers
     node tools/ufc/sync_events.js --commit         # write
     node tools/ufc/sync_events.js --fixture tools/ufc/fixtures/scoreboard.json --commit
   =========================================================================== */
'use strict';

const fs = require('fs');
const R = require('../../lib/ufc_research.js');
const E = require('./espn.js');
const D = require('./db.js');

const SPORT_KEY = 'mma_mixed_martial_arts';
const SIGNAL_COLS = 'sig_key,event_id,sport_key,market,selection,point,commence_time,home_team,away_team,best_dec,best_book,first_best_dec,first_seen_at,sharp_fair,consensus_fair,n_books,has_sharp,last_seen_at';

function log(...a) { if (!process.env.UFC_QUIET) console.log('[ufc-sync]', ...a); }

function parseArgs(argv) {
  const o = { commit: false, verify: false, fromDays: 3, toDays: 30, fixture: null, market: true, event: null, now: null, stale: true, ticks: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--from-days') o.fromDays = Number(next());
    else if (a === '--to-days') o.toDays = Number(next());
    else if (a === '--fixture') o.fixture = next();
    else if (a === '--no-market') o.market = false;
    else if (a === '--no-ticks') o.ticks = false;
    else if (a === '--no-stale') o.stale = false;
    else if (a === '--event') o.event = next();
    else if (a === '--now') o.now = next();
  }
  return o;
}

/* ---- pure pieces, exported for the tests --------------------------------- */

function eventId(providerId) { return 'espn:' + String(providerId); }
function boutId(providerId) { return 'espn:' + String(providerId); }

/* A parsed provider event -> the rows ufc.events / ufc.bouts take. */
function eventRows(ev, nowIso) {
  const eid = eventId(ev.provider_event_id);
  const event = {
    event_id: eid, provider: 'espn', provider_event_id: String(ev.provider_event_id),
    name: ev.name, short_name: ev.short_name, promotion: 'UFC',
    venue: ev.venue, city: ev.city, state: ev.state, country: ev.country, timezone: ev.timezone,
    scheduled_at: ev.scheduled_at, event_state: ev.event_state,
    bouts_total: ev.bouts.length,
    bouts_completed: ev.bouts.filter(b => b.status === 'final' || b.status === 'no_contest').length,
    bouts_live: ev.bouts.filter(b => b.status === 'live').length,
    source: 'espn', source_url: E.scoreboardDayUrl(Date.parse(ev.scheduled_at) || Date.now()),
    source_updated_at: nowIso
  };
  const bouts = ev.bouts.map(b => {
    const row = {
      bout_id: boutId(b.provider_bout_id), event_id: eid, provider: 'espn', provider_bout_id: String(b.provider_bout_id),
      bout_order: b.bout_order, card_segment: b.card_segment, is_main: !!b.is_main, is_title: !!b.is_title,
      weight_class: b.weight_class, scheduled_rounds: b.scheduled_rounds,
      red_provider_id: b.red_provider_id, blue_provider_id: b.blue_provider_id,
      red_name: b.red_name, blue_name: b.blue_name, red_record: b.red_record, blue_record: b.blue_record,
      red_rank: b.red_rank, blue_rank: b.blue_rank, corner_source: b.corner_source,
      status: b.status, status_detail: b.status_detail, round: b.round, clock: b.clock, clock_seconds: b.clock_seconds,
      referee: b.referee, source_updated_at: nowIso
    };
    if (b.status === 'final' || b.status === 'no_contest') {
      row.winner_corner = b.winner_corner; row.method = b.method; row.method_detail = b.method_detail;
      row.result_detail = b.result_detail; row.end_round = b.end_round; row.end_time = b.end_time;
    }
    return row;
  });
  return { event, bouts };
}

/* Existing bouts of an event against the incoming card. A bout the provider
   no longer lists, and that had not ended, is cancelled — in place, keeping
   its id and everything attached to it. A finished bout is never reopened. */
function reconcileBouts(existing, incoming, nowIso) {
  const seen = new Set(incoming.map(b => b.bout_id));
  const byId = {};
  (existing || []).forEach(b => { byId[b.bout_id] = b; });
  const cancelled = [];
  (existing || []).forEach(b => {
    if (seen.has(b.bout_id)) return;
    if (['final', 'no_contest', 'cancelled'].includes(b.status)) return;
    cancelled.push({ bout_id: b.bout_id, event_id: b.event_id, provider: b.provider || 'espn', provider_bout_id: b.provider_bout_id,
      status: 'cancelled', status_detail: 'absent from provider card', source_updated_at: nowIso });
  });
  const upserts = incoming.map(b => {
    const prev = byId[b.bout_id];
    if (prev && (prev.status === 'final' || prev.status === 'no_contest') && (b.status === 'scheduled' || b.status === 'unknown')) {
      /* the feed re-listed a finished bout as scheduled: keep the result */
      const keep = Object.assign({}, b); delete keep.status; delete keep.round; delete keep.clock; delete keep.clock_seconds; delete keep.status_detail;
      keep.status_detail = prev.status_detail;
      return keep;
    }
    return b;
  });
  return { upserts, cancelled };
}

/* Fill red/blue_fighter_id and collect the alias rows a resolution earns. */
function resolveBouts(bouts, index, aliases) {
  const aliasRows = [], unmatched = [], seen = new Set();
  bouts.forEach(b => {
    [['red', b.red_name, b.red_provider_id], ['blue', b.blue_name, b.blue_provider_id]].forEach(p => {
      const corner = p[0], name = p[1], pid = p[2];
      const r = R.resolveFighter(name, pid, index, aliases);
      b[corner + '_fighter_id'] = r.fighter_id || null;
      if (r.method === 'placeholder') return;   /* "TBA": not a fighter, not a miss */
      if (!r.fighter_id) {
        const k = (pid || '') + '|' + R.normName(name);
        if (!seen.has(k)) { seen.add(k); unmatched.push({ name, provider_id: pid, reason: r.method === 'ambiguous' ? 'ambiguous' : 'no_match', candidates: r.candidates }); }
        return;
      }
      if (pid && r.method !== 'provider_id') {
        aliasRows.push({ alias_key: 'espn:' + String(pid), fighter_id: r.fighter_id, display_name: name, source: 'sync',
          confidence: ['exact', 'name_order', 'surname', 'first_last'].indexOf(r.method) >= 0 ? r.method : 'exact' });
      }
      const nk = R.normName(name);
      if (nk && r.method !== 'exact' && r.method !== 'alias')
        aliasRows.push({ alias_key: 'name:' + nk, fighter_id: r.fighter_id, display_name: name, source: 'sync',
          confidence: ['provider_id', 'name_order', 'surname', 'first_last'].indexOf(r.method) >= 0 ? r.method : 'surname' });
    });
  });
  const dedup = {};
  aliasRows.forEach(a => { dedup[a.alias_key] = a; });
  return { aliasRows: Object.keys(dedup).map(k => dedup[k]), unmatched };
}

/* Fixtures from the odds feed against the bouts on file. */
function linkMarkets(signalRows, bouts, resolve, nowIso) {
  const links = [], rejections = [], fixtures = R.groupFixtures(signalRows);
  fixtures.forEach(f => {
    const n = R.normalizeFixture(f);
    n.rejections.forEach(rj => rejections.push({ signal_event_id: f.signal_event_id, sig_key: rj.sig_key || '', sport_key: f.sport_key,
      home_team: f.home_team, away_team: f.away_team, selection: rj.selection || null, market: rj.sig_key ? 'h2h' : null, reason: rj.reason, detail: rj.detail, last_seen_at: nowIso }));
    if (!n.ok) return;
    const res = R.linkFixture(n, bouts, resolve);
    if (!res.ok) {
      rejections.push({ signal_event_id: f.signal_event_id, sig_key: '', sport_key: f.sport_key, home_team: f.home_team, away_team: f.away_team,
        selection: null, market: 'h2h', reason: res.reason, detail: res.detail, last_seen_at: nowIso });
      return;
    }
    const L = res.link;
    links.push({ bout_id: L.bout_id, event_id: L.event_id, signal_event_id: L.signal_event_id, sport_key: L.sport_key || SPORT_KEY,
      home_team: L.home_team, away_team: L.away_team, red_selection: L.red_selection, blue_selection: L.blue_selection,
      red_sig_key: L.red_sig_key, blue_sig_key: L.blue_sig_key, draw_sig_key: L.draw_sig_key, other_sig_keys: L.other_sig_keys,
      commence_time: L.commence_time, link_method: L.link_method });
  });
  /* one fixture per bout: if two fixtures resolve to one bout keep the newer commence */
  const byBout = {};
  links.forEach(l => { const p = byBout[l.bout_id]; if (!p || String(l.commence_time || '') > String(p.commence_time || '')) byBout[l.bout_id] = l; });
  return { links: Object.keys(byBout).map(k => byBout[k]), rejections, fixtures: fixtures.length };
}

/* Price observations for linked bouts, tagged against the bout's bell. */
function captureRows(links, signalRows, ticks, boutsById, eventsById) {
  const bySig = {};
  (signalRows || []).forEach(r => { if (r.sig_key) bySig[r.sig_key] = r; });
  const out = [], seen = new Set();
  function add(link, corner, sigKey, at, row, source) {
    if (!sigKey || !at) return;
    const key = sigKey + '|' + at;
    if (seen.has(key)) return; seen.add(key);
    const bout = boutsById[link.bout_id] || {}, ev = eventsById[link.event_id] || {};
    const state = R.marketStateAt(at, bout, ev);
    out.push({ bout_id: link.bout_id, event_id: link.event_id, sig_key: sigKey, corner, book: row.best_book || null,
      capture_at: at, market_state: state, round: state === 'LIVE' ? (bout.round != null ? bout.round : null) : null,
      clock: state === 'LIVE' ? (bout.clock || null) : null,
      best_dec: row.best_dec != null ? +row.best_dec : null, sharp_fair: row.sharp_fair != null ? +row.sharp_fair : null,
      consensus_fair: row.consensus_fair != null ? +row.consensus_fair : null, n_books: row.n_books != null ? +row.n_books : null,
      has_sharp: row.has_sharp == null ? null : !!row.has_sharp, source });
  }
  links.forEach(link => {
    [['red', link.red_sig_key], ['blue', link.blue_sig_key], ['draw', link.draw_sig_key]].forEach(p => {
      const corner = p[0], sk = p[1];
      if (!sk) return;
      const row = bySig[sk];
      if (row) {
        if (row.first_seen_at && row.first_best_dec != null) add(link, corner, sk, row.first_seen_at, { best_dec: row.first_best_dec, sharp_fair: null, consensus_fair: null, n_books: null, has_sharp: null, best_book: null }, 'signals_open');
        if (row.last_seen_at) add(link, corner, sk, row.last_seen_at, row, 'signals');
      }
      (ticks && ticks[sk] || []).forEach(t => add(link, corner, sk, t.created_at, { best_dec: t.best_dec, sharp_fair: t.sharp_fair, consensus_fair: null, n_books: null, has_sharp: null, best_book: null }, 'signal_ticks'));
    });
  });
  return out;
}

/* Events long past their start that never closed. */
const STALE_AFTER_MS = 14 * 3600 * 1000;
function staleEvents(events, nowMs, liveIds) {
  return (events || []).filter(e => {
    if (!['scheduled', 'live'].includes(e.event_state)) return false;
    if (liveIds && liveIds.has(e.event_id)) return false;
    const t = Date.parse(e.scheduled_at);
    return isFinite(t) && nowMs - t > STALE_AFTER_MS;
  }).map(e => e.event_id);
}

function nextEvent(events, nowMs) {
  const ahead = (events || []).filter(e => ['scheduled', 'live'].includes(e.event_state) && isFinite(Date.parse(e.scheduled_at)) && Date.parse(e.scheduled_at) > nowMs - 10 * 3600 * 1000)
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
  return ahead[0] || null;
}

/* ---- the run --------------------------------------------------------------- */

async function run(o, deps) {
  deps = deps || {};
  const now = o.now ? new Date(o.now) : new Date();
  const nowIso = now.toISOString(), nowMs = now.getTime();
  const src = deps.source || E.source({ fetchImpl: deps.fetchImpl });
  const summary = { events: 0, bouts: 0, cancelled: 0, resolved: 0, unmatched: [], aliases: 0, fixtures: 0, links: 0, rejections: 0, captures: 0, stale: 0, next_event: null, errors: [] };

  /* 1. discover */
  let parsed;
  if (o.fixture) parsed = E.parseScoreboard(JSON.parse(fs.readFileSync(o.fixture, 'utf8')));
  else {
    const fromMs = nowMs - o.fromDays * 86400000, toMs = nowMs + o.toDays * 86400000;
    if (o.verify && typeof src.probe === 'function') {
      /* every request shape, each reported: a 403 names the shape that drew it */
      const probe = await src.probe(fromMs, toMs);
      probe.forEach(p => log(`  probe ${p.via.padEnd(10)} ${p.status == null ? 'ERR ' : p.status} ${p.status === 200 ? p.events + ' events, ' + p.inWindow + ' in window, ' + p.latency + 'ms' : (p.error || '')}  ${p.url}`));
      summary.probe = probe;
    }
    const r = await src.scoreboard(fromMs, toMs);
    parsed = r.events; summary.source_latency_ms = r.latency; summary.source_via = r.via || null; summary.source_tried = r.tried || null;
    if (r.via) log(`source answered via ${r.via}` + (r.totalSeen != null ? ` (${r.totalSeen} events seen, ${parsed.length} in window)` : ''));
  }
  if (o.event) parsed = parsed.filter(e => String(e.provider_event_id) === String(o.event));
  summary.events = parsed.length;
  summary.bouts = parsed.reduce((n, e) => n + e.bouts.length, 0);
  log(`${parsed.length} event(s), ${summary.bouts} bout(s) in the window`);
  parsed.forEach(e => log(`  ${e.provider_event_id}  ${e.scheduled_at}  ${e.name}  [${e.event_state}] ${e.bouts.length} bouts`));
  if (o.verify) return summary;

  const db = deps.db;
  if (!db) { summary.errors.push('no database credential'); return summary; }

  /* 2. fighters and aliases, once */
  const fighters = await db.selectAll('ufc', 'fighters', 'select=fighter_id,full_name&order=fighter_id.asc');
  const index = R.buildFighterIndex(fighters);
  const aliases = {};
  (await db.selectAll('ufc', 'fighter_aliases', 'select=alias_key,fighter_id&order=alias_key.asc')).forEach(a => { aliases[a.alias_key] = String(a.fighter_id); });
  log(`${fighters.length} fighters on file, ${Object.keys(aliases).length} aliases`);

  /* 3. events and bouts */
  const allBouts = [], eventsById = {}, boutsById = {}, liveIds = new Set();
  for (const ev of parsed) {
    const rows = eventRows(ev, nowIso);
    const existing = await db.select('ufc', 'bouts', `select=bout_id,event_id,provider,provider_bout_id,status,status_detail,first_bell_at,round,clock&event_id=eq.${encodeURIComponent(rows.event.event_id)}`);
    const rec = reconcileBouts(existing, rows.bouts, nowIso);
    const res = resolveBouts(rec.upserts, index, aliases);
    summary.resolved += rec.upserts.filter(b => b.red_fighter_id && b.blue_fighter_id).length;
    summary.unmatched.push(...res.unmatched.map(u => Object.assign({ event: rows.event.name }, u)));
    summary.cancelled += rec.cancelled.length;
    const prevEvent = (await db.select('ufc', 'events', `select=event_id,event_state,first_bell_at,completed_at&event_id=eq.${encodeURIComponent(rows.event.event_id)}`))[0];
    if (prevEvent && prevEvent.event_state === 'final' && rows.event.event_state === 'scheduled') rows.event.event_state = 'final';
    if (rows.event.event_state === 'live') liveIds.add(rows.event.event_id);
    if (rows.event.event_state === 'final' && !(prevEvent && prevEvent.completed_at)) rows.event.completed_at = nowIso;
    eventsById[rows.event.event_id] = Object.assign({}, prevEvent || {}, rows.event);
    rec.upserts.forEach(b => { boutsById[b.bout_id] = Object.assign({}, (existing || []).find(x => x.bout_id === b.bout_id) || {}, b); });
    if (o.commit) {
      await db.upsert('ufc', 'events', [rows.event], 'event_id', { returning: false });
      if (rec.upserts.length) await db.upsert('ufc', 'bouts', rec.upserts, 'bout_id', { returning: false });
      if (rec.cancelled.length) await db.upsert('ufc', 'bouts', rec.cancelled, 'bout_id', { returning: false });
      if (res.aliasRows.length) { await db.upsert('ufc', 'fighter_aliases', res.aliasRows, 'alias_key', { returning: false }); summary.aliases += res.aliasRows.length; res.aliasRows.forEach(a => { aliases[a.alias_key] = a.fighter_id; }); }
    } else {
      summary.aliases += res.aliasRows.length;
      rec.cancelled.forEach(c => log(`  would cancel ${c.bout_id} (${c.status_detail})`));
    }
    allBouts.push(...rec.upserts);
  }
  summary.unmatched.forEach(u => log(`  unresolved: ${u.name} (${u.provider_id || 'no id'}) — ${u.reason}${u.candidates && u.candidates.length ? ' ' + u.candidates.join(',') : ''}`));

  /* 4. markets */
  if (o.market) {
    try {
      const from = new Date(nowMs - 2 * 86400000).toISOString(), to = new Date(nowMs + (o.toDays + 1) * 86400000).toISOString();
      const signals = await db.selectAll('public', 'signals', `select=${SIGNAL_COLS}&sport_key=eq.${SPORT_KEY}&commence_time=gte.${from}&commence_time=lte.${to}&order=commence_time.asc`);
      const resolve = name => R.resolveFighter(name, null, index, aliases);
      const lm = linkMarkets(signals, allBouts, resolve, nowIso);
      summary.fixtures = lm.fixtures; summary.links = lm.links.length; summary.rejections = lm.rejections.length;
      log(`${signals.length} signal rows, ${lm.fixtures} fixtures, ${lm.links.length} linked, ${lm.rejections.length} rejected`);
      lm.rejections.forEach(r => log(`  rejected ${r.signal_event_id} ${r.home_team} vs ${r.away_team}${r.selection ? ' [' + r.selection + ']' : ''}: ${r.reason}`));
      if (o.commit) {
        if (lm.links.length) await db.upsert('ufc', 'bout_markets', lm.links, 'bout_id', { returning: false });
        if (lm.rejections.length) {
          const ids = Array.from(new Set(lm.rejections.map(r => r.signal_event_id)));
          const prev = ids.length ? await db.select('ufc', 'market_rejections', `select=signal_event_id,sig_key,reason,first_seen_at,seen_count&signal_event_id=in.${D.inList(ids)}`) : [];
          const pk = {}; prev.forEach(p => { pk[p.signal_event_id + '|' + p.sig_key + '|' + p.reason] = p; });
          const rows = lm.rejections.map(r => { const p = pk[r.signal_event_id + '|' + r.sig_key + '|' + r.reason]; return Object.assign({}, r, { first_seen_at: p ? p.first_seen_at : nowIso, seen_count: p ? (p.seen_count || 0) + 1 : 1 }); });
          await db.upsert('ufc', 'market_rejections', rows, 'signal_event_id,sig_key,reason', { returning: false });
        }
      }
      /* 5. captures — the openers and the current price now; the tick series
         for cards inside three days, incrementally */
      const ticks = {};
      if (o.ticks) {
        const near = lm.links.filter(l => { const ev = eventsById[l.event_id]; const t = ev && Date.parse(ev.scheduled_at); return isFinite(t) && t - nowMs < 3 * 86400000; });
        const keys = [].concat(...near.map(l => [l.red_sig_key, l.blue_sig_key, l.draw_sig_key].filter(Boolean)));
        if (keys.length) {
          const latest = {};
          for (let i = 0; i < near.length; i += 20) {
            const chunk = near.slice(i, i + 20).map(l => l.bout_id);
            (await db.select('ufc', 'market_captures', `select=sig_key,capture_at&bout_id=in.${D.inList(chunk)}&source=eq.signal_ticks&order=capture_at.desc&limit=5000`))
              .forEach(c => { if (!latest[c.sig_key] || c.capture_at > latest[c.sig_key]) latest[c.sig_key] = c.capture_at; });
          }
          for (let i = 0; i < keys.length; i += 15) {
            const chunk = keys.slice(i, i + 15);
            const minAt = chunk.map(k => latest[k]).filter(Boolean).sort()[0];
            const q = `select=sig_key,created_at,sharp_fair,best_dec&sig_key=in.${D.inList(chunk)}${minAt ? '&created_at=gt.' + encodeURIComponent(minAt) : ''}&order=created_at.asc`;
            (await db.selectAll('public', 'signal_ticks', q, 1000, 6)).forEach(t => { if (!latest[t.sig_key] || t.created_at > latest[t.sig_key]) (ticks[t.sig_key] = ticks[t.sig_key] || []).push(t); });
          }
        }
      }
      const caps = captureRows(lm.links, signals, ticks, boutsById, eventsById);
      summary.captures = caps.length;
      if (o.commit && caps.length) await db.upsert('ufc', 'market_captures', caps, 'sig_key,capture_at', { ignoreDuplicates: true, returning: false });
    } catch (e) {
      summary.errors.push('market: ' + e.message);
      log('market step failed: ' + e.message);
    }
  }

  /* 6. stale */
  if (o.stale) {
    const open = await db.select('ufc', 'events', 'select=event_id,event_state,scheduled_at&event_state=in.(scheduled,live)&order=scheduled_at.asc&limit=200');
    const stale = staleEvents(open, nowMs, liveIds);
    summary.stale = stale.length;
    if (stale.length) {
      log(`marking ${stale.length} open event(s) stale: ${stale.join(', ')}`);
      if (o.commit) for (const id of stale) await db.patch('ufc', 'events', `event_id=eq.${encodeURIComponent(id)}`, { event_state: 'stale', source_updated_at: nowIso });
    }
    const nx = nextEvent(Object.keys(eventsById).map(k => eventsById[k]).concat(open.filter(e => !eventsById[e.event_id] && !stale.includes(e.event_id))), nowMs);
    summary.next_event = nx ? { event_id: nx.event_id, name: nx.name, scheduled_at: nx.scheduled_at } : null;
  }
  return summary;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cfg = D.config();
  const db = cfg ? D.client(cfg) : null;
  if (!o.verify && !db) { console.error('No service credential (EDGD_SB_SERVICE + EDGD_SB_URL). Run with --verify to check the source only.'); process.exit(1); }
  const ledger = (db && o.commit) ? D.runLedger(db, 'ufc_sync') : null;
  if (ledger) await ledger.start({ from_days: o.fromDays, to_days: o.toDays });
  let summary, code = 0;
  try {
    summary = await run(o, { db });
    const status = summary.errors.length ? 'warn' : 'ok';
    const msg = `${summary.events} events, ${summary.bouts} bouts, ${summary.resolved} fully resolved, ${summary.unmatched.length} unresolved names, ${summary.links} market links, ${summary.rejections} rejections`;
    log(msg);
    if (ledger) {
      await ledger.finish(status, msg, { last_success_at: new Date().toISOString(), last_source_at: new Date().toISOString(), source_latency_ms: summary.source_latency_ms || null,
        details: Object.assign({}, summary, { unmatched: summary.unmatched.slice(0, 60) }) });
      await D.writeMeta(db, { ufc_sync_last_run: new Date().toISOString(), ufc_sync_last_status: status, row_count_ufc_sync: summary.bouts,
        ufc_next_event_id: summary.next_event ? summary.next_event.event_id : '', ufc_next_event_name: summary.next_event ? summary.next_event.name : '',
        ufc_next_event_at: summary.next_event ? summary.next_event.scheduled_at : '' });
    }
    if (o.verify && !summary.events) { console.error('The source answered but carried no UFC event in the window.'); code = 2; }
  } catch (e) {
    console.error('[ufc-sync] failed: ' + (e && e.stack || e));
    if (ledger) { await ledger.finish('error', String(e && e.message || e).slice(0, 400)); await D.writeMeta(db, { ufc_sync_last_run: new Date().toISOString(), ufc_sync_last_status: 'error' }); }
    code = 1;
  }
  process.exit(code);
}

module.exports = { parseArgs, eventRows, reconcileBouts, resolveBouts, linkMarkets, captureRows, staleEvents, nextEvent, run, eventId, boutId, SPORT_KEY, STALE_AFTER_MS };
if (require.main === module) main();
