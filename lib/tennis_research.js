/* ===========================================================================
   EdgeDesk Tennis — the research engine, shared by the pipeline and the page.

   ONE implementation of every rule the Live Match Center depends on, loaded by
   tools/tennis/*.js under Node (where it is tested) and by app.html in the
   browser (where it is displayed). If the two ever disagreed a match would
   link to a market on the server and not on the screen, or a flag would fire
   in a test and not on a phone. So there is one file.

   What lives here, and the rule each part obeys:

     names       normalisation and player resolution — an ambiguous match is
                 NOT a match; a DOUBLES pair is a team and is never resolved
                 to one of its players
     market      a fixture's two participants are the two sides; a doubles
                 fixture is stored as doubles and never linked to a singles
                 match; malformed fixtures are rejected WITH a reason
     point       PRE / LIVE tagging against the match's own first point, and
                 the closing reference only a pre-first-point capture may give
     health      deterministic freshness thresholds per data domain, with the
                 live feed dominating while a match is on court
     baselines   the licensed record's surface, form and ranking splits, plus
                 EdgeDesk's OWN observed serve/return baselines — the record
                 carries no point-level serve data, so those accumulate from
                 matches this pipeline has watched and start empty
     live        hold, break, first-serve and return rates from the live
                 state, compared with a baseline where one exists and
                 labelled where not
     flags       "what's different today" — deterministic, thresholded,
                 explained, and never a recommendation
     style       documented, reproducible classification rules

   Research, not picks. Nothing in this file produces a selection, a
   probability of its own, or a verb like "bet". The one probability on screen
   is the market's, de-vigged, and labelled as the market's. Nothing here
   claims a physical state: a dropped first-serve percentage is a number, not
   an injury, and retirement is never predicted.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDTennisResearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 'tennis-research-1.0';

  /* ───────────────────────────── names ────────────────────────────────── */

  /* Fold a name to the key two feeds are compared on. Accents, case,
     punctuation and a quoted nickname are presentation; the letters that
     remain are identity. Tennis names carry accents constantly (Djokovic,
     Swiatek, Muguruza), so this is load-bearing rather than cosmetic. */
  function normName(n) {
    var s = String(n == null ? '' : n);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    s = s.replace(/["“”][^"“”]*["“”]/g, ' ')
         .toLowerCase()
         .replace(/[^a-z0-9]+/g, ' ')
         .trim().replace(/\s+/g, ' ');
    return s;
  }
  function tokens(n) { return normName(n).split(' ').filter(Boolean); }
  function surnameKey(n) { var t = tokens(n); return t.length ? t[t.length - 1] : ''; }
  function firstLastKey(n) { var t = tokens(n); return t.length >= 2 ? t[0] + ' ' + t[t.length - 1] : ''; }
  function swappedKey(n) { var t = tokens(n); return t.length === 2 ? t[1] + ' ' + t[0] : ''; }
  /* "R. Nadal" / "Nadal R." -> initial + surname, the shape scoreboards use */
  function initialLastKey(n) {
    var t = tokens(n);
    if (t.length < 2) return '';
    return t[0].charAt(0) + ' ' + t[t.length - 1];
  }

  /* DOUBLES. A side in a doubles match is a PAIR, written by every feed as
     two names joined by a slash (and occasionally by " / " or "&"). A pair is
     a team: it has no ranking row, no career row and no baseline, and
     resolving it to either half would attach one player's record to a team's
     result. So it is detected, kept whole, and never resolved. This is the
     tennis counterpart of a draw outcome never becoming a fighter. */
  var PAIR_SPLIT_RE = /\s*(?:\/|\band\b|&|\+)\s*/;
  function isDoublesName(n) {
    var s = String(n == null ? '' : n);
    if (/\//.test(s)) return true;
    if (/\s&\s/.test(s)) return true;
    if (/\s\+\s/.test(s)) return true;
    return false;
  }
  function splitDoubles(n) {
    if (!isDoublesName(n)) return [String(n == null ? '' : n)];
    return String(n).split(PAIR_SPLIT_RE).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  /* The key a doubles pair is compared on: both halves folded and sorted, so
     "Bopanna/Ebden" and "Ebden / Bopanna" are one team. */
  function pairKey(n) {
    var parts = splitDoubles(n).map(surnameKey).filter(Boolean).sort();
    return parts.length >= 2 ? parts.join('|') : '';
  }

  /* Two spellings of one person: identical once folded, or the same first and
     last token when one carries a middle name. Never two different people. */
  function sameName(a, b) {
    if (isDoublesName(a) || isDoublesName(b)) {
      var pa = pairKey(a), pb = pairKey(b);
      return !!pa && pa === pb;
    }
    var x = normName(a), y = normName(b);
    if (!x || !y) return false;
    if (x === y) return true;
    var ta = x.split(' '), tb = y.split(' ');
    if (ta.length < 3 && tb.length < 3) return false;
    return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
  }

  /* An index over tennis.players rows ({player_id, full_name, tour, ...}). */
  function buildPlayerIndex(players) {
    var ix = { byId: {}, byName: {}, bySurname: {}, byFirstLast: {}, byInitialLast: {}, n: 0 };
    (players || []).forEach(function (p) {
      if (!p || p.player_id == null) return;
      var id = String(p.player_id);
      ix.byId[id] = p;
      var k = normName(p.full_name);
      if (k) (ix.byName[k] = ix.byName[k] || []).push(p);
      var s = surnameKey(p.full_name);
      if (s) (ix.bySurname[s] = ix.bySurname[s] || []).push(p);
      var fl = firstLastKey(p.full_name);
      if (fl) (ix.byFirstLast[fl] = ix.byFirstLast[fl] || []).push(p);
      var il = initialLastKey(p.full_name);
      if (il) (ix.byInitialLast[il] = ix.byInitialLast[il] || []).push(p);
      ix.n++;
    });
    return ix;
  }

  /* Resolve one participant. aliases is {alias_key -> player_id}. Returns
     {player_id, method, candidates}; a null player_id with method 'ambiguous'
     means two people could be meant and none of them is chosen, and method
     'doubles' means the name is a pair and was deliberately not resolved. */
  function resolvePlayer(name, providerId, index, aliases) {
    aliases = aliases || {};
    var out = { player_id: null, method: null, candidates: [] };
    if (isDoublesName(name)) { out.method = 'doubles'; return out; }
    var k = normName(name);
    if (providerId != null && String(providerId) !== '') {
      var a = aliases['espn:' + String(providerId)];
      if (a && index.byId[a]) { out.player_id = a; out.method = 'provider_id'; return out; }
    }
    if (k && aliases['name:' + k] && index.byId[aliases['name:' + k]]) {
      out.player_id = aliases['name:' + k]; out.method = 'alias'; return out;
    }
    if (!k) return out;
    var exact = index.byName[k] || [];
    if (exact.length === 1) { out.player_id = String(exact[0].player_id); out.method = 'exact'; return out; }
    if (exact.length > 1) { out.method = 'ambiguous'; out.candidates = exact.map(idOf); return out; }
    var sw = swappedKey(k);
    if (sw) {
      var swapped = index.byName[sw] || [];
      if (swapped.length === 1) { out.player_id = String(swapped[0].player_id); out.method = 'name_order'; return out; }
      if (swapped.length > 1) { out.method = 'ambiguous'; out.candidates = swapped.map(idOf); return out; }
    }
    var fl = firstLastKey(k);
    if (fl && fl !== k) {
      var pair = index.byFirstLast[fl] || [];
      if (pair.length === 1) { out.player_id = String(pair[0].player_id); out.method = 'first_last'; return out; }
      if (pair.length > 1) { out.method = 'ambiguous'; out.candidates = pair.map(idOf); return out; }
    }
    /* "R. Federer" — initial plus surname, only when it names one person. */
    var t = k.split(' ');
    if (t.length >= 2 && t[0].length <= 2) {
      var il = index.byInitialLast[initialLastKey(k)] || [];
      if (il.length === 1) { out.player_id = String(il[0].player_id); out.method = 'initial_last'; return out; }
      if (il.length > 1) { out.method = 'ambiguous'; out.candidates = il.map(idOf); return out; }
    }
    /* Surname alone, only when exactly one player on file carries it AND the
       feed gave nothing else to go on. Two Williamses is a refusal. */
    if (t.length === 1) {
      var sn = index.bySurname[t[0]] || [];
      if (sn.length === 1) { out.player_id = String(sn[0].player_id); out.method = 'surname'; return out; }
      if (sn.length > 1) { out.method = 'ambiguous'; out.candidates = sn.map(idOf); return out; }
    }
    return out;
    function idOf(p) { return String(p.player_id); }
  }

  /* ───────────────────────────── odds ─────────────────────────────────── */

  function impliedFromDec(dec) { var d = +dec; return (dec != null && isFinite(d) && d > 1) ? 1 / d : null; }
  function decToAm(dec) { var d = +dec; if (!(d > 1)) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function amToDec(am) { var a = +am; if (!isFinite(a) || a === 0) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  function fmtAm(am) { if (am == null || !isFinite(+am)) return '—'; return (am > 0 ? '+' : '') + Math.round(am); }
  function fmtDecAsAm(dec) { var a = decToAm(dec); return a == null ? '—' : fmtAm(a); }
  /* Two-way multiplicative de-vig: the market's own probability once the
     book's margin is removed. Tennis moneylines are strictly two-way — there
     is no draw — so a fixture with anything other than two priced sides is a
     shape this does not describe, and says so by returning null. */
  function devig2(decA, decB) {
    var a = impliedFromDec(decA), b = impliedFromDec(decB);
    if (a == null || b == null) return null;
    var s = a + b;
    return { a: a / s, b: b / s, vig: s - 1 };
  }
  function movement(openDec, curDec) {
    var o = impliedFromDec(openDec), c = impliedFromDec(curDec);
    if (o == null || c == null) return null;
    return { openAm: decToAm(openDec), nowAm: decToAm(curDec), pp: (c - o) * 100, dir: (c > o ? 'toward' : (c < o ? 'away' : 'flat')) };
  }

  /* ───────────────────────────── market ───────────────────────────────── */

  function groupFixtures(rows) {
    var by = {};
    (rows || []).forEach(function (r) {
      if (!r) return;
      var id = String(r.event_id || '');
      if (!id) return;
      var f = by[id] || (by[id] = { signal_event_id: id, sport_key: r.sport_key || null,
        home_team: r.home_team || '', away_team: r.away_team || '', commence_time: r.commence_time || null, rows: [] });
      f.rows.push(r);
      if (!f.commence_time && r.commence_time) f.commence_time = r.commence_time;
    });
    return Object.keys(by).map(function (k) { return by[k]; });
  }
  function newest(a, b) { return String(b.last_seen_at || '') > String(a.last_seen_at || '') ? b : a; }

  /* One fixture -> its normalised shape, or a rejection. */
  function normalizeFixture(f) {
    var home = normName(f.home_team), away = normName(f.away_team);
    var doubles = isDoublesName(f.home_team) || isDoublesName(f.away_team);
    var out = { signal_event_id: f.signal_event_id, sport_key: f.sport_key, home_team: f.home_team, away_team: f.away_team,
      commence_time: f.commence_time, is_doubles: doubles, h2h: { home: null, away: null, other: [] }, markets: {}, rejections: [], ok: true };
    if (!home || !away) { out.ok = false; out.rejections.push({ reason: 'fixture_unresolved', detail: 'a participant name is empty' }); return out; }
    if (home === away) { out.ok = false; out.rejections.push({ reason: 'malformed', detail: 'both participants carry the same name' }); return out; }
    (f.rows || []).forEach(function (r) {
      var m = String(r.market || '');
      (out.markets[m] = out.markets[m] || []).push(r);
      if (m !== 'h2h') return;
      if (sameName(r.selection, f.home_team)) out.h2h.home = out.h2h.home ? newest(out.h2h.home, r) : r;
      else if (sameName(r.selection, f.away_team)) out.h2h.away = out.h2h.away ? newest(out.h2h.away, r) : r;
      else {
        out.h2h.other.push(r);
        out.rejections.push({ reason: 'unknown_selection', sig_key: r.sig_key, selection: r.selection,
          detail: 'h2h selection matches neither participant' });
      }
    });
    return out;
  }

  /* The list a board draws from: one item per fixture whose two participants
     are two distinct named sides, with each side's newest h2h row. A doubles
     fixture is carried with is_doubles set so nothing downstream mistakes a
     pair for a player. */
  function matchesFromSignals(rows) {
    var out = { matches: [], rejected: [] };
    groupFixtures(rows).forEach(function (f) {
      var n = normalizeFixture(f);
      if (!n.ok) { out.rejected.push({ signal_event_id: n.signal_event_id, home_team: n.home_team, away_team: n.away_team, reasons: n.rejections }); return; }
      n.rejections.forEach(function (r) {
        out.rejected.push({ signal_event_id: n.signal_event_id, home_team: n.home_team, away_team: n.away_team, reasons: [r] });
      });
      out.matches.push({ key: n.signal_event_id, signal_event_id: n.signal_event_id, commence_time: n.commence_time,
        is_doubles: n.is_doubles,
        a: { name: n.home_team, row: n.h2h.home }, b: { name: n.away_team, row: n.h2h.away },
        markets: n.markets, priced: !!(n.h2h.home && n.h2h.away) });
    });
    out.matches.sort(function (x, y) { return (Date.parse(x.commence_time || 0) || 0) - (Date.parse(y.commence_time || 0) || 0); });
    return out;
  }

  /* Link a normalised fixture to one of the matches on file. `resolve(name)`
     answers {player_id, method}. A link is made only when BOTH participants
     resolve to the match's two sides, in either orientation. A doubles fixture
     may link only to a doubles match, and only by its pair key. */
  function linkFixture(n, matches, resolve) {
    if (!n || !n.ok) return { ok: false, reason: (n && n.rejections[0] && n.rejections[0].reason) || 'malformed', detail: n && n.rejections[0] && n.rejections[0].detail };
    var i, m;
    /* 1. the match's own names (a middle name tolerated; a pair by pair key) */
    for (i = 0; i < matches.length; i++) {
      m = matches[i];
      if (!normName(m.home_name) || !normName(m.away_name)) continue;
      if (!!m.is_doubles !== !!n.is_doubles) continue;
      if (sameName(n.home_team, m.home_name) && sameName(n.away_team, m.away_name)) return made(m, 'both_names_exact', 'home', 'away');
      if (sameName(n.home_team, m.away_name) && sameName(n.away_team, m.home_name)) return made(m, 'both_names_exact', 'away', 'home');
    }
    /* 2. through player identity — singles only. A doubles pair has no player
       id by construction, so there is no identity path for it and a fixture
       that reaches here as doubles is refused rather than guessed. */
    if (n.is_doubles) return { ok: false, reason: 'doubles_no_match', detail: 'a doubles fixture matched no doubles match on file; a pair is never resolved to a singles player' };
    var rh = resolve ? resolve(n.home_team) : null, ra = resolve ? resolve(n.away_team) : null;
    var hid = rh && rh.player_id, aid = ra && ra.player_id;
    if ((rh && rh.method === 'ambiguous') || (ra && ra.method === 'ambiguous'))
      return { ok: false, reason: 'ambiguous_alias', detail: 'a participant name matches more than one player on file' };
    if (!hid || !aid) return { ok: false, reason: 'one_player_unresolved', detail: (!hid ? n.home_team : n.away_team) + ' did not resolve to a player on file' };
    for (i = 0; i < matches.length; i++) {
      m = matches[i];
      if (m.is_doubles) continue;
      if (!m.home_player_id || !m.away_player_id) continue;
      if (String(m.home_player_id) === String(hid) && String(m.away_player_id) === String(aid)) return made(m, 'both_names_alias', 'home', 'away');
      if (String(m.away_player_id) === String(hid) && String(m.home_player_id) === String(aid)) return made(m, 'both_names_alias', 'away', 'home');
    }
    return { ok: false, reason: 'no_match_found', detail: 'both participants resolved but no scheduled match pairs them' };

    function made(mm, method, homeSide, awaySide) {
      var link = { match_id: mm.match_id, tournament_id: mm.tournament_id, signal_event_id: n.signal_event_id, sport_key: n.sport_key,
        home_team: n.home_team, away_team: n.away_team, commence_time: n.commence_time, link_method: method,
        home_selection: null, away_selection: null, home_sig_key: null, away_sig_key: null, other_sig_keys: [] };
      var homeRow = n.h2h.home, awayRow = n.h2h.away;
      if (homeSide === 'home') { link.home_selection = n.home_team; link.away_selection = n.away_team;
        link.home_sig_key = homeRow ? homeRow.sig_key : null; link.away_sig_key = awayRow ? awayRow.sig_key : null; }
      else { link.away_selection = n.home_team; link.home_selection = n.away_team;
        link.away_sig_key = homeRow ? homeRow.sig_key : null; link.home_sig_key = awayRow ? awayRow.sig_key : null; }
      Object.keys(n.markets).forEach(function (k) {
        if (k === 'h2h') return;
        n.markets[k].forEach(function (r) { if (r.sig_key) link.other_sig_keys.push(r.sig_key); });
      });
      return { ok: true, link: link, orientation: { home: homeSide, away: awaySide } };
    }
  }

  /* ───────────────────────────── first point ──────────────────────────── */

  /* The moment a capture must sit at or before to be pre-match for THIS match.
     observed_first_point: the last poll that saw the match not yet started — a
     strict bound. scheduled_start: when the poller never saw it pre (a restart
     mid-match), the scheduled start, which is weaker and is labelled. */
  function closeBound(match) {
    if (match && match.first_point_at) return { at: Date.parse(match.first_point_at), source: 'observed_first_point' };
    var st = match && match.status;
    if (st === 'live' || st === 'final') {
      if (match && match.scheduled_at) return { at: Date.parse(match.scheduled_at), source: 'scheduled_start' };
      return { at: null, source: null };
    }
    return { at: null, source: null };
  }

  /* PRE or LIVE for a capture taken at captureAt. Unknown bound on a match
     that has started is LIVE — the safe direction: a pre-match price
     mislabelled live costs a close, a live price mislabelled pre corrupts the
     record. */
  function marketStateAt(captureAt, match) {
    var t = typeof captureAt === 'number' ? captureAt : Date.parse(captureAt);
    if (!isFinite(t)) return 'LIVE';
    var b = closeBound(match);
    if (b.at != null) return t <= b.at ? 'PRE' : 'LIVE';
    var st = match && match.status;
    if (st === 'scheduled' || st === 'postponed' || st == null) return 'PRE';
    return 'LIVE';
  }

  var CLOSE_MAX_LEAD_MS = 6 * 3600 * 1000;

  /* The closing reference: the LAST pre-first-point capture with a usable fair
     line, provided it was taken close enough to the start to have seen the
     close. */
  function closingReference(captures, match, opts) {
    opts = opts || {};
    var maxLead = opts.maxLeadMs != null ? opts.maxLeadMs : CLOSE_MAX_LEAD_MS;
    var b = closeBound(match);
    if (b.at == null) return { available: false, reason: 'first point not observed', bound: b };
    var best = null;
    (captures || []).forEach(function (c) {
      if (!c) return;
      if (c.market_state && c.market_state !== 'PRE') return;
      var ts = c.at != null ? (typeof c.at === 'number' ? c.at : Date.parse(c.at)) : Date.parse(c.capture_at || c.created_at);
      if (!isFinite(ts) || ts > b.at) return;
      var fair = c.sharp_fair != null ? +c.sharp_fair : null;
      if (fair == null || !(fair > 0 && fair < 1)) return;
      if (!best || ts > best.ts) best = { ts: ts, fair: fair, dec: c.best_dec != null ? +c.best_dec : null, book: c.book || null };
    });
    if (!best) return { available: false, reason: 'no pre-match capture with a fair line', bound: b };
    var lead = b.at - best.ts;
    if (lead > maxLead) return { available: false, reason: 'last pre-match capture too far from the start (' + Math.round(lead / 60000) + 'm)', bound: b, at: new Date(best.ts).toISOString(), leadMs: lead };
    return { available: true, fair: best.fair, dec: best.dec, book: best.book, at: new Date(best.ts).toISOString(), leadMs: lead, bound: b };
  }

  function clv(entryDec, closeFair) {
    var d = +entryDec, f = +closeFair;
    if (!(d > 1) || !(f > 0 && f < 1)) return null;
    return f * d - 1;
  }

  /* ───────────────────────────── health ───────────────────────────────── */

  var HEALTH = {
    live:    { healthy: 60,        degraded: 240 },          /* seconds, while a match is on court */
    market:  { healthy: 15 * 60,   degraded: 90 * 60 },
    event:   { healthy: 12 * 3600, degraded: 36 * 3600 },    /* the draw / schedule sync */
    history: { healthy: 14 * 86400, degraded: 45 * 86400 }   /* baselines and the record */
  };
  var LEVELS = ['HEALTHY', 'LIVE DEGRADED', 'MARKET DEGRADED', 'STALE', 'OFFLINE'];

  function domainLevel(ageS, th) {
    if (ageS == null || !isFinite(ageS)) return 'OFFLINE';
    if (ageS <= th.healthy) return 'HEALTHY';
    if (ageS <= th.degraded) return 'DEGRADED';
    return 'STALE';
  }
  function ageLabel(s) {
    if (s == null || !isFinite(s)) return 'never';
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + 'm ' + (r < 10 ? '0' : '') + r + 's ago';
    var h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + (m % 60) + 'm ago';
    var d = Math.floor(h / 24);
    if (d < 365) return d + 'd ago';
    /* a year is not "500d ago" to a reader deciding whether to trust a number */
    var y = Math.floor(d / 365);
    return y + 'y ' + (d % 365) + 'd ago';
  }

  /* ctx: {phase:'live'|'window'|'idle', liveAgeS, marketAgeS, marketOk,
           eventAgeS, historyAgeS, consecutiveFailures} */
  function healthLevel(ctx) {
    ctx = ctx || {};
    var d = {
      live: { level: domainLevel(ctx.liveAgeS, HEALTH.live), ageS: ctx.liveAgeS },
      market: { level: ctx.marketOk === false ? 'OFFLINE' : domainLevel(ctx.marketAgeS, HEALTH.market), ageS: ctx.marketAgeS },
      event: { level: domainLevel(ctx.eventAgeS, HEALTH.event), ageS: ctx.eventAgeS },
      history: { level: domainLevel(ctx.historyAgeS, HEALTH.history), ageS: ctx.historyAgeS }
    };
    var reasons = [], level = 'HEALTHY';
    function worse(l) { if (LEVELS.indexOf(l) > LEVELS.indexOf(level)) level = l; }
    if (ctx.phase === 'live') {
      if (d.live.level === 'OFFLINE') { worse('OFFLINE'); reasons.push('no live poller heartbeat'); }
      else if (d.live.level === 'STALE') { worse('STALE'); reasons.push('live data stale · last update ' + ageLabel(d.live.ageS)); }
      else if (d.live.level === 'DEGRADED') { worse('LIVE DEGRADED'); reasons.push('live data ' + ageLabel(d.live.ageS)); }
      if ((ctx.consecutiveFailures || 0) >= 3 && level === 'HEALTHY') { worse('LIVE DEGRADED'); reasons.push(ctx.consecutiveFailures + ' consecutive source failures'); }
    }
    if (ctx.phase === 'window') {
      if (d.live.level === 'OFFLINE') { worse('LIVE DEGRADED'); reasons.push('no live poller heartbeat yet'); }
      else if (d.live.level === 'STALE') { worse('LIVE DEGRADED'); reasons.push('live poller last wrote ' + ageLabel(d.live.ageS)); }
    }
    if (ctx.phase === 'live' || ctx.phase === 'window') {
      if (d.market.level === 'OFFLINE') { worse('MARKET DEGRADED'); reasons.push('market unreadable'); }
      else if (d.market.level !== 'HEALTHY') { worse('MARKET DEGRADED'); reasons.push('market ' + ageLabel(d.market.ageS)); }
    }
    if (d.event.level === 'OFFLINE') { worse(ctx.phase === 'idle' ? 'OFFLINE' : 'STALE'); reasons.push('schedule sync has never run'); }
    else if (d.event.level === 'STALE') { worse('STALE'); reasons.push('schedule sync ' + ageLabel(d.event.ageS)); }
    else if (d.event.level === 'DEGRADED' && ctx.phase === 'idle') { worse('STALE'); reasons.push('schedule sync ' + ageLabel(d.event.ageS)); }
    if (d.history.level === 'STALE' || d.history.level === 'OFFLINE') {
      if (level === 'HEALTHY') level = 'STALE';
      reasons.push(d.history.level === 'OFFLINE' ? 'player baselines never built' : 'player baselines ' + ageLabel(d.history.ageS));
    }
    return { level: level, reasons: reasons, domains: d, thresholds: HEALTH };
  }

  /* ───────────────────────────── score ────────────────────────────────── */

  /* set_scores is stored as [{home, away, home_tb, away_tb}]. Everything that
     reads a scoreline goes through here so one parser owns the shape. */
  function setsFrom(match) {
    var raw = match && match.set_scores;
    if (!raw) return [];
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { return []; } }
    if (!Array.isArray(raw)) return [];
    return raw.map(function (s, i) {
      return { set: i + 1, home: num(s && s.home), away: num(s && s.away),
        home_tb: num(s && s.home_tb), away_tb: num(s && s.away_tb) };
    });
  }
  /* Is the set at index idx finished? Leading a set in progress is not winning
     it: a scoreboard that counted 1-2 in the second set as a set for the
     trailer would report "one set all" while the first set winner is a set up.
     The evidence: a later set has games in it, so this one is over, or the
     score itself is a finished tennis set (6 with two clear, 7-5, or a
     tiebreak played out). current_set alone is deliberately NOT evidence — a
     feed whose pointer has moved to set 2 while set 1 still reads 4-3 is
     inconsistent, and crediting a set on an impossible score is worse than
     waiting one poll. A retirement leaves its last set unfinished, and it is
     not credited to anyone. */
  function setComplete(sets, idx, match) {
    var x = sets[idx];
    if (!x || x.home == null || x.away == null || x.home === x.away) return false;
    for (var j = idx + 1; j < sets.length; j++) if (sets[j] && ((sets[j].home || 0) > 0 || (sets[j].away || 0) > 0)) return true;
    var hi = Math.max(x.home, x.away), lo = Math.min(x.home, x.away);
    if (hi >= 6 && hi - lo >= 2) return true;
    if (hi === 7 && (lo === 5 || lo === 6)) return true;
    if (x.home_tb != null && x.away_tb != null && x.home_tb !== x.away_tb) return true;
    return false;
  }

  function setsWon(match) {
    var s = setsFrom(match), h = 0, a = 0;
    s.forEach(function (x, i) {
      if (!setComplete(s, i, match)) return;
      if (x.home > x.away) h++; else if (x.away > x.home) a++;
    });
    return { home: h, away: a };
  }
  /* A deciding set is the last one a best-of can go to. */
  function isDecidingSet(match) {
    var bo = match && match.best_of ? +match.best_of : null;
    var cur = match && match.current_set != null ? +match.current_set : null;
    if (!bo || !cur) return false;
    return cur === bo;
  }
  function scoreLine(match) {
    var s = setsFrom(match);
    if (!s.length) return '';
    return s.map(function (x) {
      if (x.home == null || x.away == null) return '';
      var tb = (x.home_tb != null && x.away_tb != null) ? ('(' + Math.min(x.home_tb, x.away_tb) + ')') : '';
      return x.home + '-' + x.away + tb;
    }).filter(Boolean).join(' ');
  }
  function num(v) { return (v == null || v === '' || !isFinite(+v)) ? null : +v; }
  function ratio(a, b) { a = num(a); b = num(b); if (a == null || b == null || b <= 0) return null; return a / b; }
  function pctDelta(live, base) { if (live == null || base == null || !(base > 0)) return null; return (live - base) / base; }
  function mean(xs) { var v = (xs || []).filter(function (x) { return x != null && isFinite(x); }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; }
  function round3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }
  function fmtPct(x, signed) { if (x == null) return '—'; var v = Math.round(x * 100); return (signed && v > 0 ? '+' : '') + v + '%'; }

  /* ───────────────────────────── baselines ────────────────────────────── */

  var SURFACES = ['hard', 'clay', 'grass', 'carpet'];
  function normSurface(s) {
    var k = String(s == null ? '' : s).toLowerCase().trim();
    if (!k) return null;
    if (/hard/.test(k)) return 'hard';
    if (/clay/.test(k)) return 'clay';
    if (/grass/.test(k)) return 'grass';
    if (/carpet/.test(k)) return 'carpet';
    return null;
  }

  /* player: a tennis.players row. career: tennis.player_career row or null.
     surface: tennis.player_surface rows (season-grained). form:
     tennis.player_form rows. rank: tennis.rankings_current row. observed: the
     accumulated live baseline or null. now: ms. */
  function buildBaseline(input) {
    var player = input.player || {}, career = input.career || null;
    var surfaceRows = input.surface || [], formRows = (input.form || []).slice();
    var rank = input.rank || null, now = input.now != null ? input.now : Date.now();
    var pid = String(player.player_id);
    var notes = [];

    var b = { player_id: pid, full_name: player.full_name || null, tour: player.tour || null,
      builder_version: VERSION, built_at: new Date(now).toISOString(),
      matches_on_file: 0, dated_matches: 0, record_available: !!(career || surfaceRows.length || formRows.length),
      career_wins: null, career_losses: null, career_matches: null, career_win_pct: null,
      last_match_at: null, days_since_last_match: null, matches_last_365: 0, matches_last_28: 0, current_streak: 0,
      form_last10_wins: null, form_last10_sample: null,
      rank: null, rank_points: null,
      hard_win_pct: null, hard_matches: null, clay_win_pct: null, clay_matches: null,
      grass_win_pct: null, grass_matches: null, carpet_win_pct: null, carpet_matches: null,
      surface_splits: {},
      obs_matches: 0, obs_hold_pct: null, obs_break_pct: null, obs_first_serve_pct: null,
      obs_first_serve_won_pct: null, obs_second_serve_won_pct: null, obs_service_points_won_pct: null,
      obs_return_points_won_pct: null, obs_ace_per_service_game: null, obs_df_per_service_game: null,
      obs_bp_saved_pct: null, obs_bp_converted_pct: null, obs_tiebreaks_won: null, obs_tiebreaks_played: null,
      obs_deciding_sets_won: null, obs_deciding_sets_played: null, obs_set_profile: null,
      style_labels: [], style_rules_version: STYLE_RULES.version, notes: notes };

    if (career) {
      b.career_wins = num(career.wins); b.career_losses = num(career.losses);
      b.career_matches = num(career.matches);
      var wp = num(career.win_pct);
      if (wp != null) b.career_win_pct = wp > 1 ? round3(wp / 100) : round3(wp);
      else if (b.career_wins != null && b.career_matches) b.career_win_pct = round3(b.career_wins / b.career_matches);
      b.matches_on_file = b.career_matches != null ? b.career_matches : 0;
      if (career.last_match) b.last_match_at = String(career.last_match).slice(0, 10);
    } else notes.push('no_career_row');

    /* surface: the view is season-grained, so the whole ingested record is the
       sum of its seasons. A percentage is recomputed from the sums, never
       averaged across seasons of different size. */
    var bySurf = {};
    surfaceRows.forEach(function (r) {
      var s = normSurface(r.surface) || 'unknown';
      var slot = bySurf[s] || (bySurf[s] = { wins: 0, losses: 0, matches: 0 });
      slot.wins += num(r.wins) || 0;
      slot.losses += num(r.losses) || 0;
      slot.matches += num(r.matches) != null ? num(r.matches) : ((num(r.wins) || 0) + (num(r.losses) || 0));
    });
    Object.keys(bySurf).forEach(function (s) {
      var v = bySurf[s], n = v.matches || (v.wins + v.losses);
      b.surface_splits[s] = { wins: v.wins, losses: v.losses, matches: n, win_pct: n ? round3(v.wins / n) : null };
      if (SURFACES.indexOf(s) >= 0) { b[s + '_win_pct'] = n ? round3(v.wins / n) : null; b[s + '_matches'] = n; }
    });
    if (!surfaceRows.length) notes.push('no_surface_splits');

    /* form: dated, newest first */
    var dated = formRows.filter(function (f) { return f.match_date && isFinite(Date.parse(f.match_date)); });
    dated.sort(function (x, y) { return Date.parse(y.match_date) - Date.parse(x.match_date); });
    b.dated_matches = dated.length;
    if (dated.length) {
      if (!b.last_match_at) b.last_match_at = String(dated[0].match_date).slice(0, 10);
      b.days_since_last_match = Math.floor((now - Date.parse(dated[0].match_date)) / 86400000);
      b.matches_last_365 = dated.filter(function (f) { return now - Date.parse(f.match_date) <= 365 * 86400000; }).length;
      b.matches_last_28 = dated.filter(function (f) { return now - Date.parse(f.match_date) <= 28 * 86400000; }).length;
      var last10 = dated.slice(0, 10);
      b.form_last10_sample = last10.length;
      b.form_last10_wins = last10.filter(function (f) { return f.won === true || f.won === 1; }).length;
      var streak = 0, kind = null;
      for (var i = 0; i < dated.length; i++) {
        var won = (dated[i].won === true || dated[i].won === 1);
        if (kind === null) kind = won;
        if (won !== kind) break;
        streak++;
      }
      b.current_streak = kind ? streak : -streak;
      if (b.days_since_last_match > 120) notes.push('long_layoff');
    } else notes.push('no_dated_form');

    if (b.last_match_at && b.days_since_last_match == null)
      b.days_since_last_match = Math.floor((now - Date.parse(b.last_match_at)) / 86400000);

    if (rank) { b.rank = num(rank.rank); b.rank_points = num(rank.points); }
    else notes.push('no_ranking_row');

    if (!b.record_available) notes.push('no_record_on_file');
    else if ((b.career_matches || 0) < 20 && dated.length < 20) notes.push('thin_record');

    var obs = input.observed;
    if (obs && obs.matches > 0) {
      b.obs_matches = obs.matches;
      ['obs_hold_pct', 'obs_break_pct', 'obs_first_serve_pct', 'obs_first_serve_won_pct', 'obs_second_serve_won_pct',
       'obs_service_points_won_pct', 'obs_return_points_won_pct', 'obs_ace_per_service_game', 'obs_df_per_service_game',
       'obs_bp_saved_pct', 'obs_bp_converted_pct'].forEach(function (k) { b[k] = obs[k] != null ? round3(+obs[k]) : null; });
      b.obs_tiebreaks_won = obs.obs_tiebreaks_won != null ? obs.obs_tiebreaks_won : null;
      b.obs_tiebreaks_played = obs.obs_tiebreaks_played != null ? obs.obs_tiebreaks_played : null;
      b.obs_deciding_sets_won = obs.obs_deciding_sets_won != null ? obs.obs_deciding_sets_won : null;
      b.obs_deciding_sets_played = obs.obs_deciding_sets_played != null ? obs.obs_deciding_sets_played : null;
      b.obs_set_profile = obs.obs_set_profile || null;
    } else notes.push('no_observed_serve_baseline');

    b.style_labels = styleLabels(b);
    return b;
  }

  /* Accumulate EdgeDesk-observed serve/return baselines from this pipeline's
     own finished matches. rows: [{state, oppState, match, sets}]. This is the
     only source of serve data EdgeDesk has: the licensed record does not carry
     point-level serve numbers, so nothing is backfilled and the sample is
     always reported beside the rate. */
  function observedBaseline(rows) {
    var n = 0, hold = [], brk = [], fs = [], fsw = [], ssw = [], spw = [], rpw = [], ace = [], df = [], bpSaved = [], bpConv = [];
    var tbW = 0, tbP = 0, dsW = 0, dsP = 0, setProfile = {};
    (rows || []).forEach(function (r) {
      var s = r.state, o = r.oppState;
      if (!s || !s.stats_available) return;
      n++;
      push(hold, ratio(s.service_games_won, s.service_games_played));
      push(brk, ratio(s.break_points_won, s.break_points_total));
      push(fs, ratio(s.first_serves_in, s.first_serves_total));
      push(fsw, ratio(s.first_serve_points_won, s.first_serve_points_total));
      push(ssw, ratio(s.second_serve_points_won, s.second_serve_points_total));
      push(spw, ratio(s.service_points_won, s.service_points_total));
      push(rpw, ratio(s.return_points_won, s.return_points_total));
      push(ace, ratio(s.aces, s.service_games_played));
      push(df, ratio(s.double_faults, s.service_games_played));
      push(bpSaved, ratio(s.break_points_saved, s.break_points_faced));
      push(bpConv, ratio(s.break_points_won, s.break_points_total));
      if (s.tiebreaks_played != null) { tbP += num(s.tiebreaks_played) || 0; tbW += num(s.tiebreaks_won) || 0; }
      var m = r.match;
      if (m && isDecidingSetPlayed(m)) {
        dsP++;
        if (m.winner_side && r.side && m.winner_side === r.side) dsW++;
      }
      (r.sets || []).forEach(function (st) {
        if (st.set_status !== 'complete') return;
        var k = String(st.set_number);
        var h = ratio(st.service_games_won, st.service_games_played);
        if (h != null) (setProfile[k] = setProfile[k] || []).push(h);
      });
    });
    var sp = {};
    Object.keys(setProfile).forEach(function (k) { sp[k] = { n: setProfile[k].length, hold_pct: round3(mean(setProfile[k])) }; });
    return { matches: n,
      obs_hold_pct: mean(hold), obs_break_pct: mean(brk), obs_first_serve_pct: mean(fs),
      obs_first_serve_won_pct: mean(fsw), obs_second_serve_won_pct: mean(ssw),
      obs_service_points_won_pct: mean(spw), obs_return_points_won_pct: mean(rpw),
      obs_ace_per_service_game: mean(ace), obs_df_per_service_game: mean(df),
      obs_bp_saved_pct: mean(bpSaved), obs_bp_converted_pct: mean(bpConv),
      obs_tiebreaks_won: tbP ? tbW : null, obs_tiebreaks_played: tbP || null,
      obs_deciding_sets_won: dsP ? dsW : null, obs_deciding_sets_played: dsP || null,
      obs_set_profile: Object.keys(sp).length ? sp : null };
    function push(arr, v) { if (v != null && isFinite(v)) arr.push(v); }
  }
  function isDecidingSetPlayed(m) {
    var bo = m && m.best_of ? +m.best_of : null;
    if (!bo) return false;
    var s = setsFrom(m);
    return s.length >= bo;
  }

  /* ───────────────────────────── style rules ──────────────────────────── */

  /* Every label has a rule, a sample requirement, and a one-line meaning. The
     version string is stored on the baseline row, so a label can always be
     traced to the rule that produced it. Serve labels need OBSERVED data,
     because the record carries none — a player EdgeDesk has not watched gets
     no serve label rather than a guessed one. */
  var STYLE_RULES = {
    version: 'tennis-style-rules-v1',
    minObserved: 3,
    rules: [
      { label: 'BIG SERVER', needs: '3 observed matches', test: function (b) { return b.obs_matches >= 3 && b.obs_ace_per_service_game != null && b.obs_ace_per_service_game >= 1.0; }, means: 'at least one ace per service game across observed matches' },
      { label: 'HOLD-HEAVY', needs: '3 observed matches', test: function (b) { return b.obs_matches >= 3 && b.obs_hold_pct != null && b.obs_hold_pct >= 0.85; }, means: 'holds at least 85% of service games observed' },
      { label: 'RETURN-FIRST', needs: '3 observed matches', test: function (b) { return b.obs_matches >= 3 && b.obs_return_points_won_pct != null && b.obs_return_points_won_pct >= 0.42; }, means: 'wins at least 42% of return points observed' },
      { label: 'BREAK-PRONE', needs: '3 observed matches', test: function (b) { return b.obs_matches >= 3 && b.obs_hold_pct != null && b.obs_hold_pct < 0.70; }, means: 'holds under 70% of service games observed' },
      { label: 'DOUBLE-FAULT RISK', needs: '3 observed matches', test: function (b) { return b.obs_matches >= 3 && b.obs_df_per_service_game != null && b.obs_df_per_service_game >= 0.5; }, means: 'at least one double fault every two service games observed' },
      { label: 'CLUTCH ON SERVE', needs: '3 observed matches', test: function (b) { return b.obs_matches >= 3 && b.obs_bp_saved_pct != null && b.obs_bp_saved_pct >= 0.65; }, means: 'saves at least 65% of break points faced, observed' },
      { label: 'TIEBREAK-TESTED', needs: '4 observed tiebreaks', test: function (b) { return (b.obs_tiebreaks_played || 0) >= 4; }, means: 'four or more tiebreaks observed' },
      { label: 'DECIDER-TESTED', needs: '3 observed deciding sets', test: function (b) { return (b.obs_deciding_sets_played || 0) >= 3; }, means: 'three or more deciding sets observed' },
      { label: 'CLAY RECORD', needs: '20 clay matches', test: function (b) { return (b.clay_matches || 0) >= 20 && b.clay_win_pct != null && b.clay_win_pct >= 0.60; }, means: 'at least 60% on clay over 20+ matches on file' },
      { label: 'GRASS RECORD', needs: '15 grass matches', test: function (b) { return (b.grass_matches || 0) >= 15 && b.grass_win_pct != null && b.grass_win_pct >= 0.60; }, means: 'at least 60% on grass over 15+ matches on file' },
      { label: 'HARD RECORD', needs: '20 hard matches', test: function (b) { return (b.hard_matches || 0) >= 20 && b.hard_win_pct != null && b.hard_win_pct >= 0.60; }, means: 'at least 60% on hard over 20+ matches on file' },
      { label: 'IN FORM', needs: '10 dated matches', test: function (b) { return (b.form_last10_sample || 0) >= 10 && (b.form_last10_wins || 0) >= 7; }, means: 'seven or more wins in the last ten on file' },
      { label: 'COLD FORM', needs: '10 dated matches', test: function (b) { return (b.form_last10_sample || 0) >= 10 && (b.form_last10_wins || 0) <= 3; }, means: 'three or fewer wins in the last ten on file' },
      { label: 'HEAVY LOAD', needs: 'dated form', test: function (b) { return (b.matches_last_28 || 0) >= 10; }, means: 'ten or more matches in the last 28 days on file' },
      { label: 'LONG LAYOFF', needs: 'dated form', test: function (b) { return b.days_since_last_match != null && b.days_since_last_match > 120; }, means: 'more than 120 days since the last match on file' }
    ]
  };
  function styleLabels(b) {
    return STYLE_RULES.rules.filter(function (r) { try { return !!r.test(b); } catch (_) { return false; } }).map(function (r) { return r.label; });
  }
  function styleCollision(a, b) {
    var A = (a && a.style_labels) || [], B = (b && b.style_labels) || [], out = [];
    function has(l, x) { return l.indexOf(x) >= 0; }
    if ((has(A, 'BIG SERVER') && has(B, 'RETURN-FIRST')) || (has(B, 'BIG SERVER') && has(A, 'RETURN-FIRST'))) out.push('BIG SERVER vs RETURN-FIRST');
    if ((has(A, 'HOLD-HEAVY') && has(B, 'BREAK-PRONE')) || (has(B, 'HOLD-HEAVY') && has(A, 'BREAK-PRONE'))) out.push('HOLD-HEAVY vs BREAK-PRONE');
    if ((has(A, 'IN FORM') && has(B, 'COLD FORM')) || (has(B, 'IN FORM') && has(A, 'COLD FORM'))) out.push('IN FORM vs COLD FORM');
    if ((has(A, 'HEAVY LOAD') && has(B, 'LONG LAYOFF')) || (has(B, 'HEAVY LOAD') && has(A, 'LONG LAYOFF'))) out.push('HEAVY LOAD vs LONG LAYOFF');
    if (has(A, 'BIG SERVER') && has(B, 'BIG SERVER')) out.push('BIG SERVER on both sides');
    if (has(A, 'TIEBREAK-TESTED') && has(B, 'TIEBREAK-TESTED')) out.push('TIEBREAK-TESTED on both sides');
    return out;
  }
  /* A surface contrast is a fact about two records, stated only when both
     samples support it. */
  function surfaceEdge(a, b, surface) {
    var s = normSurface(surface);
    if (!s || !a || !b) return null;
    var an = a[s + '_matches'], bn = b[s + '_matches'], ap = a[s + '_win_pct'], bp = b[s + '_win_pct'];
    if (an == null || bn == null || ap == null || bp == null) return null;
    if (an < 10 || bn < 10) return { surface: s, enough: false, a: { pct: ap, n: an }, b: { pct: bp, n: bn } };
    return { surface: s, enough: true, a: { pct: ap, n: an }, b: { pct: bp, n: bn }, gap: round3(ap - bp) };
  }

  /* ───────────────────────────── live rates ───────────────────────────── */

  /* Rates for one side. state: match_live_state row; opp: the other side's
     row; base: player_baselines row or null. */
  function liveRates(state, opp, base) {
    state = state || {}; opp = opp || {}; base = base || null;
    var o = { sample: { serviceGames: num(state.service_games_played), obsMatches: (base && base.obs_matches) || 0 } };
    o.holdPct = ratio(state.service_games_won, state.service_games_played);
    o.firstServePct = ratio(state.first_serves_in, state.first_serves_total);
    o.firstServeWonPct = ratio(state.first_serve_points_won, state.first_serve_points_total);
    o.secondServeWonPct = ratio(state.second_serve_points_won, state.second_serve_points_total);
    o.servicePointsWonPct = ratio(state.service_points_won, state.service_points_total);
    o.returnPointsWonPct = ratio(state.return_points_won, state.return_points_total);
    o.bpSavedPct = ratio(state.break_points_saved, state.break_points_faced);
    o.bpConvertedPct = ratio(state.break_points_won, state.break_points_total);
    o.bpFaced = num(state.break_points_faced);
    o.bpFacedPerServiceGame = ratio(state.break_points_faced, state.service_games_played);
    o.breaksMade = num(state.break_points_won);
    o.aces = num(state.aces);
    o.doubleFaults = num(state.double_faults);
    o.acePerServiceGame = ratio(state.aces, state.service_games_played);
    o.dfPerServiceGame = ratio(state.double_faults, state.service_games_played);
    o.winners = num(state.winners);
    o.unforcedErrors = num(state.unforced_errors);
    o.winnerErrorRatio = ratio(state.winners, state.unforced_errors);
    o.totalPointsWon = num(state.total_points_won);
    var tp = num(state.total_points_won), op = num(opp.total_points_won);
    o.pointsWonPct = (tp != null && op != null && (tp + op) > 0) ? tp / (tp + op) : null;
    o.pointDiff = (tp != null && op != null) ? tp - op : null;
    /* Dominance ratio: return points won as a share of the points the opponent
       failed to win on serve. A standard tennis measure, computed from two
       stored numbers and labelled as EdgeDesk's arithmetic wherever drawn. */
    var oppSpw = ratio(opp.service_points_won, opp.service_points_total);
    o.dominanceRatio = (o.returnPointsWonPct != null && oppSpw != null && (1 - oppSpw) > 0)
      ? round3(o.returnPointsWonPct / (1 - oppSpw)) : null;
    /* against the baseline — observed only, because the record has no serve data */
    o.vs = {};
    if (base && base.obs_matches >= 1) {
      o.vs.holdPct = cmp(o.holdPct, base.obs_hold_pct, base.obs_matches);
      o.vs.firstServePct = cmp(o.firstServePct, base.obs_first_serve_pct, base.obs_matches);
      o.vs.firstServeWonPct = cmp(o.firstServeWonPct, base.obs_first_serve_won_pct, base.obs_matches);
      o.vs.secondServeWonPct = cmp(o.secondServeWonPct, base.obs_second_serve_won_pct, base.obs_matches);
      o.vs.servicePointsWonPct = cmp(o.servicePointsWonPct, base.obs_service_points_won_pct, base.obs_matches);
      o.vs.returnPointsWonPct = cmp(o.returnPointsWonPct, base.obs_return_points_won_pct, base.obs_matches);
      o.vs.bpSavedPct = cmp(o.bpSavedPct, base.obs_bp_saved_pct, base.obs_matches);
      o.vs.bpConvertedPct = cmp(o.bpConvertedPct, base.obs_bp_converted_pct, base.obs_matches);
      o.vs.acePerServiceGame = cmp(o.acePerServiceGame, base.obs_ace_per_service_game, base.obs_matches);
      o.vs.dfPerServiceGame = cmp(o.dfPerServiceGame, base.obs_df_per_service_game, base.obs_matches);
    }
    return o;
    function cmp(live, baseV, n) {
      if (live == null) return null;
      var bv = num(baseV);
      if (bv == null) return { live: live, base: null, pct: null, delta: null, n: n || null };
      return { live: live, base: bv, pct: pctDelta(live, bv), delta: live - bv, n: n || null };
    }
  }

  /* Per-set hold rate for one side, from match_set_stats rows. */
  function setPace(rows, side) {
    return (rows || []).filter(function (r) { return r.side === side && r.set_number >= 1; })
      .sort(function (a, b) { return a.set_number - b.set_number; })
      .map(function (r) {
        return { set: r.set_number, status: r.set_status, source: r.stat_source,
          gamesWon: num(r.games_won),
          holdPct: ratio(r.service_games_won, r.service_games_played),
          firstServePct: ratio(r.first_serves_in, r.first_serves_total),
          servicePointsWonPct: ratio(r.service_points_won, r.service_points_total),
          returnPointsWonPct: ratio(r.return_points_won, r.return_points_total),
          aces: num(r.aces), doubleFaults: num(r.double_faults),
          winners: num(r.winners), unforcedErrors: num(r.unforced_errors),
          bpFaced: num(r.break_points_faced), bpSaved: num(r.break_points_saved),
          bpWon: num(r.break_points_won), bpTotal: num(r.break_points_total) };
      });
  }

  /* Which side the published numbers of a set favour, with the basis stated.
     It is NOT a scoreline and not a prediction: the set score is the fact, and
     this only says what the statistics under it look like. */
  function setLean(setRows) {
    var by = {};
    (setRows || []).forEach(function (r) { if (!(r.set_number >= 1)) return; (by[r.set_number] = by[r.set_number] || {})[r.side] = r; });
    return Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).map(function (n) {
      var g = by[n], H = g.home || {}, A = g.away || {}, pts = { home: 0, away: 0 }, basis = [];
      function edge(label, a, b, w) {
        a = num(a); b = num(b);
        if (a == null || b == null || a === b) return;
        if (a > b) pts.home += w; else pts.away += w;
        basis.push(label + ' ' + (a > b ? 'home' : 'away'));
      }
      edge('games', H.games_won, A.games_won, 3);
      edge('break points won', H.break_points_won, A.break_points_won, 2);
      edge('service points won', ratio(H.service_points_won, H.service_points_total), ratio(A.service_points_won, A.service_points_total), 1);
      edge('winners', H.winners, A.winners, 1);
      var he = num(H.unforced_errors), ae = num(A.unforced_errors);
      if (he != null && ae != null && he !== ae) { if (he < ae) pts.home += 1; else pts.away += 1; basis.push('fewer errors ' + (he < ae ? 'home' : 'away')); }
      var side = pts.home === pts.away ? null : (pts.home > pts.away ? 'home' : 'away');
      var complete = (H.set_status === 'complete' || A.set_status === 'complete');
      return { set: n, side: side, margin: Math.abs(pts.home - pts.away), basis: basis, complete: complete, home: H, away: A };
    });
  }

  /* ───────────────────────────── flags ────────────────────────────────── */

  var FLAG_RULES = {
    version: 'tennis-flag-rules-v1',
    minServiceGames: 3,
    FIRST_SERVE_DROP: { threshold: -0.10, means: 'first-serve percentage at least 10 points below the observed baseline, after three service games' },
    SERVE_POINTS_DECLINE: { threshold: -0.08, means: 'service points won at least 8 points below the observed baseline' },
    HOLD_UNDER_PRESSURE: { threshold: 0.75, minGames: 4, means: 'break points faced on at least three quarters of service games, over four or more' },
    BREAK_CONVERSION_LOW: { threshold: 0.20, minChances: 5, means: 'five or more break chances with at most a fifth converted' },
    BREAK_CONVERSION_HIGH: { delta: 0.20, minChances: 4, means: 'break-point conversion at least 20 points above the observed baseline over four or more chances' },
    RETURN_PRESSURE: { delta: 0.08, means: 'return points won at least 8 points above the observed baseline' },
    DOUBLE_FAULT_SPIKE: { multiple: 2.0, minCount: 3, means: 'double faults per service game at least twice the observed baseline, with three or more' },
    ACE_RATE_SHIFT: { multiple: 1.8, minCount: 4, means: 'aces per service game at least 1.8x the observed baseline, with four or more' },
    ERROR_SPIKE: { ratio: 0.8, minErrors: 12, means: 'twelve or more unforced errors and fewer winners than errors' },
    SET_HOLD_DECLINE: { threshold: -0.25, means: 'hold rate in the current set at least 25 points below the first set' },
    DECIDING_SET: { means: 'the match has reached its deciding set' },
    TIEBREAK: { means: 'a set has reached a tiebreak' },
    NO_SERVE_BASELINE: { means: 'EdgeDesk has not watched this player before, so no serve comparison is possible' }
  };

  function flagsFor(ctx) {
    var match = ctx.match || {}, out = [];
    var sides = [{ side: 'home', name: match.home_name, state: ctx.home, opp: ctx.away, base: ctx.homeBase },
                 { side: 'away', name: match.away_name, state: ctx.away, opp: ctx.home, base: ctx.awayBase }];
    var setRows = ctx.sets || [];
    sides.forEach(function (s) {
      if (!s.state) return;
      var r = liveRates(s.state, s.opp, s.base), nm = shortName(s.name || s.side);
      var games = num(s.state.service_games_played);
      var v;
      if (!s.base || !s.base.obs_matches)
        push('NO_SERVE_BASELINE', s.side, 'watch', nm + ' has no observed serve baseline on file, so tonight’s serve numbers stand alone', null, null, '0 observed matches', FLAG_RULES.NO_SERVE_BASELINE.means);
      if (games == null || games < FLAG_RULES.minServiceGames) return;
      v = r.vs.firstServePct;
      if (v && v.delta != null && v.delta <= FLAG_RULES.FIRST_SERVE_DROP.threshold)
        push('FIRST_SERVE_DROP', s.side, 'notable', nm + ' is landing ' + fmtPct(v.live) + ' of first serves against an observed ' + fmtPct(v.base), fmtPct(v.live), fmtPct(v.base), 'observed · ' + v.n + ' matches', FLAG_RULES.FIRST_SERVE_DROP.means);
      v = r.vs.servicePointsWonPct;
      if (v && v.delta != null && v.delta <= FLAG_RULES.SERVE_POINTS_DECLINE.threshold)
        push('SERVE_POINTS_DECLINE', s.side, 'notable', nm + ' is winning ' + fmtPct(v.live) + ' of service points against an observed ' + fmtPct(v.base), fmtPct(v.live), fmtPct(v.base), 'observed · ' + v.n + ' matches', FLAG_RULES.SERVE_POINTS_DECLINE.means);
      if (games >= FLAG_RULES.HOLD_UNDER_PRESSURE.minGames && r.bpFacedPerServiceGame != null && r.bpFacedPerServiceGame >= FLAG_RULES.HOLD_UNDER_PRESSURE.threshold)
        push('HOLD_UNDER_PRESSURE', s.side, 'notable', nm + ' has faced break points in ' + (r.bpFaced || 0) + ' of ' + games + ' service games', r.bpFaced + ' faced', null, games + ' service games', FLAG_RULES.HOLD_UNDER_PRESSURE.means);
      var chances = num(s.state.break_points_total);
      if (chances != null && chances >= FLAG_RULES.BREAK_CONVERSION_LOW.minChances && r.bpConvertedPct != null && r.bpConvertedPct <= FLAG_RULES.BREAK_CONVERSION_LOW.threshold)
        push('BREAK_CONVERSION_LOW', s.side, 'notable', nm + ' has converted ' + (r.breaksMade || 0) + ' of ' + chances + ' break chances', fmtPct(r.bpConvertedPct), (s.base && s.base.obs_bp_converted_pct != null) ? fmtPct(s.base.obs_bp_converted_pct) : null, chances + ' chances', FLAG_RULES.BREAK_CONVERSION_LOW.means);
      v = r.vs.bpConvertedPct;
      if (chances != null && chances >= FLAG_RULES.BREAK_CONVERSION_HIGH.minChances && v && v.delta != null && v.delta >= FLAG_RULES.BREAK_CONVERSION_HIGH.delta)
        push('BREAK_CONVERSION_HIGH', s.side, 'notable', nm + ' is converting ' + fmtPct(v.live) + ' of break chances against an observed ' + fmtPct(v.base), fmtPct(v.live), fmtPct(v.base), 'observed · ' + v.n + ' matches', FLAG_RULES.BREAK_CONVERSION_HIGH.means);
      v = r.vs.returnPointsWonPct;
      if (v && v.delta != null && v.delta >= FLAG_RULES.RETURN_PRESSURE.delta)
        push('RETURN_PRESSURE', s.side, 'notable', nm + ' is winning ' + fmtPct(v.live) + ' of return points against an observed ' + fmtPct(v.base), fmtPct(v.live), fmtPct(v.base), 'observed · ' + v.n + ' matches', FLAG_RULES.RETURN_PRESSURE.means);
      v = r.vs.dfPerServiceGame;
      if (r.doubleFaults != null && r.doubleFaults >= FLAG_RULES.DOUBLE_FAULT_SPIKE.minCount && v && v.base != null && v.base > 0 && v.live >= FLAG_RULES.DOUBLE_FAULT_SPIKE.multiple * v.base)
        push('DOUBLE_FAULT_SPIKE', s.side, 'notable', nm + ' has ' + r.doubleFaults + ' double faults in ' + games + ' service games, against an observed ' + v.base.toFixed(2) + ' per game', v.live.toFixed(2) + '/game', v.base.toFixed(2) + '/game', 'observed · ' + v.n + ' matches', FLAG_RULES.DOUBLE_FAULT_SPIKE.means);
      v = r.vs.acePerServiceGame;
      if (r.aces != null && r.aces >= FLAG_RULES.ACE_RATE_SHIFT.minCount && v && v.base != null && v.base > 0 && v.live >= FLAG_RULES.ACE_RATE_SHIFT.multiple * v.base)
        push('ACE_RATE_SHIFT', s.side, 'notable', nm + ' has ' + r.aces + ' aces in ' + games + ' service games, against an observed ' + v.base.toFixed(2) + ' per game', v.live.toFixed(2) + '/game', v.base.toFixed(2) + '/game', 'observed · ' + v.n + ' matches', FLAG_RULES.ACE_RATE_SHIFT.means);
      if (r.unforcedErrors != null && r.unforcedErrors >= FLAG_RULES.ERROR_SPIKE.minErrors && r.winnerErrorRatio != null && r.winnerErrorRatio < FLAG_RULES.ERROR_SPIKE.ratio)
        push('ERROR_SPIKE', s.side, 'watch', nm + ' has ' + r.unforcedErrors + ' unforced errors against ' + (r.winners == null ? '—' : r.winners) + ' winners', r.unforcedErrors + ' errors', null, 'source counts', FLAG_RULES.ERROR_SPIKE.means);
      var sp = setPace(setRows, s.side), s1 = sp[0], last = sp[sp.length - 1];
      if (s1 && last && last.set > 1 && s1.holdPct != null && last.holdPct != null) {
        var d = last.holdPct - s1.holdPct;
        if (d <= FLAG_RULES.SET_HOLD_DECLINE.threshold)
          push('SET_HOLD_DECLINE', s.side, 'notable', nm + '’s hold rate has fallen from ' + fmtPct(s1.holdPct) + ' in set 1 to ' + fmtPct(last.holdPct) + ' in set ' + last.set, fmtPct(last.holdPct), fmtPct(s1.holdPct) + ' set 1', 'this match', FLAG_RULES.SET_HOLD_DECLINE.means);
      }
    });
    /* match-level flags, stated once rather than per side */
    if (isDecidingSet(match)) {
      var hb = ctx.homeBase, ab = ctx.awayBase;
      var txt = 'The match has reached its deciding set.';
      [[shortName(match.home_name), hb], [shortName(match.away_name), ab]].forEach(function (p) {
        var b = p[1];
        if (b && b.obs_deciding_sets_played) txt += ' ' + p[0] + ': ' + (b.obs_deciding_sets_won || 0) + ' of ' + b.obs_deciding_sets_played + ' deciding sets won, observed.';
        else txt += ' ' + p[0] + ' has no observed deciding-set record.';
      });
      push('DECIDING_SET', null, 'watch', txt, 'set ' + match.current_set, null, 'observed record', FLAG_RULES.DECIDING_SET.means);
    }
    var tb = setsFrom(match).filter(function (s) { return s.home_tb != null || s.away_tb != null; });
    if (tb.length) push('TIEBREAK', null, 'watch', tb.length === 1 ? 'Set ' + tb[0].set + ' reached a tiebreak.' : tb.length + ' sets have reached a tiebreak.', tb.length + ' tiebreak' + (tb.length === 1 ? '' : 's'), null, 'source scoreline', FLAG_RULES.TIEBREAK.means);
    return out;

    function push(code, side, severity, explain, current, baseline, sample, means) {
      out.push({ code: code, title: code.replace(/_/g, ' '), side: side, severity: severity, explain: explain,
        current: current, baseline: baseline, sample: sample, threshold: means, rules: FLAG_RULES.version });
    }
  }
  function shortName(n) {
    if (isDoublesName(n)) return splitDoubles(n).map(function (x) { return lastWord(x); }).join('/');
    return lastWord(n);
  }
  function lastWord(n) { return String(n || '').trim().split(/\s+/).filter(Boolean).slice(-1)[0] || String(n || ''); }

  /* ───────────────────────────── the live read ────────────────────────── */

  function liveRead(ctx) {
    var match = ctx.match || {}, lines = [];
    var H = ctx.home ? liveRates(ctx.home, ctx.away, ctx.homeBase) : null;
    var A = ctx.away ? liveRates(ctx.away, ctx.home, ctx.awayBase) : null;
    var hn = shortName(match.home_name || 'Home'), an = shortName(match.away_name || 'Away');
    if (!H && !A) return { lines: [], empty: true };
    var sc = scoreLine(match);
    if (sc) lines.push({ k: 'Score', v: sc + (match.current_set ? ' · set ' + match.current_set : ''), d: match.server_side ? (shortName(match.server_side === 'home' ? match.home_name : match.away_name) + ' serving') : '' });
    /* serve */
    var serve = [];
    [[hn, H], [an, A]].forEach(function (p) {
      var r = p[1]; if (!r) return;
      if (r.holdPct != null) serve.push(p[0] + ' holding ' + fmtPct(r.holdPct) + (r.vs.holdPct && r.vs.holdPct.base != null ? ' (observed ' + fmtPct(r.vs.holdPct.base) + ')' : ''));
      else if (r.firstServePct != null) serve.push(p[0] + ' ' + fmtPct(r.firstServePct) + ' first serves in');
    });
    if (serve.length) lines.push({ k: 'Serve', v: serve.join(' · '), d: 'service games held; observed baselines are EdgeDesk’s own from matches it has watched' });
    /* return / break */
    var brk = [];
    [[hn, H], [an, A]].forEach(function (p) {
      var r = p[1]; if (!r) return;
      var c = num(r.bpConvertedPct != null ? r.breaksMade : null);
      if (c != null) brk.push(p[0] + ' ' + c + '/' + (r.bpConvertedPct != null && r.bpConvertedPct > 0 ? Math.round(c / r.bpConvertedPct) : '—') + ' break points');
    });
    if (brk.length) lines.push({ k: 'Break points', v: brk.join(' · '), d: 'converted of chances' });
    /* points */
    if (H && H.pointDiff != null) {
      var lead = H.pointDiff > 0 ? hn : (H.pointDiff < 0 ? an : null);
      lines.push({ k: 'Points', v: lead ? (lead + ' +' + Math.abs(H.pointDiff)) : 'Even', d: (H.totalPointsWon == null ? '—' : H.totalPointsWon) + ' / ' + (A && A.totalPointsWon != null ? A.totalPointsWon : '—') + ' total points won' });
    }
    /* dominance */
    if (H && H.dominanceRatio != null && A && A.dominanceRatio != null)
      lines.push({ k: 'Dominance', v: hn + ' ' + H.dominanceRatio.toFixed(2) + ' · ' + an + ' ' + A.dominanceRatio.toFixed(2), d: 'return points won against the opponent’s service points lost — above 1.00 is winning the exchange' });
    /* market */
    if (ctx.market && ctx.market.line) lines.push({ k: 'Market', v: ctx.market.line, d: ctx.market.detail || '' });
    /* unknown */
    var unk = [];
    if (match.best_of && match.status === 'live') {
      var sw = setsWon(match), need = Math.ceil(match.best_of / 2);
      var hNeed = Math.max(0, need - sw.home), aNeed = Math.max(0, need - sw.away);
      unk.push(hNeed + ' set' + (hNeed === 1 ? '' : 's') + ' from ' + hn + ', ' + aNeed + ' from ' + an);
    }
    [[hn, ctx.homeBase], [an, ctx.awayBase]].forEach(function (p) {
      if (!p[1]) unk.push(p[0] + ' has no baseline on file');
      else if (!p[1].obs_matches) unk.push(p[0] + ' has no observed serve baseline');
    });
    if (unk.length) lines.push({ k: 'Unknown', v: unk.join(' · '), d: '' });
    return { lines: lines, empty: false };
  }

  /* ───────────────────────────── matchup ──────────────────────────────── */

  function matchupRows(match, hb, ab) {
    var rows = [];
    hb = hb || null; ab = ab || null;
    function row(label, hv, av, note, fmt, better) {
      rows.push({ label: label, home: hv == null ? null : (fmt ? fmt(hv) : hv), away: av == null ? null : (fmt ? fmt(av) : av),
        homeRaw: hv, awayRaw: av, note: note || '',
        lead: (hv == null || av == null || hv === av) ? '' : (better === 'low' ? (hv < av ? 'home' : 'away') : (better === 'high' ? (hv > av ? 'home' : 'away') : '')) });
    }
    var pct = function (v) { return Math.round(v * 100) + '%'; }, f2 = function (v) { return (+v).toFixed(2); };
    row('Ranking', hb && hb.rank, ab && ab.rank, 'current published ranking', null, 'low');
    row('Ranking points', hb && hb.rank_points, ab && ab.rank_points, '', null, 'high');
    row('Career win rate', hb && hb.career_win_pct, ab && ab.career_win_pct, 'over ' + (hb ? hb.career_matches : '—') + ' / ' + (ab ? ab.career_matches : '—') + ' matches on file', pct, 'high');
    var surf = normSurface(match && match.surface);
    if (surf) {
      row(cap(surf) + ' win rate', hb && hb[surf + '_win_pct'], ab && ab[surf + '_win_pct'],
        'over ' + ((hb && hb[surf + '_matches']) || '—') + ' / ' + ((ab && ab[surf + '_matches']) || '—') + ' matches on this surface', pct, 'high');
    }
    row('Last 10 on file', hb && hb.form_last10_wins, ab && ab.form_last10_wins, 'wins in the last ten dated matches', null, 'high');
    row('Current streak', hb && hb.current_streak, ab && ab.current_streak, '', function (v) { return v > 0 ? 'W' + v : (v < 0 ? 'L' + (-v) : '—'); }, 'high');
    row('Days since last match', hb && hb.days_since_last_match, ab && ab.days_since_last_match, '', null, '');
    row('Matches, last 28 days', hb && hb.matches_last_28, ab && ab.matches_last_28, 'recent load', null, '');
    row('Matches, last 365 days', hb && hb.matches_last_365, ab && ab.matches_last_365, '', null, '');
    /* observed serve/return — the numbers the licensed record does not carry */
    row('Hold rate (observed)', hb && hb.obs_hold_pct, ab && ab.obs_hold_pct, 'over ' + ((hb && hb.obs_matches) || 0) + ' / ' + ((ab && ab.obs_matches) || 0) + ' matches EdgeDesk has watched', pct, 'high');
    row('First serve in (observed)', hb && hb.obs_first_serve_pct, ab && ab.obs_first_serve_pct, '', pct, 'high');
    row('Service points won (observed)', hb && hb.obs_service_points_won_pct, ab && ab.obs_service_points_won_pct, '', pct, 'high');
    row('Return points won (observed)', hb && hb.obs_return_points_won_pct, ab && ab.obs_return_points_won_pct, '', pct, 'high');
    row('Break points saved (observed)', hb && hb.obs_bp_saved_pct, ab && ab.obs_bp_saved_pct, '', pct, 'high');
    row('Break points converted (observed)', hb && hb.obs_bp_converted_pct, ab && ab.obs_bp_converted_pct, '', pct, 'high');
    row('Aces / service game (observed)', hb && hb.obs_ace_per_service_game, ab && ab.obs_ace_per_service_game, '', f2, 'high');
    row('Double faults / service game (observed)', hb && hb.obs_df_per_service_game, ab && ab.obs_df_per_service_game, '', f2, 'low');
    row('Tiebreaks won (observed)', hb && hb.obs_tiebreaks_won, ab && ab.obs_tiebreaks_won, 'of ' + ((hb && hb.obs_tiebreaks_played) || 0) + ' / ' + ((ab && ab.obs_tiebreaks_played) || 0) + ' played', null, 'high');
    row('Deciding sets won (observed)', hb && hb.obs_deciding_sets_won, ab && ab.obs_deciding_sets_won, 'of ' + ((hb && hb.obs_deciding_sets_played) || 0) + ' / ' + ((ab && ab.obs_deciding_sets_played) || 0) + ' played', null, 'high');
    return rows;
  }
  function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }

  /* "What we don't know" — every reason a reader should hold this loosely. */
  function unknowns(ctx) {
    var out = [], match = ctx.match || {};
    [['home', ctx.homeBase, match.home_name], ['away', ctx.awayBase, match.away_name]].forEach(function (p) {
      var b = p[1], nm = p[2] || p[0];
      if (match.is_doubles) return;
      if (!b) { out.push({ k: 'No record on file', v: nm + ' is not in the tennis record — no ranking, no surface split, no form. Nothing is inferred from the opponent.' }); return; }
      if (!b.record_available) out.push({ k: 'No record rows', v: nm + ' has a player row but no career, surface or form rows on file.' });
      if ((b.dated_matches || 0) < 10) out.push({ k: 'Thin form sample', v: nm + ': ' + (b.dated_matches || 0) + ' dated match' + ((b.dated_matches || 0) === 1 ? '' : 'es') + ' on file.' });
      if (!b.obs_matches) out.push({ k: 'No observed serve baseline', v: nm + ': EdgeDesk has not watched a match of theirs, so hold, first-serve and return rates have nothing to be compared against. The licensed record carries no point-level serve data.' });
      else if (b.obs_matches < 3) out.push({ k: 'Small observed sample', v: nm + ': serve baselines rest on ' + b.obs_matches + ' watched match' + (b.obs_matches === 1 ? '' : 'es') + '.' });
      if (b.days_since_last_match != null && b.days_since_last_match > 120) out.push({ k: 'Long layoff', v: nm + ' last played ' + b.days_since_last_match + ' days ago on file.' });
      var surf = normSurface(match.surface);
      if (surf && (b[surf + '_matches'] || 0) < 10) out.push({ k: 'Thin surface sample', v: nm + ': ' + (b[surf + '_matches'] || 0) + ' matches on ' + surf + ' on file.' });
    });
    if (match.is_doubles) out.push({ k: 'Doubles', v: 'This is a doubles match. A pair has no ranking row, no career record and no baseline, so no player comparison is drawn and no singles market is linked to it.' });
    if (ctx.market) {
      if (ctx.market.unreadable) out.push({ k: 'Market unreadable', v: 'The signals table could not be read this session; no price context is shown.' });
      else if (!ctx.market.linked) out.push({ k: 'No market on file', v: 'No odds fixture resolved to both sides of this match.' });
      else {
        if (!ctx.market.hasSharp) out.push({ k: 'No sharp anchor', v: 'No reference-book quote in the capture; the fair line is a consensus.' });
        if (ctx.market.nBooks != null && ctx.market.nBooks < 3) out.push({ k: 'Low sportsbook coverage', v: ctx.market.nBooks + ' book' + (ctx.market.nBooks === 1 ? '' : 's') + ' priced this match.' });
        if (ctx.market.closeUnavailable) out.push({ k: 'Closing line unavailable', v: ctx.market.closeReason || 'no qualified pre-match capture.' });
      }
    }
    if (ctx.live) {
      if (ctx.live.missing && ctx.live.missing.length) out.push({ k: 'Missing live statistics', v: 'The source published no ' + ctx.live.missing.join(', ') + ' for this match.' });
      if (ctx.live.stale) out.push({ k: 'Live data stale', v: 'Last live update ' + ageLabel(ctx.live.ageS) + '.' });
      if (ctx.live.setsDerived) out.push({ k: 'Set splits derived', v: 'Per-set numbers are differences between cumulative snapshots at set boundaries, not provider splits.' });
    }
    if (match.result_type === 'retirement') out.push({ k: 'Retirement', v: 'This match ended in a retirement. The statistics stop where play stopped and describe an incomplete match.' });
    if (match.result_type === 'walkover') out.push({ k: 'Walkover', v: 'No play took place, so there are no match statistics.' });
    return out;
  }

  /* Which live stat fields the source left empty for a match. */
  function missingLiveFields(home, away) {
    var fields = [['aces', 'aces'], ['double_faults', 'double faults'], ['first_serves_in', 'first-serve split'],
      ['first_serve_points_won', 'first-serve points won'], ['service_games_won', 'service games held'],
      ['break_points_total', 'break points'], ['return_points_won', 'return points'],
      ['winners', 'winners'], ['unforced_errors', 'unforced errors'], ['total_points_won', 'total points']];
    var miss = [];
    fields.forEach(function (f) {
      var a = home && home[f[0]], b = away && away[f[0]];
      if (a == null && b == null) miss.push(f[1]);
    });
    return miss;
  }

  /* ───────────────────────────── market summary ───────────────────────── */

  function sideMarket(row) {
    if (!row) return null;
    var mv = movement(row.first_best_dec, row.best_dec);
    return { selection: row.selection, sig_key: row.sig_key, open: row.first_best_dec != null ? +row.first_best_dec : null, openAt: row.first_seen_at || null,
      now: row.best_dec != null ? +row.best_dec : null, book: row.best_book || null, at: row.last_seen_at || null,
      sharp_fair: row.sharp_fair != null ? +row.sharp_fair : null, consensus_fair: row.consensus_fair != null ? +row.consensus_fair : null,
      has_sharp: !!row.has_sharp, n_books: row.n_books != null ? +row.n_books : null, edge: row.edge != null ? +row.edge : null, movement: mv,
      closing_sharp_fair: row.closing_sharp_fair != null ? +row.closing_sharp_fair : null };
  }
  function marketSummary(homeRow, awayRow) {
    var h = sideMarket(homeRow), a = sideMarket(awayRow);
    var dv = (h && a) ? devig2(h.now, a.now) : null;
    var ov = (h && a) ? devig2(h.open, a.open) : null;
    return { home: h, away: a, devig: dv ? { home: dv.a, away: dv.b, vig: dv.vig } : null,
      openDevig: ov ? { home: ov.a, away: ov.b, vig: ov.vig } : null,
      nBooks: (h && h.n_books != null) ? h.n_books : (a && a.n_books != null ? a.n_books : null),
      hasSharp: !!((h && h.has_sharp) || (a && a.has_sharp)),
      at: [h && h.at, a && a.at].filter(Boolean).sort().pop() || null };
  }

  return {
    VERSION: VERSION,
    normName: normName, tokens: tokens, surnameKey: surnameKey, firstLastKey: firstLastKey, swappedKey: swappedKey,
    initialLastKey: initialLastKey, sameName: sameName, isDoublesName: isDoublesName, splitDoubles: splitDoubles, pairKey: pairKey,
    buildPlayerIndex: buildPlayerIndex, resolvePlayer: resolvePlayer,
    impliedFromDec: impliedFromDec, decToAm: decToAm, amToDec: amToDec, fmtAm: fmtAm, fmtDecAsAm: fmtDecAsAm, devig2: devig2, movement: movement,
    groupFixtures: groupFixtures, normalizeFixture: normalizeFixture, matchesFromSignals: matchesFromSignals, linkFixture: linkFixture,
    closeBound: closeBound, marketStateAt: marketStateAt, closingReference: closingReference, clv: clv, CLOSE_MAX_LEAD_MS: CLOSE_MAX_LEAD_MS,
    HEALTH: HEALTH, LEVELS: LEVELS, healthLevel: healthLevel, domainLevel: domainLevel, ageLabel: ageLabel,
    setsFrom: setsFrom, setComplete: setComplete, setsWon: setsWon, isDecidingSet: isDecidingSet, scoreLine: scoreLine, normSurface: normSurface, SURFACES: SURFACES,
    buildBaseline: buildBaseline, observedBaseline: observedBaseline,
    STYLE_RULES: STYLE_RULES, styleLabels: styleLabels, styleCollision: styleCollision, surfaceEdge: surfaceEdge,
    liveRates: liveRates, setPace: setPace, setLean: setLean, FLAG_RULES: FLAG_RULES, flagsFor: flagsFor, liveRead: liveRead,
    matchupRows: matchupRows, unknowns: unknowns, missingLiveFields: missingLiveFields,
    sideMarket: sideMarket, marketSummary: marketSummary, shortName: shortName, fmtPct: fmtPct
  };
});
