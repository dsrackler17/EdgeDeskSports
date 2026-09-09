/* ===========================================================================
   EdgeDesk UFC — the research engine, shared by the pipeline and the page.

   ONE implementation of every rule the Live Fight Center depends on, loaded
   by tools/ufc/*.js under Node (where it is tested) and by app.html in the
   browser (where it is displayed). If the two ever disagreed a bout would
   match a market on the server and not on the screen, or a flag would fire
   in a test and not on a phone. So there is one file.

   What lives here, and the rule each part obeys:

     names       normalisation and fighter resolution — an ambiguous match is
                 NOT a match; nothing is guessed from a surname two people share
     market      a fixture's two participants are the fighters; a "Draw" (or
                 any other outcome) is a market row and can never become a
                 corner; malformed fixtures are rejected WITH a reason
     bell        PRE / LIVE tagging against the bout's own first bell, and the
                 closing reference that only a pre-bell capture may supply
     health      deterministic freshness thresholds per data domain, with the
                 live feed dominating during an event
     baselines   a fighter's historical tendencies from the fight history and
                 career microstats already on file, every rate with its sample
     live        rates, shares and differentials from the live state, compared
                 with the baseline where one exists and labelled where not
     flags       "what's different tonight" — deterministic, thresholded,
                 explained, and never a recommendation
     style       documented, reproducible classification rules

   Research, not picks. Nothing in this file produces a selection, a
   probability of its own, or a verb like "bet". The one place a probability
   appears it is the market's, de-vigged, and labelled as the market's.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDUfcResearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 'ufc-research-1.0';
  var ROUND_SECONDS = 300;

  /* ───────────────────────────── names ────────────────────────────────── */

  var SUFFIX = /\b(jr|sr|ii|iii|iv)\b\.?/g;

  /* Fold a name to the key two feeds are compared on. Accents, case,
     punctuation, generational suffixes and a quoted nickname are all
     presentation; the letters that remain are identity. Kept byte-for-byte
     compatible with the ufcNormName the page has always used, plus the
     nickname rule, so an alias written by the server matches on the page. */
  function normName(n) {
    var s = String(n == null ? '' : n);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    s = s.replace(/["“”][^"“”]*["“”]/g, ' ')       /* Jon "Bones" Jones */
         .replace(/'[^']{2,}'/g, ' ')              /* Jon 'Bones' Jones */
         .toLowerCase()
         .replace(SUFFIX, ' ')
         .replace(/[^a-z0-9]+/g, ' ')
         .trim().replace(/\s+/g, ' ');
    return s;
  }
  function tokens(n) { return normName(n).split(' ').filter(Boolean); }
  function surnameKey(n) { var t = tokens(n); return t.length ? t[t.length - 1] : ''; }
  function swappedKey(n) {
    var t = tokens(n);
    if (t.length !== 2) return '';
    return t[1] + ' ' + t[0];
  }

  /* An index over ufc.fighters rows ({fighter_id, full_name, ...}). */
  function buildFighterIndex(fighters) {
    var ix = { byId: {}, byName: {}, bySurname: {}, n: 0 };
    (fighters || []).forEach(function (f) {
      if (!f || f.fighter_id == null) return;
      var id = String(f.fighter_id);
      ix.byId[id] = f;
      var k = normName(f.full_name);
      if (k) (ix.byName[k] = ix.byName[k] || []).push(f);
      var s = surnameKey(f.full_name);
      if (s) (ix.bySurname[s] = ix.bySurname[s] || []).push(f);
      ix.n++;
    });
    return ix;
  }

  /* Resolve one participant. aliases is {alias_key -> fighter_id} (from
     ufc.fighter_aliases). Returns {fighter_id, method, candidates}; a null
     fighter_id with method 'ambiguous' means two people could be meant and
     none of them is chosen. */
  function resolveFighter(name, providerId, index, aliases) {
    aliases = aliases || {};
    var out = { fighter_id: null, method: null, candidates: [] };
    var k = normName(name);
    if (providerId != null && String(providerId) !== '') {
      var a = aliases['espn:' + String(providerId)];
      if (a && index.byId[a]) { out.fighter_id = a; out.method = 'provider_id'; return out; }
    }
    if (k && aliases['name:' + k] && index.byId[aliases['name:' + k]]) {
      out.fighter_id = aliases['name:' + k]; out.method = 'alias'; return out;
    }
    if (!k) return out;
    var exact = index.byName[k] || [];
    if (exact.length === 1) { out.fighter_id = String(exact[0].fighter_id); out.method = 'exact'; return out; }
    if (exact.length > 1) { out.method = 'ambiguous'; out.candidates = exact.map(function (f) { return String(f.fighter_id); }); return out; }
    var sw = swappedKey(k);
    if (sw) {
      var swapped = index.byName[sw] || [];
      if (swapped.length === 1) { out.fighter_id = String(swapped[0].fighter_id); out.method = 'name_order'; return out; }
      if (swapped.length > 1) { out.method = 'ambiguous'; out.candidates = swapped.map(function (f) { return String(f.fighter_id); }); return out; }
    }
    /* Surname plus first initial, only when the surname belongs to exactly
       one person on file. "Alex Volkanovski" -> Alexander Volkanovski. */
    var t = k.split(' ');
    if (t.length >= 2) {
      var sn = index.bySurname[t[t.length - 1]] || [];
      var withInitial = sn.filter(function (f) {
        var ft = tokens(f.full_name);
        return ft.length && ft[0].charAt(0) === t[0].charAt(0);
      });
      if (sn.length === 1 && withInitial.length === 1) { out.fighter_id = String(sn[0].fighter_id); out.method = 'surname'; return out; }
      if (withInitial.length > 1) { out.method = 'ambiguous'; out.candidates = withInitial.map(function (f) { return String(f.fighter_id); }); return out; }
    }
    return out;
  }

  /* ───────────────────────────── odds ─────────────────────────────────── */

  function impliedFromDec(dec) { var d = +dec; return (dec != null && isFinite(d) && d > 1) ? 1 / d : null; }
  function decToAm(dec) { var d = +dec; if (!(d > 1)) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function amToDec(am) { var a = +am; if (!isFinite(a) || a === 0) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  function fmtAm(am) { if (am == null || !isFinite(+am)) return '—'; return (am > 0 ? '+' : '') + Math.round(am); }
  function fmtDecAsAm(dec) { var a = decToAm(dec); return a == null ? '—' : fmtAm(a); }
  /* Two-way multiplicative de-vig: the market's own probability once the
     book's margin is removed. Returns null unless both prices are usable. */
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

  var DRAW_RE = /^(draw|tie|tied|no contest|nc|push|either)$/;
  function isDrawSelection(sel) { return DRAW_RE.test(normName(sel)); }

  /* Group signals rows by fixture (the odds feed's event_id: in that feed an
     MMA event IS one bout) and sort every h2h row into home / away / draw /
     other. Nothing here can put a draw in a fighter's seat: a selection
     becomes a fighter price only by matching a participant's name. */
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

  function newest(a, b) {
    return String(b.last_seen_at || '') > String(a.last_seen_at || '') ? b : a;
  }

  /* One fixture -> its normalised shape, or a rejection. */
  function normalizeFixture(f) {
    var home = normName(f.home_team), away = normName(f.away_team);
    var out = { signal_event_id: f.signal_event_id, sport_key: f.sport_key, home_team: f.home_team, away_team: f.away_team,
      commence_time: f.commence_time, h2h: { home: null, away: null, draw: null, other: [] }, markets: {}, rejections: [], ok: true };
    if (!home || !away) { out.ok = false; out.rejections.push({ reason: 'fixture_unresolved', detail: 'a participant name is empty' }); return out; }
    if (home === away) { out.ok = false; out.rejections.push({ reason: 'malformed', detail: 'both participants carry the same name' }); return out; }
    if (isDrawSelection(f.home_team) || isDrawSelection(f.away_team)) {
      out.ok = false; out.rejections.push({ reason: 'draw_as_fighter', detail: 'a fixture participant is a draw/no-contest outcome' }); return out;
    }
    (f.rows || []).forEach(function (r) {
      var m = String(r.market || '');
      (out.markets[m] = out.markets[m] || []).push(r);
      if (m !== 'h2h') return;
      var s = normName(r.selection);
      if (s === home) out.h2h.home = out.h2h.home ? newest(out.h2h.home, r) : r;
      else if (s === away) out.h2h.away = out.h2h.away ? newest(out.h2h.away, r) : r;
      else if (isDrawSelection(r.selection)) out.h2h.draw = out.h2h.draw ? newest(out.h2h.draw, r) : r;
      else {
        out.h2h.other.push(r);
        out.rejections.push({ reason: 'unknown_selection', sig_key: r.sig_key, selection: r.selection,
          detail: 'h2h selection matches neither participant and is not a draw' });
      }
    });
    return out;
  }

  /* The list a board draws from: one item per fixture whose two participants
     are two distinct named fighters, with each fighter's newest h2h row and,
     kept apart from them, any draw price. */
  function boutsFromSignals(rows) {
    var out = { bouts: [], rejected: [] };
    groupFixtures(rows).forEach(function (f) {
      var n = normalizeFixture(f);
      if (!n.ok) { out.rejected.push({ signal_event_id: n.signal_event_id, home_team: n.home_team, away_team: n.away_team, reasons: n.rejections }); return; }
      n.rejections.forEach(function (r) {
        out.rejected.push({ signal_event_id: n.signal_event_id, home_team: n.home_team, away_team: n.away_team, reasons: [r] });
      });
      out.bouts.push({ key: n.signal_event_id, signal_event_id: n.signal_event_id, commence_time: n.commence_time,
        a: { name: n.home_team, row: n.h2h.home }, b: { name: n.away_team, row: n.h2h.away },
        draw: n.h2h.draw, markets: n.markets, priced: !!(n.h2h.home && n.h2h.away) });
    });
    out.bouts.sort(function (x, y) { return (Date.parse(x.commence_time || 0) || 0) - (Date.parse(y.commence_time || 0) || 0); });
    return out;
  }

  /* Link a normalised fixture to one of an event's bouts. `resolve(name)`
     answers {fighter_id, method}. A link is made only when BOTH participants
     resolve to the bout's two corners, in either orientation. */
  function linkFixture(n, bouts, resolve) {
    if (!n || !n.ok) return { ok: false, reason: (n && n.rejections[0] && n.rejections[0].reason) || 'malformed', detail: n && n.rejections[0] && n.rejections[0].detail };
    var home = normName(n.home_team), away = normName(n.away_team);
    /* 1. the bout's own names, exactly */
    for (var i = 0; i < bouts.length; i++) {
      var b = bouts[i], rn = normName(b.red_name), bn = normName(b.blue_name);
      if (!rn || !bn) continue;
      if (home === rn && away === bn) return made(b, 'both_names_exact', 'red', 'blue');
      if (home === bn && away === rn) return made(b, 'both_names_exact', 'blue', 'red');
    }
    /* 2. through fighter identity */
    var rh = resolve ? resolve(n.home_team) : null, ra = resolve ? resolve(n.away_team) : null;
    var hid = rh && rh.fighter_id, aid = ra && ra.fighter_id;
    if ((rh && rh.method === 'ambiguous') || (ra && ra.method === 'ambiguous'))
      return { ok: false, reason: 'ambiguous_alias', detail: 'a participant name matches more than one fighter on file' };
    if (!hid || !aid) return { ok: false, reason: 'one_fighter_unresolved', detail: (!hid ? n.home_team : n.away_team) + ' did not resolve to a fighter on file' };
    for (var j = 0; j < bouts.length; j++) {
      var c = bouts[j];
      if (!c.red_fighter_id || !c.blue_fighter_id) continue;
      if (String(c.red_fighter_id) === String(hid) && String(c.blue_fighter_id) === String(aid)) return made(c, 'both_names_alias', 'red', 'blue');
      if (String(c.blue_fighter_id) === String(hid) && String(c.red_fighter_id) === String(aid)) return made(c, 'both_names_alias', 'blue', 'red');
    }
    return { ok: false, reason: 'no_bout_match', detail: 'both participants resolved but no scheduled bout pairs them' };

    function made(b, method, homeCorner, awayCorner) {
      var link = { bout_id: b.bout_id, event_id: b.event_id, signal_event_id: n.signal_event_id, sport_key: n.sport_key,
        home_team: n.home_team, away_team: n.away_team, commence_time: n.commence_time, link_method: method,
        red_selection: null, blue_selection: null, red_sig_key: null, blue_sig_key: null, draw_sig_key: null, other_sig_keys: [] };
      var homeRow = n.h2h.home, awayRow = n.h2h.away;
      if (homeCorner === 'red') { link.red_selection = n.home_team; link.blue_selection = n.away_team;
        link.red_sig_key = homeRow ? homeRow.sig_key : null; link.blue_sig_key = awayRow ? awayRow.sig_key : null; }
      else { link.blue_selection = n.home_team; link.red_selection = n.away_team;
        link.blue_sig_key = homeRow ? homeRow.sig_key : null; link.red_sig_key = awayRow ? awayRow.sig_key : null; }
      link.draw_sig_key = n.h2h.draw ? n.h2h.draw.sig_key : null;
      Object.keys(n.markets).forEach(function (m) {
        if (m === 'h2h') return;
        n.markets[m].forEach(function (r) { if (r.sig_key) link.other_sig_keys.push(r.sig_key); });
      });
      return { ok: true, link: link, orientation: { home: homeCorner, away: awayCorner } };
    }
  }

  /* ───────────────────────────── bell ─────────────────────────────────── */

  /* The moment a capture must sit at or before to be pre-fight for THIS bout.
     observed_bell: the last poll that saw the bout not yet started — a strict
     bound. card_start: when the poller never saw the bout pre (a restart mid
     fight), the card's own start, which every bout's bell is after — weaker,
     still safe, and labelled. */
  function closeBound(bout, event) {
    if (bout && bout.first_bell_at) return { at: Date.parse(bout.first_bell_at), source: 'observed_bell' };
    var st = bout && bout.status;
    if (st === 'live' || st === 'final' || st === 'no_contest') {
      if (event && event.scheduled_at) return { at: Date.parse(event.scheduled_at), source: 'card_start' };
      return { at: null, source: null };
    }
    return { at: null, source: null };
  }

  /* PRE or LIVE for a capture taken at captureAt, against the bout as known
     at that moment. Unknown bound on a bout that has started is LIVE — the
     safe direction: a pre-fight price mislabelled live costs a close, a live
     price mislabelled pre corrupts the record. */
  function marketStateAt(captureAt, bout, event) {
    var t = typeof captureAt === 'number' ? captureAt : Date.parse(captureAt);
    if (!isFinite(t)) return 'LIVE';
    var b = closeBound(bout, event);
    if (b.at != null) return t <= b.at ? 'PRE' : 'LIVE';
    var st = bout && bout.status;
    if (st === 'scheduled' || st === 'postponed' || st == null) return 'PRE';
    return 'LIVE';
  }

  var CLOSE_MAX_LEAD_MS = 6 * 3600 * 1000;

  /* The closing reference for a bout: the LAST pre-bell capture with a usable
     fair line, provided it was taken close enough to the bell to have seen the
     close. captures: [{at|capture_at|created_at, sharp_fair, best_dec, market_state}]. */
  function closingReference(captures, bout, event, opts) {
    opts = opts || {};
    var maxLead = opts.maxLeadMs != null ? opts.maxLeadMs : CLOSE_MAX_LEAD_MS;
    var b = closeBound(bout, event);
    if (b.at == null) return { available: false, reason: 'first bell not observed', bound: b };
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
    if (!best) return { available: false, reason: 'no pre-bell capture with a fair line', bound: b };
    var lead = b.at - best.ts;
    if (lead > maxLead) return { available: false, reason: 'last pre-bell capture too far from the bell (' + Math.round(lead / 60000) + 'm)', bound: b, at: new Date(best.ts).toISOString(), leadMs: lead };
    return { available: true, fair: best.fair, dec: best.dec, book: best.book, at: new Date(best.ts).toISOString(), leadMs: lead, bound: b };
  }

  function clv(entryDec, closeFair) {
    var d = +entryDec, f = +closeFair;
    if (!(d > 1) || !(f > 0 && f < 1)) return null;
    return f * d - 1;
  }

  /* ───────────────────────────── health ───────────────────────────────── */

  var HEALTH = {
    live:    { healthy: 45,        degraded: 180 },          /* seconds, during an event */
    market:  { healthy: 15 * 60,   degraded: 90 * 60 },      /* seconds, during an event window */
    event:   { healthy: 12 * 3600, degraded: 36 * 3600 },    /* seconds, event sync */
    history: { healthy: 14 * 86400, degraded: 45 * 86400 }   /* seconds, baselines */
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
    return Math.floor(h / 24) + 'd ago';
  }

  /* ctx: {phase:'live'|'window'|'idle', liveAgeS, marketAgeS, marketOk, eventAgeS, historyAgeS,
           consecutiveFailures}. phase 'live' = a bout or card is in progress;
     'window' = a card is within its window but nothing is live;
     'idle' = no card near. */
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
      /* a card inside its window with no recent poller write is not healthy,
         but nothing is live yet: degraded, and the reason says so */
      if (d.live.level === 'OFFLINE') { worse('LIVE DEGRADED'); reasons.push('no live poller heartbeat yet'); }
      else if (d.live.level === 'STALE') { worse('LIVE DEGRADED'); reasons.push('live poller last wrote ' + ageLabel(d.live.ageS)); }
    }
    if (ctx.phase === 'live' || ctx.phase === 'window') {
      if (d.market.level === 'OFFLINE') { worse('MARKET DEGRADED'); reasons.push('market unreadable'); }
      else if (d.market.level !== 'HEALTHY') { worse('MARKET DEGRADED'); reasons.push('market ' + ageLabel(d.market.ageS)); }
    }
    if (d.event.level === 'OFFLINE') { worse(ctx.phase === 'idle' ? 'OFFLINE' : 'STALE'); reasons.push('event sync has never run'); }
    else if (d.event.level === 'STALE') { worse('STALE'); reasons.push('event sync ' + ageLabel(d.event.ageS)); }
    else if (d.event.level === 'DEGRADED' && ctx.phase === 'idle') { worse('STALE'); reasons.push('event sync ' + ageLabel(d.event.ageS)); }
    if (d.history.level === 'STALE' || d.history.level === 'OFFLINE') {
      if (level === 'HEALTHY') level = 'STALE';
      reasons.push(d.history.level === 'OFFLINE' ? 'fighter baselines never built' : 'fighter baselines ' + ageLabel(d.history.ageS));
    }
    return { level: level, reasons: reasons, domains: d, thresholds: HEALTH };
  }

  /* ───────────────────────────── time ─────────────────────────────────── */

  function parseClock(s) {
    if (s == null) return null;
    if (typeof s === 'number') return isFinite(s) ? s : null;
    var m = /^(\d+):(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    return (+m[1]) * 60 + (+m[2]);
  }
  /* The UFC clock counts DOWN inside a round. Elapsed fight time is the
     rounds already finished plus what has run off this one. */
  function elapsedFromClock(round, clockSeconds, roundSeconds) {
    var rs = roundSeconds || ROUND_SECONDS;
    if (round == null || !(round >= 1)) return null;
    if (clockSeconds == null || !isFinite(clockSeconds)) return null;
    var rem = Math.max(0, Math.min(rs, +clockSeconds));
    return (round - 1) * rs + (rs - rem);
  }
  /* A finished bout: end_time is time INTO the ending round. A decision ran
     the whole distance. */
  function elapsedAtEnd(bout) {
    if (!bout) return null;
    var m = String(bout.method || '');
    if (/dec/i.test(m) && bout.scheduled_rounds) return bout.scheduled_rounds * ROUND_SECONDS;
    var er = bout.end_round != null ? +bout.end_round : null, et = parseClock(bout.end_time);
    if (er != null && et != null) return (er - 1) * ROUND_SECONDS + et;
    if (bout.elapsed_seconds != null) return +bout.elapsed_seconds;
    return null;
  }
  function elapsedOf(bout, state) {
    if (!bout) return null;
    if (bout.status === 'final' || bout.status === 'no_contest') { var e = elapsedAtEnd(bout); if (e != null) return e; }
    if (state && state.elapsed_seconds != null) return +state.elapsed_seconds;
    if (bout.elapsed_seconds != null) return +bout.elapsed_seconds;
    var cs = bout.clock_seconds != null ? +bout.clock_seconds : parseClock(bout.clock);
    return elapsedFromClock(bout.round, cs);
  }
  function fmtSeconds(s) {
    if (s == null || !isFinite(+s)) return '—';
    var n = Math.max(0, Math.round(+s));
    return Math.floor(n / 60) + ':' + ('0' + (n % 60)).slice(-2);
  }

  /* ───────────────────────────── baselines ────────────────────────────── */

  function methodClass(m) {
    var s = String(m || '').toLowerCase();
    if (!s) return 'unknown';
    if (/dq|disqual/.test(s)) return 'dq';
    if (/sub/.test(s)) return 'sub';
    if (/ko|tko|knock|stopp/.test(s)) return 'ko';
    if (/dec/.test(s)) return 'dec';
    if (/overturn|no contest|nc/.test(s)) return 'nc';
    return 'other';
  }
  function resultFor(fight, fid) {
    var w = fight && fight.winner;
    if (w == null || w === '') return 'unknown';
    var ws = String(w).toLowerCase();
    if (ws === 'draw') return 'draw';
    if (ws === 'nc' || ws === 'no contest') return 'nc';
    if (String(w) === String(fid)) return 'win';
    if (fight.opponent_id != null && String(w) === String(fight.opponent_id)) return 'loss';
    return 'loss';
  }
  function fightSeconds(f) {
    var r = f.round != null ? +f.round : null, t = parseClock(f.time);
    if (r == null || !(r >= 1) || t == null) return null;
    return (r - 1) * ROUND_SECONDS + t;
  }
  function mean(xs) { var v = xs.filter(function (x) { return x != null && isFinite(x); }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; }
  function round3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }

  /* fighter: a ufc.fighters row. fights: that fighter's ufc.fighter_fights
     rows. career: the ufc.fighter_career_stats row or null. byId: fighters by
     id (for opponent quality). observed: {fights, ...} accumulated from this
     pipeline's own live tables, or null. now: ms. */
  function buildBaseline(input) {
    var fighter = input.fighter || {}, fights = (input.fights || []).slice(), career = input.career || null;
    var byId = input.byId || {}, now = input.now != null ? input.now : Date.now();
    var fid = String(fighter.fighter_id);
    var notes = [];
    var dated = fights.filter(function (f) { return f.date && isFinite(Date.parse(f.date)); });
    dated.sort(function (a, b) { return Date.parse(b.date) - Date.parse(a.date); });

    var b = { fighter_id: fid, full_name: fighter.full_name || null, builder_version: VERSION,
      fights_on_file: fights.length, dated_fights: dated.length, career_stats_available: !!career,
      slpm: null, sapm: null, striking_accuracy: null, striking_defense: null, takedown_avg: null, takedown_accuracy: null,
      takedown_defense: null, submission_avg: null, knockdown_avg: null, control_time_avg: null,
      wins: 0, losses: 0, draws: 0, no_contests: 0, win_ko: 0, win_sub: 0, win_dec: 0, loss_ko: 0, loss_sub: 0, loss_dec: 0,
      finish_rate: null, ko_rate: null, sub_rate: null, decision_rate: null, finished_loss_rate: null, distance_rate: null,
      avg_fight_seconds: null, total_fight_seconds: 0, timed_fights: 0, five_round_scheduled: 0, fights_past_r3: 0,
      r4_r5_seconds: 0, finishes_after_r3: 0, title_fights: 0, round_finish_dist: {},
      last_fight_at: null, days_since_last_fight: null, fights_last_365: 0, fights_last_730: 0, current_streak: 0,
      last3_wins: null, last3_finishes: null, last3_avg_fight_seconds: null, last5_wins: null, last5_finishes: null, last5_avg_fight_seconds: null,
      opp_avg_win_pct: null, opp_sample: 0, opp_adj_win_pct: null,
      obs_fights: 0, obs_sig_attempts_per_min: null, obs_sig_landed_per_min: null, obs_absorbed_per_min: null, obs_td_attempts_per_15: null,
      obs_head_share: null, obs_body_share: null, obs_leg_share: null, obs_distance_share: null, obs_clinch_share: null, obs_ground_share: null,
      obs_round_pace: null, style_labels: [], style_rules_version: STYLE_RULES.version, notes: notes };

    if (career) {
      ['slpm', 'sapm', 'striking_accuracy', 'striking_defense', 'takedown_avg', 'takedown_accuracy', 'takedown_defense',
       'submission_avg', 'knockdown_avg', 'control_time_avg'].forEach(function (k) { b[k] = career[k] != null && isFinite(+career[k]) ? +career[k] : null; });
      /* percentages arrive as 0.45 or 45 depending on the sync; store 0..1 */
      ['striking_accuracy', 'striking_defense', 'takedown_accuracy', 'takedown_defense'].forEach(function (k) { if (b[k] != null && b[k] > 1) b[k] = b[k] / 100; });
    } else notes.push('no_career_stats');

    var secs = [], distance = 0, finishedLosses = 0, oppPcts = [], oppWeighted = { num: 0, den: 0 };
    fights.forEach(function (f) {
      var res = resultFor(f, fid), mc = methodClass(f.method);
      if (res === 'win') { b.wins++; if (mc === 'ko') b.win_ko++; else if (mc === 'sub') b.win_sub++; else if (mc === 'dec') b.win_dec++; }
      else if (res === 'loss') { b.losses++; if (mc === 'ko') b.loss_ko++; else if (mc === 'sub') b.loss_sub++; else if (mc === 'dec') b.loss_dec++; if (mc === 'ko' || mc === 'sub') finishedLosses++; }
      else if (res === 'draw') b.draws++;
      else if (res === 'nc') b.no_contests++;
      var s = fightSeconds(f);
      if (s != null) { secs.push(s); b.total_fight_seconds += s; b.timed_fights++; }
      if (f.went_distance === true || mc === 'dec') distance++;
      if (f.title_fight) { b.title_fights++; b.five_round_scheduled++; }
      var r = f.round != null ? +f.round : null;
      if (r != null && r >= 4) { b.fights_past_r3++; if (s != null) b.r4_r5_seconds += Math.max(0, s - 3 * ROUND_SECONDS); if (mc === 'ko' || mc === 'sub') b.finishes_after_r3++; }
      if (r != null && (mc === 'ko' || mc === 'sub')) b.round_finish_dist[String(r)] = (b.round_finish_dist[String(r)] || 0) + 1;
      var opp = f.opponent_id != null ? byId[String(f.opponent_id)] : null;
      if (opp && opp.wins != null && opp.losses != null && (+opp.wins + +opp.losses) > 0) {
        var p = +opp.wins / (+opp.wins + +opp.losses);
        oppPcts.push(p);
        if (res === 'win' || res === 'loss') { oppWeighted.den += p; if (res === 'win') oppWeighted.num += p; }
      }
    });
    var decided = b.wins + b.losses;
    if (b.wins > 0) { b.finish_rate = round3((b.win_ko + b.win_sub) / b.wins); b.ko_rate = round3(b.win_ko / b.wins); b.sub_rate = round3(b.win_sub / b.wins); b.decision_rate = round3(b.win_dec / b.wins); }
    if (b.losses > 0) b.finished_loss_rate = round3(finishedLosses / b.losses);
    if (decided > 0) b.distance_rate = round3(distance / decided);
    b.avg_fight_seconds = secs.length ? Math.round(mean(secs)) : null;
    if (oppPcts.length) { b.opp_avg_win_pct = round3(mean(oppPcts)); b.opp_sample = oppPcts.length; }
    if (oppWeighted.den > 0 && oppPcts.length >= 5) b.opp_adj_win_pct = round3(oppWeighted.num / oppWeighted.den);

    if (dated.length) {
      b.last_fight_at = String(dated[0].date).slice(0, 10);
      b.days_since_last_fight = Math.floor((now - Date.parse(dated[0].date)) / 86400000);
      b.fights_last_365 = dated.filter(function (f) { return now - Date.parse(f.date) <= 365 * 86400000; }).length;
      b.fights_last_730 = dated.filter(function (f) { return now - Date.parse(f.date) <= 730 * 86400000; }).length;
      var streak = 0, kind = null;
      for (var i = 0; i < dated.length; i++) {
        var rr = resultFor(dated[i], fid);
        if (rr === 'nc') continue;
        if (rr !== 'win' && rr !== 'loss') break;
        if (!kind) kind = rr;
        if (rr !== kind) break;
        streak++;
      }
      b.current_streak = kind === 'loss' ? -streak : streak;
      function recent(n) {
        var slice = dated.slice(0, n);
        var wins = slice.filter(function (f) { return resultFor(f, fid) === 'win'; });
        var fin = wins.filter(function (f) { var m = methodClass(f.method); return m === 'ko' || m === 'sub'; });
        var ss = slice.map(fightSeconds).filter(function (x) { return x != null; });
        return { wins: wins.length, finishes: fin.length, avg: ss.length ? Math.round(mean(ss)) : null, n: slice.length };
      }
      var r3 = recent(3), r5 = recent(5);
      if (r3.n >= 3) { b.last3_wins = r3.wins; b.last3_finishes = r3.finishes; b.last3_avg_fight_seconds = r3.avg; }
      if (r5.n >= 5) { b.last5_wins = r5.wins; b.last5_finishes = r5.finishes; b.last5_avg_fight_seconds = r5.avg; }
      if (b.days_since_last_fight > 365) notes.push('long_layoff');
    }
    if (!fights.length) notes.push('debut_or_no_history');
    else if (dated.length < 5) notes.push('few_fights');
    if (!b.fights_past_r3) notes.push('no_r4_r5_history');
    if (!b.five_round_scheduled) notes.push('no_five_round_history_on_file');

    var obs = input.observed;
    if (obs && obs.fights > 0) {
      b.obs_fights = obs.fights;
      ['obs_sig_attempts_per_min', 'obs_sig_landed_per_min', 'obs_absorbed_per_min', 'obs_td_attempts_per_15', 'obs_head_share', 'obs_body_share',
       'obs_leg_share', 'obs_distance_share', 'obs_clinch_share', 'obs_ground_share'].forEach(function (k) { b[k] = obs[k] != null ? round3(+obs[k]) : null; });
      b.obs_round_pace = obs.obs_round_pace || null;
    } else notes.push('no_observed_live_baseline');

    b.style_labels = styleLabels(b);
    return b;
  }

  /* Accumulate EdgeDesk-observed baselines from this pipeline's own final
     bouts. rows: [{state (fight_live_state row for the fighter's corner),
     oppState, elapsed, rounds: [{round, round_seconds, sig_strikes_attempted}]}]. */
  function observedBaseline(rows) {
    var n = 0, att = [], landed = [], absorbed = [], tdA = [], head = [], body = [], leg = [], dist = [], clinch = [], ground = [], pace = {};
    (rows || []).forEach(function (r) {
      var s = r.state, o = r.oppState, el = r.elapsed;
      if (!s || !el || el < 60) return;
      n++;
      var mins = el / 60;
      if (s.sig_strikes_attempted != null) att.push(s.sig_strikes_attempted / mins);
      if (s.sig_strikes_landed != null) landed.push(s.sig_strikes_landed / mins);
      if (o && o.sig_strikes_landed != null) absorbed.push(o.sig_strikes_landed / mins);
      if (s.takedowns_attempted != null) tdA.push(s.takedowns_attempted / mins * 15);
      var tgt = sum3(s.head_strikes_landed, s.body_strikes_landed, s.leg_strikes_landed);
      if (tgt > 0) { head.push(s.head_strikes_landed / tgt); body.push(s.body_strikes_landed / tgt); leg.push(s.leg_strikes_landed / tgt); }
      var pos = sum3(s.distance_strikes_landed, s.clinch_strikes_landed, s.ground_strikes_landed);
      if (pos > 0) { dist.push(s.distance_strikes_landed / pos); clinch.push(s.clinch_strikes_landed / pos); ground.push(s.ground_strikes_landed / pos); }
      (r.rounds || []).forEach(function (rd) {
        if (rd.sig_strikes_attempted == null || !rd.round_seconds || rd.round_seconds < 60) return;
        var k = String(rd.round);
        (pace[k] = pace[k] || []).push(rd.sig_strikes_attempted / (rd.round_seconds / 60));
      });
    });
    var rp = {};
    Object.keys(pace).forEach(function (k) { rp[k] = { n: pace[k].length, sig_attempts_per_min: round3(mean(pace[k])) }; });
    return { fights: n, obs_sig_attempts_per_min: mean(att), obs_sig_landed_per_min: mean(landed), obs_absorbed_per_min: mean(absorbed),
      obs_td_attempts_per_15: mean(tdA), obs_head_share: mean(head), obs_body_share: mean(body), obs_leg_share: mean(leg),
      obs_distance_share: mean(dist), obs_clinch_share: mean(clinch), obs_ground_share: mean(ground), obs_round_pace: Object.keys(rp).length ? rp : null };
  }
  function sum3(a, b, c) { return (a == null ? 0 : +a) + (b == null ? 0 : +b) + (c == null ? 0 : +c); }

  /* ───────────────────────────── style rules ──────────────────────────── */

  /* Every label has a rule, a sample requirement, and a one-line meaning.
     The version string is stored on the baseline row, so a label can always
     be traced to the rule that produced it. */
  var STYLE_RULES = {
    version: 'style-rules-v1',
    rules: [
      { label: 'WRESTLER', needs: 'career stats', test: function (b) { return b.takedown_avg != null && b.takedown_avg >= 2.5; }, means: 'takedowns per 15 minutes at or above 2.5' },
      { label: 'STRIKER', needs: 'career stats', test: function (b) { return b.slpm != null && b.slpm >= 4.0 && b.takedown_avg != null && b.takedown_avg < 1.0; }, means: 'landed sig. strikes/min at or above 4.0 with under 1.0 takedowns per 15' },
      { label: 'HIGH PACE', needs: 'career stats', test: function (b) { return b.slpm != null && b.slpm >= 5.0; }, means: 'landed sig. strikes/min at or above 5.0' },
      { label: 'LOW PACE', needs: 'career stats', test: function (b) { return b.slpm != null && b.slpm < 3.0; }, means: 'landed sig. strikes/min under 3.0' },
      { label: 'PRESSURE', needs: 'career stats', test: function (b) { return b.slpm != null && b.sapm != null && b.slpm >= 4.5 && b.sapm >= 3.5; }, means: 'high output and high absorption: exchanges, not counters' },
      { label: 'COUNTER', needs: 'career stats', test: function (b) { return b.striking_defense != null && b.sapm != null && b.slpm != null && b.striking_defense >= 0.58 && b.sapm <= 3.0 && b.slpm < 4.0; }, means: 'strong defense, low absorption, moderate output' },
      { label: 'GRAPPLING-HEAVY', needs: 'career stats', test: function (b) { return (b.takedown_avg != null && b.takedown_avg >= 3.0) || (b.submission_avg != null && b.submission_avg >= 1.0); }, means: 'takedowns per 15 at or above 3.0, or submission attempts per 15 at or above 1.0' },
      { label: 'SUBMISSION THREAT', needs: '5 wins or career stats', test: function (b) { return (b.wins >= 5 && b.sub_rate != null && b.sub_rate >= 0.4) || (b.submission_avg != null && b.submission_avg >= 1.2); }, means: 'at least 40% of wins by submission over 5+ wins, or 1.2+ attempts per 15' },
      { label: 'FINISH-HEAVY', needs: '5 wins', test: function (b) { return b.wins >= 5 && b.finish_rate != null && b.finish_rate >= 0.6; }, means: 'at least 60% of wins inside the distance over 5+ wins' },
      { label: 'DECISION-HEAVY', needs: '5 wins', test: function (b) { return b.wins >= 5 && b.decision_rate != null && b.decision_rate >= 0.6; }, means: 'at least 60% of wins by decision over 5+ wins' },
      { label: 'DURABLE', needs: '3 losses', test: function (b) { return b.losses >= 3 && b.finished_loss_rate != null && b.finished_loss_rate <= 0.25; }, means: 'no more than a quarter of losses by finish over 3+ losses' },
      { label: 'FIVE-ROUND TESTED', needs: 'fight history', test: function (b) { return b.fights_past_r3 >= 2; }, means: 'has fought into round 4 or 5 at least twice on file' }
    ]
  };
  function styleLabels(b) {
    return STYLE_RULES.rules.filter(function (r) { try { return !!r.test(b); } catch (_) { return false; } }).map(function (r) { return r.label; });
  }
  function styleCollision(a, b) {
    var A = (a && a.style_labels) || [], B = (b && b.style_labels) || [];
    var out = [];
    function has(l, x) { return l.indexOf(x) >= 0; }
    if ((has(A, 'STRIKER') && (has(B, 'WRESTLER') || has(B, 'GRAPPLING-HEAVY'))) || (has(B, 'STRIKER') && (has(A, 'WRESTLER') || has(A, 'GRAPPLING-HEAVY'))))
      out.push('STRIKER vs WRESTLER');
    if ((has(A, 'HIGH PACE') && has(B, 'LOW PACE')) || (has(B, 'HIGH PACE') && has(A, 'LOW PACE'))) out.push('HIGH PACE vs LOW PACE');
    if ((has(A, 'PRESSURE') && has(B, 'COUNTER')) || (has(B, 'PRESSURE') && has(A, 'COUNTER'))) out.push('PRESSURE vs COUNTER');
    if (has(A, 'GRAPPLING-HEAVY') && has(B, 'GRAPPLING-HEAVY')) out.push('GRAPPLING-HEAVY on both sides');
    if (has(A, 'FINISH-HEAVY') && has(B, 'FINISH-HEAVY')) out.push('FINISH-HEAVY on both sides');
    if (has(A, 'DECISION-HEAVY') && has(B, 'DECISION-HEAVY')) out.push('DECISION-HEAVY on both sides');
    if ((has(A, 'FINISH-HEAVY') && has(B, 'DURABLE')) || (has(B, 'FINISH-HEAVY') && has(A, 'DURABLE'))) out.push('FINISHER vs DURABLE');
    return out;
  }

  /* ───────────────────────────── live rates ───────────────────────────── */

  function num(v) { return (v == null || !isFinite(+v)) ? null : +v; }
  function ratio(a, b) { a = num(a); b = num(b); if (a == null || b == null || b <= 0) return null; return a / b; }
  function pctDelta(live, base) { if (live == null || base == null || !(base > 0)) return null; return (live - base) / base; }

  /* Rates for one corner. state: fight_live_state row; opp: the other corner's
     row; elapsed: seconds; base: fighter_baselines row or null. */
  function liveRates(state, opp, elapsed, base) {
    state = state || {}; opp = opp || {}; base = base || null;
    var mins = elapsed != null && elapsed > 0 ? elapsed / 60 : null;
    var o = { elapsed: elapsed, mins: mins, sample: { elapsed: elapsed, careerStats: !!(base && base.career_stats_available), obsFights: (base && base.obs_fights) || 0 } };
    var attempts = num(state.sig_strikes_attempted), landed = num(state.sig_strikes_landed);
    o.sigAttemptsPerMin = mins ? ratio(attempts, mins) : null;
    o.sigLandedPerMin = mins ? ratio(landed, mins) : null;
    o.accuracy = ratio(landed, attempts);
    o.absorbedPerMin = mins ? ratio(num(opp.sig_strikes_landed), mins) : null;
    o.oppAccuracy = ratio(num(opp.sig_strikes_landed), num(opp.sig_strikes_attempted));
    o.defense = o.oppAccuracy == null ? null : 1 - o.oppAccuracy;
    o.sigDiff = (landed != null && num(opp.sig_strikes_landed) != null) ? landed - num(opp.sig_strikes_landed) : null;
    o.headDiff = (num(state.head_strikes_landed) != null && num(opp.head_strikes_landed) != null) ? num(state.head_strikes_landed) - num(opp.head_strikes_landed) : null;
    o.tdAttemptsPer15 = mins ? ratio(num(state.takedowns_attempted), mins / 15) : null;
    o.tdLandedPer15 = mins ? ratio(num(state.takedowns_landed), mins / 15) : null;
    o.tdAccuracy = ratio(num(state.takedowns_landed), num(state.takedowns_attempted));
    var oppTdA = num(opp.takedowns_attempted), oppTdL = num(opp.takedowns_landed);
    o.tdDefense = (oppTdA != null && oppTdA > 0 && oppTdL != null) ? 1 - oppTdL / oppTdA : null;
    o.subPer15 = mins ? ratio(num(state.submission_attempts), mins / 15) : null;
    o.controlSeconds = num(state.control_seconds);
    o.controlShare = (elapsed && o.controlSeconds != null) ? o.controlSeconds / elapsed : null;
    o.controlDiff = (o.controlSeconds != null && num(opp.control_seconds) != null) ? o.controlSeconds - num(opp.control_seconds) : null;
    o.knockdowns = num(state.knockdowns);
    var tgt = sum3(state.head_strikes_landed, state.body_strikes_landed, state.leg_strikes_landed);
    o.target = tgt > 0 ? { head: num(state.head_strikes_landed) / tgt, body: num(state.body_strikes_landed) / tgt, leg: num(state.leg_strikes_landed) / tgt, n: tgt } : null;
    var pos = sum3(state.distance_strikes_landed, state.clinch_strikes_landed, state.ground_strikes_landed);
    o.position = pos > 0 ? { distance: num(state.distance_strikes_landed) / pos, clinch: num(state.clinch_strikes_landed) / pos, ground: num(state.ground_strikes_landed) / pos, n: pos } : null;
    o.groundStrikes = num(state.ground_strikes_landed);
    /* against the baseline */
    o.vs = {};
    if (base) {
      o.vs.sigLandedPerMin = cmp(o.sigLandedPerMin, base.slpm, 'career');
      o.vs.absorbedPerMin = cmp(o.absorbedPerMin, base.sapm, 'career');
      o.vs.accuracy = cmp(o.accuracy, base.striking_accuracy, 'career');
      o.vs.defense = cmp(o.defense, base.striking_defense, 'career');
      o.vs.tdLandedPer15 = cmp(o.tdLandedPer15, base.takedown_avg, 'career');
      o.vs.tdAccuracy = cmp(o.tdAccuracy, base.takedown_accuracy, 'career');
      o.vs.tdDefense = cmp(o.tdDefense, base.takedown_defense, 'career');
      o.vs.subPer15 = cmp(o.subPer15, base.submission_avg, 'career');
      if (base.obs_fights >= 1) {
        o.vs.sigAttemptsPerMin = cmp(o.sigAttemptsPerMin, base.obs_sig_attempts_per_min, 'observed', base.obs_fights);
        o.vs.tdAttemptsPer15 = cmp(o.tdAttemptsPer15, base.obs_td_attempts_per_15, 'observed', base.obs_fights);
        o.vs.body = cmp(o.target ? o.target.body : null, base.obs_body_share, 'observed', base.obs_fights);
        o.vs.leg = cmp(o.target ? o.target.leg : null, base.obs_leg_share, 'observed', base.obs_fights);
        o.vs.head = cmp(o.target ? o.target.head : null, base.obs_head_share, 'observed', base.obs_fights);
        o.vs.distance = cmp(o.position ? o.position.distance : null, base.obs_distance_share, 'observed', base.obs_fights);
        o.vs.clinch = cmp(o.position ? o.position.clinch : null, base.obs_clinch_share, 'observed', base.obs_fights);
        o.vs.ground = cmp(o.position ? o.position.ground : null, base.obs_ground_share, 'observed', base.obs_fights);
      }
    }
    return o;
    function cmp(live, baseV, kind, n) {
      if (live == null) return null;
      var bv = num(baseV);
      if (bv == null) return { live: live, base: null, pct: null, kind: kind, n: n || null };
      return { live: live, base: bv, pct: pctDelta(live, bv), kind: kind, n: n || null };
    }
  }

  /* Per-round pace from fight_round_stats rows for one corner. */
  function roundPace(rows, corner) {
    return (rows || []).filter(function (r) { return r.corner === corner && r.round >= 1; })
      .sort(function (a, b) { return a.round - b.round; })
      .map(function (r) {
        var secs = num(r.round_seconds);
        var mins = secs && secs >= 30 ? secs / 60 : null;
        return { round: r.round, seconds: secs, status: r.round_status, source: r.stat_source,
          sigAttemptsPerMin: mins ? ratio(num(r.sig_strikes_attempted), mins) : null,
          sigLandedPerMin: mins ? ratio(num(r.sig_strikes_landed), mins) : null,
          sigLanded: num(r.sig_strikes_landed), sigAttempted: num(r.sig_strikes_attempted),
          tdLanded: num(r.takedowns_landed), tdAttempted: num(r.takedowns_attempted),
          control: num(r.control_seconds), kd: num(r.knockdowns), sub: num(r.submission_attempts) };
      });
  }

  /* A statistical lean per round: which corner the round's published numbers
     favour, with the basis stated. It is NOT a scorecard and is labelled so
     wherever it is drawn. Requires both corners' rows. */
  function roundLean(roundRows) {
    var by = {};
    (roundRows || []).forEach(function (r) { if (!(r.round >= 1)) return; (by[r.round] = by[r.round] || {})[r.corner] = r; });
    return Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).map(function (n) {
      var g = by[n], R = g.red || {}, B = g.blue || {}, pts = { red: 0, blue: 0 }, basis = [];
      function edge(label, a, b, w) {
        a = num(a); b = num(b);
        if (a == null || b == null || a === b) return;
        if (a > b) pts.red += w; else pts.blue += w;
        basis.push(label + ' ' + (a > b ? 'red' : 'blue'));
      }
      edge('knockdowns', R.knockdowns, B.knockdowns, 3);
      edge('sig. strikes', R.sig_strikes_landed, B.sig_strikes_landed, 2);
      edge('takedowns', R.takedowns_landed, B.takedowns_landed, 1);
      edge('control', R.control_seconds, B.control_seconds, 1);
      edge('sub attempts', R.submission_attempts, B.submission_attempts, 1);
      var corner = pts.red === pts.blue ? null : (pts.red > pts.blue ? 'red' : 'blue');
      var complete = (R.round_status === 'complete' || B.round_status === 'complete');
      return { round: n, corner: corner, margin: Math.abs(pts.red - pts.blue), basis: basis, complete: complete, red: R, blue: B };
    });
  }

  /* ───────────────────────────── flags ────────────────────────────────── */

  var EPS = 1e-9;   /* threshold compares are on decimals: 0.6 - 0.4 is not quite 0.2 in floating point */
  var FLAG_RULES = {
    version: 'flag-rules-v1',
    minElapsed: 120,
    PACE_SPIKE: { threshold: 0.25, means: 'sig. strikes landed per minute at least 25% above the career rate, after two minutes' },
    PACE_DROP: { threshold: -0.25, means: 'sig. strikes landed per minute at least 25% below the career rate, after two minutes' },
    WRESTLING_SHIFT: { threshold: 1.8, minAttempts: 3, means: 'takedown attempts per 15 at least 1.8x the career landed rate, with 3+ attempts' },
    FAILED_WRESTLING_LOAD: { minAttempts: 4, maxAccuracy: 0.34, means: '4+ takedown attempts landing a third or less' },
    DEFENSIVE_LEAK: { threshold: 0.3, means: 'sig. strikes absorbed per minute at least 30% above the career rate' },
    UNUSUAL_ACCURACY: { threshold: 0.2, minAttempts: 15, means: 'accuracy at least 20 points from the career figure over 15+ attempts' },
    TARGET_SHIFT: { threshold: 0.12, minObs: 3, minLanded: 15, means: 'body or leg share at least 12 points above the observed share, over 3+ observed fights' },
    RANGE_SHIFT: { threshold: 0.2, minObs: 3, minLanded: 15, means: 'distance share at least 20 points from the observed share, over 3+ observed fights' },
    CONTROL_WITHOUT_DAMAGE: { minControl: 120, maxGround: 8, means: 'two minutes or more of control with eight or fewer ground strikes landed' },
    ROUND_PACE_DECLINE: { threshold: -0.25, means: 'this round\'s sig. attempt rate at least 25% below round 1' },
    LATE_ROUND_PROFILE: { means: 'a fighter with 4-5 round history on file is entering those rounds' },
    KNOCKDOWN: { means: 'a knockdown was scored' }
  };

  function flagsFor(ctx) {
    var bout = ctx.bout || {}, elapsed = ctx.elapsed, out = [];
    var sides = [{ corner: 'red', name: bout.red_name, state: ctx.red, opp: ctx.blue, base: ctx.redBase },
                 { corner: 'blue', name: bout.blue_name, state: ctx.blue, opp: ctx.red, base: ctx.blueBase }];
    var rounds = ctx.rounds || [];
    sides.forEach(function (s) {
      if (!s.state) return;
      var r = liveRates(s.state, s.opp, elapsed, s.base), nm = s.name || s.corner;
      var who = nm.split(' ').slice(-1)[0];
      if (r.knockdowns != null && r.knockdowns > 0)
        push('KNOCKDOWN', s.corner, 'watch', r.knockdowns + ' knockdown' + (r.knockdowns === 1 ? '' : 's') + ' by ' + who, r.knockdowns, null, null, 'source count');
      if (elapsed == null || elapsed < FLAG_RULES.minElapsed) return;
      var v;
      v = r.vs.sigLandedPerMin;
      if (v && v.pct != null) {
        if (v.pct >= FLAG_RULES.PACE_SPIKE.threshold - EPS) push('PACE_SPIKE', s.corner, 'notable', who + ' is landing ' + fmtPct(v.pct, true) + ' vs career pace', v.live.toFixed(2) + '/min', v.base.toFixed(2) + '/min', 'career', FLAG_RULES.PACE_SPIKE.means);
        else if (v.pct <= FLAG_RULES.PACE_DROP.threshold + EPS) push('PACE_DROP', s.corner, 'notable', who + ' is landing ' + fmtPct(v.pct, true) + ' vs career pace', v.live.toFixed(2) + '/min', v.base.toFixed(2) + '/min', 'career', FLAG_RULES.PACE_DROP.means);
      }
      var tdA = num(s.state.takedowns_attempted);
      if (tdA != null && tdA >= FLAG_RULES.WRESTLING_SHIFT.minAttempts && s.base && s.base.takedown_avg != null && s.base.takedown_avg > 0 && r.tdAttemptsPer15 != null
          && r.tdAttemptsPer15 >= FLAG_RULES.WRESTLING_SHIFT.threshold * s.base.takedown_avg - EPS)
        push('WRESTLING_SHIFT', s.corner, 'notable', who + ': ' + tdA + ' takedown attempts through ' + fmtSeconds(elapsed) + ' against a ' + s.base.takedown_avg.toFixed(1) + '/15 career landed rate', r.tdAttemptsPer15.toFixed(1) + ' att/15', s.base.takedown_avg.toFixed(2) + ' landed/15', 'career', FLAG_RULES.WRESTLING_SHIFT.means);
      if (tdA != null && tdA >= FLAG_RULES.FAILED_WRESTLING_LOAD.minAttempts && r.tdAccuracy != null && r.tdAccuracy <= FLAG_RULES.FAILED_WRESTLING_LOAD.maxAccuracy + EPS)
        push('FAILED_WRESTLING_LOAD', s.corner, 'notable', who + ' has landed ' + num(s.state.takedowns_landed) + ' of ' + tdA + ' takedowns', Math.round(r.tdAccuracy * 100) + '%', s.base && s.base.takedown_accuracy != null ? Math.round(s.base.takedown_accuracy * 100) + '% career' : null, 'career', FLAG_RULES.FAILED_WRESTLING_LOAD.means);
      v = r.vs.absorbedPerMin;
      if (v && v.pct != null && v.pct >= FLAG_RULES.DEFENSIVE_LEAK.threshold - EPS)
        push('DEFENSIVE_LEAK', s.corner, 'notable', who + ' is absorbing ' + fmtPct(v.pct, true) + ' vs career', v.live.toFixed(2) + '/min', v.base.toFixed(2) + '/min', 'career', FLAG_RULES.DEFENSIVE_LEAK.means);
      v = r.vs.accuracy;
      var att = num(s.state.sig_strikes_attempted);
      if (v && v.base != null && att != null && att >= FLAG_RULES.UNUSUAL_ACCURACY.minAttempts && Math.abs(v.live - v.base) >= FLAG_RULES.UNUSUAL_ACCURACY.threshold - EPS)
        push('UNUSUAL_ACCURACY', s.corner, 'notable', who + ' is landing ' + Math.round(v.live * 100) + '% of sig. attempts vs ' + Math.round(v.base * 100) + '% career', Math.round(v.live * 100) + '%', Math.round(v.base * 100) + '%', 'career', FLAG_RULES.UNUSUAL_ACCURACY.means);
      if (s.base && s.base.obs_fights >= FLAG_RULES.TARGET_SHIFT.minObs && r.target && r.target.n >= FLAG_RULES.TARGET_SHIFT.minLanded) {
        ['body', 'leg'].forEach(function (k) {
          var vv = r.vs[k];
          if (vv && vv.base != null && vv.live - vv.base >= FLAG_RULES.TARGET_SHIFT.threshold - EPS)
            push('TARGET_SHIFT', s.corner, 'notable', who + ' is targeting the ' + k + ' on ' + Math.round(vv.live * 100) + '% of landed sig. strikes vs ' + Math.round(vv.base * 100) + '% observed', Math.round(vv.live * 100) + '%', Math.round(vv.base * 100) + '%', 'observed · ' + s.base.obs_fights + ' fights', FLAG_RULES.TARGET_SHIFT.means);
        });
      }
      if (s.base && s.base.obs_fights >= FLAG_RULES.RANGE_SHIFT.minObs && r.position && r.position.n >= FLAG_RULES.RANGE_SHIFT.minLanded) {
        var d = r.vs.distance;
        if (d && d.base != null && Math.abs(d.live - d.base) >= FLAG_RULES.RANGE_SHIFT.threshold - EPS)
          push('RANGE_SHIFT', s.corner, 'notable', Math.round(d.live * 100) + '% of ' + who + '\'s landed sig. strikes are at distance vs ' + Math.round(d.base * 100) + '% observed', Math.round(d.live * 100) + '%', Math.round(d.base * 100) + '%', 'observed · ' + s.base.obs_fights + ' fights', FLAG_RULES.RANGE_SHIFT.means);
      }
      if (r.controlSeconds != null && r.controlSeconds >= FLAG_RULES.CONTROL_WITHOUT_DAMAGE.minControl && r.groundStrikes != null && r.groundStrikes <= FLAG_RULES.CONTROL_WITHOUT_DAMAGE.maxGround)
        push('CONTROL_WITHOUT_DAMAGE', s.corner, 'watch', who + ' has ' + fmtSeconds(r.controlSeconds) + ' of control but ' + r.groundStrikes + ' ground strikes landed', fmtSeconds(r.controlSeconds), null, 'source count', FLAG_RULES.CONTROL_WITHOUT_DAMAGE.means);
      var rp = roundPace(rounds, s.corner), r1 = rp[0], last = rp[rp.length - 1];
      if (r1 && last && last.round > 1 && r1.sigAttemptsPerMin != null && last.sigAttemptsPerMin != null && r1.sigAttemptsPerMin > 0 && (last.seconds || 0) >= 90) {
        var pd = (last.sigAttemptsPerMin - r1.sigAttemptsPerMin) / r1.sigAttemptsPerMin;
        if (pd <= FLAG_RULES.ROUND_PACE_DECLINE.threshold + EPS) {
          var hist = s.base && s.base.obs_round_pace && s.base.obs_round_pace['1'] && s.base.obs_round_pace[String(last.round)];
          var histTxt = hist && hist.n >= 2 && s.base.obs_round_pace['1'].sig_attempts_per_min > 0
            ? ' Observed decline over the same rounds: ' + fmtPct((s.base.obs_round_pace[String(last.round)].sig_attempts_per_min - s.base.obs_round_pace['1'].sig_attempts_per_min) / s.base.obs_round_pace['1'].sig_attempts_per_min, false) + ' (' + hist.n + ' fights).'
            : ' No observed round profile on file to compare.';
          push('ROUND_PACE_DECLINE', s.corner, 'notable', who + '\'s sig. attempt rate has fallen ' + fmtPct(pd, false) + ' from round 1 to round ' + last.round + '.' + histTxt, last.sigAttemptsPerMin.toFixed(1) + '/min', r1.sigAttemptsPerMin.toFixed(1) + '/min R1', 'this fight', FLAG_RULES.ROUND_PACE_DECLINE.means);
        }
      }
      if (bout.round >= 4 && s.base && s.base.fights_past_r3 > 0)
        push('LATE_ROUND_PROFILE', s.corner, 'watch', who + ' has ' + s.base.fights_past_r3 + ' fight' + (s.base.fights_past_r3 === 1 ? '' : 's') + ' past round 3 on file' + (s.base.finishes_after_r3 ? ', ' + s.base.finishes_after_r3 + ' ending in a finish' : ''), s.base.fights_past_r3 + ' fights', null, 'fight history', FLAG_RULES.LATE_ROUND_PROFILE.means);
      else if (bout.round >= 4 && s.base && !s.base.fights_past_r3)
        push('LATE_ROUND_PROFILE', s.corner, 'watch', who + ' has no round 4-5 history on file', '0 fights', null, 'fight history', FLAG_RULES.LATE_ROUND_PROFILE.means);
    });
    return out;
    function push(code, corner, severity, explain, current, baseline, sample, means) {
      out.push({ code: code, title: code.replace(/_/g, ' '), corner: corner, severity: severity, explain: explain,
        current: current, baseline: baseline, sample: sample, threshold: means, rules: FLAG_RULES.version });
    }
  }
  function fmtPct(x, signed) { if (x == null) return '—'; var v = Math.round(x * 100); return (signed && v > 0 ? '+' : '') + v + '%'; }

  /* ───────────────────────────── the live read ────────────────────────── */

  function liveRead(ctx) {
    var bout = ctx.bout || {}, elapsed = ctx.elapsed, lines = [];
    var R = ctx.red ? liveRates(ctx.red, ctx.blue, elapsed, ctx.redBase) : null;
    var B = ctx.blue ? liveRates(ctx.blue, ctx.red, elapsed, ctx.blueBase) : null;
    var rn = (bout.red_name || 'Red').split(' ').slice(-1)[0], bn = (bout.blue_name || 'Blue').split(' ').slice(-1)[0];
    if (!R && !B) return { lines: [], empty: true };
    /* fight shape */
    var tdA = (num(ctx.red && ctx.red.takedowns_attempted) || 0) + (num(ctx.blue && ctx.blue.takedowns_attempted) || 0);
    var per15 = elapsed ? tdA / (elapsed / 60) * 15 : null;
    var baseTd = mean([ctx.redBase && ctx.redBase.takedown_avg, ctx.blueBase && ctx.blueBase.takedown_avg]);
    if (elapsed >= 120) {
      if (per15 != null && per15 >= 4 && (baseTd == null || per15 >= 1.8 * baseTd)) lines.push({ k: 'Fight shape', v: 'Wrestling-heavy relative to pre-fight history', d: tdA + ' takedown attempts · ' + per15.toFixed(1) + '/15' + (baseTd != null ? ' vs ' + baseTd.toFixed(1) + ' career avg' : '') });
      else if (per15 != null && tdA === 0) lines.push({ k: 'Fight shape', v: 'No takedown attempted yet', d: fmtSeconds(elapsed) + ' elapsed' });
      else if (per15 != null) lines.push({ k: 'Fight shape', v: 'Mixed', d: tdA + ' takedown attempt' + (tdA === 1 ? '' : 's') + ' · ' + per15.toFixed(1) + '/15' });
    }
    /* pace */
    var pace = [];
    [[rn, R], [bn, B]].forEach(function (p) {
      var r = p[1]; if (!r) return;
      var v = r.vs.sigLandedPerMin;
      if (v && v.pct != null) pace.push(p[0] + ' ' + fmtPct(v.pct, true) + ' vs baseline');
      else if (r.sigLandedPerMin != null) pace.push(p[0] + ' ' + r.sigLandedPerMin.toFixed(1) + ' landed/min · no baseline');
    });
    if (pace.length) lines.push({ k: 'Pace', v: pace.join(' · '), d: 'landed sig. strikes per minute against UFCStats career rates' });
    /* range */
    var rangeBits = [];
    [[rn, R], [bn, B]].forEach(function (p) {
      var r = p[1]; if (!r || !r.position) return;
      var v = r.vs.distance;
      rangeBits.push(p[0] + ' ' + Math.round(r.position.distance * 100) + '% at distance' + (v && v.base != null ? ' (observed ' + Math.round(v.base * 100) + '%)' : ''));
    });
    if (rangeBits.length) lines.push({ k: 'Range', v: rangeBits.join(' · '), d: 'share of landed sig. strikes by position' });
    /* control */
    if (R && R.controlDiff != null) {
      var lead = R.controlDiff > 0 ? rn : (R.controlDiff < 0 ? bn : null);
      lines.push({ k: 'Control', v: lead ? lead + ' +' + fmtSeconds(Math.abs(R.controlDiff)) : 'Even', d: fmtSeconds(R.controlSeconds) + ' / ' + fmtSeconds(num(ctx.blue.control_seconds)) });
    }
    /* differential */
    if (R && R.sigDiff != null) lines.push({ k: 'Sig. strike differential', v: (R.sigDiff > 0 ? rn + ' +' + R.sigDiff : (R.sigDiff < 0 ? bn + ' +' + (-R.sigDiff) : 'Even')), d: 'landed' });
    /* market */
    if (ctx.market && ctx.market.line) lines.push({ k: 'Market', v: ctx.market.line, d: ctx.market.detail || '' });
    /* unknown */
    var unk = [];
    if (bout.scheduled_rounds && bout.round) { var left = bout.scheduled_rounds - bout.round; if (left > 0 && bout.status === 'live') unk.push(left + ' round' + (left === 1 ? '' : 's') + ' remain'); }
    [[rn, ctx.redBase], [bn, ctx.blueBase]].forEach(function (p) {
      var b = p[1];
      if (!b) unk.push(p[0] + ' has no history on file');
      else if (bout.scheduled_rounds === 5 && !b.fights_past_r3) unk.push(p[0] + ' has no round 4-5 history on file');
    });
    if (unk.length) lines.push({ k: 'Unknown', v: unk.join(' · '), d: '' });
    return { lines: lines, empty: false };
  }

  /* ───────────────────────────── matchup ──────────────────────────────── */

  function matchupRows(bout, rf, bf, rb, bb) {
    var rows = [];
    rf = rf || {}; bf = bf || {}; rb = rb || null; bb = bb || null;
    function row(label, rv, bv, note, fmt, better) {
      rows.push({ label: label, red: rv == null ? null : (fmt ? fmt(rv) : rv), blue: bv == null ? null : (fmt ? fmt(bv) : bv),
        redRaw: rv, blueRaw: bv, note: note || '', lead: (rv == null || bv == null || rv === bv) ? '' : (better === 'low' ? (rv < bv ? 'red' : 'blue') : (better === 'high' ? (rv > bv ? 'red' : 'blue') : '')) });
    }
    var inch = function (v) { return v + '"'; }, pct = function (v) { return Math.round(v * 100) + '%'; }, f2 = function (v) { return (+v).toFixed(2); };
    row('Reach', num(rf.reach_inches), num(bf.reach_inches), (num(rf.reach_inches) != null && num(bf.reach_inches) != null) ? Math.abs(rf.reach_inches - bf.reach_inches) + '" difference' : 'reach not on file for both', inch, 'high');
    row('Height', num(rf.height_inches), num(bf.height_inches), '', inch, '');
    row('Stance', rf.stance || null, bf.stance || null, (rf.stance && bf.stance && rf.stance !== bf.stance) ? 'opposite stances' : '', null, '');
    row('Age', num(rf.age), num(bf.age), '', null, '');
    row('Record', rf.pro_record || (rf.wins != null ? rf.wins + '-' + rf.losses + '-' + (rf.draws || 0) : null), bf.pro_record || (bf.wins != null ? bf.wins + '-' + bf.losses + '-' + (bf.draws || 0) : null), '', null, '');
    if (rb || bb) {
      row('Sig. strikes landed / min', rb && rb.slpm, bb && bb.slpm, 'UFCStats career', f2, 'high');
      row('Sig. strikes absorbed / min', rb && rb.sapm, bb && bb.sapm, 'UFCStats career', f2, 'low');
      row('Striking accuracy', rb && rb.striking_accuracy, bb && bb.striking_accuracy, 'vs opponent striking defense', pct, 'high');
      row('Striking defense', rb && rb.striking_defense, bb && bb.striking_defense, '', pct, 'high');
      row('Takedowns / 15', rb && rb.takedown_avg, bb && bb.takedown_avg, 'vs opponent takedown defense', f2, 'high');
      row('Takedown accuracy', rb && rb.takedown_accuracy, bb && bb.takedown_accuracy, '', pct, 'high');
      row('Takedown defense', rb && rb.takedown_defense, bb && bb.takedown_defense, '', pct, 'high');
      row('Sub attempts / 15', rb && rb.submission_avg, bb && bb.submission_avg, '', f2, 'high');
      row('Finish rate', rb && rb.finish_rate, bb && bb.finish_rate, (rb ? rb.wins : '—') + ' / ' + (bb ? bb.wins : '—') + ' wins', pct, 'high');
      row('Losses by finish', rb && rb.finished_loss_rate, bb && bb.finished_loss_rate, (rb ? rb.losses : '—') + ' / ' + (bb ? bb.losses : '—') + ' losses', pct, 'low');
      row('Avg fight time', rb && rb.avg_fight_seconds, bb && bb.avg_fight_seconds, 'timed fights ' + (rb ? rb.timed_fights : '—') + ' / ' + (bb ? bb.timed_fights : '—'), fmtSeconds, '');
      row('Fights past R3', rb && rb.fights_past_r3, bb && bb.fights_past_r3, 'five-round experience on file', null, 'high');
      row('Days since last fight', rb && rb.days_since_last_fight, bb && bb.days_since_last_fight, '', null, 'low');
      row('Fights, last 365d', rb && rb.fights_last_365, bb && bb.fights_last_365, '', null, 'high');
      row('Fights on file', rb && rb.fights_on_file, bb && bb.fights_on_file, 'career mileage in the dataset', null, '');
      row('Total recorded fight time', rb && rb.total_fight_seconds, bb && bb.total_fight_seconds, '', fmtSeconds, '');
      row('Opponent avg win %', rb && rb.opp_avg_win_pct, bb && bb.opp_avg_win_pct, 'over ' + (rb ? rb.opp_sample : '—') + ' / ' + (bb ? bb.opp_sample : '—') + ' opponents on file', pct, 'high');
      row('Current streak', rb && rb.current_streak, bb && bb.current_streak, '', function (v) { return v > 0 ? 'W' + v : (v < 0 ? 'L' + (-v) : '—'); }, 'high');
    }
    return rows;
  }

  /* "What we don't know" — every reason a reader should hold this loosely. */
  function unknowns(ctx) {
    var out = [], bout = ctx.bout || {};
    [['red', ctx.redBase, bout.red_name], ['blue', ctx.blueBase, bout.blue_name]].forEach(function (p) {
      var b = p[1], nm = p[2] || p[0];
      if (!b) { out.push({ k: 'No history on file', v: nm + ' is not in the fighter dataset — no baseline, no tendencies. Nothing is inferred from the opponent.' }); return; }
      if (b.dated_fights === 0) out.push({ k: 'Debut', v: nm + ' has no dated fight on file.' });
      else if (b.dated_fights < 5) out.push({ k: 'Limited sample', v: nm + ': ' + b.dated_fights + ' dated fight' + (b.dated_fights === 1 ? '' : 's') + ' on file. Rates over this few fights are not stable.' });
      if (!b.career_stats_available) out.push({ k: 'No career microstats', v: nm + ' has no UFCStats career rates, so pace and accuracy comparisons are unavailable.' });
      if (b.days_since_last_fight != null && b.days_since_last_fight > 365) out.push({ k: 'Long layoff', v: nm + ' last fought ' + b.days_since_last_fight + ' days ago.' });
      if (b.opp_sample < 5) out.push({ k: 'Opponent-quality adjustment uncertain', v: nm + ': only ' + b.opp_sample + ' opponents with a record on file.' });
      if (bout.scheduled_rounds === 5 && !b.fights_past_r3) out.push({ k: 'No five-round history', v: nm + ' has never been past round 3 on file.' });
      if (!b.obs_fights) out.push({ k: 'No observed target or range baseline', v: nm + ': EdgeDesk has not yet watched a fight of theirs live, so target and position shifts cannot be measured.' });
    });
    if (ctx.market) {
      if (ctx.market.unreadable) out.push({ k: 'Market unreadable', v: 'The signals table could not be read this session; no price context is shown.' });
      else if (!ctx.market.linked) out.push({ k: 'No market on file', v: 'No odds-feed fixture resolved to both fighters of this bout.' });
      else { if (!ctx.market.hasSharp) out.push({ k: 'No sharp anchor', v: 'No reference-book quote in the capture; the fair line is a consensus.' });
        if (ctx.market.nBooks != null && ctx.market.nBooks < 3) out.push({ k: 'Low sportsbook coverage', v: ctx.market.nBooks + ' book' + (ctx.market.nBooks === 1 ? '' : 's') + ' priced this bout.' });
        if (ctx.market.closeUnavailable) out.push({ k: 'Closing line unavailable', v: ctx.market.closeReason || 'no qualified pre-bell capture.' }); }
    }
    if (ctx.live) {
      if (ctx.live.missing && ctx.live.missing.length) out.push({ k: 'Missing live statistics', v: 'The source published no ' + ctx.live.missing.join(', ') + ' for this bout.' });
      if (ctx.live.stale) out.push({ k: 'Live data stale', v: 'Last live update ' + ageLabel(ctx.live.ageS) + '.' });
      if (ctx.live.roundsDerived) out.push({ k: 'Round splits derived', v: 'Per-round numbers are differences between cumulative snapshots at round boundaries, not provider splits.' });
    }
    if (bout.late_replacement) out.push({ k: 'Late replacement', v: 'This bout was rebooked on short notice.' });
    return out;
  }

  /* Which live stat fields the source left empty for a bout. */
  function missingLiveFields(red, blue) {
    var fields = [['sig_strikes_landed', 'sig. strikes'], ['total_strikes_landed', 'total strikes'], ['takedowns_landed', 'takedowns'], ['control_seconds', 'control time'],
      ['knockdowns', 'knockdowns'], ['submission_attempts', 'submission attempts'], ['head_strikes_landed', 'target split'], ['distance_strikes_landed', 'position split']];
    var miss = [];
    fields.forEach(function (f) {
      var a = red && red[f[0]], b = blue && blue[f[0]];
      if (a == null && b == null) miss.push(f[1]);
    });
    return miss;
  }

  /* ───────────────────────────── market summary ───────────────────────── */

  /* One corner's market column from a signals row (the capture's own fields). */
  function cornerMarket(row) {
    if (!row) return null;
    var mv = movement(row.first_best_dec, row.best_dec);
    return { selection: row.selection, sig_key: row.sig_key, open: row.first_best_dec != null ? +row.first_best_dec : null, openAt: row.first_seen_at || null,
      now: row.best_dec != null ? +row.best_dec : null, book: row.best_book || null, at: row.last_seen_at || null,
      sharp_fair: row.sharp_fair != null ? +row.sharp_fair : null, consensus_fair: row.consensus_fair != null ? +row.consensus_fair : null,
      has_sharp: !!row.has_sharp, n_books: row.n_books != null ? +row.n_books : null, edge: row.edge != null ? +row.edge : null, movement: mv,
      closing_sharp_fair: row.closing_sharp_fair != null ? +row.closing_sharp_fair : null };
  }
  function marketSummary(redRow, blueRow, drawRow) {
    var r = cornerMarket(redRow), b = cornerMarket(blueRow), d = cornerMarket(drawRow);
    var dv = (r && b) ? devig2(r.now, b.now) : null;
    var ov = (r && b) ? devig2(r.open, b.open) : null;
    return { red: r, blue: b, draw: d, devig: dv ? { red: dv.a, blue: dv.b, vig: dv.vig } : null,
      openDevig: ov ? { red: ov.a, blue: ov.b, vig: ov.vig } : null,
      nBooks: (r && r.n_books != null) ? r.n_books : (b && b.n_books != null ? b.n_books : null),
      hasSharp: !!((r && r.has_sharp) || (b && b.has_sharp)),
      at: [r && r.at, b && b.at].filter(Boolean).sort().pop() || null };
  }

  return {
    VERSION: VERSION, ROUND_SECONDS: ROUND_SECONDS,
    normName: normName, tokens: tokens, surnameKey: surnameKey, swappedKey: swappedKey,
    buildFighterIndex: buildFighterIndex, resolveFighter: resolveFighter,
    impliedFromDec: impliedFromDec, decToAm: decToAm, amToDec: amToDec, fmtAm: fmtAm, fmtDecAsAm: fmtDecAsAm, devig2: devig2, movement: movement,
    isDrawSelection: isDrawSelection, groupFixtures: groupFixtures, normalizeFixture: normalizeFixture, boutsFromSignals: boutsFromSignals, linkFixture: linkFixture,
    closeBound: closeBound, marketStateAt: marketStateAt, closingReference: closingReference, clv: clv, CLOSE_MAX_LEAD_MS: CLOSE_MAX_LEAD_MS,
    HEALTH: HEALTH, LEVELS: LEVELS, healthLevel: healthLevel, domainLevel: domainLevel, ageLabel: ageLabel,
    parseClock: parseClock, elapsedFromClock: elapsedFromClock, elapsedAtEnd: elapsedAtEnd, elapsedOf: elapsedOf, fmtSeconds: fmtSeconds,
    methodClass: methodClass, resultFor: resultFor, fightSeconds: fightSeconds, buildBaseline: buildBaseline, observedBaseline: observedBaseline,
    STYLE_RULES: STYLE_RULES, styleLabels: styleLabels, styleCollision: styleCollision,
    liveRates: liveRates, roundPace: roundPace, roundLean: roundLean, FLAG_RULES: FLAG_RULES, flagsFor: flagsFor, liveRead: liveRead,
    matchupRows: matchupRows, unknowns: unknowns, missingLiveFields: missingLiveFields,
    cornerMarket: cornerMarket, marketSummary: marketSummary
  };
});
