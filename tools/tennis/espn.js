#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the ESPN adapter.

   ESPN's public, keyless site API is the same feed family this repository
   already trusts for football schedules, rosters and finals
   (tools/collective/sync_schedule.js, football/rosters/fetch_rosters.js) and
   for the UFC Live Fight Center. Nothing here logs in, pays, or bypasses
   anything; a field the feed does not carry is left null and named in the
   diagnostics, never invented.

   THE REQUEST SHAPE. The UFC adapter learned this the hard way in production:
   ESPN's edge answered 403 to a date RANGE carrying a custom User-Agent, while
   the plain single-day request the football jobs make was answered from the
   same runners. So this sends the plain request from the start — accept: json,
   follow redirects, no custom User-Agent — and discovery tries a day, then a
   range, then the plain scoreboard, recording which shape answered.

   THE FEED IS NOT A CONTRACT. ESPN files tennis matches in two different
   places depending on the endpoint and the week: directly under
   `events[].competitions[]`, and nested under `events[].groupings[].competitions[]`
   (the draw's mens-singles / womens-doubles buckets). Both are walked. Every
   read is guarded: an event with no competitions, a competition with one
   competitor, a status with no type, and statistics in any of the shapes ESPN
   has used all parse to what they contain and no more. Keys the normaliser
   does not recognise are collected in `unmapped` so an operator can extend
   STAT_ALIASES with evidence instead of guessing.

   DOUBLES. A competitor with a roster of two athletes, or a display name
   carrying a slash, is a PAIR. It is parsed, kept whole, marked is_doubles,
   and never split into a player — the pair is the side.
   =========================================================================== */
'use strict';

const R = require('../../lib/tennis_research.js');

const ESPN_API = (process.env.ESPN_API || 'https://site.api.espn.com').replace(/\/$/, '');
const ESPN_WEB_API = (process.env.ESPN_WEB_API || 'https://site.web.api.espn.com').replace(/\/$/, '');

const TOURS = ['atp', 'wta'];
const TOUR_LABEL = { atp: 'ATP', wta: 'WTA' };

function ymd(d) { return new Date(d).toISOString().slice(0, 10).replace(/-/g, ''); }

function scoreboardDayUrl(tour, dayMs) {
  return `${ESPN_API}/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${ymd(dayMs)}&limit=900`;
}
function scoreboardRangeUrl(tour, fromMs, toMs) {
  return `${ESPN_API}/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${ymd(fromMs)}-${ymd(toMs)}&limit=900`;
}
function scoreboardPlainUrl(tour) {
  return `${ESPN_API}/apis/site/v2/sports/tennis/${tour}/scoreboard?limit=900`;
}
function summaryUrl(tour, providerEventId) {
  return `${ESPN_WEB_API}/apis/site/v2/sports/tennis/${tour}/summary?event=${encodeURIComponent(providerEventId)}`;
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const f = fetchImpl || ((...a) => fetch(...a));
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 15000) : null;
  const t0 = Date.now();
  try {
    const res = await f(url, { headers: { accept: 'application/json' }, redirect: 'follow', signal: ctl ? ctl.signal : undefined });
    const text = await res.text();
    const latency = Date.now() - t0;
    if (!res.ok) { const e = new Error(`${res.status} from ${url.split('?')[0]}`); e.status = res.status; e.latency = latency; throw e; }
    return { json: text ? JSON.parse(text) : null, latency };
  } finally { if (timer) clearTimeout(timer); }
}

/* ---- small readers -------------------------------------------------------- */
function str(v) { return v == null ? null : String(v); }
function numOrNull(v) { const n = Number(v); return (v == null || v === '' || !isFinite(n)) ? null : n; }
function intOrNull(v) { const n = Number(v); return (v == null || v === '' || !isFinite(n)) ? null : Math.round(n); }

function statusOf(st) {
  st = st || {};
  const type = st.type || {};
  const name = String(type.name || '').toUpperCase();
  const state = String(type.state || '').toLowerCase();
  const detail = str(type.detail || type.shortDetail || type.description || null);
  let status = 'unknown', resultType = null;
  if (/CANCEL/.test(name)) status = 'cancelled';
  else if (/POSTPONE|SUSPEND|DELAY/.test(name)) status = 'postponed';
  else if (/WALKOVER/.test(name) || /walkover/i.test(detail || '')) { status = 'walkover'; resultType = 'walkover'; }
  else if (state === 'pre') status = 'scheduled';
  else if (state === 'in') status = 'live';
  else if (state === 'post') status = 'final';
  if (status === 'final') {
    const blob = `${name} ${detail || ''} ${type.description || ''}`;
    if (/RETIRE|\bRET\b/i.test(blob)) resultType = 'retirement';
    else if (/WALKOVER|\bW\/?O\b/i.test(blob)) { resultType = 'walkover'; status = 'walkover'; }
    else if (/DEFAULT|\bDEF\b/i.test(blob)) resultType = 'default';
    else if (/ABANDON/i.test(blob)) resultType = 'abandoned';
    else resultType = 'completed';
  }
  return { status, state, name, detail, completed: !!type.completed, period: intOrNull(st.period), resultType };
}

/* A competitor -> one side. Doubles is a roster of two (or a slashed name). */
function sideOf(c) {
  if (!c) return null;
  const roster = Array.isArray(c.roster) ? c.roster : (Array.isArray(c.athletes) ? c.athletes : null);
  let name = null, providerId = null, doubles = false;
  if (roster && roster.length > 1) {
    doubles = true;
    name = roster.map(a => str((a && (a.athlete ? (a.athlete.displayName || a.athlete.fullName || a.athlete.shortName) : (a.displayName || a.fullName || a.shortName))) || '')).filter(Boolean).join('/');
    providerId = roster.map(a => str((a && (a.athlete ? a.athlete.id : a.id)) || '')).filter(Boolean).join('/') || null;
  } else {
    const a = (roster && roster.length === 1 ? (roster[0].athlete || roster[0]) : null) || c.athlete || c.team || {};
    name = str(a.displayName || a.fullName || a.shortName || a.name || c.displayName || c.name || null);
    providerId = str(a.id != null ? a.id : (c.id != null ? c.id : null));
    if (name && R.isDoublesName(name)) doubles = true;
  }
  if (!name) return null;
  const line = Array.isArray(c.linescores) ? c.linescores : [];
  return {
    name, providerId, doubles,
    order: numOrNull(c.order),
    winner: c.winner === true,
    seed: str(c.seed != null ? c.seed : (c.curatedRank && c.curatedRank.current) || null),
    rank: intOrNull(c.rank != null ? c.rank : ((c.athlete && (c.athlete.rank != null ? c.athlete.rank : (c.athlete.ranking != null ? c.athlete.ranking : null))) || null)),
    linescores: line.map(l => ({ value: intOrNull(l && (l.value != null ? l.value : l.displayValue)), tiebreak: intOrNull(l && (l.tiebreak != null ? l.tiebreak : l.tiebreakScore)) })),
    serving: c.possession === true || c.serving === true || c.isServing === true,
    statistics: c.statistics || (c.stats ? { stats: c.stats } : null)
  };
}

function roundOf(c) {
  const notes = Array.isArray(c.notes) ? c.notes : [];
  for (const n of notes) {
    const h = str(n && (n.headline || n.text));
    if (h) return h.replace(/^.*?-\s*/, '').trim() || h.trim();
  }
  const cands = [c.round && (c.round.displayName || c.round.text || c.round.name), c.type && c.type.text, c.headline];
  for (const x of cands) if (x && typeof x === 'string' && x.trim()) return x.trim();
  return null;
}
function groupingLabel(g) {
  if (!g) return null;
  const s = g.grouping || g;
  return str((s && (s.shortName || s.name || s.displayName || s.slug)) || null);
}
/* WHICH TOUR A MATCH BELONGS TO, from the draw bucket it is filed under.
   A runner showed why this matters: ESPN's atp scoreboard and its wta
   scoreboard both return the US Open as the SAME event id carrying the SAME
   478 competitions — men's singles, women's singles, every doubles draw. The
   tour that answered is therefore not the tour a match is played on, and
   trusting it would file every women's match as ATP (and let two pollers
   write the same rows).

   MIXED is real (mixed doubles) and is kept as itself. A label the classifier
   does not recognise falls back to the tour that answered and is reported, so
   an operator extends this with evidence rather than a guess. */
function tourOfGrouping(label, feedTour) {
  const s = String(label == null ? '' : label).toLowerCase();
  if (/mixed/.test(s)) return 'MIXED';
  if (/\bwomen|\bwta\b|ladies|girls/.test(s)) return 'WTA';
  if (/\bmen|\batp\b|boys/.test(s)) return 'ATP';
  return TOUR_LABEL[feedTour] || 'OTHER';
}

/* Which tour's poller owns a match, so exactly one runner writes each row.
   A mixed-doubles match belongs to no single tour, so one is named as its
   owner by convention: the first tour in TOURS. Stated rather than emergent. */
function ownerTour(matchTour) {
  const t = String(matchTour || '').toUpperCase();
  if (t === 'ATP' || t === 'WTA') return t;
  return TOUR_LABEL[TOURS[0]];
}

function bestOfFrom(c, tour) {
  const n = intOrNull(c && c.format && c.format.sets && (c.format.sets.count != null ? c.format.sets.count : c.format.sets.value));
  if (n === 3 || n === 5) return n;
  return null;
}

/* One competition -> one match. */
function parseMatch(c, ev, groupLabel, idx, feedTour) {
  if (!c || !Array.isArray(c.competitors) || c.competitors.length < 2) return null;
  const comps = c.competitors.slice().sort((a, b) => (numOrNull(a.order) || 99) - (numOrNull(b.order) || 99));
  const home = sideOf(comps[0]), away = sideOf(comps[1]);
  if (!home || !away) return null;
  const st = statusOf(c.status);
  const doubles = !!(home.doubles || away.doubles) || /doubles/i.test(String(groupLabel || ''));
  const sets = [];
  const n = Math.max(home.linescores.length, away.linescores.length);
  for (let i = 0; i < n; i++) {
    sets.push({ home: home.linescores[i] ? home.linescores[i].value : null,
                away: away.linescores[i] ? away.linescores[i].value : null,
                home_tb: home.linescores[i] ? home.linescores[i].tiebreak : null,
                away_tb: away.linescores[i] ? away.linescores[i].tiebreak : null });
  }
  const m = {
    provider_match_id: str(c.id),
    provider_tournament_id: str(ev.id),
    round: roundOf(c) || (groupLabel || null),
    grouping: groupLabel || null,
    tour: tourOfGrouping(groupLabel, feedTour),
    tour_source: /mixed|women|wta|men|atp|ladies|boys|girls/i.test(String(groupLabel || '')) ? 'grouping' : 'feed',
    is_doubles: doubles,
    best_of: bestOfFrom(c),
    court: str((c.venue && (c.venue.fullName || c.venue.name)) || c.court || null),
    scheduled_at: str(c.date || ev.date || null),
    match_order: idx + 1,
    home_provider_id: home.providerId, away_provider_id: away.providerId,
    home_name: home.name, away_name: away.name,
    home_seed: home.seed, away_seed: away.seed,
    home_rank: home.rank, away_rank: away.rank,
    status: st.status, status_detail: st.detail,
    current_set: st.period != null && st.period >= 1 ? st.period : (sets.length || null),
    set_scores: sets,
    server_side: home.serving ? 'home' : (away.serving ? 'away' : null),
    winner_side: null, result_type: st.resultType, result_detail: st.detail,
    inline_stats: { home: home.statistics || null, away: away.statistics || null }
  };
  const sw = R.setsWon({ set_scores: sets });
  m.sets_home = sw.home; m.sets_away = sw.away;
  const last = sets.length ? sets[sets.length - 1] : null;
  m.games_home = last ? last.home : null;
  m.games_away = last ? last.away : null;
  if (st.status === 'final' || st.status === 'walkover') {
    if (home.winner) m.winner_side = 'home';
    else if (away.winner) m.winner_side = 'away';
  }
  return m;
}

/* One event -> a tournament plus its matches. */
function parseTournament(ev, tour) {
  if (!ev || ev.id == null) return null;
  let comps = [];
  const groups = [];
  if (Array.isArray(ev.competitions)) comps = comps.concat(ev.competitions.map(c => ({ c, g: null })));
  if (Array.isArray(ev.groupings)) {
    ev.groupings.forEach(g => {
      const label = groupingLabel(g);
      groups.push(label);
      (Array.isArray(g.competitions) ? g.competitions : []).forEach(c => comps.push({ c, g: label }));
    });
  }
  const venue = (ev.venue) || (comps[0] && comps[0].c && comps[0].c.venue) || {};
  const addr = venue.address || ev.address || {};
  const matches = comps.map((x, i) => parseMatch(x.c, ev, x.g, i, tour)).filter(Boolean);
  const anyLive = matches.some(m => m.status === 'live');
  const allDone = matches.length > 0 && matches.every(m => ['final', 'walkover', 'cancelled'].includes(m.status));
  let state = 'scheduled';
  if (anyLive) state = 'live';
  else if (allDone) state = 'final';
  const season = ev.season || {};
  /* A combined event (a slam) carries both draws. Its own tour is what its
     matches say, not what answered: two draws means MIXED. */
  const tours = {};
  matches.forEach(m => { if (m.tour === 'ATP' || m.tour === 'WTA') tours[m.tour] = true; });
  const seen = Object.keys(tours);
  const eventTour = seen.length > 1 ? 'MIXED' : (seen[0] || TOUR_LABEL[tour] || 'OTHER');
  return {
    provider_tournament_id: str(ev.id),
    tour: eventTour,
    feed_tour: TOUR_LABEL[tour] || 'OTHER',
    name: str(ev.name || ev.shortName),
    short_name: str(ev.shortName),
    level: str((ev.tournament && (ev.tournament.level || ev.tournament.type)) || (season.slug) || null),
    surface: R.normSurface(ev.surface || (ev.tournament && ev.tournament.surface) || (ev.groupings && ev.groupings[0] && ev.groupings[0].surface) || null),
    venue: str(venue.fullName || venue.name || null),
    city: str(addr.city || null),
    country: str(addr.country || null),
    start_date: dateOnly(ev.date || (ev.season && ev.season.startDate)),
    end_date: dateOnly(ev.endDate || (ev.season && ev.season.endDate)),
    draw_size: intOrNull(ev.drawSize || (ev.tournament && ev.tournament.drawSize)),
    state,
    groupings: groups.filter(Boolean),
    matches
  };
}
function dateOnly(v) { if (!v) return null; const t = Date.parse(v); return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; }

function parseScoreboard(json, tour) {
  if (!json) return [];
  const list = Array.isArray(json.events) ? json.events : (json.id != null ? [json] : []);
  return list.map(e => parseTournament(e, tour)).filter(Boolean);
}

/* ---- statistics ----------------------------------------------------------- */

/* Source key -> canonical column. Keys are compared with everything but
   letters and digits removed, lowercased. A key mapped to a composite base
   ("first_serve_points") carries "31/44" in its displayValue. */
const STAT_ALIASES = {
  aces: 'aces', ace: 'aces', totalaces: 'aces',
  doublefaults: 'double_faults', doublefault: 'double_faults', df: 'double_faults',
  firstservepercentage: 'first_serve_pct_only', firstservepct: 'first_serve_pct_only', firstserve: 'first_serves',
  firstservesin: 'first_serves_in', firstservein: 'first_serves_in', firstservemade: 'first_serves_in',
  firstservesattempted: 'first_serves_total', firstservetotal: 'first_serves_total', firstservesplayed: 'first_serves_total',
  firstservestotal: 'first_serves_total', firstservesattempts: 'first_serves_total',
  firstservepointswon: 'first_serve_points_won', firstservewon: 'first_serve_points_won', winningpctonfirstserve: 'first_serve_points_pct_only',
  firstservepointsplayed: 'first_serve_points_total', firstservepointstotal: 'first_serve_points_total', firstservepoints: 'first_serve_points',
  secondservepointswon: 'second_serve_points_won', secondservewon: 'second_serve_points_won', winningpctonsecondserve: 'second_serve_points_pct_only',
  secondservepointsplayed: 'second_serve_points_total', secondservepointstotal: 'second_serve_points_total', secondservepoints: 'second_serve_points',
  secondservesin: 'second_serves_in', secondservetotal: 'second_serves_total',
  servicegamesplayed: 'service_games_played', servicegames: 'service_games_played', gamesserved: 'service_games_played',
  servicegameswon: 'service_games_won', serviceholds: 'service_games_won', holds: 'service_games_won',
  servicepointswon: 'service_points_won', servicepointsplayed: 'service_points_total', servicepointstotal: 'service_points_total',
  servicepoints: 'service_points',
  breakpointsfaced: 'break_points_faced', breakpointfaced: 'break_points_faced',
  breakpointssaved: 'break_points_saved', breakpointsaved: 'break_points_saved',
  breakpointswon: 'break_points_won', breakpointsconverted: 'break_points_won', breaks: 'break_points_won',
  breakpointschances: 'break_points_total', breakpointopportunities: 'break_points_total', breakpointstotal: 'break_points_total',
  breakpoints: 'break_points', breakpointconversion: 'break_points',
  returngamesplayed: 'return_games_played', returngameswon: 'return_games_won',
  returnpointswon: 'return_points_won', returnpointsplayed: 'return_points_total', returnpointstotal: 'return_points_total',
  returnpoints: 'return_points',
  totalpointswon: 'total_points_won', pointswon: 'total_points_won', totalpoints: 'total_points',
  winners: 'winners', totalwinners: 'winners',
  unforcederrors: 'unforced_errors', unforcederror: 'unforced_errors',
  forcederrors: 'forced_errors',
  netpointswon: 'net_points_won', netpointsplayed: 'net_points_total', netpoints: 'net_points',
  fastestserve: 'max_serve_speed_kph', maxspeed: 'max_serve_speed_kph', fastestservespeed: 'max_serve_speed_kph',
  averagefirstservespeed: 'avg_first_serve_speed_kph', avgfirstservespeed: 'avg_first_serve_speed_kph',
  averagesecondservespeed: 'avg_second_serve_speed_kph', avgsecondservespeed: 'avg_second_serve_speed_kph',
  tiebreakswon: 'tiebreaks_won', tiebreaksplayed: 'tiebreaks_played'
};
/* keys legitimately in the feed and legitimately not stored */
const STAT_IGNORE = new Set(['gameswon', 'setswon', 'points', 'winpercentage', 'servicepointswonpct', 'returnpointswonpct',
  'totalservicepointswonpct', 'breakpointconversionpct', 'firstservereturnpointswon', 'secondservereturnpointswon',
  'receivingpointswonpct', 'winnerserrorratio', 'timeoncourt', 'duration', 'rank', 'seed']);

/* the columns tennis.match_live_state actually holds */
const STAT_FIELDS = ['aces', 'double_faults', 'first_serves_in', 'first_serves_total', 'first_serve_points_won',
  'first_serve_points_total', 'second_serve_points_won', 'second_serve_points_total', 'service_games_played',
  'service_games_won', 'service_points_won', 'service_points_total', 'break_points_faced', 'break_points_saved',
  'return_games_played', 'return_games_won', 'return_points_won', 'return_points_total', 'break_points_won',
  'break_points_total', 'total_points_won', 'winners', 'unforced_errors', 'forced_errors', 'net_points_won',
  'net_points_total', 'max_serve_speed_kph', 'avg_first_serve_speed_kph', 'avg_second_serve_speed_kph',
  'tiebreaks_won', 'tiebreaks_played'];

/* composite bases: "31/44" means won/total */
const COMPOSITE = {
  first_serve_points: ['first_serve_points_won', 'first_serve_points_total'],
  second_serve_points: ['second_serve_points_won', 'second_serve_points_total'],
  service_points: ['service_points_won', 'service_points_total'],
  return_points: ['return_points_won', 'return_points_total'],
  break_points: ['break_points_won', 'break_points_total'],
  net_points: ['net_points_won', 'net_points_total'],
  total_points: ['total_points_won', null],
  first_serves: ['first_serves_in', 'first_serves_total'],
  second_serves: ['second_serves_in', 'second_serves_total']
};

function keyOf(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

/* A node that names a period ("period": 2) or calls itself "Set 2" is a
   PER-SET SPLIT, not the match total. ESPN nests both under the same
   `splits` / `statistics` keys, so a flattener that followed everything would
   let the last set's counters overwrite the match's — the second set's 3 of 4
   holds silently replacing the match's 10 of 12. setSplits() reads these
   nodes deliberately; the totals reader steps over them. */
function isPeriodSplit(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const p = Number(node.period);
  if (node.period != null && isFinite(p) && p >= 1) return true;
  const label = String(node.name || node.displayName || node.abbreviation || '').trim();
  return /^set\s*\d+$/i.test(label);
}

function flattenStats(raw, out, path, depth) {
  out = out || []; depth = depth || 0;
  if (raw == null) return out;
  if (Array.isArray(raw)) { raw.forEach(x => flattenStats(x, out, path, depth)); return out; }
  if (typeof raw !== 'object') return out;
  if (depth > 0 && isPeriodSplit(raw)) return out;
  if (raw.name != null && (raw.value != null || raw.displayValue != null) && !Array.isArray(raw.stats)) {
    out.push({ key: raw.name, value: raw.value, display: raw.displayValue, abbr: raw.abbreviation, category: path || null });
    return out;
  }
  if (Array.isArray(raw.stats)) raw.stats.forEach(x => flattenStats(x, out, raw.name || path, depth + 1));
  if (Array.isArray(raw.categories)) raw.categories.forEach(x => flattenStats(x, out, x.name || path, depth + 1));
  if (raw.splits) flattenStats(raw.splits, out, path, depth + 1);
  if (Array.isArray(raw.statistics)) flattenStats(raw.statistics, out, path, depth + 1);
  if (Array.isArray(raw.athletes)) flattenStats(raw.athletes, out, path, depth + 1);
  return out;
}

/* Raw statistics -> canonical fields. Returns {stats, unmapped, mapped}. */
function normalizeStats(raw) {
  const stats = {}; const unmapped = {}; let mapped = 0;
  const pctOnly = {};
  flattenStats(raw).forEach(item => {
    const k = keyOf(item.key);
    if (!k || STAT_IGNORE.has(k)) return;
    let canon = STAT_ALIASES[k];
    if (!canon && item.abbr) canon = STAT_ALIASES[keyOf(item.abbr)];
    if (!canon) { unmapped[k] = (unmapped[k] || 0) + 1; return; }
    const disp = item.display != null ? String(item.display) : null;
    /* a percentage with no counts behind it is remembered but not stored as a
       count: the schema holds counts, and a share is derivable from them */
    if (/_pct_only$/.test(canon)) { const v = pctFrom(disp != null ? disp : item.value); if (v != null) pctOnly[canon] = v; return; }
    const composite = disp && /^\s*\d+\s*\/\s*\d+\s*$/.test(disp) ? disp.split('/').map(x => intOrNull(x.trim())) : null;
    if (COMPOSITE[canon]) {
      const [wonKey, totalKey] = COMPOSITE[canon];
      if (composite) { stats[wonKey] = composite[0]; if (totalKey) stats[totalKey] = composite[1]; mapped++; }
      else { const v = intOrNull(item.value != null ? item.value : disp); if (v != null) { stats[wonKey] = v; mapped++; } }
      return;
    }
    if (composite && /_won$|_in$|_faced$|_saved$/.test(canon)) {
      stats[canon] = composite[0];
      const totalKey = canon.replace(/_won$/, '_total').replace(/_in$/, '_total').replace(/_faced$/, '_total').replace(/_saved$/, '_faced');
      if (STAT_FIELDS.includes(totalKey) && stats[totalKey] == null) stats[totalKey] = composite[1];
      mapped++;
      return;
    }
    const v = intOrNull(item.value != null ? item.value : disp);
    if (v != null) { stats[canon] = v; mapped++; }
  });
  /* derive a count from a percentage ONLY when its own denominator is stored */
  if (pctOnly.first_serve_pct_only != null && stats.first_serves_total != null && stats.first_serves_in == null) {
    stats.first_serves_in = Math.round(pctOnly.first_serve_pct_only * stats.first_serves_total);
    mapped++;
  }
  const clean = {};
  STAT_FIELDS.forEach(f => { clean[f] = stats[f] != null ? stats[f] : null; });
  return { stats: clean, unmapped, mapped, pctOnly };
}
function pctFrom(v) {
  if (v == null) return null;
  const s = String(v).replace('%', '').trim();
  const n = Number(s);
  if (!isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

/* Per-set splits when the payload carries them. */
function setSplits(raw) {
  const out = {};
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const label = String(node.name || node.displayName || node.abbreviation || '');
    const m = /^set\s*(\d)$/i.exec(label.trim());
    const period = node.period != null ? intOrNull(node.period) : (m ? intOrNull(m[1]) : null);
    if (period != null && period >= 1 && (Array.isArray(node.stats) || Array.isArray(node.categories) || Array.isArray(node.statistics))) {
      const n = normalizeStats(node);
      if (n.mapped) out[period] = n.stats;
      return;
    }
    Object.keys(node).forEach(k => { if (k !== 'stats' && typeof node[k] === 'object') visit(node[k]); });
  }
  visit(raw);
  return out;
}

/* ---- players: the provider's own directory -------------------------------- */

/* The athlete endpoints, tried in order. ESPN has moved tennis athletes between
   its site and web APIs before, so both shapes are attempted and whichever
   answers is recorded on the row. A player the feed will not describe keeps the
   id and name the scoreboard already gave, and every other column stays null. */
function athleteUrls(tour, athleteId) {
  const id = encodeURIComponent(String(athleteId));
  return [
    { via: 'web-v3', url: `${ESPN_WEB_API}/apis/common/v3/sports/tennis/${tour}/athletes/${id}` },
    { via: 'site-v2', url: `${ESPN_API}/apis/site/v2/sports/tennis/${tour}/athletes/${id}` }
  ];
}
function rankingsUrls(tour) {
  return [
    { via: 'site-v2', url: `${ESPN_API}/apis/site/v2/sports/tennis/${tour}/rankings` },
    { via: 'web-v2', url: `${ESPN_WEB_API}/apis/site/v2/sports/tennis/${tour}/rankings` }
  ];
}

/* Find the first value under any of these keys, anywhere in the document. The
   athlete payload nests differently between the two APIs, so a walk beats a
   fixed path — but it stops at the first hit and never guesses a type. */
function dig(node, keys, depth) {
  depth = depth == null ? 0 : depth;
  if (!node || typeof node !== 'object' || depth > 6) return undefined;
  for (const k of keys) if (node[k] != null && typeof node[k] !== 'object') return node[k];
  for (const k of keys) if (node[k] != null && typeof node[k] === 'object') {
    const v = node[k].displayValue != null ? node[k].displayValue : (node[k].name != null ? node[k].name : undefined);
    if (v != null && typeof v !== 'object') return v;
  }
  const kids = Array.isArray(node) ? node : Object.keys(node).map(k => node[k]);
  for (const kid of kids) {
    if (kid && typeof kid === 'object') {
      const v = dig(kid, keys, depth + 1);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/* HEIGHT. ESPN publishes it as a display string ("6' 2\"") in some shapes and a
   bare number in others, and the number's unit is not stated. Rather than
   assume, the value is only converted when it falls in a range that can only be
   one unit: 120-230 is centimetres, 48-90 is inches. Anything else is left null
   rather than stored wrong. */
function heightCm(display, raw) {
  const d = display == null ? '' : String(display);
  const fi = /^\s*(\d)\s*'\s*(\d{1,2})?\s*"?\s*$/.exec(d);
  if (fi) {
    const inches = (+fi[1]) * 12 + (fi[2] ? +fi[2] : 0);
    return Math.round(inches * 2.54);
  }
  const cm = /^\s*(\d{2,3})\s*cm\s*$/i.exec(d);
  if (cm) return +cm[1];
  const n = Number(raw != null ? raw : d);
  if (!isFinite(n) || n <= 0) return null;
  if (n >= 120 && n <= 230) return Math.round(n);
  if (n >= 48 && n <= 90) return Math.round(n * 2.54);
  return null;
}

function dateOnlyOrNull(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/* One athlete document -> the columns the directory holds. Everything is
   optional: the caller already has a usable row without any of it. */
function parseAthlete(json) {
  if (!json || typeof json !== 'object') return null;
  const a = json.athlete && typeof json.athlete === 'object' ? json.athlete : json;
  const out = {
    full_name: str(dig(a, ['fullName', 'displayName', 'name'])) || null,
    display_name: str(dig(a, ['displayName'])) || null,
    short_name: str(dig(a, ['shortName'])) || null,
    country: str(dig(a, ['citizenship', 'country'])) || null,
    country_code: str(dig(a, ['countryCode', 'abbreviation'])) || null,
    plays: str(dig(a, ['hand', 'plays', 'playingHand'])) || null,
    height_cm: heightCm(dig(a, ['displayHeight']), dig(a, ['height'])),
    weight_kg: null,
    birth_date: dateOnlyOrNull(dig(a, ['dateOfBirth', 'birthDate', 'dob'])),
    turned_pro: intOrNull(dig(a, ['turnedPro', 'proYear', 'debutYear']))
  };
  const w = Number(dig(a, ['weight']));
  if (isFinite(w) && w > 0) out.weight_kg = (w >= 40 && w <= 160) ? Math.round(w) : (w >= 90 && w <= 350 ? Math.round(w * 0.453592) : null);
  const any = Object.keys(out).some(k => out[k] != null);
  return any ? out : null;
}

/* A rankings document -> [{provider_athlete_id, rank, points, as_of}]. */
function parseRankings(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  const asOf = dateOnlyOrNull(dig(json, ['lastUpdated', 'asOf', 'date']));
  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) { node.forEach(x => walk(x, depth + 1)); return; }
    const ath = node.athlete || node.competitor;
    const rank = node.current != null ? node.current : (node.rank != null ? node.rank : null);
    if (ath && ath.id != null && rank != null && isFinite(Number(rank))) {
      out.push({ provider_athlete_id: String(ath.id),
        full_name: str(ath.displayName || ath.fullName || ath.name) || null,
        rank: intOrNull(rank),
        points: intOrNull(node.points != null ? node.points : node.statistics && node.statistics.points),
        as_of: asOf });
      return;
    }
    Object.keys(node).forEach(k => walk(node[k], depth + 1));
  })(json, 0);
  const seen = {}, uniq = [];
  out.forEach(r => { if (!seen[r.provider_athlete_id]) { seen[r.provider_athlete_id] = true; uniq.push(r); } });
  return uniq;
}

/* ---- discovery ------------------------------------------------------------ */
function inWindow(t, fromMs, toMs) {
  const d = t && t.start_date ? Date.parse(t.start_date) : NaN;
  if (!isFinite(d)) return true;              /* an undated tournament is kept, never silently dropped */
  return d >= fromMs - 21 * 86400000 && d <= toMs + 86400000;
}
/* THE SHAPE THAT ANSWERS THE QUESTION BEING ASKED. A runner measured all
   three against the live feed: for one tour, `day` returned 1 tournament and
   `range` returned 5 over the same window, with `plain` matching `day`. The
   sync asks about a WINDOW, so it asks for the range first and falls back to
   the narrower shapes; the poller asks about TODAY and has its own day()
   request. Whichever shape answered is recorded either way. */
function discoveryAttempts(tour, fromMs, toMs) {
  return [
    { via: 'range', url: scoreboardRangeUrl(tour, fromMs, toMs) },
    { via: 'day', url: scoreboardDayUrl(tour, Date.now()) },
    { via: 'plain', url: scoreboardPlainUrl(tour) }
  ];
}

/* THE SAME EVENT, ANSWERED TWICE. A runner showed the US Open coming back
   from both the atp and the wta scoreboard as provider id 189-2026 with the
   same 478 competitions. Two rows would collide on the same primary key and
   flip the tournament's tour on every run, so the two answers are merged into
   one: matches unioned by their own provider id, and the tour set to what the
   merged draw actually contains. */
function mergeTournaments(list) {
  const by = {}, order = [];
  (list || []).forEach(t => {
    if (!t) return;
    const k = String(t.provider_tournament_id);
    const prev = by[k];
    if (!prev) { by[k] = t; order.push(k); return; }
    const seen = {};
    prev.matches.forEach(m => { seen[String(m.provider_match_id)] = true; });
    t.matches.forEach(m => { if (!seen[String(m.provider_match_id)]) { prev.matches.push(m); seen[String(m.provider_match_id)] = true; } });
    const tours = {};
    prev.matches.forEach(m => { if (m.tour === 'ATP' || m.tour === 'WTA') tours[m.tour] = true; });
    const kinds = Object.keys(tours);
    prev.tour = kinds.length > 1 ? 'MIXED' : (kinds[0] || prev.tour);
    prev.feed_tour = [prev.feed_tour, t.feed_tour].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join('+');
    prev.groupings = (prev.groupings || []).concat(t.groupings || []).filter((x, i, a) => a.indexOf(x) === i);
    if (t.state === 'live') prev.state = 'live';
    ['surface', 'venue', 'city', 'country', 'level', 'draw_size', 'end_date'].forEach(f => { if (prev[f] == null && t[f] != null) prev[f] = t[f]; });
  });
  return order.map(k => by[k]);
}

function source(opts) {
  opts = opts || {};
  const fetchImpl = opts.fetchImpl || null;
  const timeoutMs = opts.timeoutMs || 15000;
  return {
    TOURS,
    urls: { scoreboardDayUrl, scoreboardRangeUrl, scoreboardPlainUrl, summaryUrl },
    /* Every tournament on one tour. Tries the day, then the range, then the
       plain scoreboard; whichever answers is used and named in `via`. */
    async scoreboard(tour, fromMs, toMs) {
      const tried = [];
      for (const a of discoveryAttempts(tour, fromMs, toMs)) {
        try {
          const r = await fetchJson(a.url, fetchImpl, timeoutMs);
          const all = parseScoreboard(r.json, tour);
          tried.push({ via: a.via, status: 200, tournaments: all.length });
          return { tournaments: all.filter(t => inWindow(t, fromMs, toMs)), latency: r.latency, via: a.via, tried, totalSeen: all.length };
        } catch (e) {
          tried.push({ via: a.via, status: (e && e.status) || null, error: String(e && e.message || e).slice(0, 120) });
        }
      }
      const err = new Error(`every ${tour} discovery request failed: ` + tried.map(t => `${t.via} -> ${t.status || t.error}`).join('; '));
      err.tried = tried;
      throw err;
    },
    /* ONE tour-day, for the poller. The scoreboard is a document per tour per
       day carrying every tournament's matches for that day, so this is the
       whole unit a poller drives. The plain scoreboard is the fallback: it
       answers with whatever ESPN considers current, which during a session is
       the same day. */
    async day(tour, dayMs) {
      const tried = [];
      for (const a of [{ via: 'day', url: scoreboardDayUrl(tour, dayMs) }, { via: 'plain', url: scoreboardPlainUrl(tour) }]) {
        try {
          const r = await fetchJson(a.url, fetchImpl, timeoutMs);
          return { tournaments: parseScoreboard(r.json, tour), latency: r.latency, via: a.via, tried };
        } catch (e) { tried.push({ via: a.via, status: (e && e.status) || null, error: String(e && e.message || e).slice(0, 120) }); }
      }
      const err = new Error(`${tour} day request failed: ` + tried.map(t => `${t.via} -> ${t.status || t.error}`).join('; '));
      err.tried = tried;
      throw err;
    },
    /* Both tours, merged, with per-tour failures reported rather than fatal:
       one tour answering is a usable day. */
    async allTours(fromMs, toMs, tours) {
      const out = { tournaments: [], latency: 0, byTour: {}, errors: [] };
      for (const tour of (tours || TOURS)) {
        try {
          const r = await this.scoreboard(tour, fromMs, toMs);
          out.tournaments.push(...r.tournaments);
          out.latency = Math.max(out.latency, r.latency || 0);
          out.byTour[tour] = { via: r.via, tournaments: r.tournaments.length, totalSeen: r.totalSeen };
        } catch (e) { out.errors.push({ tour, error: String(e && e.message || e).slice(0, 200), tried: e.tried || null }); }
      }
      out.tournaments = mergeTournaments(out.tournaments);
      if (!out.tournaments.length && out.errors.length === (tours || TOURS).length) {
        const err = new Error('no tour answered: ' + out.errors.map(x => x.tour + ' ' + x.error).join(' | '));
        err.byTour = out.byTour; err.errors = out.errors;
        throw err;
      }
      return out;
    },
    /* One athlete, best-effort. Returns null rather than throwing when the feed
       simply will not describe this player: the directory row is still valid. */
    async athlete(tour, athleteId) {
      const tried = [];
      for (const a of athleteUrls(tour, athleteId)) {
        try {
          const r = await fetchJson(a.url, fetchImpl, timeoutMs);
          const parsed = parseAthlete(r.json);
          if (parsed) return { athlete: parsed, via: a.via, latency: r.latency };
          tried.push({ via: a.via, status: 200, error: 'answered but carried no athlete fields' });
        } catch (e) { tried.push({ via: a.via, status: (e && e.status) || null, error: String(e && e.message || e).slice(0, 120) }); }
      }
      return { athlete: null, via: null, tried };
    },
    /* A tour's current rankings, best-effort. */
    async rankings(tour) {
      const tried = [];
      for (const a of rankingsUrls(tour)) {
        try {
          const r = await fetchJson(a.url, fetchImpl, timeoutMs);
          const rows = parseRankings(r.json);
          if (rows.length) return { rows, via: a.via, latency: r.latency };
          tried.push({ via: a.via, status: 200, error: 'answered but carried no ranked athlete' });
        } catch (e) { tried.push({ via: a.via, status: (e && e.status) || null, error: String(e && e.message || e).slice(0, 120) }); }
      }
      return { rows: [], via: null, tried };
    },
    async probe(fromMs, toMs) {
      const out = [];
      for (const tour of TOURS) {
        for (const a of discoveryAttempts(tour, fromMs, toMs)) {
          try {
            const r = await fetchJson(a.url, fetchImpl, timeoutMs);
            const all = parseScoreboard(r.json, tour);
            const matches = all.reduce((n, t) => n + t.matches.length, 0);
            out.push({ tour, via: a.via, url: a.url, status: 200, latency: r.latency, tournaments: all.length, matches });
          } catch (e) { out.push({ tour, via: a.via, url: a.url, status: (e && e.status) || null, error: String(e && e.message || e).slice(0, 160) }); }
        }
      }
      return out;
    },
    /* One tournament in detail, for statistics the scoreboard omits. */
    async summary(tour, providerTournamentId) {
      const r = await fetchJson(summaryUrl(tour, providerTournamentId), fetchImpl, timeoutMs);
      return { json: r.json, latency: r.latency };
    }
  };
}

module.exports = { ESPN_API, ESPN_WEB_API, TOURS, TOUR_LABEL, scoreboardDayUrl, scoreboardRangeUrl, scoreboardPlainUrl, summaryUrl,
  fetchJson, parseScoreboard, parseTournament, parseMatch, statusOf, sideOf, STAT_ALIASES, STAT_FIELDS, STAT_IGNORE, COMPOSITE,
  normalizeStats, setSplits, flattenStats, isPeriodSplit, tourOfGrouping, ownerTour, mergeTournaments,
  athleteUrls, rankingsUrls, parseAthlete, parseRankings, heightCm, dig, discoveryAttempts, inWindow, source, keyOf, pctFrom };
