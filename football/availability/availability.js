/* ============================================================================
   EdgeDesk CFB AVAILABILITY — the deterministic core.

   College football has no universal injury report. There is no free,
   standardized CFB equivalent of the NFL's league-filed report, so EdgeDesk
   builds its own availability layer out of public evidence and says exactly
   how good that evidence is.

   THIS FILE OWNS THE FACTS. It normalizes a raw report into a status, resolves
   it to a real player on a real roster, ranks it against every other report
   about that player, scores its confidence and impact, and decides how fresh
   it is. Presentation and AI narration read the output; neither may add to it.

   THE RULES THIS FILE WILL NOT BREAK
   - Nothing is invented. A status, a designation, a return date, a practice
     level and a diagnosis all come from the source text or they are absent.
   - No status is stronger than its source. "Did not practice" is a practice
     fact, never an OUT. A non-contact jersey is not a QUESTIONABLE.
   - A lower-tier source never overwrites a higher-tier one. When a newer
     low-tier report contradicts an official one, the official one stands and
     the disagreement is RECORDED, not silently dropped.
   - A player who cannot be resolved safely is stored unresolved, never
     assigned to the wrong player.
   - Last week's report is not this week's news. Freshness is explicit.
   - "No reported injuries", "no verified data" and "partial coverage" are
     three different statements and are never collapsed into one.

   Node and browser (UMD). Ingestion (fetch_availability.js) and the tests
   both drive it; the browser can load it for the admin view.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDCFBAVAIL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_cfb_availability_v1';

  var STATUSES = ['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'GAME_TIME_DECISION', 'DAY_TO_DAY', 'LIMITED', 'PROBABLE', 'EXPECTED', 'AVAILABLE', 'UNKNOWN'];
  var PRACTICE = ['DNP', 'LIMITED', 'FULL', 'NOT_REPORTED', 'UNKNOWN'];
  /* How much doubt a status carries. Used for ordering and for "worst first",
     never as a probability — it is a display rank, not a number about a game. */
  var DOUBT = { OUT: 100, DOUBTFUL: 80, GAME_TIME_DECISION: 65, QUESTIONABLE: 60, DAY_TO_DAY: 50, LIMITED: 40, PROBABLE: 25, EXPECTED: 20, AVAILABLE: 10, UNKNOWN: 0 };

  /* ---------------------------------------------------------------- source */
  /* Tier 1 is official. Tier 2 is credentialed reporting. Tier 3 is other
     public reporting. Anything not on this list is not a source. */
  var SOURCE_TIER = {
    OFFICIAL_TEAM: 1, OFFICIAL_CONFERENCE: 1, COACH_QUOTE: 1, DEPTH_CHART: 1,
    TEAM_REPORTER: 2, REPUTABLE_MEDIA: 2,
    GAME_PARTICIPATION: 3, OTHER: 3
  };
  /* Named and refused on purpose: these are how a fake injury enters a
     dataset, and the product's credibility is the dataset. */
  var REFUSED_SOURCES = /(reddit|forum|message ?board|discord|telegram|twitter\.com\/(?!.*\b(beat|reporter)\b)|x\.com|fantasy ?(pros|guru|sharks)|rotoballer|aggregat|ai[- ]generated|chatgpt|unsourced)/i;
  function sourceTier(type) { return SOURCE_TIER[String(type || '').toUpperCase()] || null; }
  function isUsableSource(rep) {
    if (!rep) return false;
    if (!sourceTier(rep.source_type)) return false;
    var hay = String(rep.source_url || '') + ' ' + String(rep.source_name || '');
    return !REFUSED_SOURCES.test(hay);
  }

  /* ------------------------------------------------------------- utilities */
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function lower(s) { return clean(s).toLowerCase(); }
  function fold(s) {
    var t = String(s == null ? '' : s);
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return t;
  }
  function toMs(t) { if (t == null || t === '') return null; var ms = Date.parse(String(t)); return isFinite(ms) ? ms : null; }
  function iso(ms) { return new Date(ms).toISOString(); }

  /* ------------------------------------------------- status normalization */
  /* Ordered, longest-intent-first. Each rule states the EXACT wording it
     recognises; anything unrecognised stays UNKNOWN and keeps its raw text so
     a human can see what the extractor could not read. */
  var STATUS_RULES = [
    [/\b(?:has been |was |is )?ruled out\b|\bwill (?:not|n't) (?:play|dress|be available)\b|\bout for (?:the |this )?(?:season|year|game|week)\b|\bdid not (?:travel|make the trip)\b|\bwill miss\b|\bout indefinitely\b/i, 'OUT'],
    [/\bunlikely to play\b|\bnot expected to play\b|\bdoubtful\b/i, 'DOUBTFUL'],
    [/\bgame[- ]time decision\b|\bgametime decision\b|\bdecided (?:on )?game day\b/i, 'GAME_TIME_DECISION'],
    [/\bquestionable\b|\buncertain (?:for|to play)\b|\bup in the air\b|\btouch and go\b/i, 'QUESTIONABLE'],
    [/\bday[- ]to[- ]day\b/i, 'DAY_TO_DAY'],
    [/\bprobable\b|\blikely to play\b/i, 'PROBABLE'],
    [/\bexpected to (?:play|be available|go|start)\b|\bshould play\b|\bplans to play\b|\bwill play\b|\bhas been cleared\b|\bcleared to (?:play|return)\b|\bwill (?:start|be back)\b/i, 'EXPECTED'],
    [/\b(?:is |are )?available\b|\bno restrictions\b|\bfull(?:ly)? (?:cleared|healthy)\b|\bactive\b/i, 'AVAILABLE'],
    /* LIMITED as a STATUS only when the source says limited availability, not
       limited practice — practice is handled separately below. */
    [/\blimited (?:role|snaps|availability|capacity)\b|\bon a (?:snap |pitch )?count\b/i, 'LIMITED']
  ];
  var PRACTICE_RULES = [
    [/\bdid not (?:practice|participate)\b|\bdnp\b|\bmissed practice\b|\bheld out of practice\b|\bno[nt][- ]participant\b/i, 'DNP'],
    [/\blimited (?:participant|participation|in practice|practice)\b|\bpractic\w+ (?:in a )?limited\b|\blimited (?:on )?(?:tuesday|wednesday|thursday|friday|monday)\b/i, 'LIMITED'],
    [/\bfull (?:participant|participation|go)\b|\bpracticed fully\b|\bfull practice\b|\bfull (?:on )?(?:tuesday|wednesday|thursday|friday|monday)\b/i, 'FULL']
  ];
  /* Observations that are NOT a status, however often they are treated as one.
     Each is kept as a note so the evidence survives without being upgraded. */
  var OBSERVATION_ONLY = [
    [/\bnon[- ]contact (?:jersey|jersey|role)\b|\bgreen jersey\b|\byellow (?:non[- ]contact )?jersey\b/i, 'wore a non-contact jersey'],
    [/\bin (?:a )?(?:walking )?boot\b|\bon crutches\b|\barm in a sling\b|\bwearing a brace\b/i, 'seen in a boot, sling or brace'],
    [/\bdressed (?:but )?did not play\b|\bdid not dress\b|\bdid not (?:see|record) (?:the field|action|a snap)\b/i, 'did not record participation'],
    [/\bwent through (?:individual )?(?:drills|warmups)\b|\bwarmed up\b/i, 'went through warmups'],
    [/\bcarted off\b|\bhelped off\b|\bleft the game\b|\bexited (?:the game|early)\b/i, 'left a game early']
  ];
  var BODY_PARTS = ['acl','mcl','hamstring','ankle','knee','shoulder','concussion','head','foot','hand','wrist','elbow','hip','groin','quad','calf','achilles','back','neck','ribs','oblique','thumb','finger','toe','illness','undisclosed'];

  /* rawText -> what the source ACTUALLY said. Never more. */
  function normalizeAvailabilityStatus(rawText) {
    var raw = clean(rawText);
    var out = { status: 'UNKNOWN', practice_status: 'NOT_REPORTED', body_part: null, observations: [], matched: null, raw: raw || null };
    if (!raw) return out;
    var t = fold(raw);
    /* a negated designation is not that designation */
    var i;
    for (i = 0; i < PRACTICE_RULES.length; i++) if (PRACTICE_RULES[i][0].test(t)) { out.practice_status = PRACTICE_RULES[i][1]; break; }
    for (i = 0; i < STATUS_RULES.length; i++) {
      if (!STATUS_RULES[i][0].test(t)) continue;
      /* "not questionable", "no longer out" — a denial is not a designation */
      var m = t.match(STATUS_RULES[i][0]);
      var before = t.slice(Math.max(0, m.index - 22), m.index);
      if (/\b(no longer|not|isn'?t|wasn'?t|never)\s*$/i.test(before)) continue;
      out.status = STATUS_RULES[i][1]; out.matched = m[0]; break;
    }
    for (i = 0; i < OBSERVATION_ONLY.length; i++) if (OBSERVATION_ONLY[i][0].test(t)) out.observations.push(OBSERVATION_ONLY[i][1]);
    for (i = 0; i < BODY_PARTS.length; i++) if (new RegExp('\\b' + BODY_PARTS[i] + '\\b', 'i').test(t)) { out.body_part = BODY_PARTS[i]; break; }
    /* A practice level alone is a practice fact. It is NOT an availability
       designation, and this is the single most common way injury data lies. */
    if (out.status === 'UNKNOWN' && out.practice_status === 'FULL' && /\bfull (?:participant|participation)\b/i.test(t)) out.status = 'UNKNOWN';
    return out;
  }
  /* An explicit designation from a structured feed (ESPN status, an official
     report's own column) — trusted as given, still mapped to our vocabulary. */
  function normalizeDesignation(word) {
    var w = lower(word).replace(/[^a-z- ]/g, '');
    if (!w) return 'UNKNOWN';
    if (/^out\b|^out for/.test(w)) return 'OUT';
    if (/doubtful/.test(w)) return 'DOUBTFUL';
    if (/questionable/.test(w)) return 'QUESTIONABLE';
    if (/game[- ]time/.test(w)) return 'GAME_TIME_DECISION';
    if (/day[- ]to[- ]day/.test(w)) return 'DAY_TO_DAY';
    if (/probable/.test(w)) return 'PROBABLE';
    if (/expected|likely/.test(w)) return 'EXPECTED';
    if (/available|active|healthy|cleared/.test(w)) return 'AVAILABLE';
    if (/limited/.test(w)) return 'LIMITED';
    if (/suspend|ineligible|dismiss/.test(w)) return 'OUT';
    return 'UNKNOWN';
  }

  /* --------------------------------------------------- player identity */
  var SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b\.?/gi;
  function normName(s) {
    var t = fold(lower(s)).replace(/[.'’`]/g, '').replace(SUFFIX, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
    return t.replace(/\s+/g, ' ');
  }
  function nameParts(s) {
    var n = normName(s);
    if (!n) return { first: '', last: '', initial: '', full: '' };
    var bits = n.split(' ');
    return { first: bits[0] || '', last: bits.length > 1 ? bits[bits.length - 1] : '', initial: (bits[0] || '').charAt(0), full: n };
  }
  /* Deterministic. Returns the matched roster player and HOW it matched, or an
     unresolved verdict with the reason. Ambiguity is never broken by a guess. */
  function resolvePlayer(report, rosterPlayers) {
    var out = { player: null, match: null, match_confidence: 'NONE', candidates: 0, reason: null };
    var list = (rosterPlayers || []).filter(Boolean);
    if (!list.length) { out.reason = 'no roster on file for this team'; return out; }
    var want = nameParts(report && report.player_name);
    if (!want.full) { out.reason = 'report carries no player name'; return out; }
    var jersey = report && report.jersey != null ? String(report.jersey).replace(/[^0-9]/g, '') : '';
    var pos = report && report.position ? lower(report.position) : '';
    function samePos(p) { return !pos || !p.position || lower(p.position) === pos || lower(p.position).charAt(0) === pos.charAt(0); }

    /* 1. a roster id given outright */
    if (report && report.player_id) {
      var byId = list.filter(function (p) { return String(p.espn_id || p.player_id || '') === String(report.player_id); });
      if (byId.length === 1) { out.player = byId[0]; out.match = 'roster_id'; out.match_confidence = 'EXACT'; return out; }
    }
    /* 2. exact normalized full name */
    var exact = list.filter(function (p) { return normName(p.name) === want.full; });
    if (exact.length === 1) {
      /* A unique exact name is a safe match. A position the source got wrong
         does not unmake it, but it is recorded so the admin view can see the
         source and the roster disagreeing. */
      out.player = exact[0]; out.match = 'exact_name';
      out.match_confidence = samePos(exact[0]) ? 'EXACT' : 'HIGH';
      if (!samePos(exact[0])) out.reason = 'the source lists ' + clean(report.position) + ', the roster lists ' + clean(exact[0].position);
      return out;
    }
    if (exact.length > 1) {
      var byJersey = jersey ? exact.filter(function (p) { return String(p.jersey || '').replace(/[^0-9]/g, '') === jersey; }) : [];
      if (byJersey.length === 1) { out.player = byJersey[0]; out.match = 'name_and_jersey'; out.match_confidence = 'EXACT'; return out; }
      var byPos = exact.filter(samePos);
      if (byPos.length === 1) { out.player = byPos[0]; out.match = 'name_and_position'; out.match_confidence = 'HIGH'; return out; }
      out.candidates = exact.length; out.reason = 'two players on this roster share the name'; return out;
    }
    /* 3. last name plus first initial ("B. Morton", "Behren Morton") */
    if (want.last) {
      var byLast = list.filter(function (p) { var q = nameParts(p.name); return q.last === want.last; });
      var narrowed = byLast.filter(function (p) { var q = nameParts(p.name); return !want.initial || q.initial === want.initial; });
      var pool = narrowed.length ? narrowed : byLast;
      if (pool.length === 1 && samePos(pool[0])) { out.player = pool[0]; out.match = want.first === nameParts(pool[0].name).first ? 'last_name' : 'initial_and_last_name'; out.match_confidence = 'HIGH'; return out; }
      if (pool.length > 1) {
        var j2 = jersey ? pool.filter(function (p) { return String(p.jersey || '').replace(/[^0-9]/g, '') === jersey; }) : [];
        if (j2.length === 1) { out.player = j2[0]; out.match = 'last_name_and_jersey'; out.match_confidence = 'HIGH'; return out; }
        var p2 = pool.filter(samePos);
        if (p2.length === 1) { out.player = p2[0]; out.match = 'last_name_and_position'; out.match_confidence = 'MEDIUM'; return out; }
        out.candidates = pool.length; out.reason = 'several players share the last name'; return out;
      }
      if (pool.length === 1) { out.candidates = 1; out.reason = 'name matched but the position contradicts the roster'; return out; }
    }
    out.reason = 'no roster player matched the name';
    return out;
  }

  /* ------------------------------------------------------------ confidence */
  /* Deterministic, from the source tier and how explicit the evidence is.
     The AI layer consumes this. It never chooses it. */
  function scoreConfidence(rec) {
    var tier = sourceTier(rec && rec.source_type);
    var explicit = rec && rec.status && rec.status !== 'UNKNOWN';
    var type = String(rec && rec.source_type || '').toUpperCase();
    if (!tier) return 'LOW';
    if (tier === 1 && explicit && (type === 'OFFICIAL_TEAM' || type === 'OFFICIAL_CONFERENCE')) return 'CONFIRMED';
    if (tier === 1 && explicit) return 'HIGH';            /* coach quote, depth chart designation */
    if (tier === 2 && explicit) return 'MEDIUM';
    if (type === 'GAME_PARTICIPATION' || type === 'DEPTH_CHART') return 'LOW';
    return explicit ? 'MEDIUM' : 'LOW';
  }
  var CONF_RANK = { CONFIRMED: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

  /* ---------------------------------------------------------------- impact */
  /* Role-based and deterministic. Without a depth role from a real source we
     do NOT claim a player is the starter, so his impact is capped. */
  var POS_GROUP = {
    QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE',
    OL: 'OL', OT: 'OL', LT: 'OL', RT: 'OL', OG: 'OL', LG: 'OL', RG: 'OL', G: 'OL', C: 'OL',
    DL: 'DL', DT: 'DL', NT: 'DL', DE: 'EDGE', EDGE: 'EDGE', OLB: 'EDGE',
    LB: 'LB', ILB: 'LB', MLB: 'LB', CB: 'CB', DB: 'DB', S: 'S', FS: 'S', SS: 'S',
    K: 'K', PK: 'K', P: 'P', LS: 'LS', ATH: 'ATH'
  };
  var STARTER_IMPACT = { QB: 'HIGH', OL: 'HIGH', EDGE: 'HIGH', WR: 'MEDIUM', RB: 'MEDIUM', TE: 'MEDIUM', DL: 'MEDIUM', CB: 'MEDIUM', S: 'MEDIUM', LB: 'MEDIUM', DB: 'MEDIUM', K: 'LOW', P: 'LOW', LS: 'LOW', ATH: 'LOW' };
  var NONSTARTER_IMPACT = { QB: 'MEDIUM', OL: 'LOW', EDGE: 'LOW', WR: 'LOW', RB: 'LOW', TE: 'LOW', DL: 'LOW', CB: 'LOW', S: 'LOW', LB: 'LOW', DB: 'LOW', K: 'LOW', P: 'LOW', LS: 'LOW', ATH: 'LOW' };
  function posGroup(position) { var p = String(position || '').toUpperCase().replace(/[^A-Z]/g, ''); return POS_GROUP[p] || null; }
  function isStarterRole(depthRole) { var r = lower(depthRole); return !!r && /(^|[^0-9])1($|[^0-9])|starter|^qb1|^rb1|^wr1|^lt$|^rt$/.test(r); }
  function impactLevel(rec) {
    var grp = posGroup(rec && rec.position);
    if (!grp) return 'UNKNOWN';
    var doubt = DOUBT[rec && rec.status] || 0;
    /* An AVAILABLE or EXPECTED player is news, not an absence. */
    if (doubt <= DOUBT.PROBABLE) return 'LOW';
    var base = isStarterRole(rec && rec.depth_role) ? STARTER_IMPACT[grp] : NONSTARTER_IMPACT[grp];
    if (!base) return 'UNKNOWN';
    /* A questionable starter is one notch below an out starter. */
    if (base === 'HIGH' && doubt < DOUBT.DOUBTFUL) return 'MEDIUM';
    return base;
  }

  /* ------------------------------------------------------------- freshness */
  /* Last week's report is not this week's news. Kickoff, when known, is what
     "this game" means; otherwise the observation's own age is used. */
  function getAvailabilityFreshness(rec, opts) {
    opts = opts || {};
    var now = toMs(opts.now) != null ? toMs(opts.now) : Date.now();
    var seen = toMs(rec && (rec.source_published_at || rec.observed_at));
    if (seen == null) return { state: 'HISTORICAL', age_hours: null, reason: 'the report carries no timestamp' };
    var kick = toMs(opts.kickoff);
    var ageH = (now - seen) / 3600000;
    if (kick != null) {
      /* a report from before the previous game week cannot describe this one */
      var beforeKick = (kick - seen) / 3600000;
      if (beforeKick > 168) return { state: 'HISTORICAL', age_hours: ageH, reason: 'filed more than a week before kickoff' };
      if (beforeKick > 96) return { state: 'STALE', age_hours: ageH, reason: 'filed before this game week' };
    }
    if (ageH < 0) return { state: 'LIVE', age_hours: 0, reason: null };
    if (ageH <= 6) return { state: 'LIVE', age_hours: ageH, reason: null };
    if (ageH <= 48) return { state: 'CURRENT', age_hours: ageH, reason: null };
    if (ageH <= 96) return { state: 'AGING', age_hours: ageH, reason: null };
    if (ageH <= 168) return { state: 'STALE', age_hours: ageH, reason: null };
    return { state: 'HISTORICAL', age_hours: ageH, reason: 'older than a week' };
  }
  var FRESH_RANK = { LIVE: 5, CURRENT: 4, AGING: 3, STALE: 2, HISTORICAL: 1 };
  function isCurrentEnough(state) { return FRESH_RANK[state] >= FRESH_RANK.AGING; }

  /* --------------------------------------------------------- canonicalize */
  /* One player, many reports. The canonical record is the best evidence:
     highest source tier, then highest confidence, then newest. A newer
     lower-tier report that disagrees does NOT win — it is recorded as a
     contested note so the disagreement is visible instead of lost. */
  function reportKey(r) { return [r.team_id || r.team_abbr || '', r.player_id || normName(r.player_name), r.week == null ? '' : r.week].join('|'); }
  function rankReport(r) {
    return [10 - (sourceTier(r.source_type) || 9), CONF_RANK[r.confidence] || 0, toMs(r.source_published_at || r.observed_at) || 0];
  }
  function betterOf(a, b) {
    var ra = rankReport(a), rb = rankReport(b);
    for (var i = 0; i < ra.length; i++) { if (ra[i] !== rb[i]) return ra[i] > rb[i] ? a : b; }
    return a;
  }
  function canonicalize(reports, opts) {
    opts = opts || {};
    var usable = (reports || []).filter(isUsableSource);
    if (!usable.length) return null;
    var best = usable.reduce(function (acc, r) { return acc ? betterOf(acc, r) : r; }, null);
    var contested = usable.filter(function (r) {
      if (r === best) return false;
      if (r.status === best.status || r.status === 'UNKNOWN') return false;
      return true;
    }).map(function (r) {
      var newer = (toMs(r.source_published_at || r.observed_at) || 0) > (toMs(best.source_published_at || best.observed_at) || 0);
      return { status: r.status, source_name: r.source_name, source_type: r.source_type, source_url: r.source_url || null,
        published_at: r.source_published_at || r.observed_at || null, newer_than_canonical: newer,
        why_not_canonical: newer ? ('a ' + String(r.source_type).toLowerCase().replace(/_/g, ' ') + ' report is newer but ranks below the ' + String(best.source_type).toLowerCase().replace(/_/g, ' ') + ' it contradicts')
          : ('older than the ' + String(best.source_type).toLowerCase().replace(/_/g, ' ') + ' report that stands') };
    });
    /* the practice trail, only for days a source actually reported */
    var timeline = usable.filter(function (r) { return r.practice_status && r.practice_status !== 'NOT_REPORTED' && r.practice_status !== 'UNKNOWN'; })
      .map(function (r) { var ms = toMs(r.source_published_at || r.observed_at); return { at: ms != null ? iso(ms) : null, day: ms != null ? dayName(ms, opts.tz) : null, practice_status: r.practice_status, status: r.status, source_name: r.source_name, source_type: r.source_type }; })
      .filter(function (x) { return x.at; })
      .sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
    var seenDay = {}, trail = [];
    timeline.forEach(function (x) { seenDay[x.day + '|' + x.practice_status] = 1; });
    timeline.forEach(function (x) { var k = x.day; if (trail.length && trail[trail.length - 1].day === k) { trail[trail.length - 1] = x; return; } trail.push(x); });
    var fresh = getAvailabilityFreshness(best, opts);
    var canonical = {
      id: reportKey(best), season: best.season, week: best.week,
      team_id: best.team_id || null, team_name: best.team_name || null, team_abbr: best.team_abbr || null,
      player_id: best.player_id || null, player_name: best.player_name, position: best.position || null, depth_role: best.depth_role || null,
      availability_status: best.status, practice_status: best.practice_status || 'NOT_REPORTED',
      injury_type: best.injury_type || null, body_part: best.body_part || null,
      source_type: best.source_type, source_name: best.source_name, source_url: best.source_url || null,
      source_published_at: best.source_published_at || null, observed_at: best.observed_at,
      raw_status: best.raw_status || null, raw_text: best.raw_text || null,
      confidence: best.confidence, impact_level: impactLevel(best),
      verified: sourceTier(best.source_type) === 1 && CONF_RANK[best.confidence] >= CONF_RANK.HIGH,
      freshness: fresh.state, freshness_reason: fresh.reason, age_hours: fresh.age_hours == null ? null : Math.round(fresh.age_hours * 10) / 10,
      observations: best.observations || [],
      evidence_count: usable.length,
      contested: contested.length > 0, contested_by: contested,
      timeline: trail,
      evidence: usable.map(function (r) {
        return { status: r.status, practice_status: r.practice_status || 'NOT_REPORTED', source_type: r.source_type, source_name: r.source_name,
          source_url: r.source_url || null, published_at: r.source_published_at || r.observed_at || null, confidence: r.confidence, raw_text: r.raw_text || null };
      }).sort(function (a, b) { return String(b.published_at || '').localeCompare(String(a.published_at || '')); })
    };
    return canonical;
  }
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function dayName(ms, tz) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', weekday: 'short' }).format(new Date(ms)); }
    catch (e) { return DAYS[new Date(ms).getUTCDay()]; }
  }

  /* Build every canonical record for a set of raw reports. */
  function buildCanonical(reports, opts) {
    var groups = {};
    (reports || []).forEach(function (r) { if (!isUsableSource(r)) return; var k = reportKey(r); (groups[k] = groups[k] || []).push(r); });
    var out = [];
    Object.keys(groups).forEach(function (k) { var c = canonicalize(groups[k], opts); if (c) out.push(c); });
    out.sort(function (a, b) {
      var ia = IMPACT_RANK[a.impact_level] || 0, ib = IMPACT_RANK[b.impact_level] || 0;
      if (ia !== ib) return ib - ia;
      return (DOUBT[b.availability_status] || 0) - (DOUBT[a.availability_status] || 0) || String(a.player_name).localeCompare(String(b.player_name));
    });
    return out;
  }
  var IMPACT_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

  /* ----------------------------------------------------- game-level summary */
  /* "No reported injuries" and "we have no data" are different statements and
     this function is where that distinction is made. */
  function teamSummary(records, opts) {
    opts = opts || {};
    var recs = (records || []).filter(function (r) { return isCurrentEnough(r.freshness); });
    var stale = (records || []).length - recs.length;
    var flagged = recs.filter(function (r) { return (DOUBT[r.availability_status] || 0) > DOUBT.PROBABLE; });
    var high = flagged.filter(function (r) { return r.impact_level === 'HIGH'; });
    var other = flagged.filter(function (r) { return r.impact_level !== 'HIGH'; });
    var cleared = recs.filter(function (r) { return (DOUBT[r.availability_status] || 0) <= DOUBT.PROBABLE && r.availability_status !== 'UNKNOWN'; });
    var official = recs.filter(function (r) { return sourceTier(r.source_type) === 1; });
    var checked = !!(opts.sources_checked);
    var quality;
    if (!checked && !recs.length) quality = 'NONE';
    else if (official.length && recs.length >= 3) quality = 'STRONG';
    else if (recs.length) quality = 'PARTIAL';
    else if (opts.official_report_found) quality = 'STRONG';        /* an official report that lists nobody */
    else quality = checked ? 'LIMITED' : 'NONE';
    return {
      highImpact: high, other: other, cleared: cleared,
      unknown: quality === 'NONE' || quality === 'LIMITED',
      counts: { flagged: flagged.length, high: high.length, cleared: cleared.length, records: recs.length, stale: stale, official: official.length },
      dataQuality: quality,
      official_report_found: !!opts.official_report_found,
      sources_checked: opts.sources_checked || 0, sources_failed: opts.sources_failed || 0,
      lastUpdated: recs.reduce(function (m, r) { var t = r.observed_at; return (!m || String(t) > String(m)) ? t : m; }, null)
    };
  }
  var QUALITY_RANK = { STRONG: 4, PARTIAL: 3, LIMITED: 2, NONE: 1 };
  function getGameAvailabilitySummary(game) {
    game = game || {};
    var home = teamSummary(game.home_records, game.home_meta || {});
    var away = teamSummary(game.away_records, game.away_meta || {});
    var q = QUALITY_RANK[home.dataQuality] < QUALITY_RANK[away.dataQuality] ? home.dataQuality : away.dataQuality;
    return {
      home: home, away: away,
      dataQuality: q,
      lastUpdated: [home.lastUpdated, away.lastUpdated].filter(Boolean).sort().pop() || null,
      sources_checked: (home.sources_checked || 0) + (away.sources_checked || 0),
      sources_failed: (home.sources_failed || 0) + (away.sources_failed || 0)
    };
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, STATUSES: STATUSES, PRACTICE: PRACTICE, DOUBT: DOUBT,
    SOURCE_TIER: SOURCE_TIER, REFUSED_SOURCES: REFUSED_SOURCES, sourceTier: sourceTier, isUsableSource: isUsableSource,
    normalizeAvailabilityStatus: normalizeAvailabilityStatus, normalizeDesignation: normalizeDesignation,
    normName: normName, nameParts: nameParts, resolvePlayer: resolvePlayer,
    scoreConfidence: scoreConfidence, CONF_RANK: CONF_RANK,
    posGroup: posGroup, isStarterRole: isStarterRole, impactLevel: impactLevel, IMPACT_RANK: IMPACT_RANK,
    getAvailabilityFreshness: getAvailabilityFreshness, isCurrentEnough: isCurrentEnough, FRESH_RANK: FRESH_RANK,
    canonicalize: canonicalize, buildCanonical: buildCanonical, reportKey: reportKey, rankReport: rankReport,
    teamSummary: teamSummary, getGameAvailabilitySummary: getGameAvailabilitySummary, QUALITY_RANK: QUALITY_RANK,
    dayName: dayName
  };
});
