/* ============================================================================
   CFB Model Lab — market history: capture, de-duplication, openers, closes.

   Sources (docs/cfb-lab/ARCHITECTURE.md §Market):
     espn      ESPN's public scoreboard, fetched by the lab job every hour: the
               line ESPN carries for its book while a game is ahead (spread,
               total, moneyline, prices), and — once final — the line ESPN froze
               at kickoff, stored as the provider's declared close. Keyless.
     cfbd      the CFBD provider-mean line the V2 pipeline records daily in
               football/cfb_v2/shadow/<season>/lines.jsonl (consensus, with the
               provider's declared opener).
     odds_api  per-sportsbook quotes The Odds API returns to the Supabase
               `capture` function, written there by cfb_lab_ingest_quotes() and
               pulled here with the service role (optional; off without keys).

   Every quote goes through lab_core.dedupeDecision (METRICS §4): unchanged
   quotes are dropped except for the 6-hour and close-zone heartbeats, and a
   quote at or after kickoff is never recorded as pregame.

   Before de-duplication every candidate passes the integrity rules
   (integrity.js, docs/cfb-production/MARKET_INTEGRITY.md): an impossible value
   (a +450 spread, American odds of 0, a two-way price below fair, a timestamp
   from the future), a quote from another game (teams, orientation, kickoff),
   a robust cross-book outlier, a sign flip or an uncorroborated jump is written
   to quarantine.jsonl with its reasons and evidence — kept for investigation,
   never deleted, and never part of any opener, close or consensus. Provider
   payloads are schema-checked first (providers.js): a missing required field
   rejects that element and is logged, never read as zero.

     node football/cfb_lab/market.js capture [--season 2026] [--now ISO] [--no-espn] [--no-cfbd] [--supabase]
     node football/cfb_lab/market.js lines   [--season 2026] [--now ISO]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lab_core.js');
const G = require('./ledger.js');
const I = require('./integrity.js');
const P = require('./providers.js');
const SRC = require(path.join(G.REPO, 'tools', 'record', 'football_record_sources.js'));

const U = L.util;

/* ------------------------------------------------------------ books */
function bookKey(name) { return String(name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'unknown'; }
function american(x) {
  if (x === null || x === undefined || x === '') return null;
  const t = String(x).trim();
  if (/^(even|ev)$/i.test(t)) return 100;
  const n = Number(t.replace(/^\+/, ''));
  return Number.isFinite(n) && n !== 0 ? Math.round(n) : null;
}

/* ----------------------------------------------------------- quotes */
function baseQuote(o) {
  const q = Object.assign({
    game_id: null, season: null, week: null, source: null, provider_event_id: null, book: null, market_type: null,
    home_line: null, total_points: null, price_home: null, price_away: null, price_over: null, price_under: null,
    observed_at: null, provider_updated_at: null, kickoff_ts: null, is_heartbeat: false, is_provider_open: false,
    is_provider_close: false, is_pregame: true, home_team: null, away_team: null, retrieved_at: null,
  }, o);
  q.fingerprint = G.ids.fingerprint(q);
  q.quote_id = G.ids.quote(q);
  return q;
}

/* ESPN odds object -> the three markets for one book, using the record's
   orientation-checked line reader for the spread. */
function espnMarkets(odds, homeAbbr, awayAbbr) {
  const line = SRC.espnLine(odds, homeAbbr, awayAbbr);
  const ho = odds.homeTeamOdds || {}, ao = odds.awayTeamOdds || {};
  const ps = odds.pointSpread || {}, ml = odds.moneyline || {}, tt = odds.total || {};
  const cur = (o) => (o && (o.current || o.close || o.open)) || null;
  const priceHome = american(ho.spreadOdds) ?? american(cur(ps.home) && cur(ps.home).odds);
  const priceAway = american(ao.spreadOdds) ?? american(cur(ps.away) && cur(ps.away).odds);
  const mlHome = american(ho.moneyLine) ?? american(cur(ml.home) && cur(ml.home).odds);
  const mlAway = american(ao.moneyLine) ?? american(cur(ml.away) && cur(ml.away).odds);
  const pOver = american(odds.overOdds) ?? american(cur(tt.over) && cur(tt.over).odds);
  const pUnder = american(odds.underOdds) ?? american(cur(tt.under) && cur(tt.under).odds);
  const openHome = ps.home && ps.home.open ? SRC.parseLineText(ps.home.open.line) : null;
  const openTotal = tt.over && tt.over.open ? SRC.parseLineText(tt.over.open.line) : null;
  return {
    book: bookKey(odds.provider && odds.provider.name),
    spread: line && line.home_line != null ? { home_line: line.home_line, price_home: priceHome, price_away: priceAway } : null,
    total: line && line.total != null ? { total_points: line.total, price_over: pOver, price_under: pUnder } : null,
    moneyline: (mlHome != null || mlAway != null) ? { price_home: mlHome, price_away: mlAway } : null,
    open: { home_line: openHome, total_points: openTotal },
  };
}

/* One ESPN scoreboard payload -> quote candidates. Pregame games give live
   pregame quotes; completed games give the provider's declared close; games in
   progress give nothing (in-play odds are never read). */
function quotesFromEspn(json, observedAt, index) {
  index = index || {};
  const out = [];
  const obs = U.iso(observedAt);
  ((json && json.events) || []).forEach((ev) => {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const st = (comp.status && comp.status.type) || {};
    const state = st.state || null;
    const home = (comp.competitors || []).find((c) => c.homeAway === 'home') || {};
    const away = (comp.competitors || []).find((c) => c.homeAway === 'away') || {};
    const gid = String(ev.id);
    const gi = index[gid] || {};
    const kickoff = U.iso(comp.date || ev.date || gi.kickoff);
    const completed = st.completed === true && !/POSTPONED|CANCEL|SUSPEND|FORFEIT/i.test(String(st.name || ''));
    const pregame = state === 'pre' && U.ms(obs) < U.ms(kickoff);
    if (!pregame && !completed) return;
    const common = { game_id: gid, provider_event_id: gid, source: 'espn', season: gi.season ?? (ev.season && ev.season.year) ?? null,
      week: gi.week ?? (ev.week && ev.week.number) ?? null, kickoff_ts: kickoff, observed_at: obs, retrieved_at: obs,
      home_team: (home.team && (home.team.displayName || home.team.location)) || null,
      away_team: (away.team && (away.team.displayName || away.team.location)) || null };
    (comp.odds || []).forEach((odds) => {
      const m = espnMarkets(odds, home.team && home.team.abbreviation, away.team && away.team.abbreviation);
      const flags = completed ? { is_provider_close: true, is_pregame: false } : {};
      ['spread', 'total', 'moneyline'].forEach((mt) => {
        if (!m[mt]) return;
        out.push(baseQuote(Object.assign({}, common, flags, m[mt], { book: m.book, market_type: mt })));
      });
      if (pregame && m.open.home_line != null) out.push(baseQuote(Object.assign({}, common, { book: m.book, market_type: 'spread', home_line: m.open.home_line, is_provider_open: true })));
      if (pregame && m.open.total_points != null) out.push(baseQuote(Object.assign({}, common, { book: m.book, market_type: 'total', total_points: m.open.total_points, is_provider_open: true })));
    });
  });
  return out;
}

/* The V2 pipeline's CFBD ledger -> consensus quotes (+ the declared opener). */
function quotesFromCfbd(rows, index) {
  index = index || {};
  const out = [];
  (rows || []).forEach((x) => {
    const gid = String(x.game_id), gi = index[gid] || {};
    const common = { game_id: gid, provider_event_id: gid, source: 'cfbd', book: 'consensus', season: gi.season ?? null, week: gi.week ?? null,
      kickoff_ts: U.iso(gi.kickoff), observed_at: U.iso(x.observed_at), retrieved_at: U.iso(x.retrieved_at || x.observed_at),
      home_team: gi.home || null, away_team: gi.away || null };
    if (!common.kickoff_ts || !(U.ms(common.observed_at) < U.ms(common.kickoff_ts))) return;
    if (U.isNum(x.current_home_line)) out.push(baseQuote(Object.assign({}, common, { market_type: 'spread', home_line: x.current_home_line })));
    if (U.isNum(x.total_current)) out.push(baseQuote(Object.assign({}, common, { market_type: 'total', total_points: x.total_current })));
    if (U.isNum(x.open_home_line)) out.push(baseQuote(Object.assign({}, common, { market_type: 'spread', home_line: x.open_home_line, is_provider_open: true })));
    if (U.isNum(x.total_open)) out.push(baseQuote(Object.assign({}, common, { market_type: 'total', total_points: x.total_open, is_provider_open: true })));
  });
  return out;
}

/* ------------------------------------------------ Odds API events */
/* An Odds API event is joined to a game by the BOARD'S OWN RULE
   (supabase/functions/edgedesk_ai/_intelligence.js joinSignalsToGames: both
   teams resolve through football/fbs/fbs.js to this game's own teams, in this
   orientation, and the kickoffs agree within 36 h). A half match, a swapped
   orientation or an ambiguous name is refused and counted, never guessed: a
   quote joined to the wrong game is a fabricated market. Each join is written
   once to the event map (method teams_and_kickoff); cfb_lab_ingest_quotes()
   then resolves that event's later quotes to the game as they arrive. */
let INTEL = null;
function intel() { return INTEL || (INTEL = require(path.join(G.REPO, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'))); }
function scheduleGames(season) {
  const rd = (p) => { try { return JSON.parse(fs.readFileSync(path.join(G.REPO, p), 'utf8')); } catch (e) { return null; } };
  const out = new Map();
  const slate = rd('football/fbs/slate.json');
  ((slate && slate.games) || []).filter((g) => g.season === season).forEach((g) => out.set(String(g.game_id),
    { game_id: String(g.game_id), home_team: g.home_team, away_team: g.away_team, home_id: g.home_team_id, away_id: g.away_team_id, kickoff: g.kickoff }));
  const cur = rd('football/cfb_v2/current.json');
  ((cur && cur.rows) || []).filter((r) => r.season === season && !out.has(String(r.game_id))).forEach((r) => out.set(String(r.game_id),
    { game_id: String(r.game_id), home_team: r.home, away_team: r.away, kickoff: r.kickoff }));
  return [...out.values()];
}
function mapOddsEvents(quotes, eventMap, games, now) {
  const mapped = new Set((eventMap || []).map((m) => m.source + '|' + m.provider_event_id));
  const events = new Map();
  for (const q of quotes || []) {
    if (q.source !== 'odds_api' || q.game_id || !q.provider_event_id || mapped.has('odds_api|' + q.provider_event_id)) continue;
    if (!events.has(q.provider_event_id)) events.set(q.provider_event_id, { provider_event_id: String(q.provider_event_id), home_team: q.home_team, away_team: q.away_team, commence_time: q.kickoff_ts });
  }
  if (!events.size) return { rows: [], events: 0, joined: 0, refused: 0, refusal_reasons: {}, unresolved_names: [] };
  const j = intel().joinSignalsToGames({ signals: [...events.values()], games });
  const rows = [];
  Object.keys(j.by_game).sort().forEach((gid) => j.by_game[gid].forEach((ev) => {
    const r = { source: 'odds_api', provider_event_id: ev.provider_event_id, game_id: gid, method: 'teams_and_kickoff', confidence: 1, created_at: U.iso(now), supersedes: null };
    r.map_id = G.ids.map(r);
    rows.push(r);
  }));
  return { rows, events: events.size, joined: j.signals_joined, refused: j.signals_refused, refusal_reasons: j.refusal_reasons, unresolved_names: j.unresolved_names, diagnosis: j.diagnosis };
}

/* A quote that arrives without a game_id (an Odds API event) is resolved
   through the event map first — the newest map row for (source,
   provider_event_id) wins — so its key and quote_id are the ones the same
   quote would have had with the game_id already set. Unmapped, it keeps
   game_id null and is keyed by provider_event_id. */
function resolveEvent(q, eventMap) {
  if (q.game_id || !q.provider_event_id || !eventMap || !eventMap.length) return q;
  let best = null;
  for (const m of eventMap) {
    if (m.source !== q.source || String(m.provider_event_id) !== String(q.provider_event_id)) continue;
    if (!best || U.ms(m.created_at) > U.ms(best.created_at) || (U.ms(m.created_at) === U.ms(best.created_at) && String(m.map_id || '') > String(best.map_id || ''))) best = m;
  }
  return best && best.game_id ? baseQuote(Object.assign({}, q, { game_id: String(best.game_id) })) : q;
}

/* Apply the de-dup + heartbeat rule against the stored history (METRICS §4).
   A quote that can never be stored is refused. Provider-declared rows are
   kept once per key and flag (their value is a fact about the provider, not an
   observation). Ordinary rows are compared only with the latest ORDINARY row
   of their key. */
function selectNew(stored, candidates, opts) {
  opts = opts || {};
  const latest = new Map(), provOpen = new Set(), provClose = new Set();
  const keyOf = (q) => L.quoteKey(q);
  const byTime = stored.slice().sort((a, b) => U.ms(a.observed_at) - U.ms(b.observed_at));
  for (const q of byTime) {
    if (q.is_provider_open) { provOpen.add(keyOf(q)); continue; }
    if (q.is_provider_close) { provClose.add(keyOf(q)); continue; }
    latest.set(keyOf(q), q);
  }
  const out = [], stats = { received: candidates.length, written: 0, duplicates: 0, refused: 0, refusals: {} };
  const ids = new Set(stored.map((q) => q.quote_id));
  const sorted = candidates.map((q) => resolveEvent(q, opts.eventMap)).sort((a, b) => U.ms(a.observed_at) - U.ms(b.observed_at));
  for (const q of sorted) {
    const k = keyOf(q);
    const why = L.quoteRefusal(q);
    let d;
    if (why) { d = 'refused'; stats.refusals[why] = (stats.refusals[why] || 0) + 1; }
    else if (ids.has(q.quote_id)) d = 'duplicate';
    else if (q.is_provider_open) d = provOpen.has(k) ? 'duplicate' : 'written';
    else if (q.is_provider_close) d = provClose.has(k) ? 'duplicate' : 'written';
    else d = L.dedupeDecision(latest.get(k) || null, q);
    if (d === 'written') {
      const prev = latest.get(k);
      const row = Object.assign({}, q, { is_heartbeat: !!(prev && !q.is_provider_open && !q.is_provider_close && prev.fingerprint === q.fingerprint) });
      out.push(row); ids.add(row.quote_id);
      if (q.is_provider_open) provOpen.add(k); else if (q.is_provider_close) provClose.add(k); else latest.set(k, row);
      stats.written++;
    } else if (d === 'duplicate') stats.duplicates++; else stats.refused++;
  }
  return { rows: out, stats };
}

/* ------------------------------------------------ integrity screen */
/* Every candidate, before de-duplication (MARKET_INTEGRITY.md §3-5):
     REJECT      integrity.validateQuote: impossible values, clocks, wrong game
     QUARANTINE  integrity.screenQuote: cross-book outlier (MAD), 1-2 book
                 disagreement, sign flip, uncorroborated jump; and
                 integrity.crossMarket: one book's spread and moneyline name
                 different favourites
   Accepted quotes go on to selectNew; the others become quarantine rows. The
   wrong-game KICKOFF test applies to name-joined sources (odds_api) only: an
   ESPN or CFBD quote carries the game's own id, so a kickoff that differs from
   the index means the index is stale (a moved game), not that the quote is
   someone else's. */
const ID_JOINED = new Set(['espn', 'cfbd', 'record']);
function screenCandidates(stored, candidates, opts) {
  opts = opts || {};
  const idx = opts.index || {};
  const sameTeam = opts.sameTeam || null;
  const now = opts.now || null;
  const accepted = [], quarantined = [];
  const ord = (q) => !q.is_provider_open && !q.is_provider_close && q.is_pregame !== false;
  const byGame = new Map();
  const add = (q) => { if (!q.game_id || !ord(q)) return; const k = q.game_id + '|' + q.market_type; if (!byGame.has(k)) byGame.set(k, []); byGame.get(k).push(q); };
  stored.forEach(add);
  const latestOf = (q) => {
    const xs = byGame.get(q.game_id + '|' + q.market_type) || [];
    let best = null;
    for (const x of xs) if (x.source === q.source && x.book === q.book && U.ms(x.observed_at) <= U.ms(q.observed_at) && (!best || U.ms(x.observed_at) > U.ms(best.observed_at))) best = x;
    return best;
  };
  const sorted = candidates.slice().sort((a, b) => (U.ms(a.observed_at) - U.ms(b.observed_at)) || (a.quote_id < b.quote_id ? -1 : 1));
  /* one book, one moment: spread vs moneyline favourite */
  const moment = new Map();
  sorted.forEach((q) => { if (!ord(q) || !q.game_id) return; const k = [q.source, q.book, q.game_id, U.iso(q.observed_at)].join('|'); if (!moment.has(k)) moment.set(k, {}); moment.get(k)[q.market_type] = q; });
  const crossBad = new Set();
  moment.forEach((m) => { if (I.crossMarket(m.spread, m.moneyline).length) { crossBad.add(m.spread.quote_id); crossBad.add(m.moneyline.quote_id); } });
  for (const q of sorted) {
    const gi = q.game_id ? idx[q.game_id] : null;
    const game = gi ? { home: gi.home, away: gi.away, kickoff: ID_JOINED.has(q.source) ? null : gi.kickoff } : null;
    const v = I.validateQuote(q, { now, game, sameTeam });
    if (!v.ok) { quarantined.push(qRow(q, 'REJECT', v.reasons, { warnings: v.warnings }, now, I.RULES.quote)); continue; }
    if (crossBad.has(q.quote_id)) { quarantined.push(qRow(q, 'QUARANTINE', ['CROSS_MARKET_ORIENTATION'], null, now, I.RULES.outlier)); continue; }
    if (q.game_id && ord(q) && (q.market_type === 'spread' || q.market_type === 'total')) {
      const sc = I.screenQuote(q, byGame.get(q.game_id + '|' + q.market_type) || [], latestOf(q));
      if (!sc.ok) { quarantined.push(qRow(q, 'QUARANTINE', sc.reasons, sc.evidence, now, I.RULES.outlier)); continue; }
    }
    accepted.push(q); add(q);
  }
  return { accepted, quarantined };
}
function qRow(q, severity, reasons, evidence, now, rule) {
  const r = { quarantine_id: null, stage: 'INGEST', severity, reasons: reasons.slice(), rule_version: rule, status: 'OPEN',
    quote_id: q.quote_id, source: q.source, book: q.book, game_id: q.game_id || null, provider_event_id: q.provider_event_id || null,
    market_type: q.market_type, season: q.season == null ? null : q.season, week: q.week == null ? null : q.week,
    home_line: q.home_line == null ? null : q.home_line, total_points: q.total_points == null ? null : q.total_points,
    price_home: q.price_home == null ? null : q.price_home, price_away: q.price_away == null ? null : q.price_away,
    price_over: q.price_over == null ? null : q.price_over, price_under: q.price_under == null ? null : q.price_under,
    observed_at: U.iso(q.observed_at) || (q.observed_at == null ? null : String(q.observed_at)), provider_updated_at: q.provider_updated_at || null, kickoff_ts: q.kickoff_ts || null,
    is_pregame: q.is_pregame !== false, is_provider_open: !!q.is_provider_open, is_provider_close: !!q.is_provider_close,
    home_team: q.home_team || null, away_team: q.away_team || null, evidence: evidence || null, detected_at: U.iso(now) };
  r.quarantine_id = G.ids.quarantine(r);
  return r;
}
/* the same bad number re-observed every hour is one investigation, not 24:
   a quarantine row whose key, values and reasons match the key's latest
   quarantine row within the heartbeat interval is not written again */
function dedupeQuarantine(existing, rows) {
  const latest = new Map();
  const keyOf = (r) => [r.source, r.book, r.game_id || r.provider_event_id, r.market_type].join('|');
  const sig = (r) => JSON.stringify([r.home_line, r.total_points, r.price_home, r.price_away, r.price_over, r.price_under, r.reasons]);
  existing.slice().sort((a, b) => U.ms(a.observed_at) - U.ms(b.observed_at)).forEach((r) => latest.set(keyOf(r), r));
  const out = []; let skipped = 0;
  rows.forEach((r) => {
    const p = latest.get(keyOf(r));
    if (p && sig(p) === sig(r) && U.ms(r.observed_at) - U.ms(p.observed_at) < L.constants.HEARTBEAT_H * 3600000) { skipped++; return; }
    out.push(r); latest.set(keyOf(r), r);
  });
  return { rows: out, skipped };
}
/* ESPN's own view of each game this hour: its state and its current kickoff
   (the schedule authority for moved, early, postponed and canceled games). */
function espnSchedule(payloads) {
  const out = {};
  (payloads || []).forEach((json) => ((json && json.events) || []).forEach((ev) => {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const st = (comp.status && comp.status.type) || {};
    const name = String(st.name || '');
    const status = /POSTPONED/i.test(name) ? 'POSTPONED' : /CANCEL/i.test(name) ? 'CANCELED' : /SUSPEND/i.test(name) ? 'SUSPENDED'
      : st.state === 'in' ? 'IN_PROGRESS' : (st.state === 'post' || st.completed === true) ? 'FINISHED' : st.state === 'pre' ? 'SCHEDULED' : 'UNKNOWN';
    out[String(ev.id)] = { status, state: st.state || null, name: name || null, kickoff: U.iso(comp.date || ev.date) };
  }));
  return out;
}

/* ------------------------------------------------- openers and closes */
/* For each game whose close is due (kickoff + 3 h <= now) and not yet
   derived: per-book and CONSENSUS OPEN/CLOSE rows (METRICS §4). The spread is
   always derived — a game known only from a LIVE prediction (`games`) gets
   MISSING consensus rows — total and moneyline only when the game has a quote
   of that market. */
function deriveLines(quotes, existingLines, now, games) {
  const done = new Set(existingLines.filter((l) => l.kind === 'CLOSE' && l.book === 'CONSENSUS' && l.market_type === 'spread').map((l) => l.game_id));
  const byGame = new Map();
  const kickOf = new Map();
  for (const g of games || []) if (g.game_id && g.kickoff_ts) { kickOf.set(String(g.game_id), U.iso(g.kickoff_ts)); if (!byGame.has(String(g.game_id))) byGame.set(String(g.game_id), []); }
  for (const q of quotes) if (q.game_id) { if (!byGame.has(q.game_id)) byGame.set(q.game_id, []); byGame.get(q.game_id).push(q); }
  const out = [];
  const derivedAt = U.iso(now);
  const p0 = (x) => (U.isNum(U.num(x)) && U.num(x) !== 0 ? U.num(x) : null);
  const r2 = (x) => (U.isNum(U.num(x)) ? Math.round(U.num(x) * 100) / 100 : null);
  for (const [gid, qs] of byGame) {
    if (done.has(gid)) continue;
    const kick = kickOf.get(gid) || qs.map((q) => q.kickoff_ts).filter(Boolean)[0];
    if (!kick || !L.closeDue(kick, now)) continue;
    for (const mt of ['spread', 'total', 'moneyline']) {
      if (mt !== 'spread' && !qs.some((q) => q.market_type === mt)) continue;
      const o = L.openerFrom(qs, mt, null, kick), c = L.closeFrom(qs, mt, kick);
      const mk = (kind, book, v, rule, perBookQuote) => {
        const row = { game_id: gid, kind, book, market_type: mt,
          home_line: r2(v.home_line), total_points: r2(v.total_points), price_home: p0(v.price_home), price_away: p0(v.price_away),
          observed_at: v.observed_at ? U.iso(v.observed_at) : null, n_books: perBookQuote ? 1 : (v.n_books ?? 0), quality: v.quality || 'OBSERVED',
          best_line_home: book === 'CONSENSUS' && mt === 'spread' ? r2(v.best_line_home) : null,
          best_line_away: book === 'CONSENSUS' && mt === 'spread' ? r2(v.best_line_away) : null,
          rule_version: rule, quote_ids: v.quote_ids || (perBookQuote ? [perBookQuote.quote_id] : []), derived_at: derivedAt, kickoff_ts: U.iso(kick) };
        row.line_id = G.ids.line(row);
        return row;
      };
      const perBook = (q) => ({ home_line: mt === 'spread' ? q.home_line : null, total_points: mt === 'total' ? q.total_points : null,
        price_home: mt === 'total' ? q.price_over : q.price_home, price_away: mt === 'total' ? q.price_under : q.price_away,
        observed_at: U.iso(q.observed_at), quality: 'OBSERVED' });
      o.per_book.forEach((q) => out.push(mk('OPEN', q.source + ':' + q.book, perBook(q), L.RULES.open, q)));
      c.per_book.forEach((q) => out.push(mk('CLOSE', q.source + ':' + q.book, perBook(q), L.RULES.close, q)));
      out.push(mk('OPEN', 'CONSENSUS', o.consensus, L.RULES.open));
      out.push(mk('CLOSE', 'CONSENSUS', c.consensus, L.RULES.close));
    }
  }
  return out;
}

/* ------------------------------------------------------------ index */
/* game_id -> {season, week, kickoff, home, away} from the published cards. */
function gameIndex(season) {
  const idx = {};
  const put = (id, o) => { const k = String(id); idx[k] = Object.assign(idx[k] || {}, Object.fromEntries(Object.entries(o).filter(([, v]) => v != null))); };
  const rd = (p) => { try { return JSON.parse(fs.readFileSync(path.join(G.REPO, p), 'utf8')); } catch (e) { return null; } };
  const rec = rd('record/football/cfb_' + season + '.json');
  if (rec && rec.games) Object.values(rec.games).forEach((g) => put(g.game_id, { season: g.season, week: g.week, kickoff: g.kickoff, home: g.home, away: g.away }));
  const slate = rd('football/fbs/slate.json');
  if (slate && slate.games) slate.games.filter((g) => g.season === season).forEach((g) => put(g.game_id, { season: g.season, week: g.week, kickoff: g.kickoff, home: g.home_team, away: g.away_team }));
  const cur = rd('football/cfb_v2/current.json');
  if (cur && cur.rows) cur.rows.filter((r) => r.season === season).forEach((r) => put(r.game_id, { season: r.season, week: r.week, kickoff: r.kickoff, home: r.home, away: r.away }));
  return idx;
}

/* ------------------------------------------------------------- fetch */
function etDates(now, backDays, fwdDays) {
  const out = [];
  for (let d = -backDays; d <= fwdDays; d++) out.push(SRC.etDate(new Date(U.ms(now) + d * 86400000).toISOString()));
  return [...new Set(out)];
}
/* Each date is one guarded call (providers.js): a 30 s timeout, two bounded
   retries on a timeout / network fault / 5xx / 429, and the ESPN circuit
   breaker. With the breaker OPEN nothing is requested this hour; the stored
   quotes simply age and the market becomes MARKET_STALE. */
async function fetchEspn(now, opts) {
  opts = opts || {};
  const payloads = [];
  const br = opts.breaker || new P.Breaker('espn_scoreboard', P.POLICIES.espn_scoreboard, opts.breakerState);
  for (const d of etDates(now, opts.back == null ? 2 : opts.back, opts.fwd == null ? 9 : opts.fwd)) {
    const r = await P.guarded('espn_scoreboard', async (signal) => {
      const text = opts.fetchText ? await opts.fetchText(SRC.espnScoreboardUrl('cfb', d), signal) : await P.httpText(SRC.espnScoreboardUrl('cfb', d), signal);
      try { return JSON.parse(text); } catch (e) { throw new P.SchemaError('ESPN ' + d + ': not JSON'); }
    }, { breaker: br, now: U.iso(now), sleep: opts.sleep, rand: opts.rand });
    if (r.ok) payloads.push(r.value);
    else payloads.push({ error: d + ': ' + (r.class || 'UNKNOWN') + ' ' + r.error, error_class: r.class, events: [] });
  }
  payloads.breaker = br.snapshot();
  return payloads;
}

/* ------------------------------------------------------------- run */
async function capture(season, now, opts) {
  opts = opts || {};
  const store = new G.Store(season, opts.storeOpts);
  const idx = gameIndex(season);
  const cand = [];
  const log = { espn: null, cfbd: null, supabase: null };
  let schedule = {};
  if (opts.espn !== false) {
    const payloads = opts.espnPayloads || await fetchEspn(now, opts);
    const errs = payloads.filter((p) => p.error).map((p) => p.error);
    const schema = { rejected_payloads: 0, rejected_events: 0, problems: [] };
    payloads.forEach((p) => {
      if (p.error) return;
      const v = P.validateEspnScoreboard(p, { use: 'quotes' });
      if (!v.ok) { schema.rejected_payloads++; schema.problems.push(...v.problems); return; }
      if (v.rejected.length) { schema.rejected_events += v.rejected.length; schema.problems.push(...v.rejected.slice(0, 10).map((x) => 'event ' + x.id + ': ' + x.problems.join('; '))); }
      cand.push(...quotesFromEspn({ events: v.events }, now, idx));
    });
    schedule = espnSchedule(payloads.filter((p) => !p.error));
    log.espn = { days: payloads.length, errors: errs, candidates: cand.length, schema, breaker: payloads.breaker || null };
  }
  if (opts.cfbd !== false) {
    const f = path.join(G.REPO, 'football', 'cfb_v2', 'shadow', String(season), 'lines.jsonl');
    const all = G.readJsonl(f);
    const bad = all.map((x) => P.validateCfbdLineRow(x)).map((p, i) => ({ i, p })).filter((x) => x.p.length);
    const rows = all.filter((x, i) => !bad.some((b) => b.i === i));
    const c = quotesFromCfbd(rows, idx);
    cand.push(...c); log.cfbd = { ledger_rows: all.length, candidates: c.length, schema_rejected: bad.length, schema_problems: bad.slice(0, 10).map((b) => 'row ' + (b.i + 1) + ': ' + b.p.join('; ')) };
  }
  let eventMap = store.eventMap();
  if (opts.supabaseQuotes) {
    const idxQ = opts.supabaseQuotes.map((q) => { const gi = (q.game_id && idx[q.game_id]) || {}; return baseQuote(Object.assign({}, q, { season: q.season ?? gi.season ?? season, week: q.week ?? gi.week ?? null })); });
    const mp = mapOddsEvents(idxQ, eventMap, opts.games || scheduleGames(season), now);
    if (mp.rows.length) { store.append('event_map', mp.rows, 'map_id'); eventMap = eventMap.concat(mp.rows); }
    cand.push(...idxQ);
    log.supabase = { candidates: idxQ.length, unmapped_events: mp.events, mapped_now: mp.rows.length, refused: mp.refused, refusal_reasons: mp.refusal_reasons, unresolved_names: mp.unresolved_names };
  }
  const stored = store.quotes();
  const resolved = cand.map((q) => resolveEvent(q, eventMap));
  const scr = screenCandidates(stored, resolved, { index: idx, now, sameTeam: opts.sameTeam || require('./identity.js').sameTeamFn() });
  const qd = dedupeQuarantine(store.quarantine(), scr.quarantined);
  const qres = store.append('quarantine', qd.rows, 'quarantine_id');
  const reasons = {};
  scr.quarantined.forEach((r) => r.reasons.forEach((x) => { reasons[x] = (reasons[x] || 0) + 1; }));
  log.integrity = { rule: [I.RULES.quote, I.RULES.outlier], candidates: resolved.length, accepted: scr.accepted.length,
    rejected: scr.quarantined.filter((r) => r.severity === 'REJECT').length, quarantined: scr.quarantined.filter((r) => r.severity === 'QUARANTINE').length,
    quarantine_written: qres.written, quarantine_repeats_skipped: qd.skipped, reasons };
  const sel = selectNew(stored, scr.accepted, { eventMap });
  /* an Odds API quote whose event is still unmapped is kept (keyed by its
     provider event) but cannot enter a game's market until it is mapped */
  const res = store.appendQuotes(sel.rows);
  return { log, dedupe: sel.stats, written: res.written, conflicts: res.conflicts, schedule };
}
/* The kickoff a close is anchored to (MARKET_INTEGRITY.md §7): the one ESPN
   reported when it settled the game (the result's sources), else the newest
   kickoff any LIVE snapshot was taken against, else the newest a quote
   carried. Never the FIRST snapshot's kickoff: a game that moved later would
   close too early (a stale close, written once and forever), and a game that
   moved EARLIER would take quotes observed after the real start (live odds). */
function authoritativeKickoffs(store) {
  const out = new Map();
  const put = (gid, t, basis, rank) => { if (!gid || U.ms(t) === null) return; const c = out.get(gid); if (!c || rank > c.rank) out.set(gid, { kickoff_ts: U.iso(t), basis, rank }); };
  const newest = new Map();
  for (const p of store.predictions()) if (p.origin === 'LIVE') { const c = newest.get(p.game_id); if (!c || U.ms(p.prediction_ts) > U.ms(c.prediction_ts)) newest.set(p.game_id, p); }
  newest.forEach((p, gid) => put(gid, p.kickoff_ts, 'newest LIVE snapshot', 1));
  const cur = settleCurrent(store.results());
  cur.forEach((r, gid) => { const k = (r.sources || []).map((x) => x.kickoff_ts).filter(Boolean)[0]; if (k) put(gid, k, 'result:' + (r.sources.find((x) => x.kickoff_ts) || {}).source, 2); });
  return out;
}
function settleCurrent(results) {
  const m = new Map();
  (results || []).slice().sort((a, b) => U.ms(a.recorded_at) - U.ms(b.recorded_at)).forEach((r) => m.set(r.game_id, r));
  return m;
}
/* Openers and closes are derived once, and only for a game with a settled
   state (FINAL, POSTPONED, CANCELED or NO_CONTEST): the result is the evidence
   that the game's real kickoff has passed. */
function lines(season, now, opts) {
  opts = opts || {};
  const store = new G.Store(season, opts.storeOpts);
  const auth = authoritativeKickoffs(store);
  const settled = settleCurrent(store.results());
  /* every game with a LIVE prediction gets its lines, quotes or not */
  const games = [];
  const seen = new Set();
  for (const p of store.predictions()) if (p.origin === 'LIVE' && !seen.has(p.game_id)) { seen.add(p.game_id); games.push({ game_id: p.game_id, kickoff_ts: (auth.get(p.game_id) || {}).kickoff_ts || p.kickoff_ts }); }
  const gate = (gid) => settled.has(gid);
  const quotes = store.quotes().filter((q) => !q.game_id || gate(q.game_id));
  /* a quoted game without a LIVE prediction is anchored the same way */
  quotes.forEach((q) => { if (q.game_id && !seen.has(q.game_id) && auth.has(q.game_id)) { seen.add(q.game_id); games.push({ game_id: q.game_id, kickoff_ts: auth.get(q.game_id).kickoff_ts }); } });
  const rows = deriveLines(quotes, store.lines(), now, games.filter((g) => gate(g.game_id)));
  const res = store.append('lines', rows, 'line_id');
  return { derived: rows.length, written: res.written, conflicts: res.conflicts, waiting_for_result: games.filter((g) => !gate(g.game_id) && L.closeDue(g.kickoff_ts, now)).length };
}

/* An audited correction to a derived OPEN or CLOSE line (MARKET_INTEGRITY.md
   §6). The original line is never edited, replaced or removed, and grading
   keeps using it; the correction is a separate record ("opener corrected
   version") with the values, the reason and the actor, for a person to act on. */
function correctLine(season, o, opts) {
  const store = new G.Store(season, opts && opts.storeOpts);
  if (!o || !o.line_id) throw new Error('correction needs line_id');
  if (!o.reason || String(o.reason).trim().length < 10) throw new Error('correction needs a reason (10+ characters)');
  if (!o.actor || !/^[a-z0-9_.@-]{2,64}$/i.test(String(o.actor))) throw new Error('correction needs an actor');
  const orig = store.lines().find((l) => l.line_id === o.line_id);
  if (!orig) throw new Error('no line ' + o.line_id);
  const hl = o.home_line == null ? null : I.num(o.home_line), tp = o.total_points == null ? null : I.num(o.total_points);
  if (orig.market_type === 'spread' && (hl === null || Math.abs(hl) > I.BOUNDS.SPREAD_ABS_MAX)) throw new Error('corrected spread must be a number within +/-' + I.BOUNDS.SPREAD_ABS_MAX);
  if (orig.market_type === 'total' && (tp === null || tp < I.BOUNDS.TOTAL_MIN || tp > I.BOUNDS.TOTAL_MAX)) throw new Error('corrected total out of bounds');
  const prior = store.marketCorrections().filter((c) => c.line_id === o.line_id);
  const row = { correction_id: null, line_id: orig.line_id, game_id: orig.game_id, kind: orig.kind, book: orig.book, market_type: orig.market_type,
    version: prior.length + 1, original: { home_line: orig.home_line, total_points: orig.total_points, price_home: orig.price_home, price_away: orig.price_away, quality: orig.quality },
    corrected: { home_line: hl, total_points: tp, price_home: o.price_home == null ? null : I.num(o.price_home), price_away: o.price_away == null ? null : I.num(o.price_away) },
    reason: String(o.reason), actor: String(o.actor), created_at: U.iso(o.now || new Date()) };
  row.correction_id = G.ids.correction(row);
  const res = store.append('market_corrections', [row], 'correction_id');
  return { row, written: res.written };
}

module.exports = { mapOddsEvents, scheduleGames, resolveEvent, bookKey, american, baseQuote, espnMarkets, quotesFromEspn, quotesFromCfbd, selectNew, deriveLines, gameIndex, fetchEspn, capture, lines,
  screenCandidates, dedupeQuarantine, espnSchedule, authoritativeKickoffs, correctLine };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const season = Number(arg('--season', new Date().getUTCFullYear()));
  const now = arg('--now', new Date().toISOString());
  (async () => {
    if (a[0] === 'capture') console.log(JSON.stringify(await capture(season, now, { espn: !a.includes('--no-espn'), cfbd: !a.includes('--no-cfbd') })));
    else if (a[0] === 'lines') console.log(JSON.stringify(lines(season, now)));
    else console.log('usage: market.js capture|lines [--season S] [--now ISO]');
  })().catch((e) => { console.error(e); process.exit(1); });
}
