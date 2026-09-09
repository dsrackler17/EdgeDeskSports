#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk UFC — the ESPN adapter.

   ESPN's public, keyless site and core JSON APIs are the same feeds this
   repository already trusts for football schedules, rosters and finals
   (tools/collective/sync_schedule.js, football/rosters/fetch_rosters.js).
   Nothing here logs in, pays, or bypasses anything; a field the feed does not
   carry is left null and named in the diagnostics, never invented.

   THE FEED IS NOT A CONTRACT. Every read below is guarded: an event with no
   competitions, a competition with one competitor, a status with no type, a
   statistics payload in any of the three shapes ESPN has used (flat name /
   value lists, category groups, and "52/110" composites) all parse to what
   they contain and no more. Keys the normaliser does not recognise are
   collected in `unmapped` so an operator can extend STAT_ALIASES with
   evidence instead of guessing.
   =========================================================================== */
'use strict';

const ESPN_API = (process.env.ESPN_API || 'https://site.api.espn.com').replace(/\/$/, '');
const ESPN_WEB_API = (process.env.ESPN_WEB_API || 'https://site.web.api.espn.com').replace(/\/$/, '');
const ESPN_CORE = (process.env.ESPN_CORE_API || 'https://sports.core.api.espn.com').replace(/\/$/, '');
const UA = 'EdgeDeskSports/ufc (+https://edgedesksports.com)';

function ymd(d) { return new Date(d).toISOString().slice(0, 10).replace(/-/g, ''); }

function scoreboardUrl(fromMs, toMs) {
  return `${ESPN_API}/apis/site/v2/sports/mma/ufc/scoreboard?dates=${ymd(fromMs)}-${ymd(toMs)}&limit=100`;
}
function scoreboardDayUrl(dayMs) {
  return `${ESPN_API}/apis/site/v2/sports/mma/ufc/scoreboard?dates=${ymd(dayMs)}&limit=100`;
}
function fightCenterUrl(providerEventId) {
  return `${ESPN_WEB_API}/apis/site/v2/sports/mma/ufc/fightcenter/${encodeURIComponent(providerEventId)}?region=us&lang=en`;
}
function statsUrl(providerEventId, providerBoutId, athleteId) {
  return `${ESPN_CORE}/v2/sports/mma/leagues/ufc/events/${encodeURIComponent(providerEventId)}/competitions/${encodeURIComponent(providerBoutId)}/competitors/${encodeURIComponent(athleteId)}/statistics`;
}

/* fetch with a hard timeout and one measured latency. */
async function fetchJson(url, fetchImpl, timeoutMs) {
  const f = fetchImpl || ((...a) => fetch(...a));
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 15000) : null;
  const t0 = Date.now();
  try {
    const res = await f(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: ctl ? ctl.signal : undefined });
    const text = await res.text();
    const latency = Date.now() - t0;
    if (!res.ok) { const e = new Error(`${res.status} from ${url.split('?')[0]}`); e.status = res.status; e.latency = latency; throw e; }
    return { json: text ? JSON.parse(text) : null, latency };
  } finally { if (timer) clearTimeout(timer); }
}

/* ---- events and bouts ----------------------------------------------------- */

function str(v) { return v == null ? null : String(v); }
function numOrNull(v) { const n = Number(v); return (v == null || v === '' || !isFinite(n)) ? null : n; }

function statusOf(st) {
  st = st || {};
  const type = st.type || {};
  const name = String(type.name || '').toUpperCase();
  const state = String(type.state || '').toLowerCase();
  let status = 'unknown';
  if (/CANCEL/.test(name)) status = 'cancelled';
  else if (/POSTPONE/.test(name)) status = 'postponed';
  else if (state === 'pre') status = 'scheduled';
  else if (state === 'in') status = 'live';
  else if (state === 'post') status = 'final';
  const result = st.result || {};
  const method = str(result.displayName || result.name || null);
  if (status === 'final' && /no contest/i.test(String(method || '') + ' ' + String(type.description || ''))) status = 'no_contest';
  return {
    status, state, name,
    detail: str(type.detail || type.shortDetail || type.description || null),
    completed: !!type.completed,
    period: numOrNull(st.period),
    displayClock: str(st.displayClock),
    clock: numOrNull(st.clock),
    method,
    methodDetail: str(result.description || result.shortDisplayName || null),
    methodShort: str(result.shortDisplayName || null)
  };
}

function weightClassOf(c) {
  const cands = [c.type && c.type.text, c.type && c.type.abbreviation, c.weightClass && (c.weightClass.text || c.weightClass.displayName || c.weightClass),
    c.notes && c.notes[0] && c.notes[0].headline];
  for (const x of cands) if (x && typeof x === 'string' && x.trim()) return x.replace(/\s*-\s*bout$/i, '').trim();
  return null;
}
function titleOf(c) {
  const bits = [c.type && c.type.text, c.notes && c.notes[0] && c.notes[0].headline, c.title, c.isTitle].map(x => String(x == null ? '' : x)).join(' ');
  return /title|championship|\bbelt\b/i.test(bits);
}
function recordOf(comp) {
  if (typeof comp.record === 'string') return comp.record;
  if (Array.isArray(comp.records) && comp.records[0]) return str(comp.records[0].summary || comp.records[0].displayValue || null);
  if (comp.athlete && typeof comp.athlete.record === 'string') return comp.athlete.record;
  if (comp.athlete && Array.isArray(comp.athlete.records) && comp.athlete.records[0]) return str(comp.athlete.records[0].summary || null);
  return null;
}
function rankOf(comp) {
  const r = comp.rank != null ? comp.rank : (comp.athlete && (comp.athlete.rank != null ? comp.athlete.rank : (comp.athlete.ranking != null ? comp.athlete.ranking : null)));
  if (r == null || r === '') return null;
  const s = String(r);
  return /^\d+$/.test(s) ? s : (/^c$/i.test(s) ? 'C' : s.slice(0, 12));
}

/* One competition -> one bout. Corner assignment is the provider's own
   order: the first-listed competitor is the red corner, which is how ESPN
   presents a UFC bout. The rule is recorded on the row (corner_source). */
function parseBout(c, ev, idx, total) {
  if (!c || !Array.isArray(c.competitors) || c.competitors.length < 2) return null;
  const comps = c.competitors.slice().sort((a, b) => (numOrNull(a.order) || 99) - (numOrNull(b.order) || 99));
  const red = comps[0], blue = comps[1];
  const st = statusOf(c.status);
  const rounds = numOrNull(c.format && c.format.regulation && c.format.regulation.periods);
  const matchNumber = numOrNull(c.matchNumber != null ? c.matchNumber : (c.boutNumber != null ? c.boutNumber : null));
  const bout = {
    provider_bout_id: str(c.id),
    provider_event_id: str(ev.id),
    bout_order: matchNumber != null ? matchNumber : (total - idx),
    order_source: matchNumber != null ? 'match_number' : 'array_reversed',
    card_segment: str((c.cardSegment && (c.cardSegment.description || c.cardSegment.name)) || null),
    is_main: idx === 0 || (matchNumber != null && matchNumber === total),
    is_title: titleOf(c),
    weight_class: weightClassOf(c),
    scheduled_rounds: rounds,
    red_provider_id: str(red.athlete && red.athlete.id != null ? red.athlete.id : red.id),
    blue_provider_id: str(blue.athlete && blue.athlete.id != null ? blue.athlete.id : blue.id),
    red_name: str((red.athlete && (red.athlete.displayName || red.athlete.fullName)) || red.displayName || red.name || null),
    blue_name: str((blue.athlete && (blue.athlete.displayName || blue.athlete.fullName)) || blue.displayName || blue.name || null),
    red_record: recordOf(red), blue_record: recordOf(blue),
    red_rank: rankOf(red), blue_rank: rankOf(blue),
    corner_source: 'provider_order',
    status: st.status, status_detail: st.detail,
    round: st.period, clock: st.displayClock, clock_seconds: st.clock,
    winner_corner: null, method: null, method_detail: null, result_detail: null, end_round: null, end_time: null,
    referee: str((c.officials && c.officials[0] && (c.officials[0].displayName || c.officials[0].fullName)) || c.referee || null),
    scheduled_at: str(c.date || ev.date || null),
    raw_status_name: st.name,
    inline_stats: { red: red.statistics || null, blue: blue.statistics || null }
  };
  if (st.status === 'final' || st.status === 'no_contest') {
    if (red.winner === true) bout.winner_corner = 'red';
    else if (blue.winner === true) bout.winner_corner = 'blue';
    else if (st.status === 'no_contest') bout.winner_corner = 'nc';
    else if (/draw/i.test(String(st.method || '') + ' ' + String(st.detail || ''))) bout.winner_corner = 'draw';
    bout.method = st.method; bout.method_detail = st.methodDetail;
    bout.end_round = st.period; bout.end_time = st.displayClock;
    bout.result_detail = st.detail;
  }
  if (!bout.red_name || !bout.blue_name || !bout.provider_bout_id) return null;
  return bout;
}

function parseEvent(ev) {
  if (!ev || ev.id == null) return null;
  const comps = Array.isArray(ev.competitions) ? ev.competitions : (Array.isArray(ev.cards) ? [].concat(...ev.cards.map(k => k.competitions || [])) : []);
  const venue = (comps[0] && comps[0].venue) || ev.venue || {};
  const addr = venue.address || {};
  const st = statusOf(ev.status || (comps[0] && comps[0].status));
  const bouts = comps.map((c, i) => parseBout(c, ev, i, comps.length)).filter(Boolean);
  let event_state = 'scheduled';
  if (st.status === 'cancelled') event_state = 'cancelled';
  else if (st.status === 'postponed') event_state = 'postponed';
  else if (bouts.some(b => b.status === 'live')) event_state = 'live';
  else if (st.status === 'live') event_state = 'live';
  else if (bouts.length && bouts.every(b => ['final', 'no_contest', 'cancelled'].includes(b.status))) event_state = 'final';
  else if (st.status === 'final') event_state = 'final';
  return {
    provider_event_id: str(ev.id),
    name: str(ev.name), short_name: str(ev.shortName),
    scheduled_at: str(ev.date || null),
    venue: str(venue.fullName || venue.name || null),
    city: str(addr.city || null), state: str(addr.state || null), country: str(addr.country || null),
    timezone: str(venue.timezone || addr.timezone || null),
    event_state, status_name: st.name, status_detail: st.detail,
    bouts
  };
}

function parseScoreboard(json) {
  if (!json) return [];
  const list = Array.isArray(json.events) ? json.events : (json.id != null ? [json] : (json.event ? [json.event] : []));
  return list.map(parseEvent).filter(Boolean);
}

/* ---- statistics ----------------------------------------------------------- */

/* Source key -> canonical column. Keys are compared with everything but
   letters and digits removed, lowercased. A key mapped to a composite base
   ("sig_strikes") carries "landed/attempted" in its displayValue. */
const STAT_ALIASES = {
  sigstrikeslanded: 'sig_strikes_landed', significantstrikeslanded: 'sig_strikes_landed', sigstrlanded: 'sig_strikes_landed', sigstrikelanded: 'sig_strikes_landed',
  sigstrikesattempted: 'sig_strikes_attempted', significantstrikesattempted: 'sig_strikes_attempted', sigstrattempted: 'sig_strikes_attempted', sigstrikeattempted: 'sig_strikes_attempted',
  sigstrikes: 'sig_strikes', significantstrikes: 'sig_strikes', sigstr: 'sig_strikes', sigstrikelandedattempted: 'sig_strikes',
  totalstrikeslanded: 'total_strikes_landed', totalstrikesattempted: 'total_strikes_attempted', totalstrikes: 'total_strikes', totalstr: 'total_strikes', strikeslanded: 'total_strikes_landed', strikesattempted: 'total_strikes_attempted',
  takedownslanded: 'takedowns_landed', takedownlanded: 'takedowns_landed', tdlanded: 'takedowns_landed', takedowns: 'takedowns', td: 'takedowns',
  takedownsattempted: 'takedowns_attempted', takedownattempted: 'takedowns_attempted', tdattempted: 'takedowns_attempted', takedownattempts: 'takedowns_attempted',
  knockdowns: 'knockdowns', knockdown: 'knockdowns', kd: 'knockdowns',
  submissionattempts: 'submission_attempts', subattempts: 'submission_attempts', submissions: 'submission_attempts', subatt: 'submission_attempts',
  reversals: 'reversals', rev: 'reversals',
  controltime: 'control_seconds', controltimeseconds: 'control_seconds', ctrl: 'control_seconds', ctrltime: 'control_seconds', control: 'control_seconds',
  headstrikeslanded: 'head_strikes_landed', sigstrikesheadlanded: 'head_strikes_landed', headlanded: 'head_strikes_landed', sigheadlanded: 'head_strikes_landed',
  headstrikesattempted: 'head_strikes_attempted', sigstrikesheadattempted: 'head_strikes_attempted', headattempted: 'head_strikes_attempted',
  headstrikes: 'head_strikes', sigstrikeshead: 'head_strikes', head: 'head_strikes',
  bodystrikeslanded: 'body_strikes_landed', sigstrikesbodylanded: 'body_strikes_landed', bodylanded: 'body_strikes_landed',
  bodystrikesattempted: 'body_strikes_attempted', sigstrikesbodyattempted: 'body_strikes_attempted', bodyattempted: 'body_strikes_attempted',
  bodystrikes: 'body_strikes', sigstrikesbody: 'body_strikes', body: 'body_strikes',
  legstrikeslanded: 'leg_strikes_landed', sigstrikesleglanded: 'leg_strikes_landed', leglanded: 'leg_strikes_landed', legslanded: 'leg_strikes_landed',
  legstrikesattempted: 'leg_strikes_attempted', sigstrikeslegattempted: 'leg_strikes_attempted', legattempted: 'leg_strikes_attempted',
  legstrikes: 'leg_strikes', sigstrikesleg: 'leg_strikes', leg: 'leg_strikes', legs: 'leg_strikes',
  distancestrikeslanded: 'distance_strikes_landed', sigstrikesdistancelanded: 'distance_strikes_landed', distancelanded: 'distance_strikes_landed', standingstrikeslanded: 'distance_strikes_landed',
  distancestrikesattempted: 'distance_strikes_attempted', sigstrikesdistanceattempted: 'distance_strikes_attempted', distanceattempted: 'distance_strikes_attempted',
  distancestrikes: 'distance_strikes', sigstrikesdistance: 'distance_strikes', distance: 'distance_strikes', standing: 'distance_strikes',
  clinchstrikeslanded: 'clinch_strikes_landed', sigstrikesclinchlanded: 'clinch_strikes_landed', clinchlanded: 'clinch_strikes_landed',
  clinchstrikesattempted: 'clinch_strikes_attempted', sigstrikesclinchattempted: 'clinch_strikes_attempted', clinchattempted: 'clinch_strikes_attempted',
  clinchstrikes: 'clinch_strikes', sigstrikesclinch: 'clinch_strikes', clinch: 'clinch_strikes',
  groundstrikeslanded: 'ground_strikes_landed', sigstrikesgroundlanded: 'ground_strikes_landed', groundlanded: 'ground_strikes_landed',
  groundstrikesattempted: 'ground_strikes_attempted', sigstrikesgroundattempted: 'ground_strikes_attempted', groundattempted: 'ground_strikes_attempted',
  groundstrikes: 'ground_strikes', sigstrikesground: 'ground_strikes', ground: 'ground_strikes'
};
/* keys that are legitimately in the feed and legitimately not stored */
const STAT_IGNORE = new Set(['sigstrikespct', 'sigstrikepct', 'sigstrikeaccuracy', 'takedownpct', 'takedownaccuracy', 'tdpct', 'accuracy', 'sigstrikespercentage',
  'strikespct', 'winprobability', 'rounds', 'time', 'fighttime', 'weight', 'weightclass', 'sigstrikesperminute', 'sigstrikeslandedperminute', 'roundsfought', 'headpct', 'bodypct', 'legpct',
  'distancepct', 'clinchpct', 'groundpct', 'ctrlpct', 'controlpct']);

const STAT_FIELDS = ['knockdowns', 'sig_strikes_landed', 'sig_strikes_attempted', 'total_strikes_landed', 'total_strikes_attempted', 'takedowns_landed', 'takedowns_attempted',
  'submission_attempts', 'reversals', 'control_seconds', 'head_strikes_landed', 'head_strikes_attempted', 'body_strikes_landed', 'body_strikes_attempted',
  'leg_strikes_landed', 'leg_strikes_attempted', 'distance_strikes_landed', 'distance_strikes_attempted', 'clinch_strikes_landed', 'clinch_strikes_attempted',
  'ground_strikes_landed', 'ground_strikes_attempted'];

function keyOf(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function clockToSeconds(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? Math.round(v) : null;
  const s = String(v).trim();
  const m = /^(\d+):(\d{1,2})$/.exec(s);
  if (m) return (+m[1]) * 60 + (+m[2]);
  const n = Number(s);
  return isFinite(n) ? Math.round(n) : null;
}
function intOrNull(v) { const n = Number(v); return (v == null || v === '' || !isFinite(n)) ? null : Math.round(n); }

/* Walk any of ESPN's statistics shapes and emit {key, value, display} triples. */
function flattenStats(raw, out, path) {
  out = out || [];
  if (raw == null) return out;
  if (Array.isArray(raw)) { raw.forEach(x => flattenStats(x, out, path)); return out; }
  if (typeof raw !== 'object') return out;
  if (raw.name != null && (raw.value != null || raw.displayValue != null) && !Array.isArray(raw.stats)) {
    out.push({ key: String(raw.abbreviation && keyOf(raw.abbreviation).length > 2 ? raw.name : raw.name), value: raw.value, display: raw.displayValue, abbr: raw.abbreviation, category: path || null });
    return out;
  }
  if (Array.isArray(raw.stats)) { raw.stats.forEach(x => flattenStats(x, out, raw.name || path)); }
  if (Array.isArray(raw.categories)) { raw.categories.forEach(x => flattenStats(x, out, x.name || path)); }
  if (raw.splits) flattenStats(raw.splits, out, path);
  if (Array.isArray(raw.statistics)) flattenStats(raw.statistics, out, path);
  if (Array.isArray(raw.athletes)) flattenStats(raw.athletes, out, path);
  return out;
}

/* Raw statistics -> canonical fields. Returns {stats, unmapped, mapped}. */
function normalizeStats(raw) {
  const stats = {}; const unmapped = {}; let mapped = 0;
  flattenStats(raw).forEach(item => {
    const k = keyOf(item.key);
    if (!k || STAT_IGNORE.has(k)) return;
    let canon = STAT_ALIASES[k];
    if (!canon && item.abbr) canon = STAT_ALIASES[keyOf(item.abbr)];
    if (!canon) { unmapped[k] = (unmapped[k] || 0) + 1; return; }
    const disp = item.display != null ? String(item.display) : null;
    const composite = disp && /^\s*\d+\s*\/\s*\d+\s*$/.test(disp) ? disp.split('/').map(x => intOrNull(x.trim())) : null;
    if (canon === 'control_seconds') { const v = clockToSeconds(disp != null && /:/.test(disp) ? disp : item.value); if (v != null) { stats.control_seconds = v; mapped++; } return; }
    if (!/_landed$|_attempted$|^knockdowns$|^submission_attempts$|^reversals$/.test(canon)) {
      /* a composite base such as sig_strikes: "52/110" or {value: 52} */
      if (composite) { stats[canon + '_landed'] = composite[0]; stats[canon + '_attempted'] = composite[1]; mapped++; }
      else { const v = intOrNull(item.value != null ? item.value : disp); if (v != null) { stats[canon + '_landed'] = v; mapped++; } }
      return;
    }
    if (composite && /_landed$/.test(canon)) { stats[canon] = composite[0]; stats[canon.replace(/_landed$/, '_attempted')] = composite[1]; mapped++; return; }
    const v = intOrNull(item.value != null ? item.value : disp);
    if (v != null) { stats[canon] = v; mapped++; }
  });
  return { stats, unmapped, mapped };
}

/* Per-round splits, when the payload carries them. Looks for split groups
   named like "Round 1" / "round1" / {period: 1}. Returns {round -> stats}. */
function roundSplits(raw) {
  const out = {};
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const label = String(node.name || node.displayName || node.abbreviation || '');
    const m = /^round\s*(\d)$|^r(\d)$/i.exec(label.trim());
    const period = node.period != null ? intOrNull(node.period) : (m ? intOrNull(m[1] || m[2]) : null);
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

/* ---- the source, as one object the jobs use ------------------------------- */
function source(opts) {
  opts = opts || {};
  const fetchImpl = opts.fetchImpl || null;
  const timeoutMs = opts.timeoutMs || 15000;
  return {
    urls: { scoreboardUrl, scoreboardDayUrl, fightCenterUrl, statsUrl },
    async scoreboard(fromMs, toMs) {
      const r = await fetchJson(scoreboardUrl(fromMs, toMs), fetchImpl, timeoutMs);
      return { events: parseScoreboard(r.json), latency: r.latency, raw: r.json };
    },
    /* One event in detail: the fight-center document when it answers, the
       day's scoreboard otherwise. Both parse to the same shape. */
    async eventDetail(providerEventId, scheduledAtMs) {
      let lastErr = null;
      try {
        const r = await fetchJson(fightCenterUrl(providerEventId), fetchImpl, timeoutMs);
        const evs = parseScoreboard(r.json).filter(e => String(e.provider_event_id) === String(providerEventId));
        if (evs.length) return { event: evs[0], latency: r.latency, via: 'fightcenter' };
      } catch (e) { lastErr = e; }
      if (scheduledAtMs != null && isFinite(scheduledAtMs)) {
        const r2 = await fetchJson(scoreboardDayUrl(scheduledAtMs), fetchImpl, timeoutMs);
        const evs2 = parseScoreboard(r2.json).filter(e => String(e.provider_event_id) === String(providerEventId));
        if (evs2.length) return { event: evs2[0], latency: r2.latency, via: 'scoreboard' };
        if (lastErr) throw lastErr;
        const e = new Error(`event ${providerEventId} absent from the day's scoreboard`); e.status = 404; throw e;
      }
      throw lastErr || new Error(`event ${providerEventId} not found`);
    },
    async competitorStats(providerEventId, providerBoutId, athleteId) {
      const r = await fetchJson(statsUrl(providerEventId, providerBoutId, athleteId), fetchImpl, timeoutMs);
      const n = normalizeStats(r.json);
      return { stats: n.stats, unmapped: n.unmapped, mapped: n.mapped, rounds: roundSplits(r.json), latency: r.latency };
    }
  };
}

module.exports = { ESPN_API, ESPN_CORE, ESPN_WEB_API, scoreboardUrl, scoreboardDayUrl, fightCenterUrl, statsUrl, fetchJson, parseEvent, parseBout, parseScoreboard,
  statusOf, STAT_ALIASES, STAT_FIELDS, STAT_IGNORE, normalizeStats, roundSplits, flattenStats, source, keyOf, clockToSeconds };
