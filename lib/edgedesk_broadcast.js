/* ===========================================================================
   EdgeDesk — BROADCAST AND SCHEDULE VERIFICATION (EDBroadcast)
   docs/content-engine/GAMES_TO_WATCH.md §Broadcasts

   "Where to watch" is a factual claim, so it is verified like one. A network
   is printed only with the source that verified it and the time it was
   verified; anything less is held, never guessed.

   SOURCES, in the order they are trusted
     OWNER_VERIFIED   the owner recorded the network from an official source
                      (a conference schedule, a school athletics site, the
                      network's own release) with its URL, in /admin/content/
     OFFICIAL_NETWORK ESPN's public scoreboard listing a network ESPN itself
                      operates (ABC, ESPN, ESPN2, ESPNU, ESPNEWS, SEC Network,
                      ACC Network, ESPN+): the rights holder's own listing
     CORROBORATED     two independent listings agree
     LISTED           a single third-party listing (ESPN's scoreboard naming
                      CBS, FOX, NBC, Big Ten Network, The CW …): useful, NOT
                      confirmation — the article is held until the owner
                      verifies it or a second listing agrees
     NONE             nothing on file

   STATUS (what the article may do)
     CONFIRMED        print the network, its streaming options, the source and
                      the verification time
     TENTATIVE        held: a listing exists but is not confirmed
     CONFLICT         held: two sources disagree on the network or the time
     CHANGED          held: the listing changed after it was verified (flex
                      scheduling, a regional split) — re-verify
     STALE            held: verified, but not inside the revalidation window
     POSTPONED / CANCELED   the game is withdrawn from the article
     UNVERIFIED       held: no listing at all

   STREAMING. A streaming option is printed only when (a) the source listed it
   for this game, or (b) it is the verified network's OWN live-streaming
   service (NETWORK_SERVICE in STREAMING below), described as exactly that —
   "CBS games stream live on Paramount+" — never as a game-specific claim.

   Time zones: the instant is UTC (EDSchedule); Eastern and Central are
   formatted from it with their own DST rules, never by a fixed offset.

   Browser: window.EDBroadcast. Node: require('./edgedesk_broadcast.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDBroadcast = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var B = { VERSION: 'edgedesk_broadcast/1' };

  B.CONFIG = {
    /* a verification older than this before publication is revalidated */
    revalidate_hours: 24,
    /* inside this many hours of kickoff, a verification must be this fresh */
    gameweek_hours: 72, gameweek_revalidate_hours: 12,
    /* a source time this far from the schedule's is a conflict */
    time_tolerance_minutes: 5
  };

  /* networks ESPN operates: its scoreboard listing one of these is the
     rights holder's own listing */
  var ESPN_FAMILY = ['ABC', 'ESPN', 'ESPN2', 'ESPNU', 'ESPNEWS', 'SEC Network', 'ACC Network', 'ESPN+', 'SEC Network+', 'ACC Network Extra'];
  var ALIASES = {
    'SECN': 'SEC Network', 'SEC NETWORK': 'SEC Network', 'ACCN': 'ACC Network', 'ACC NETWORK': 'ACC Network', 'ESPN+': 'ESPN+', 'ESPN PLUS': 'ESPN+',
    'SECN+': 'SEC Network+', 'ACCNX': 'ACC Network Extra', 'BTN': 'Big Ten Network', 'BIG TEN NETWORK': 'Big Ten Network', 'FS1': 'FS1', 'FS2': 'FS2',
    'CBSSN': 'CBS Sports Network', 'CBS SPORTS NETWORK': 'CBS Sports Network', 'CW': 'The CW', 'THE CW': 'The CW', 'CW NETWORK': 'The CW',
    'ABC': 'ABC', 'ESPN': 'ESPN', 'ESPN2': 'ESPN2', 'ESPNU': 'ESPNU', 'ESPNEWS': 'ESPNEWS', 'CBS': 'CBS', 'FOX': 'FOX', 'NBC': 'NBC',
    'PEACOCK': 'Peacock', 'TRUTV': 'truTV', 'TNT': 'TNT', 'TBS': 'TBS', 'NFL NETWORK': 'NFL Network', 'NFLN': 'NFL Network', 'AMAZON PRIME VIDEO': 'Prime Video',
    'PRIME VIDEO': 'Prime Video', 'NETFLIX': 'Netflix', 'YOUTUBE': 'YouTube', 'PARAMOUNT+': 'Paramount+'
  };
  B.normalizeNetwork = function (name) {
    var s = String(name == null ? '' : name).trim();
    if (!s) return null;
    var k = s.toUpperCase().replace(/\s+/g, ' ');
    return ALIASES[k] || s;
  };
  B.espnOperated = function (network) { return ESPN_FAMILY.indexOf(B.normalizeNetwork(network)) >= 0; };

  /* THE NETWORK'S OWN LIVE-STREAMING SERVICE (reviewed 2026-10). Only
     services the network itself runs or names for live games; a network not
     listed here gets no streaming line. The owner reviews this table each
     season (docs/content-engine/GAMES_TO_WATCH.md). */
  B.STREAMING = {
    ABC: { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    ESPN: { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    ESPN2: { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    ESPNU: { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    'SEC Network': { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    'ACC Network': { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    'ESPN+': { service: 'ESPN+', note: 'a streaming-only broadcast in the ESPN app', url: 'https://www.espn.com/watch/' },
    CBS: { service: 'Paramount+', note: 'plans that include live CBS', url: 'https://www.paramountplus.com/' },
    NBC: { service: 'Peacock', note: 'a Peacock subscription', url: 'https://www.peacocktv.com/' },
    Peacock: { service: 'Peacock', note: 'a streaming-only broadcast on Peacock', url: 'https://www.peacocktv.com/' }
  };

  function present(x) { return !(x === null || x === undefined || x === ''); }
  function ms(t) { if (!present(t)) return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v == null ? null : new Date(v).toISOString(); }
  function uniq(a) { var s = {}; return a.filter(function (x) { if (s[x]) return false; s[x] = 1; return true; }); }

  /* ======================================================== ESPN PARSER
     One public scoreboard payload (site.api.espn.com … /scoreboard) → one
     LISTING per event: the date ESPN carries, whether its time is valid
     (timeValid false = TBA), the game status, the venue, and every TV and
     streaming outlet by market (national, home, away). Nothing is inferred:
     a field ESPN does not carry stays null. */
  B.parseEspnScoreboard = function (payload, retrievedAt, sourceUrl) {
    var out = {};
    var evs = (payload && payload.events) || [];
    evs.forEach(function (e) {
      if (!e || !e.id) return;
      var c = (e.competitions && e.competitions[0]) || {};
      var st = (c.status && c.status.type) || (e.status && e.status.type) || {};
      var outlets = [];
      (c.geoBroadcasts || []).forEach(function (g) {
        var name = g && g.media && (g.media.shortName || g.media.name);
        if (!name) return;
        outlets.push({ network: B.normalizeNetwork(name), type: g.type && g.type.shortName ? String(g.type.shortName) : null,
          market: g.market && g.market.type ? String(g.market.type).toLowerCase() : null, region: g.region || null });
      });
      if (!outlets.length) (c.broadcasts || []).forEach(function (b) {
        (b.names || []).forEach(function (n) { outlets.push({ network: B.normalizeNetwork(n), type: 'TV', market: b.market ? String(b.market).toLowerCase() : null, region: null }); });
      });
      var comp = (c.competitors || []);
      var home = comp.filter(function (x) { return x.homeAway === 'home'; })[0], away = comp.filter(function (x) { return x.homeAway === 'away'; })[0];
      out[String(e.id)] = {
        game_id: String(e.id), source: { name: 'ESPN scoreboard', kind: 'listing', url: sourceUrl || null, operator: 'ESPN' },
        retrieved_at: iso(retrievedAt) || null,
        kickoff: iso(c.date || e.date), time_valid: c.timeValid === false ? false : (c.timeValid === true ? true : null),
        status: st.name || null, status_detail: st.detail || st.shortDetail || st.description || null,
        home: home && home.team ? home.team.location || home.team.displayName : null, away: away && away.team ? away.team.location || away.team.displayName : null,
        venue: c.venue ? { name: c.venue.fullName || null, city: c.venue.address ? c.venue.address.city || null : null, state: c.venue.address ? c.venue.address.state || null : null } : null,
        outlets: outlets
      };
    });
    return out;
  };

  /* ===================================================== VERIFICATION
     listing  one game's ESPN listing (parseEspnScoreboard) or null
     owner    the owner's verification row, or null:
              { network, streaming, source_url, source_kind, source_name,
                verified_at, kickoff (a verified changed kickoff), reason,
                status ('postponed' | 'canceled' | null) }
     schedule the game's schedule truth: { kickoff (ISO), kickoff_verified }
     → the record an article reads */
  var STATUS_WITHDRAWN = { STATUS_POSTPONED: 'POSTPONED', STATUS_CANCELED: 'CANCELED', STATUS_CANCELLED: 'CANCELED', STATUS_FORFEIT: 'CANCELED' };
  B.verify = function (gameId, listing, owner, schedule) {
    schedule = schedule || {};
    var rec = { schema: 'edgedesk_broadcast_v1', version: B.VERSION, game_id: String(gameId), status: 'UNVERIFIED', tier: 'NONE',
      network: null, networks: [], regional: [], streaming: [], source: null, verified_at: null, verified_by: null,
      kickoff: schedule.kickoff || null, kickoff_source: schedule.kickoff ? 'schedule feed' : null, schedule_change: null,
      problems: [], listing: listing || null };
    var natTV = [], natStream = [], regional = [];
    if (listing) (listing.outlets || []).forEach(function (o) {
      if (!o.network) return;
      var tv = !o.type || /tv/i.test(o.type), stream = /stream/i.test(o.type || ''), nat = !o.market || o.market === 'national';
      if (/radio/i.test(o.type || '')) return;
      if (nat && tv) natTV.push(o.network); else if (nat && stream) natStream.push(o.network); else if (tv) regional.push({ network: o.network, market: o.market });
    });
    natTV = uniq(natTV); natStream = uniq(natStream);
    var withdrawn = listing && STATUS_WITHDRAWN[listing.status];
    if (owner && /postpon/i.test(owner.status || '')) withdrawn = 'POSTPONED';
    if (owner && /cancel/i.test(owner.status || '')) withdrawn = 'CANCELED';
    /* the network */
    if (owner && present(owner.network)) {
      rec.network = B.normalizeNetwork(owner.network); rec.tier = 'OWNER_VERIFIED';
      rec.source = { name: owner.source_name || owner.source_kind || 'owner verification', kind: owner.source_kind || 'official', url: owner.source_url || null };
      rec.verified_at = iso(owner.verified_at); rec.verified_by = 'owner';
      if (!present(owner.source_url)) rec.problems.push({ code: 'NO_SOURCE_URL', text: 'the owner verification carries no source URL' });
      if (natTV.length && natTV.indexOf(rec.network) < 0) {
        var listedAfter = listing && ms(listing.retrieved_at) != null && ms(owner.verified_at) != null && ms(listing.retrieved_at) > ms(owner.verified_at);
        rec.problems.push({ code: listedAfter ? 'LISTING_CHANGED' : 'LISTING_DIFFERS', text: 'ESPN’s scoreboard lists ' + natTV.join(' / ') + (listedAfter ? ', after the owner verified ' + rec.network : '') });
      }
    } else if (natTV.length || natStream.length) {
      /* a streaming-only national broadcast (ESPN+, Peacock) is the network */
      var nets = natTV.length ? natTV : natStream;
      rec.network = nets[0];
      rec.tier = nets.every(B.espnOperated) ? 'OFFICIAL_NETWORK' : 'LISTED';
      rec.source = listing.source; rec.verified_at = listing.retrieved_at; rec.verified_by = 'feed';
      if (nets.length > 1) rec.networks = nets.slice();
      if (!natTV.length) natStream = [];
    }
    rec.networks = rec.networks.length ? rec.networks : (rec.network ? [rec.network] : []);
    rec.regional = regional;
    /* streaming: listed for this game, else the verified network's own service */
    natStream.forEach(function (s) { rec.streaming.push({ service: s, basis: 'LISTED_FOR_GAME', note: null, url: null }); });
    if (owner && Array.isArray(owner.streaming)) owner.streaming.forEach(function (s) { if (s && present(s.service || s)) rec.streaming.push({ service: s.service || s, basis: 'OWNER_VERIFIED', note: s.note || null, url: s.url || null }); });
    if (rec.network && B.STREAMING[rec.network] && !rec.streaming.some(function (s) { return s.service === B.STREAMING[rec.network].service; })) {
      var S = B.STREAMING[rec.network];
      rec.streaming.push({ service: S.service, basis: 'NETWORK_SERVICE', note: S.note, url: S.url });
    }
    /* the time: an owner-verified change wins; a listing time that disagrees
       with the schedule is a conflict until someone verifies it */
    var schedMs = ms(schedule.kickoff);
    if (owner && present(owner.kickoff)) {
      rec.schedule_change = { from: iso(schedule.kickoff), to: iso(owner.kickoff), reason: owner.reason || null, source_url: owner.source_url || null, verified_at: iso(owner.verified_at) };
      rec.kickoff = iso(owner.kickoff); rec.kickoff_source = 'owner verification';
    } else if (listing && ms(listing.kickoff) != null && schedMs != null && listing.time_valid !== false
      && Math.abs(ms(listing.kickoff) - schedMs) > B.CONFIG.time_tolerance_minutes * 60e3) {
      rec.problems.push({ code: 'TIME_CONFLICT', text: 'ESPN’s scoreboard has the game at ' + iso(listing.kickoff) + ', the schedule at ' + iso(schedule.kickoff) });
    }
    if (listing && listing.time_valid === false && schedule.kickoff_verified) rec.problems.push({ code: 'TIME_TBA_AT_SOURCE', text: 'ESPN’s scoreboard marks the time as to be announced' });
    if (schedule.kickoff_verified === false && !(owner && present(owner.kickoff))) rec.problems.push({ code: 'KICKOFF_UNVERIFIED', text: 'the schedule has not confirmed a kickoff time' });
    /* the status */
    if (withdrawn) rec.status = withdrawn;
    else if (!rec.network) rec.status = 'UNVERIFIED';
    else if (rec.problems.some(function (p) { return p.code === 'LISTING_CHANGED'; })) rec.status = 'CHANGED';
    else if (rec.problems.some(function (p) { return p.code === 'LISTING_DIFFERS' || p.code === 'TIME_CONFLICT' || p.code === 'TIME_TBA_AT_SOURCE'; })) rec.status = 'CONFLICT';
    else if (rec.tier === 'LISTED') rec.status = 'TENTATIVE';
    else if (rec.problems.some(function (p) { return p.code === 'NO_SOURCE_URL' || p.code === 'KICKOFF_UNVERIFIED'; })) rec.status = 'TENTATIVE';
    else rec.status = 'CONFIRMED';
    return rec;
  };

  /* is a CONFIRMED record still fresh enough to publish at `at`? */
  B.fresh = function (rec, at, kickoff) {
    if (!rec || rec.status !== 'CONFIRMED') return { ok: false, reason: rec ? rec.status : 'UNVERIFIED' };
    var t = ms(rec.verified_at), when = ms(at) == null ? Date.now() : ms(at), k = ms(kickoff || rec.kickoff);
    if (t == null) return { ok: false, reason: 'NO_TIMESTAMP' };
    var limit = (k != null && k - when <= B.CONFIG.gameweek_hours * 3600e3) ? B.CONFIG.gameweek_revalidate_hours : B.CONFIG.revalidate_hours;
    var age = (when - t) / 3600e3;
    return age <= limit ? { ok: true, age_hours: Math.round(age * 10) / 10, limit_hours: limit }
      : { ok: false, reason: 'STALE', age_hours: Math.round(age * 10) / 10, limit_hours: limit };
  };

  /* may an article print this record as where to watch? */
  B.publishable = function (rec, at) {
    if (!rec) return { ok: false, reason: 'UNVERIFIED', text: 'no broadcast listing is on file' };
    if (rec.status === 'POSTPONED' || rec.status === 'CANCELED') return { ok: false, reason: rec.status, withdraw: true, text: 'the game is ' + rec.status.toLowerCase() };
    if (rec.status !== 'CONFIRMED') return { ok: false, reason: rec.status, text: B.STATUS_TEXT[rec.status] || rec.status };
    var f = B.fresh(rec, at);
    if (!f.ok) return { ok: false, reason: 'STALE', text: 'the broadcast was verified ' + f.age_hours + ' hours ago; it must be re-verified within ' + f.limit_hours + ' hours of publication' };
    return { ok: true, reason: null, text: null };
  };
  B.STATUS_TEXT = {
    UNVERIFIED: 'no broadcast listing is on file',
    TENTATIVE: 'a single third-party listing names the network; it is not confirmed',
    CONFLICT: 'two sources disagree on the network or the time',
    CHANGED: 'the listing changed after it was verified',
    STALE: 'the verification is too old for publication'
  };

  /* ====================================================== DISPLAY
     Eastern and Central times from the UTC instant, each with its own DST.
     Uses EDSchedule when present so there is one formatter. */
  function sched() { var G = typeof globalThis !== 'undefined' ? globalThis : {}; return G.EDSchedule || (typeof require === 'function' ? (function () { try { return require('./edgedesk_schedule.js'); } catch (e) { return null; } })() : null); }
  B.timesText = function (kickoffIso) {
    var S = sched(); if (!S || !kickoffIso) return null;
    var g = { kickoff: kickoffIso, start_time_tbd: false };
    var et = S.display(g, 'America/New_York'), ct = S.display(g, 'America/Chicago');
    if (!et.verified) return null;
    return { date: et.text.split(' · ')[0], et: et.clock + ' ' + et.zone_abbr, ct: ct.clock + ' ' + ct.zone_abbr, et_abbr: et.zone_abbr, ct_abbr: ct.zone_abbr };
  };
  /* "Watch: ABC · Stream: the ESPN app (with a participating TV provider or an
     ESPN subscription) · Verified Oct. 8, 5:00 PM ET (ESPN scoreboard)" */
  B.watchLine = function (rec) {
    if (!rec || rec.status !== 'CONFIRMED') return null;
    var s = rec.streaming.map(function (x) { return x.service + (x.basis === 'NETWORK_SERVICE' && x.note ? ' (' + x.note + ')' : ''); });
    return { tv: rec.networks.join(' / '), stream: s.length ? s.join('; ') : null, regional: rec.regional.length ? rec.regional.map(function (r) { return r.network + ' (' + r.market + ' market)'; }).join(', ') : null };
  };
  return B;
});
