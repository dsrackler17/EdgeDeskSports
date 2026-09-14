// deno-lint-ignore-file
/* ============================================================================
   EdgeDesk INTELLIGENCE KERNEL — the deterministic half of the research desk.

   ONE FILE, TWO HOSTS. This exact block is inlined into:
     - supabase/functions/edgedesk_ai/index.ts   (server: retrieval + decisions)
     - app.html                                   (browser: board + cards)
   tools/presentation/inline.js keeps them byte-identical and
   presentation_sync.test.js fails the moment one drifts. Edit THIS file.

   WHY IT EXISTS
     The presentation layer (EDPRES) translates a decision that already exists.
     Nothing owned the decision itself for anything but a captured signal, so a
     game with a schedule, a model line and no quote had no decision at all —
     and "no signal row" became "no game". This kernel owns that middle ground:
     what a slate IS, what a fair price ACTUALLY rests on, whether a quote is
     still live, whether a defensible probability exists for a market at all,
     and what decision the evidence supports.

   THE RULES IT ENFORCES, AND THEY ARE NOT NEGOTIABLE
     1. A fair price is labelled by the reference that PRODUCED it. The phrase
        "Pinnacle de-vig fair" is generated in exactly one place — fairMethod()
        — and only when a reference book's own de-vigged number is on the row.
     2. Book count is not sharp confirmation. Six soft books cloning a number
        are one opinion, and confirmationRead() says so in words.
     3. A model disagreement is not an edge. Model EV is computed ONLY where a
        documented, out-of-sample outcome probability exists for that sport and
        market, and the validation record travels with every number it touches.
     4. A stale quote is research. It can never be actionable, and refreshing
        that fails leaves the last observed price with its timestamp attached
        and its actionability withdrawn.
     5. An empty query is not an empty world. slateState() distinguishes no
        scheduled games, games without quotes, games without signals, a failed
        retrieval and incomplete coverage, and carries the sentence the answer
        must use.
     6. Nothing here invents a number. Every probability is either a de-vigged
        market price, or an owned model output whose validation is quoted
        alongside it, or null with a reason.
   ============================================================================ */
/*__EDINTEL_START__*/
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDINTEL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var PACKET_SCHEMA = 'edgedesk_game_evidence_v1';
  var LEDGER_SCHEMA = 'edgedesk_recommendation_v1';
  var DECISIONS = ['BET CANDIDATE', 'WATCH', 'PASS', 'INSUFFICIENT DATA'];
  /* Not a decision. The absence of one, named, so it can never be read as a
     judgement about a selection — and deliberately NOT in DECISIONS, so the
     ledger's own validator refuses to record it as though the desk decided. */
  var DECISIONS_DISABLED = 'DECISIONS DISABLED';

  /* ====================================================================== */
  /* THE FBS TEAM RESOLVER — COPIED FROM football/fbs/fbs.js, NOT REWRITTEN. */
  /*                                                                        */
  /* This is the whole reason Intelligence said "no CFB matchups" on a board */
  /* showing 75 games and 46 markets. The odds capture writes the BOOK's     */
  /* name for a program — "North Texas Mean Green", "Miami (OH) RedHawks" —  */
  /* and the college schedule writes the school alone — "North Texas",       */
  /* "Miami". A server that joins those two feeds on a normalised string     */
  /* joins NOTHING, and reports that emptiness as an absence of markets.     */
  /* tools/newsletter/market.js hit exactly this and says so: "a live run    */
  /* read 410 college signal rows and joined zero, and every refusal said    */
  /* no_slate_game_with_both_teams".                                         */
  /*                                                                        */
  /* The board never had that bug because it resolves through EDFbs. So the  */
  /* resolver is COPIED here by tools/presentation/inline.js rather than     */
  /* re-implemented: one alias table, one prefix rule, and a board and a     */
  /* desk that cannot disagree about who is playing.                        */
  /* ====================================================================== */
  /*__EDFBSKEY_START__*/
  /* SHARED WITH THE EDGE FUNCTION. tools/presentation/inline.js copies this
     block verbatim into supabase/functions/edgedesk_ai/_intelligence.js, which
     is itself copied into index.ts and app.html. The odds capture writes book
     names ("North Texas Mean Green") and the college schedule writes school
     names ("North Texas"), so a server that compares normalised strings joins
     NOTHING — the failure tools/newsletter/market.js documents as "410 college
     signal rows and joined zero". One resolver, one alias table, copied rather
     than re-implemented, so the board and the desk cannot disagree about who
     is playing. presentation_sync.test.js fails on drift. */
  var ACCENTS = { 'é': 'e', 'í': 'i', 'á': 'a', 'ó': 'o',
    'ú': 'u', 'ñ': 'n', '’': "'", '‘': "'" };
  function normKey(name) {
    if (name == null) return null;
    var s = String(name).trim().toLowerCase(), out = '', i, c;
    for (i = 0; i < s.length; i++) { c = s.charAt(i); out += (ACCENTS[c] || c); }
    out = out.replace(/[^a-z0-9]+/g, '');
    return out || null;
  }

  /* A LOOSER key, for joining feeds that decorate the school name with a
     nickname ("Ohio Bobcats" for "Ohio") or an ampersand ("Texas A&M" ->
     "texasaandm" in one artifact, "texasam" in another). Used ONLY for
     alias resolution, never as a team's identity. */
  function aliasKey(name) {
    if (name == null) return null;
    var s = String(name).trim().toLowerCase(), out = '', i, c;
    for (i = 0; i < s.length; i++) { c = s.charAt(i); out += (ACCENTS[c] || c); }
    out = out.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    return out || null;
  }

  /*__EDFBSKEY_END__*/

  /*__EDFBSRESOLVE_START__*/
  var TEAM_ALIASES = {
    appstate: ['appalachian state', 'appalachian st', 'app st'],
    hawaii: ["hawai'i", 'hawaii', 'hawaii rainbow warriors', 'university of hawaii'],
    sanjosestate: ['san jose state', 'san jose st', 'sjsu'],
    miamioh: ['miami ohio', 'miami (ohio)', 'miami oh', 'miami (oh)', 'miami redhawks', 'miami-ohio'],
    miami: ['miami fl', 'miami (fl)', 'miami florida', 'miami (florida)', 'miami hurricanes', 'miami-florida'],
    olemiss: ['mississippi', 'ole miss rebels'],
    massachusetts: ['umass', 'u mass', 'mass'],
    southernmiss: ['southern mississippi', 'southern miss', 'so miss', 'usm'],
    uconn: ['connecticut'],
    ulmonroe: ['louisiana monroe', 'louisiana-monroe', 'ul monroe', 'ulm', 'la monroe'],
    louisiana: ['louisiana lafayette', 'louisiana-lafayette', 'ul lafayette', 'ull', 'la lafayette',
      'louisiana ragin cajuns'],
    ncstate: ['north carolina state', 'n c state', 'nc st'],
    utsa: ['texas san antonio', 'texas-san antonio', 'ut san antonio'],
    utep: ['texas el paso', 'texas-el paso', 'ut el paso'],
    floridainternational: ['fiu', 'florida intl'],
    floridaatlantic: ['fau'],
    uab: ['alabama birmingham', 'alabama-birmingham', 'ala birmingham'],
    ucf: ['central florida'],
    southflorida: ['usf'],
    smu: ['southern methodist'],
    tcu: ['texas christian'],
    byu: ['brigham young'],
    lsu: ['louisiana state'],
    pittsburgh: ['pitt'],
    texasam: ['texas a&m', 'texas a and m', 'texas am', 'texas a m', 'texas aandm', 'texasaandm'],
    samhouston: ['sam houston state', 'sam houston st', 'shsu'],
    jacksonvillestate: ['jax state', 'jacksonville st'],
    usc: ['southern california', 'southern cal'],
    unlv: ['nevada las vegas', 'nevada-las vegas', 'las vegas'],
    nevada: ['nevada reno', 'nevada-reno'],
    middletennessee: ['middle tennessee state', 'middle tennessee st', 'mtsu'],
    westernkentucky: ['wku'],
    northernillinois: ['niu'],
    charlotte: ['north carolina charlotte', 'unc charlotte'],
    olddominion: ['odu'],
    coastalcarolina: ['ccu'],
    bowlinggreen: ['bowling green state'],
    kentstate: ['kent'],
    sacramentostate: ['sac state', 'sacramento st', 'csu sacramento'],
    northdakotastate: ['ndsu', 'north dakota st'],
    missouristate: ['missouri st'],
    kennesawstate: ['kennesaw st'],
    georgiasouthern: ['ga southern'],
    georgiastate: ['ga state'],
    mississippistate: ['miss state', 'mississippi st'],
    northcarolina: ['unc'],
    fresnostate: ['fresno st'],
    boisestate: ['boise st'],
    arizonastate: ['arizona st'],
    michiganstate: ['michigan st'],
    oklahomastate: ['oklahoma st'],
    oregonstate: ['oregon st'],
    washingtonstate: ['washington st'],
    pennstate: ['penn st'],
    iowastate: ['iowa st'],
    kansasstate: ['kansas st'],
    floridastate: ['florida st'],
    coloradostate: ['colorado st'],
    sandiegostate: ['san diego st'],
    utahstate: ['utah st'],
    texasstate: ['texas st'],
    arkansasstate: ['arkansas st'],
    ballstate: ['ball st'],
    newmexicostate: ['new mexico st'],
    louisianatech: ['la tech'],
    virginiatech: ['va tech'],
    eastcarolina: ['ecu'],
    westvirginia: ['wvu']
  };
  /* the reverse map, keyed the loose way so "Texas A&M" and "Texas AandM"
     both land on the same row */
  var ALIAS_TO_KEY = {};
  (function () {
    var k, i;
    for (k in TEAM_ALIASES) if (Object.prototype.hasOwnProperty.call(TEAM_ALIASES, k)) {
      for (i = 0; i < TEAM_ALIASES[k].length; i++) ALIAS_TO_KEY[aliasKey(TEAM_ALIASES[k][i])] = k;
    }
  })();

  /* "Boise St" and "Boise St." are the same school as "Boise State"; the
     expansion is tried only AFTER the exact and alias passes fail, so it can
     never overrule a real name. */
  function expandState(name) {
    var s = String(name == null ? '' : name);
    var out = s.replace(/(^|[^a-z])st\.?($|[^a-z])/gi, function (m, a, b) { return a + 'State' + b; });
    return out === s ? null : out;
  }

  function teamIndex(universe) {
    var ix = { byKey: {}, byAlias: {}, keys: [], prefixes: [], universe: universe };
    if (!universe || !universe.teams) return ix;
    var i, k, t;
    for (i = 0; i < universe.order.length; i++) {
      k = universe.order[i]; t = universe.teams[k];
      ix.byKey[k] = t;
      ix.byAlias[aliasKey(t.name)] = k;
      for (var a = 0; a < t.aliases.length; a++) ix.byAlias[aliasKey(t.aliases[a])] = k;
      ix.keys.push(k);
    }
    for (k in ALIAS_TO_KEY) if (Object.prototype.hasOwnProperty.call(ALIAS_TO_KEY, k)) {
      if (ix.byKey[ALIAS_TO_KEY[k]] && !ix.byAlias[k]) ix.byAlias[k] = ALIAS_TO_KEY[k];
    }
    ix.keys.sort(function (x, y) { return y.length - x.length || x.localeCompare(y); });
    /* The prefix pass runs over canonical keys AND known aliases together:
       a book writes "UMass Minutemen" and "Pitt Panthers", which are a
       nickname stuck onto an ALIAS, not onto the school's schedule name. */
    var seen = {};
    function addPrefix(s, key) {
      if (!s || s.length < 3 || seen[s + '|' + key]) return;
      seen[s + '|' + key] = 1;
      ix.prefixes.push({ s: s, key: key });
    }
    for (i = 0; i < ix.keys.length; i++) addPrefix(ix.keys[i], ix.keys[i]);
    for (k in ix.byAlias) if (Object.prototype.hasOwnProperty.call(ix.byAlias, k)) addPrefix(k, ix.byAlias[k]);
    ix.prefixes.sort(function (x, y) { return y.s.length - x.s.length || x.s.localeCompare(y.s); });
    return ix;
  }

  function resolveTeam(name, ix, opts) {
    opts = opts || {};
    if (!ix || !name) return null;
    var k = normKey(name);
    if (k && ix.byKey[k]) return { key: k, team: ix.byKey[k], how: 'exact', ambiguous: null };
    var ak = aliasKey(name);
    if (ak && ix.byAlias[ak]) return { key: ix.byAlias[ak], team: ix.byKey[ix.byAlias[ak]], how: 'alias', ambiguous: null };
    var ex = expandState(name);
    if (ex) {
      var ek = normKey(ex), eak = aliasKey(ex);
      if (ek && ix.byKey[ek]) return { key: ek, team: ix.byKey[ek], how: 'state-expansion', ambiguous: null };
      if (eak && ix.byAlias[eak]) return { key: ix.byAlias[eak], team: ix.byKey[ix.byAlias[eak]], how: 'state-expansion', ambiguous: null };
    }
    /* longest unambiguous prefix, over canonical keys and aliases together.
       `ix.prefixes` is longest-first, so the first hit is the longest; a
       SECOND hit of the same length pointing at a DIFFERENT school is a tie
       and resolves to nothing — "Ohio" must never swallow "Ohio State", and
       Miami Florida must never take Miami Ohio's number. */
    if (!ak || ak.length < (opts.minPrefix == null ? 3 : opts.minPrefix)) return null;
    var best = null, tie = null, i, c;
    for (i = 0; i < ix.prefixes.length; i++) {
      c = ix.prefixes[i];
      if (ak.indexOf(c.s) !== 0) continue;
      if (!best) { best = c; continue; }
      if (c.s.length === best.s.length) { if (c.key !== best.key) { tie = c; } continue; }
      break;                                     /* shorter than `best`: stop */
    }
    if (!best) return null;
    if (tie) return { key: null, team: null, how: 'ambiguous', ambiguous: [best.key, tie.key] };
    return { key: best.key, team: ix.byKey[best.key], how: 'prefix', matched: best.s, ambiguous: null };
  }

  /* Does this captured odds event describe this scheduled game? Both sides
     must resolve to the game's own teams and the kickoffs must agree. A
     half match is not a match: a quote joined on the home team alone is how
     a book's Ohio number ends up priced against Ohio State. */
  function matchesEvent(ev, item, ix, opts) {
    opts = opts || {};
    if (!ev || !item) return false;
    var windowMs = opts.windowMs == null ? 36 * 3600e3 : opts.windowMs;
    var hk = item.meta ? item.meta.home.key : normKey(item.g && item.g.home_team);
    var ak = item.meta ? item.meta.away.key : normKey(item.g && item.g.away_team);
    var rh = resolveTeam(ev.home, ix), ra = resolveTeam(ev.away, ix);
    if (!rh || !ra || !rh.key || !ra.key) return false;
    if (rh.key !== hk || ra.key !== ak) return false;
    var t = Date.parse(ev.t);
    if (!isFinite(t) || !isFinite(item.t)) return false;
    return Math.abs(t - item.t) < windowMs;
  }
  /*__EDFBSRESOLVE_END__*/

  /* ------------------------------------------------------------------ util */
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function clean(v) { return str(v).replace(/\s+/g, ' ').trim(); }
  function r4(v) { var n = num(v); return n == null ? null : Math.round(n * 1e4) / 1e4; }
  function r2(v) { var n = num(v); return n == null ? null : Math.round(n * 100) / 100; }
  function toMs(t) {
    if (t == null || t === '') return null;
    if (typeof t === 'number') return isFinite(t) ? t : null;
    var ms = Date.parse(String(t));
    return isFinite(ms) ? ms : null;
  }
  function uniq(a) { var s = [], i; for (i = 0; i < (a || []).length; i++) if (a[i] != null && s.indexOf(a[i]) < 0) s.push(a[i]); return s; }
  function pct(v, dp) { var n = num(v); return n == null ? null : (n * 100).toFixed(dp == null ? 1 : dp) + '%'; }
  /* Name comparison for side resolution. Same shape as the resolver in the
     edge function and the FBS universe: accents folded, punctuation dropped,
     whitespace collapsed. A display label is compared, never trusted as an id. */
  function normName(v) {
    var t = String(v == null ? '' : v).toLowerCase();
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* older runtimes */ }
    return t.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function pp(v, dp) { var n = num(v); return n == null ? null : (n >= 0 ? '+' : '') + (n * 100).toFixed(dp == null ? 1 : dp) + ' pp'; }

  /* ==================================================================== */
  /* CONFIGURATION — every threshold explicit, every one overridable.      */
  /*                                                                       */
  /* Nothing below is a universal betting truth and none of it is asserted */
  /* as one. These are EdgeDesk's operating limits, named so they can be   */
  /* argued with, moved, or measured. configure() merges an override map   */
  /* so a deployment can move a limit without editing this file.           */
  /* ==================================================================== */
  var CONFIG = {
    /* The EV floor a price must clear before a decision may be actionable.
       Tracks the browser engine's REAL_FLOOR so the two halves of the product
       cannot disagree about the same number. */
    /* THE KILL SWITCH, AS A SWITCH.
       This used to be documented as `configure({ ev_floor: 1 })` — set the
       expected-value floor to 100% per unit and nothing can clear it. That is
       a threshold pressed into service as a control, and it is the wrong shape
       three ways over. It only reaches a verdict through one branch, which is
       conditioned on an expected value EXISTING, and for college spreads under
       RESEARCH_LEAN there usually is none. What it does produce is PASS — a
       substantive betting judgement meaning "evaluated, and not worth it at
       this price" — when the truth is that the desk is not making decisions at
       all. And it writes ev_floor: 1 into the ledger's config_used, so rows
       recorded during the shutdown claim a floor that was never a policy.
       An operator turning the decision layer off should not have to reason
       about any of that. */
    decisions_enabled: true,
    ev_floor: 0.005,
    /* How much better than the floor a price must be before the decision is
       allowed to read as a candidate rather than a lean. */
    candidate_ev: 0.02,
    /* Quote freshness, in minutes, by market family. A pregame side moves more
       slowly than a total on a short board; both move faster than a future. */
    quote_ttl_min: { h2h: 90, spreads: 90, totals: 90, futures: 720, _default: 90 },
    /* Past this multiple of its TTL a quote is not merely aging, it is stale
       and may not support an actionable conclusion at all. */
    stale_multiple: 1,
    /* A quote whose age cannot be established is treated as unverified rather
       than as fresh. The conservative direction, always. */
    unknown_age_is_actionable: false,
    /* Minimum independent book families behind a fair price before the number
       is treated as corroborated. Families, not books: cloned lines from one
       feed are one opinion however many brands carry it. */
    min_independent_families: 3,
    /* A model-versus-market gap this large or larger triggers the diagnostic
       checklist rather than a recommendation. In points of spread or total. */
    disagreement_points: 3,
    /* Above this, EdgeDesk treats the disagreement as a suspected data fault
       and refuses to treat it as value at all. */
    disagreement_points_hard: 7,
    /* A market whose validation record does not clear these may never produce
       a BET CANDIDATE on model grounds alone. */
    min_validation_n: 500,
    max_validation_p: 0.05,
    /* How much of the detection edge must survive before a candidate stands. */
    min_edge_remaining: 0.4,
    /* Kickoff guard: inside this many minutes a pregame price is not treated
       as reliably available. */
    min_minutes_to_kickoff: 2
  };
  function configure(over) {
    if (!over) return CONFIG;
    for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) {
      if (k === 'quote_ttl_min' && over[k] && typeof over[k] === 'object') {
        for (var m in over[k]) if (Object.prototype.hasOwnProperty.call(over[k], m)) CONFIG.quote_ttl_min[m] = over[k][m];
      } else CONFIG[k] = over[k];
    }
    return CONFIG;
  }
  function config() { return CONFIG; }

  /* ==================================================================== */
  /* ODDS MATHEMATICS                                                      */
  /*                                                                       */
  /* All of it deterministic, all of it reversible, none of it a model.    */
  /* The one formula that matters, stated once and implemented once:       */
  /*                                                                       */
  /*     EV per unit staked = P(win) x (d - 1) - P(loss)                   */
  /*                                                                       */
  /* A push returns the stake and contributes ZERO profit, so it is not a  */
  /* loss and must not be folded into one. P(win) + P(loss) + P(push) = 1. */
  /* ==================================================================== */

  function americanToDec(am) {
    var a = num(am);
    if (a == null || a === 0) return null;
    return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
  }
  function decToAmerican(dec) {
    var d = num(dec);
    if (d == null || d <= 1) return null;
    return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
  }
  function fmtAmerican(am) {
    var a = num(am);
    if (a == null) return null;
    a = Math.round(a);
    return (a > 0 ? '+' : '') + a;
  }
  /** The raw implied probability of a decimal price, vig included. */
  function impliedProb(dec) { var d = num(dec); return (d == null || d <= 1) ? null : 1 / d; }

  /**
   * Strip the vig from a two-way market.
   *
   * `proportional` (the default, also called multiplicative) divides each raw
   * implied probability by the overround. It is the method the rest of this
   * stack uses and the one every number here is comparable with. It assumes
   * the book's margin is applied evenly across both sides, which is known to
   * be false at long prices — favourite-longshot bias puts more of the margin
   * on the longshot — so a de-vigged number on a heavy favourite is the least
   * trustworthy one this function produces. That limitation is returned WITH
   * the answer rather than left for the reader to remember.
   */
  function devigTwoWay(decA, decB, method) {
    var a = impliedProb(decA), b = impliedProb(decB);
    if (a == null || b == null) {
      return { ok: false, method: null, p_a: null, p_b: null, overround: null,
        why: 'A two-way de-vig needs both sides of the market. Only ' + (a == null && b == null ? 'neither side' : 'one side') + ' is on file.' };
    }
    var over = a + b;
    if (!(over > 0.9) || over > 1.6) {
      return { ok: false, method: null, p_a: null, p_b: null, overround: r4(over),
        why: 'The two prices imply a book overround of ' + over.toFixed(3) + ', which is not a coherent two-way market. One of the sides is stale, mispaired or a placeholder.' };
    }
    var m = method === 'additive' ? 'additive' : 'proportional';
    var pa, pb;
    if (m === 'additive') { var half = (over - 1) / 2; pa = a - half; pb = b - half; }
    else { pa = a / over; pb = b / over; }
    if (!(pa > 0 && pa < 1 && pb > 0 && pb < 1)) {
      return { ok: false, method: m, p_a: null, p_b: null, overround: r4(over),
        why: 'De-vigging these two prices produced a value outside 0-1, so it is not a probability.' };
    }
    return {
      ok: true, method: m, p_a: r4(pa), p_b: r4(pb), overround: r4(over),
      vig_points: r4(over - 1),
      limitation: 'Proportional de-vig assumes the margin is spread evenly across both sides. Favourite-longshot bias means it is not, so the de-vigged number on a heavy favourite carries the most error.'
    };
  }

  /**
   * Expected value per unit staked, pushes handled correctly.
   *
   * Returns null rather than a number whenever an input is missing, because a
   * missing probability is the single commonest way a plausible EV gets
   * manufactured out of nothing.
   */
  function ev(o) {
    o = o || {};
    var d = num(o.dec) != null ? num(o.dec) : americanToDec(o.american);
    var pw = num(o.p_win), pp_ = num(o.p_push) || 0;
    if (d == null || d <= 1 || pw == null) {
      return { ev: null, p_win: pw, p_push: pp_ || null, p_loss: null, dec: d,
        why: d == null || d <= 1 ? 'No usable price.' : 'No outcome probability, so there is no expected value to compute. A line difference alone is not a probability.' };
    }
    if (pw < 0 || pw > 1 || pp_ < 0 || pp_ > 1 || pw + pp_ > 1 + 1e-9) {
      return { ev: null, p_win: pw, p_push: pp_, p_loss: null, dec: d,
        why: 'The supplied probabilities do not form a distribution (win + push exceeds 1).' };
    }
    var pl = Math.max(0, 1 - pw - pp_);
    var e = pw * (d - 1) - pl;
    return {
      ev: r4(e), p_win: r4(pw), p_push: r4(pp_), p_loss: r4(pl), dec: r4(d),
      formula: 'EV = P(win) x (d - 1) - P(loss); a push returns the stake and adds zero profit',
      why: null
    };
  }

  /** The win probability at which this price breaks even, pushes included. */
  function breakEvenProb(dec, pPush) {
    var d = num(dec), q = num(pPush) || 0;
    if (d == null || d <= 1) return null;
    return r4((1 - q) / d);
  }
  /** The decimal price at which a given probability earns exactly `target` EV. */
  function priceForEv(pWin, pPush, target) {
    var pw = num(pWin), q = num(pPush) || 0, t = num(target) || 0;
    if (pw == null || pw <= 0) return null;
    return r4((t + 1 - q) / pw);
  }
  /** The worst price still clearing the floor: below this the bet is off. */
  function minPlayableDec(pWin, pPush, floor) {
    return priceForEv(pWin, pPush, floor == null ? CONFIG.ev_floor : floor);
  }

  /* ==================================================================== */
  /* EMPIRICAL DISTRIBUTIONS — for pushes, and for nothing else by default */
  /*                                                                       */
  /* A push probability is a real, computable quantity the moment a margin  */
  /* distribution exists, and a fabricated one is indistinguishable from a  */
  /* real one in the output. So distributions are REGISTERED, with their    */
  /* training period and scope attached, and a market with no registered    */
  /* distribution returns null and says why.                               */
  /* ==================================================================== */
  var DISTRIBUTIONS = {};

  /**
   * Register an empirical distribution.
   *
   * `pmf` is a map of integer outcome -> probability. `basis` must name what it
   * was fitted on and over what period; a registration without one is refused,
   * because an undocumented distribution is the thing this whole layer exists
   * to prevent.
   */
  function registerDistribution(key, spec) {
    if (!key || !spec || !spec.pmf || !spec.basis || !spec.window) {
      return { ok: false, why: 'A distribution must carry a pmf, a fitted window and a basis naming what it was fitted on. It is refused without them.' };
    }
    var total = 0, k;
    for (k in spec.pmf) if (Object.prototype.hasOwnProperty.call(spec.pmf, k)) total += num(spec.pmf[k]) || 0;
    if (!(total > 0.95 && total < 1.05)) return { ok: false, why: 'The supplied pmf sums to ' + total.toFixed(4) + ', which is not a distribution.' };
    DISTRIBUTIONS[key] = {
      key: key, pmf: spec.pmf, window: spec.window, basis: spec.basis,
      sport: spec.sport || null, quantity: spec.quantity || null,
      sigma: num(spec.sigma), limitations: spec.limitations || null,
      calibration: spec.calibration || null, registered_at: new Date().toISOString()
    };
    return { ok: true, key: key, mass: r4(total) };
  }
  function distribution(key) { return DISTRIBUTIONS[key] || null; }
  function distributions() { var o = [], k; for (k in DISTRIBUTIONS) if (Object.prototype.hasOwnProperty.call(DISTRIBUTIONS, k)) o.push(DISTRIBUTIONS[k]); return o; }
  function clearDistributions() { DISTRIBUTIONS = {}; }

  /**
   * P(exact push) at a handicap.
   *
   * Only a whole-number handicap can push, and only when a registered
   * distribution can say how often the margin lands exactly there. A half-point
   * line returns a hard zero with the reason; an integer line with no
   * distribution returns NULL, not zero — "cannot be computed" and "cannot
   * happen" are different answers and collapsing them quietly overstates EV.
   */
  function pushProbability(o) {
    o = o || {};
    var h = num(o.handicap);
    if (h == null) return { p_push: 0, possible: false, method: 'no handicap', why: 'A moneyline cannot push on the number.' };
    if (Math.abs(h % 1) > 1e-9) return { p_push: 0, possible: false, method: 'half-point line', why: 'A half-point handicap cannot land exactly on the number, so a push is impossible.' };
    var d = o.distribution_key ? DISTRIBUTIONS[o.distribution_key] : null;
    if (!d) {
      return { p_push: null, possible: true, method: null,
        why: 'This is a whole-number handicap, so a push is possible, but no empirical margin distribution is registered for this sport and market. The push probability is UNKNOWN — it is not zero, and expected value computed as though it were zero is overstated.' };
    }
    /* The registered pmf is a distribution over the model residual — how far
       the real margin lands from the projection. A push needs the RESULT to
       land on the number, which is the residual landing on the distance
       between the projection and the number. */
    var centre = num(o.centre);
    if (centre == null) {
      return { p_push: null, possible: true, method: d.key,
        why: 'A distribution is registered but no projected centre was supplied, so there is nothing to measure the handicap against.' };
    }
    var offset = Math.round(h - centre);
    var p = num(d.pmf[String(offset)]);
    if (p == null) {
      /* Off the tabulated support. The tails are thin by construction, so this
         is a genuinely small number rather than an unknown one — but it is
         reported as a bound, not as a point estimate. */
      return { p_push: 0, possible: true, method: d.key, bounded: true,
        why: 'The required residual (' + offset + ') is outside the tabulated support of ' + d.key + ', where the observed mass was zero over ' + d.window + '. Treated as a bound of zero rather than a measurement.' };
    }
    return {
      p_push: r4(p), possible: true, method: d.key, offset: offset,
      basis: d.basis, window: d.window, limitations: d.limitations,
      why: null
    };
  }

  /* ==================================================================== */
  /* MODEL VALIDATION REGISTRY                                             */
  /*                                                                       */
  /* The question "may this model's disagreement become a recommendation?" */
  /* has a recorded answer for EdgeDesk's own football model, and the      */
  /* answer is mostly no. It is recorded here so the decision layer can    */
  /* obey it instead of rediscovering it, and so every number the model    */
  /* touches carries the record that governs it.                           */
  /*                                                                       */
  /* NOTHING HERE IS ASSERTED. Every field is transcribed from the model's */
  /* own validation_summary, which is generated by its training job. A     */
  /* sport and market with no entry gets NO probability and NO model EV —  */
  /* absence of a record is not permission.                                */
  /* ==================================================================== */
  var MODEL_VALIDATION = {};

  function registerValidation(sport, market, rec) {
    MODEL_VALIDATION[sport + '|' + market] = rec;
    return rec;
  }
  /**
   * What is known about this model's performance in this market.
   *
   * Returns a record with an explicit TIER:
   *   PROBABILITY  — a calibrated outcome probability exists and may feed EV
   *   DIRECTIONAL  — a measured directional edge exists, too weak for EV
   *   RESEARCH     — measured and NOT better than the market; research only
   *   UNVALIDATED  — nothing measured; no model number may leave this layer
   */
  function validationFor(sport, market) {
    var m = normMarket(market);
    var rec = MODEL_VALIDATION[sport + '|' + m] || MODEL_VALIDATION[sport + '|_any'] || null;
    if (rec) return rec;
    return {
      sport: sport || null, market: m, tier: 'UNVALIDATED',
      beats_market: null, n: null, window: null,
      may_produce_probability: false, may_produce_model_ev: false, max_decision: 'WATCH',
      basis: 'No validation record is registered for this sport and market.',
      limitations: 'An unvalidated model may inform research priority and may be quoted as an estimate. It may not become a probability, an expected value, or a reason to bet.'
    };
  }
  function normMarket(m) {
    var s = clean(m).toLowerCase();
    if (s === 'ml' || s === 'moneyline' || s === 'h2h') return 'h2h';
    if (s === 'spread' || s === 'spreads' || s === 'ats') return 'spreads';
    if (s === 'total' || s === 'totals' || s === 'ou' || s === 'o/u') return 'totals';
    return s || 'h2h';
  }
  function marketLabel(m) {
    var s = normMarket(m);
    return s === 'h2h' ? 'Moneyline' : s === 'spreads' ? 'Spread' : s === 'totals' ? 'Total' : (m == null ? null : String(m));
  }

  /**
   * Load a football model's own validation_summary into the registry.
   *
   * Transcription only: every value comes from the artifact, and a field the
   * artifact does not carry stays null. This is what lets the decision layer
   * say "the model's own walk-forward record says it does not beat the close"
   * with a citation instead of an opinion.
   */
  function loadFootballValidation(sport, params, calibration) {
    if (!params || !params.validation_summary) return null;
    var V = params.validation_summary, M = V.market || {};
    var out = [];
    var beats = M.beats_closing_line === true;
    var maxTier = clean(M.max_tier) || null;

    /* --- moneyline: a calibrated win probability, out of sample ---------- */
    var wp = V.winprob || (M.engine_replay && M.engine_replay.winprob) || null;
    if (wp && num(wp.brier) != null) {
      var cal = V.calibration || null;
      var worst = null;
      if (cal && cal.length) {
        cal.forEach(function (b) {
          var gap = Math.abs((num(b.p_obs) || 0) - (num(b.p_pred) || 0));
          if (!worst || gap > worst.gap) worst = { bin: b.bin, gap: gap, pred: num(b.p_pred), obs: num(b.p_obs), n: num(b.n) };
        });
      }
      out.push(registerValidation(sport, 'h2h', {
        sport: sport, market: 'h2h', tier: 'PROBABILITY',
        beats_market: beats, n: num(wp.n), window: wp.window || M.window || null,
        brier: num(wp.brier), log_loss: num(wp.log_loss), sigma: num(wp.sigma),
        calibration: cal,
        worst_calibration_bin: worst ? { bin: worst.bin, predicted: r4(worst.pred), observed: r4(worst.obs), n: worst.n, gap_pp: r2(worst.gap * 100) } : null,
        may_produce_probability: true,
        /* EV is allowed, and it is labelled EXPERIMENTAL for as long as the
           model does not beat the close. A calibrated probability is a real
           thing; being better than the market is a different claim. */
        may_produce_model_ev: true,
        experimental: !beats,
        max_decision: beats ? 'BET CANDIDATE' : 'WATCH',
        basis: (wp.basis || '') + ' Model ' + (params.model_version || 'unknown') + ', ' + (V.firewall && V.firewall.headline_test ? 'headline test ' + V.firewall.headline_test : 'window ' + (wp.window || '?')) + '.',
        limitations: 'Brier ' + num(wp.brier) + ' over n=' + num(wp.n) + '. '
          + (worst ? 'Worst-calibrated band ' + worst.bin + ': predicted ' + r4(worst.pred) + ' against an observed ' + r4(worst.obs) + ' over n=' + worst.n + '. ' : '')
          + (beats ? '' : 'The model does NOT beat the closing line, so a probability edge measured against a soft price is not evidence of an edge against the market.')
      }));
    }

    /* --- spread: measured, and measured to be no better than the close --- */
    var ats = M.ats_vs_close || null;
    if (ats) {
      var atsRows = [], key;
      for (key in ats) if (Object.prototype.hasOwnProperty.call(ats, key)) {
        atsRows.push({ gap: num(key), n: num(ats[key].n), win_pct: num(ats[key].win_pct), p: num(ats[key].binom_p_one_sided) });
      }
      atsRows.sort(function (a, b) { return a.gap - b.gap; });
      var best = null;
      atsRows.forEach(function (r) { if (r.p != null && r.n >= CONFIG.min_validation_n && (!best || r.p < best.p)) best = r; });
      var sig = best && best.p != null && best.p <= CONFIG.max_validation_p;
      out.push(registerValidation(sport, 'spreads', {
        sport: sport, market: 'spreads', tier: sig ? 'DIRECTIONAL' : 'RESEARCH',
        beats_market: beats, n: atsRows.length ? atsRows[0].n : null,
        window: M.window || null,
        by_gap: atsRows, best_gap: best,
        mae_model: num(M.spread_mae_model), mae_market: num(M.spread_mae_market) != null ? num(M.spread_mae_market) : num(M.spread_mae_closing_market),
        may_produce_probability: false, may_produce_model_ev: false,
        experimental: true,
        max_decision: 'WATCH',
        basis: 'The model’s own walk-forward record against the closing line over ' + (M.window || 'the test window') + '.',
        limitations: 'Against the close the model wins '
          + atsRows.map(function (r) { return r.win_pct + '% at ' + r.gap + '+ points (n=' + r.n + ', p=' + r.p + ')'; }).join(', ')
          + '. ' + (sig ? 'One gap band clears significance; the rest do not.'
            : 'No band is significant and the win rate DEGRADES as the disagreement grows, which is the opposite of what a real edge looks like. A spread gap is therefore a research signal and a diagnostic trigger, never a reason to bet.')
      }));
    }

    /* --- total: a small, documented, one-directional effect -------------- */
    var ou = M.ou_vs_close || null;
    if (ou) {
      var ouRows = [], k2;
      for (k2 in ou) if (Object.prototype.hasOwnProperty.call(ou, k2)) {
        ouRows.push({ gap: num(k2), n: num(ou[k2].n), win_pct: num(ou[k2].win_pct), p: num(ou[k2].binom_p_one_sided) });
      }
      ouRows.sort(function (a, b) { return a.gap - b.gap; });
      var bestOu = null;
      ouRows.forEach(function (r) { if (r.p != null && r.n >= CONFIG.min_validation_n && (!bestOu || r.p < bestOu.p)) bestOu = r; });
      var ouSig = bestOu && bestOu.p != null && bestOu.p <= CONFIG.max_validation_p;
      out.push(registerValidation(sport, 'totals', {
        sport: sport, market: 'totals', tier: ouSig ? 'DIRECTIONAL' : 'RESEARCH',
        beats_market: beats, n: ouRows.length ? ouRows[0].n : null, window: M.window || null,
        by_gap: ouRows, best_gap: bestOu,
        mae_model: num(M.total_mae_model), mae_market: num(M.total_mae_market) != null ? num(M.total_mae_market) : num(M.total_mae_closing_market),
        may_produce_probability: false, may_produce_model_ev: false,
        experimental: true, max_decision: 'WATCH',
        basis: 'The model’s own walk-forward record against the closing total over ' + (M.window || 'the test window') + '.',
        limitations: 'Against the close the model wins '
          + ouRows.map(function (r) { return r.win_pct + '% at ' + r.gap + '+ points (n=' + r.n + ', p=' + r.p + ')'; }).join(', ')
          + '. ' + (ouSig ? 'The effect strengthens with the size of the disagreement and clears significance at n=' + bestOu.n + ', p=' + bestOu.p + ' — a small measured directional edge, not a probability. It may raise research priority and may not produce an expected value.'
            : 'Nothing here clears significance.')
      }));
    }

    /* The residual distributions, registered for push probability. */
    if (params.distributions && params.distributions.margin_resid_pmf) {
      registerDistribution(sport + '|margin_resid', {
        pmf: params.distributions.margin_resid_pmf,
        sigma: params.distributions.sigma_margin,
        sport: sport, quantity: 'model margin residual, in points',
        window: (V.firewall && V.firewall.distributional) ? V.firewall.distributional : 'see the model’s firewall record',
        basis: 'Empirical residual of the published model spread against the realised margin, tabulated by the model’s own training job. '
          + ((params.data_provenance && params.data_provenance.schedules) || ''),
        limitations: 'Fitted on the model’s training seasons and applied unchanged. It describes the spread of outcomes around THIS model’s projection and is not a market-implied distribution.'
      });
    }
    if (params.distributions && params.distributions.total_resid_pmf) {
      registerDistribution(sport + '|total_resid', {
        pmf: params.distributions.total_resid_pmf,
        sigma: params.distributions.sigma_total,
        sport: sport, quantity: 'model total residual, in points',
        window: (V.firewall && V.firewall.distributional) ? V.firewall.distributional : 'see the model’s firewall record',
        basis: 'Empirical residual of the published model total against the realised total.',
        limitations: 'Fitted on the model’s training seasons and applied unchanged.'
      });
    }

    /* The close-anticipation record, when the calibration artifact carries
       one. This is the ONE market claim the football model has actually
       earned, so it is registered as its own capability rather than being
       folded into a spread edge it does not have. */
    if (calibration && calibration.clv_proxy_vs_open) {
      registerValidation(sport, '_close_anticipation', {
        sport: sport, market: '_close_anticipation', tier: 'DIRECTIONAL',
        beats_market: false,
        by_gap: Object.keys(calibration.clv_proxy_vs_open).map(function (g) {
          var r = calibration.clv_proxy_vs_open[g];
          return { gap: num(g), n: num(r.n), moved_toward_model_pct: num(r.moved_toward_model_pct) };
        }).sort(function (a, b) { return a.gap - b.gap; }),
        may_produce_probability: false, may_produce_model_ev: false,
        experimental: true, max_decision: 'WATCH',
        basis: calibration.basis || 'walk-forward replay recorded in the model’s calibration artifact',
        limitations: 'This says the CLOSE tends to move toward the model when the model disagrees with the OPEN. '
          + 'It is a statement about line movement, not about results, and it is measured against the opening line rather than against the price EdgeDesk actually has. '
          + 'It raises research priority. It is not an edge and it is not a probability.'
      });
    }
    return { registered: out.length, max_tier: maxTier, beats_market: beats };
  }

  /**
   * A model win probability, but only where one is permitted.
   *
   * The margin residual distribution turns a projected margin into P(win) by
   * integrating the residual past the number. That arithmetic is always
   * possible; whether the ANSWER means anything is the question the validation
   * registry exists to settle, and this function refuses rather than guesses.
   */
  function modelWinProbability(o) {
    o = o || {};
    var sport = o.sport, market = normMarket(o.market);
    var v = validationFor(sport, market);
    if (!v.may_produce_probability) {
      return { p: null, permitted: false, validation: v,
        why: 'EdgeDesk holds no validated outcome probability for ' + (marketLabel(market) || market) + ' in this sport, so none is produced. '
          + v.limitations };
    }
    var margin = num(o.model_margin);           /* projected margin, subject side */
    var handicap = num(o.handicap) || 0;         /* 0 for a moneyline */
    var key = o.distribution_key || (sport + '|margin_resid');
    var d = DISTRIBUTIONS[key];
    if (margin == null) return { p: null, permitted: true, validation: v, why: 'No projected margin on file for this side.' };
    if (!d) return { p: null, permitted: true, validation: v, why: 'No margin distribution is registered for ' + sport + ', so a projected margin cannot be turned into a probability.' };
    /* Cover requires margin + residual > handicap-adjusted target. */
    var need = handicap;                         /* points the side must beat */
    var pWin = 0, pPush = 0, k, off, mass;
    for (k in d.pmf) if (Object.prototype.hasOwnProperty.call(d.pmf, k)) {
      off = num(k); mass = num(d.pmf[k]) || 0;
      var outcome = margin + off;
      if (outcome > need + 1e-9) pWin += mass;
      else if (Math.abs(outcome - need) <= 1e-9) pPush += mass;
    }
    return {
      p: r4(pWin), p_push: r4(pPush), permitted: true, validation: v,
      method: 'empirical margin-residual integration over ' + key,
      distribution: { key: key, window: d.window, basis: d.basis, limitations: d.limitations },
      experimental: v.experimental === true,
      why: null
    };
  }

  /* ==================================================================== */
  /* FAIR PRICE PROVENANCE                                                 */
  /*                                                                       */
  /* THE BUG THIS REPLACES, stated plainly so it cannot come back:         */
  /*                                                                       */
  /*   var fairP = e.sharp_fair; var fairSrc = 'Pinnacle de-vig fair';     */
  /*   if (fairP == null) { fairP = e.consensus_fair; fairSrc = '...'; }   */
  /*                                                                       */
  /* The label was chosen by WHICH COLUMN WAS POPULATED. Capture writes    */
  /* `sharp_fair` from the consensus whenever no reference book quotes, so */
  /* a row with has_sharp=false and a populated sharp_fair was labelled    */
  /* "Pinnacle de-vig fair" — while the same row's reasons_against said    */
  /* "no sharp (Pinnacle) confirmation on this exact side". One row, two   */
  /* contradictory claims, both generated from owned data.                 */
  /*                                                                       */
  /* Capture v9 already records the truth: `reference_type`, and           */
  /* `sharp_book_fair` which is NULL whenever there was no reference book. */
  /* This reads those, and it is the ONLY place the phrase can be made.    */
  /* ==================================================================== */

  var METHODS = {
    SHARP_REFERENCE_DEVIG: {
      short: 'sharp reference de-vig',
      sharp: true,
      why: 'A reference book quoted this exact selection at this exact number, and the fair price is its own two-way price with the vig removed.'
    },
    ROBUST_CONSENSUS_MEDIAN: {
      short: 'multi-book consensus',
      sharp: false,
      why: 'No reference book quoted this selection, so the fair price is the de-vigged median of the independent books that did. It is a screening number, not a sharp read.'
    },
    SHARP_CLAIMED_UNVERIFIED: {
      short: 'anchor claimed but not evidenced',
      sharp: false,
      why: 'The row claims a sharp reference but carries no reference-book number to prove it, so it is treated as a consensus and reported as unverified.'
    },
    NO_FAIR: { short: 'no fair price', sharp: false, why: 'No fair price is stored on this row, so there is nothing to price the number against.' },
    UNKNOWN: {
      short: 'anchor unknown',
      sharp: false,
      why: 'This row was written before capture recorded which reference produced the fair price. It is not guessed: unknown is the honest answer, and it resolves on the next capture pass.'
    }
  };

  /**
   * What this fair price ACTUALLY rests on.
   *
   * `scope` is 'live' (the current board) or 'entry' (what was true when the
   * row was priced). Grading must use 'entry' — CLV is measured from the entry
   * price, so asking "was it sharp-anchored" about a graded row is a question
   * about the moment of pricing, not about now.
   */
  function fairMethod(row, scope) {
    row = row || {};
    var entry = scope === 'entry';
    var refType = clean(entry ? (row.first_reference_type || row.reference_type) : row.reference_type).toLowerCase() || null;
    var hasSharp = entry
      ? (row.first_has_sharp === true || row.first_has_sharp === 'true')
      : (row.has_sharp === true || row.has_sharp === 'true');
    var hasSharpKnown = entry ? (row.first_has_sharp != null) : (row.has_sharp != null);
    var bookFair = num(entry ? (row.first_sharp_book_fair != null ? row.first_sharp_book_fair : row.sharp_book_fair) : row.sharp_book_fair);
    var anchored = num(entry ? (row.first_sharp_fair != null ? row.first_sharp_fair : row.sharp_fair) : row.sharp_fair);
    var consensus = num(row.consensus_fair);
    var refBook = clean(row.reference_book) || null;
    var pin = num(row.pin_dec), pinOpp = num(row.pin_opp_dec);

    var method, fair, label;
    if (anchored == null && consensus == null) {
      method = 'NO_FAIR'; fair = null;
    } else if (refType === 'sharp' && bookFair != null) {
      method = 'SHARP_REFERENCE_DEVIG'; fair = anchored != null ? anchored : bookFair;
    } else if (refType === 'sharp' && bookFair == null) {
      method = 'SHARP_CLAIMED_UNVERIFIED'; fair = anchored != null ? anchored : consensus;
    } else if (refType === 'robust_consensus' || refType === 'none') {
      method = 'ROBUST_CONSENSUS_MEDIAN'; fair = anchored != null ? anchored : consensus;
    } else if (refType == null && hasSharpKnown && hasSharp && bookFair != null) {
      /* A legacy row with no reference_type but a real reference-book number is
         still evidenced, and refusing it would throw away a true fact. */
      method = 'SHARP_REFERENCE_DEVIG'; fair = anchored != null ? anchored : bookFair;
    } else if (refType == null && hasSharpKnown && !hasSharp) {
      method = 'ROBUST_CONSENSUS_MEDIAN'; fair = anchored != null ? anchored : consensus;
    } else if (refType == null && hasSharpKnown && hasSharp && bookFair == null) {
      method = 'SHARP_CLAIMED_UNVERIFIED'; fair = anchored != null ? anchored : consensus;
    } else {
      method = 'UNKNOWN'; fair = anchored != null ? anchored : consensus;
    }

    var M = METHODS[method];
    if (method === 'SHARP_REFERENCE_DEVIG') {
      label = (refBook ? titleCase(refBook) : 'Sharp reference') + ' de-vig fair';
    } else if (method === 'ROBUST_CONSENSUS_MEDIAN') {
      label = 'multi-book consensus fair (no sharp reference)';
    } else if (method === 'SHARP_CLAIMED_UNVERIFIED') {
      label = 'consensus fair (a sharp anchor is claimed but not evidenced)';
    } else if (method === 'NO_FAIR') {
      label = 'no fair price on file';
    } else {
      label = 'fair price of unrecorded origin';
    }

    /* The reference quotes that ACTUALLY contributed, named rather than
       implied. An empty list on a sharp method is itself a finding. */
    var contributing = [];
    if (method === 'SHARP_REFERENCE_DEVIG') {
      if (pin != null) contributing.push({ book: refBook || 'reference book', side: 'this selection', dec: r4(pin), american: fmtAmerican(decToAmerican(pin)) });
      if (pinOpp != null) contributing.push({ book: refBook || 'reference book', side: 'the other side', dec: r4(pinOpp), american: fmtAmerican(decToAmerican(pinOpp)) });
    }
    var twoWay = (method === 'SHARP_REFERENCE_DEVIG' && pin != null && pinOpp != null)
      ? devigTwoWay(pin, pinOpp) : null;

    return {
      method: method,
      sharp: M.sharp,
      label: label,
      short: M.short,
      why: M.why,
      fair_probability: r4(fair),
      fair_decimal: fair && fair > 0 ? r4(1 / fair) : null,
      fair_american: fair && fair > 0 ? fmtAmerican(decToAmerican(1 / fair)) : null,
      reference_book: method === 'SHARP_REFERENCE_DEVIG' ? refBook : null,
      reference_type: refType,
      sharp_book_fair: r4(bookFair),
      consensus_fair: r4(consensus),
      contributing_quotes: contributing,
      two_way: twoWay,
      /* The sentence a reader gets. It never claims more than the row proves. */
      sentence: method === 'SHARP_REFERENCE_DEVIG'
        ? 'Fair price from ' + (refBook ? titleCase(refBook) : 'the sharp reference') + '’s own two-way quote with the vig removed'
          + (contributing.length ? ' (' + contributing.map(function (c) { return c.side + ' ' + c.american; }).join(', ') + ')' : '') + '.'
        : method === 'ROBUST_CONSENSUS_MEDIAN'
          ? 'Fair price from the de-vigged median of the independent books quoting this selection. No sharp reference quoted it, so this is a screening number.'
          : method === 'SHARP_CLAIMED_UNVERIFIED'
            ? 'This row claims a sharp anchor but carries no reference-book price to evidence it. Treated as a consensus and flagged.'
            : method === 'NO_FAIR'
              ? 'No fair price is on file for this selection.'
              : 'The origin of this fair price was not recorded. It is reported as unknown rather than guessed.',
      scope: entry ? 'entry' : 'live'
    };
  }
  function titleCase(s) {
    return clean(s).replace(/\b([a-z])/g, function (m2) { return m2.toUpperCase(); });
  }

  /**
   * What the book count does and does not prove.
   *
   * Six books quoting the same number is six observations of one opinion when
   * they share a feed. This returns the honest read and refuses to let a count
   * stand in for independent sharp confirmation.
   */
  function confirmationRead(row) {
    row = row || {};
    var fm = fairMethod(row);
    var books = num(row.n_books);
    var families = num(row.n_books_eff) != null ? num(row.n_books_eff) : books;
    var corrob = num(row.corrob_n) || 0;
    var corrobRef = clean(row.corrob_ref) || null;
    var bits = [];
    if (fm.sharp) bits.push('A sharp reference' + (fm.reference_book ? ' (' + titleCase(fm.reference_book) + ')' : '') + ' is quoting this exact selection.');
    else bits.push('No sharp reference is quoting this selection, so the fair price rests on softer books.');
    if (families != null) {
      bits.push(families + ' independent book ' + (families === 1 ? 'family' : 'families') + ' stand behind the fair price'
        + (books != null && books !== families ? ' (' + books + ' quotes in total, de-duplicated to ' + families + ')' : '') + '.');
    }
    if (corrob) bits.push('Corroborated at ' + corrob + ' level' + (corrob === 1 ? '' : 's') + ' against the ' + (corrobRef === 'pinnacle' ? 'sharp reference' : 'book median') + '.');
    return {
      sharp_confirmed: fm.sharp === true,
      independent_families: families,
      total_books: books,
      corroboration: corrob,
      corroboration_reference: corrobRef,
      sufficient_families: families != null && families >= CONFIG.min_independent_families,
      sentence: bits.join(' '),
      /* Said explicitly because the temptation to read one as the other is the
         whole reason this function exists. */
      caveat: 'Book count is not sharp confirmation. Books sharing a pricing feed move together, so a high count can be one opinion repeated. Independent confirmation is the reference book quoting the same side, and that is reported separately above.'
    };
  }

  /* ==================================================================== */
  /* QUOTE STATE — is this price still a price?                            */
  /* ==================================================================== */

  function quoteTtlMin(market, over) {
    var m = normMarket(market);
    var t = over && over[m] != null ? over[m] : CONFIG.quote_ttl_min[m];
    return num(t) != null ? num(t) : CONFIG.quote_ttl_min._default;
  }

  /**
   * Classify a quote by age and say whether it may support an action.
   *
   * A stale price is not deleted and not hidden — research keeps it, with its
   * timestamp — but `actionable` goes false and stays false until a refresh
   * lands. That single boolean is what stops a 2,126-minute-old number from
   * appearing under "top opportunities".
   */
  function quoteState(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var at = toMs(o.captured_at);
    var ageMin = at != null ? Math.max(0, (now - at) / 60000) : num(o.age_min);
    var limit = quoteTtlMin(o.market, o.ttl_override);
    var hard = limit * (num(o.stale_multiple) != null ? num(o.stale_multiple) : CONFIG.stale_multiple);
    var kickoff = toMs(o.kickoff);
    var minsToKick = kickoff != null ? (kickoff - now) / 60000 : null;

    var status, why, actionable;
    if (ageMin == null) {
      status = 'UNKNOWN';
      why = 'This quote carries no capture timestamp, so its age cannot be established. It is treated as unverified rather than as current.';
      actionable = CONFIG.unknown_age_is_actionable === true;
    } else if (ageMin >= hard) {
      status = 'STALE';
      why = 'Last captured ' + Math.round(ageMin) + ' minutes ago, past the ' + limit + '-minute limit for a ' + (marketLabel(o.market) || 'market') + ' quote. This is the last price EdgeDesk observed, not a price that is currently available.';
      actionable = false;
    } else if (ageMin >= limit / 2) {
      status = 'AGING';
      why = 'Captured ' + Math.round(ageMin) + ' minutes ago, inside the ' + limit + '-minute limit but past half of it. Confirm it is still on the board before acting.';
      actionable = true;
    } else {
      status = 'CURRENT';
      why = 'Captured ' + Math.round(ageMin) + ' minute' + (Math.round(ageMin) === 1 ? '' : 's') + ' ago.';
      actionable = true;
    }

    var kickBlock = null;
    if (minsToKick != null && minsToKick < 0) {
      kickBlock = 'This game has already started. A pregame price is not available.';
      actionable = false; status = status === 'CURRENT' ? 'STARTED' : status;
    } else if (minsToKick != null && minsToKick < CONFIG.min_minutes_to_kickoff) {
      kickBlock = 'Kickoff is under ' + CONFIG.min_minutes_to_kickoff + ' minutes away; a pregame price is not reliably available.';
      actionable = false;
    }

    return {
      status: status,
      age_min: ageMin == null ? null : Math.round(ageMin * 10) / 10,
      limit_min: limit,
      captured_at: at != null ? new Date(at).toISOString() : null,
      minutes_to_kickoff: minsToKick == null ? null : Math.round(minsToKick),
      actionable: actionable && !kickBlock,
      why: kickBlock ? why + ' ' + kickBlock : why,
      kickoff_block: kickBlock,
      /* Research always keeps it. Only the ACTION is withdrawn. */
      research_usable: true,
      research_note: status === 'STALE' || status === 'UNKNOWN'
        ? 'Keep this quote for research with its timestamp attached. Do not describe it as currently available and do not build a price conclusion on it.'
        : null
    };
  }

  /**
   * The result of trying to refresh a quote before acting on it.
   *
   * A failed refresh is NOT the same as a fresh quote and NOT the same as no
   * quote. It leaves the last observation standing, with its age, and with
   * actionability withdrawn — which is exactly what a person needs to know.
   */
  function applyRefresh(prev, refreshed, o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    if (refreshed && refreshed.ok) {
      var st = quoteState({ captured_at: refreshed.captured_at || now, now: now, market: o.market, kickoff: o.kickoff });
      return {
        quote: refreshed.quote, state: st, refreshed: true, changed: !!refreshed.changed,
        note: refreshed.changed ? 'The price changed on refresh; the decision below is against the NEW number.' : 'Refreshed and unchanged.'
      };
    }
    var stale = quoteState({ captured_at: prev && prev.captured_at, now: now, market: o.market, kickoff: o.kickoff });
    stale.actionable = false;
    stale.status = stale.status === 'CURRENT' ? 'UNCONFIRMED' : stale.status;
    stale.why = 'The refresh did not complete (' + ((refreshed && refreshed.why) || 'no reason recorded') + '). ' + stale.why
      + ' The last observed price is retained for research; it is NOT described as currently available or actionable.';
    return { quote: prev, state: stale, refreshed: false, changed: false, note: stale.why };
  }

  /* ==================================================================== */
  /* THE MARKET RESOLVER — a LINE and a PRICE are not the same object      */
  /*                                                                       */
  /* THE MISTAKE THIS EXISTS TO END                                        */
  /*   football/fbs/slate.json carries "market_status": "NOT JOINED IN     */
  /*   THIS BUILD" on every game, and its own note says why: "Market       */
  /*   quotes are joined live in the browser from captured signals and     */
  /*   cfb.lines." An earlier reading of that artifact concluded the       */
  /*   application had no college prices at all. It was wrong. The board   */
  /*   resolves a market for roughly two games in three, and it does it    */
  /*   from TWO sources in priority order (fbP4Market in app.html):        */
  /*                                                                       */
  /*     1. a captured `signals` row, matched to the game through the FBS  */
  /*        universe's alias resolver with BOTH teams required to resolve  */
  /*     2. cfb.lines — the ingested CollegeFootballData consensus, keyed  */
  /*        on the CFBD game_id                                            */
  /*     3. the captured row again, marked stale, if neither of the above  */
  /*                                                                       */
  /*   Counting only (1) is why the research desk reported one quoted game */
  /*   on a card the board showed as forty-six.                            */
  /*                                                                       */
  /* THE DISTINCTION THAT HAS TO SURVIVE                                   */
  /*   A cfb.lines row carries a spread, a total and two moneylines. It    */
  /*   carries NO BOOK and NO TIMESTAMP. It is a LINE: a number to compare */
  /*   a model against. It is NOT an executable price, and no expected     */
  /*   value may ever be computed from one.                                */
  /*                                                                       */
  /*   A captured signals row carries a decimal price, the book offering   */
  /*   it and the moment it was seen. That is a PRICE.                     */
  /*                                                                       */
  /*   Both are markets. Only one can be bet into. Everything below keeps  */
  /*   them apart, and NOTHING here invents the missing half: a spread     */
  /*   handicap yields no per-side odds, and mirroring it into a synthetic */
  /*   -110 on both sides would manufacture an executable price out of a   */
  /*   number that never had one.                                          */
  /* ==================================================================== */

  /* The board's own windows, restated so the two halves agree.
     A captured PRICE is actionable inside quote_ttl_min. A consensus LINE has
     no timestamp at all and is research context for as long as the board
     considers the card live — 72h, matching FBP4_QUOTE_FRESH_MS. */
  CONFIG.line_research_window_min = 72 * 60;
  /* The spread-convention constants the engine uses. Same numbers, because it
     is the same question: does negating this row reconcile it with the model? */
  CONFIG.orientation_bound_pts = 21;
  CONFIG.orientation_reconcile_pts = 7;

  /**
   * A joined market number that only agrees with the model once it is negated
   * is a row stored in the opposite convention, not a disagreement about
   * football. It is DROPPED and named — never flipped, because a row nobody
   * can vouch for is not made trustworthy by guessing which way round it was
   * meant to be. Same rule, same constants as EDCfbP4.market.orientationFault.
   */
  function orientationFault(modelNumber, marketNumber, opts) {
    opts = opts || {};
    var m = num(modelNumber), k = num(marketNumber);
    if (m == null || k == null) return null;
    var bound = num(opts.bound) != null ? num(opts.bound) : CONFIG.orientation_bound_pts;
    var reconcile = num(opts.reconcile) != null ? num(opts.reconcile) : CONFIG.orientation_reconcile_pts;
    var asIs = Math.abs(m - k), flipped = Math.abs(m + k);
    if (!(asIs > bound) || !(flipped <= reconcile) || !(flipped < asIs)) return null;
    return {
      model: m, market: k, gap: r2(asIs), gap_if_negated: r2(flipped),
      bound: bound, reconcile: reconcile,
      basis: 'This market number disagrees with the model by ' + r2(asIs) + ' points, and negating it reconciles '
        + 'them to ' + r2(flipped) + '. That is one row stored in the opposite spread convention, not a '
        + 'disagreement about football. The number is DROPPED rather than flipped.'
    };
  }

  /** cfb.lines.spread -> the engine's margin convention, per the declaration. */
  function lineToMargin(spread, convention) {
    var v = num(spread);
    if (v == null) return null;
    return convention === 'margin' ? v : -v;
  }

  /**
   * Resolve one game's market from every source that legitimately has one.
   *
   * @param o.signals   captured rows already matched to THIS game
   * @param o.lines     cfb.lines rows for this game_id
   * @param o.model_home_line  the engine's projection as the FBS slate artifact
   *                    publishes it: home side, BETTING convention, negative for
   *                    a home favourite. Negated internally for the orientation
   *                    check. It never becomes a market number.
   * @param o.model_margin  the same projection in the engine's MARGIN convention
   *                    (positive = home favoured), i.e. projectGame's fair_spread.
   *                    Pass whichever one you actually hold; if both, this wins.
   * @param o.lines_convention 'betting' (default, negate) or 'margin'
   */
  /* ====================================================================== */
  /* AVAILABILITY — AND THE ONE RULE THAT MATTERS                            */
  /*                                                                        */
  /* College football has no universal injury report. football/availability/ */
  /* says so in its own README and publishes four DIFFERENT findings that    */
  /* must never collapse into one another:                                   */
  /*                                                                        */
  /*   verified flags     a trusted source named a player and a designation  */
  /*   no reported injuries   an OFFICIAL report was read and listed nobody  */
  /*   partial coverage   some players verified, no universal report exists  */
  /*   no verified data   EdgeDesk looked and found nothing it would publish */
  /*                                                                        */
  /* The last one is NOT the first one. A team with no report on file is     */
  /* UNKNOWN. It is not healthy, it is not clean, and no sentence produced   */
  /* from this data may imply that it is. That is the whole reason this      */
  /* function exists rather than a field read.                               */
  /* ====================================================================== */

  var AVAIL_STATES = ['VERIFIED_FLAGS', 'NO_REPORTED_INJURIES', 'PARTIAL', 'UNKNOWN', 'NOT_RETRIEVED'];
  /* How old an availability read may be before it stops describing today.
     A designation is a weekly artefact; past this it is history. */
  var AVAIL_STALE_H = 72;

  /**
   * One team's availability, classified rather than described.
   *
   * @param o.record   the team's row from football/availability/current.json
   * @param o.team     the team name, for the sentence
   * @param o.generated_at the artifact's own build time
   * @param o.now      clock
   */
  function availabilityRead(o) {
    o = o || {};
    var rec = o.record || null;
    var team = clean(o.team) || 'this team';
    var gen = toMs(o.generated_at);
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var ageH = gen == null ? null : Math.round((now - gen) / 3600e3);
    var stale = ageH != null && ageH > AVAIL_STALE_H;

    if (!rec) {
      return finishAvail('NOT_RETRIEVED', {
        team: team, players: [], quarterbacks: [],
        sentence: 'No availability record was retrieved for ' + team + '. That is a RETRIEVAL result, not a '
          + 'medical one: it says nothing about whether anyone is hurt.',
        age_hours: ageH, stale: stale, quality: null, counts: null,
        official_report_found: null, sources_checked: null, sources_failed: null
      });
    }

    var counts = rec.counts || {};
    var records = num(counts.records) || 0;
    var flagged = num(counts.flagged) || 0;
    var quality = clean(rec.dataQuality) || 'NONE';
    var official = rec.official_report_found === true;
    var checked = num(rec.sources_checked) || 0;
    var failed = num(rec.sources_failed) || 0;
    var players = rec.players || [];
    var qbs = players.filter(function (pl) {
      return String(pl.position || pl.pos || '').toUpperCase().indexOf('QB') === 0;
    });

    var state, sentence;
    if (flagged > 0 || records > 0) {
      state = quality === 'STRONG' ? 'VERIFIED_FLAGS' : 'PARTIAL';
      sentence = records + ' availability record' + (records === 1 ? '' : 's') + ' on file for ' + team
        + ' (' + flagged + ' carrying doubt), data quality ' + quality
        + (official ? ', from an official report' : ', from unofficial sources')
        + '. Players NOT named here are UNREPORTED, not confirmed fit.';
    } else if (official) {
      state = 'NO_REPORTED_INJURIES';
      sentence = 'An OFFICIAL availability report was read for ' + team + ' and it listed nobody. '
        + 'That is a positive finding and the only circumstance in which "no reported injuries" is a fact '
        + 'rather than an absence.';
    } else {
      state = 'UNKNOWN';
      sentence = 'No availability record is on file for ' + team + '. EdgeDesk checked ' + checked
        + ' source' + (checked === 1 ? '' : 's') + (failed ? ' and ' + failed + ' failed' : '')
        + ', found no official report, and published nothing. '
        + 'THIS IS UNKNOWN, NOT HEALTHY: nobody has been confirmed fit and no injury has been ruled out. '
        + 'Do not describe this team as healthy, clean or fully available.';
    }
    if (stale && state !== 'NOT_RETRIEVED') {
      sentence += ' The availability build is ' + ageH + ' hours old, past the ' + AVAIL_STALE_H
        + '-hour window in which a weekly designation still describes today, so treat it as history.';
    }

    return finishAvail(state, {
      team: team, quality: quality, counts: counts,
      players: players, quarterbacks: qbs,
      official_report_found: official, sources_checked: checked, sources_failed: failed,
      age_hours: ageH, stale: stale, sentence: sentence
    });
  }

  function finishAvail(state, o) {
    return {
      state: state, team: o.team, sentence: o.sentence,
      data_quality: o.quality, counts: o.counts,
      players: o.players, quarterbacks: o.quarterbacks,
      official_report_found: o.official_report_found,
      sources_checked: o.sources_checked, sources_failed: o.sources_failed,
      artifact_age_hours: o.age_hours, stale: o.stale,
      /* THE TWO PERMISSIONS, SAID AS DATA SO NO CONSUMER HAS TO INFER THEM. */
      may_claim_healthy: state === 'NO_REPORTED_INJURIES',
      may_adjust_projection: false,
      adjustment_note: 'EdgeDesk does not move a projection on availability evidence. The engine prices an '
        + 'injury report only when it is given one in its own contract (player, position, starter, snap share, '
        + 'severity, status, replacement quality), and the college dataset carries neither snap share nor '
        + 'replacement quality. An unvalidated adjustment invented here would be a number with no backtest '
        + 'behind it, so availability is EVIDENCE A READER WEIGHS and never an automatic edit to the model.',
      source: 'football/availability/current.json (schema edgedesk_cfb_availability_v1)'
    };
  }

  /* ====================================================================== */
  /* JOINING A BOOK'S FIXTURES TO A SCHEDULE'S GAMES                         */
  /* ====================================================================== */

  /**
   * A resolver index built from the games themselves.
   *
   * fbs.js's teamIndex() wants a universe. The FBS slate artifact already
   * publishes the canonical key for every side (`home_team_id`), which is what
   * a universe would have produced, so the index is built from the card rather
   * than from a second copy of the FBS membership tables. A universe of only
   * this week's teams is also a SMALLER chance of an ambiguous prefix, which
   * is the newsletter's own reasoning for doing it this way.
   *
   * @param games [{home_team, away_team, home_id?, away_id?}]
   */
  /* A published canonical key ("northtexas") or nothing. A numeric id is a
     DATABASE row id — cfb.games stores those in the same field name — and
     using one as a team key would index a team under "247" and resolve
     nothing to it. Never inferred from the value beyond this: all digits is
     not a team key, everything else is taken as published. */
  function canonKey(id, name) {
    var v = clean(id);
    if (v && !/^[0-9]+$/.test(v)) return v;
    return normKey(name);
  }

  function fbsIndexFor(games) {
    var universe = { teams: {}, order: [] };
    (games || []).forEach(function (g) {
      [[g.home_team, g.home_id], [g.away_team, g.away_id]].forEach(function (pair) {
        var name = clean(pair[0]);
        if (!name) return;
        /* The published id when there is one, the canonical key otherwise.
           Never a guess: a row with neither is skipped, not invented. */
        var key = canonKey(pair[1], name);
        if (!key || universe.teams[key]) return;
        universe.teams[key] = { key: key, name: name, aliases: [] };
        universe.order.push(key);
      });
    });
    /* THE PREFIX TRAP, WHICH A CARD-SIZED UNIVERSE MAKES WORSE RATHER THAN
       BETTER. fbs.js resolves an unknown spelling by longest unambiguous
       prefix, and a tie between two schools resolves to nothing. That rule
       only protects "Miami (OH) RedHawks" from taking Miami Florida's number
       while BOTH Miamis are in the universe. Build the universe from one
       week's card and Miami Ohio is usually absent — so `miamiohredhawks`
       finds only `miami`, resolves cleanly, and the wrong game gets priced.
       A quote on the wrong team is a fabricated market, which is worse than a
       reported miss.

       So every program the curated alias table knows about is seeded as a
       competing key even when it is not playing. `miamioh` is then the longer
       prefix and wins; no game on the card carries that key, so the row is
       REFUSED and counted. The seed can only ever cause a refusal — it adds
       no game and joins nothing. */
    Object.keys(TEAM_ALIASES).forEach(function (key) {
      if (universe.teams[key]) return;
      universe.teams[key] = { key: key, name: key, aliases: TEAM_ALIASES[key], off_card: true };
      universe.order.push(key);
    });
    return teamIndex(universe);
  }

  /**
   * Join captured odds rows to scheduled games, by the BOARD'S OWN RULE.
   *
   * matchesEvent's contract, unchanged: both sides must resolve to this game's
   * own teams and the kickoffs must agree inside a bounded window. A half
   * match is refused — a quote joined on the home team alone is how a book's
   * Ohio number ends up priced against Ohio State.
   *
   * Every refusal is COUNTED AND NAMED. A join that silently drops rows is
   * indistinguishable from a feed with no rows, and telling those two apart is
   * the entire point: 410 rows joined to nothing was reported to the reader as
   * "there are no CFB matchups to evaluate".
   *
   * @param o.signals  captured rows: {home_team, away_team, commence_time, ...}
   * @param o.games    schedule rows: {game_id, home_team, away_team, kickoff}
   * @param o.window_ms  kickoff tolerance (default 36h, matchesEvent's own)
   * @returns {by_game, joined, unjoined, diagnosis}
   */
  function joinSignalsToGames(o) {
    o = o || {};
    var games = o.games || [], sigs = o.signals || [];
    var windowMs = num(o.window_ms) != null ? num(o.window_ms) : 36 * 3600e3;
    var ix = fbsIndexFor(games);
    var byGame = {}, reasons = {}, unresolvedNames = {};
    var memo = Object.create(null);
    function res(name) {
      var n = clean(name);
      if (!n) return null;
      if (memo[n] === undefined) memo[n] = resolveTeam(n, ix);
      return memo[n];
    }
    /* Each game under the key pair ITS OWN names resolve to, so a row and a
       game are compared on the same footing rather than one raw and one
       resolved. */
    var pairIx = {};
    games.forEach(function (g) {
      var hk = canonKey(g.home_id, g.home_team);
      var ak = canonKey(g.away_id, g.away_team);
      if (!hk || !ak) return;
      var t = toMs(g.kickoff);
      (pairIx[ak + '|' + hk] = pairIx[ak + '|' + hk] || []).push({ game: g, t: t });
    });
    function note(why) { reasons[why] = (reasons[why] || 0) + 1; }

    sigs.forEach(function (r) {
      var rh = res(r.home_team), ra = res(r.away_team);
      if (!rh || !rh.key || !ra || !ra.key) {
        note(rh && rh.how === 'ambiguous' || ra && ra.how === 'ambiguous'
          ? 'a team name resolved ambiguously and was refused rather than guessed'
          : 'a team name on the book fixture resolves to no team on this card');
        [r.home_team, r.away_team].forEach(function (n) {
          var rr = res(n); if (!rr || !rr.key) unresolvedNames[clean(n)] = (unresolvedNames[clean(n)] || 0) + 1;
        });
        return;
      }
      var cand = pairIx[ra.key + '|' + rh.key];
      if (!cand || !cand.length) { note('both teams resolved, but no game on this card has them in this orientation'); return; }
      var t = toMs(r.commence_time);
      var hit = null;
      cand.forEach(function (c) {
        if (t == null || c.t == null) { if (!hit) hit = c; return; }
        if (Math.abs(t - c.t) < windowMs && !hit) hit = c;
      });
      if (!hit) { note('both teams resolved, but the book kickoff and the schedule kickoff differ by more than the window'); return; }
      var gid = String(hit.game.game_id);
      (byGame[gid] = byGame[gid] || []).push(r);
    });

    var joined = 0, k;
    for (k in byGame) if (Object.prototype.hasOwnProperty.call(byGame, k)) joined += byGame[k].length;
    var unresolved = Object.keys(unresolvedNames).sort(function (a, b) {
      return unresolvedNames[b] - unresolvedNames[a];
    }).slice(0, 12);

    return {
      by_game: byGame,
      games_with_signals: Object.keys(byGame).length,
      signals_read: sigs.length,
      signals_joined: joined,
      signals_refused: sigs.length - joined,
      refusal_reasons: reasons,
      unresolved_names: unresolved,
      /* THE SENTENCE THAT HAD TO EXIST. Zero joined out of a non-empty read is
         a JOIN fault, and saying so is what stops it being reported as an
         empty market. */
      diagnosis: !sigs.length
        ? 'The capture returned no rows for this sport and window, so there was nothing to join.'
        : joined === 0
          ? 'JOIN FAULT: ' + sigs.length + ' captured rows were read and NONE joined to a game on this card. '
            + 'That is a name-resolution failure, not an absence of markets, and it may not be reported as one.'
          : joined + ' of ' + sigs.length + ' captured rows joined to ' + Object.keys(byGame).length + ' games on this card.',
      resolver: 'football/fbs/fbs.js resolveTeam + matchesEvent rule (exact, alias, state expansion, longest unambiguous prefix)'
    };
  }

  function resolveMarket(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var conv = o.lines_convention === 'margin' ? 'margin' : 'betting';
    var sigs = o.signals || [];
    var lines = o.lines || [];
    var notes = [];

    /* cfb.lines prefers the consensus provider where one exists, exactly as
       the board and the daily health check both do. */
    var line = null;
    lines.forEach(function (l) {
      if (!line || String(l.provider || '').toLowerCase().indexOf('consensus') >= 0) line = l;
    });

    function capturedFor(marketKey, wantSide) {
      var hit = null;
      sigs.forEach(function (s) {
        if (normMarket(s.market) !== marketKey) return;
        if (wantSide && String(s.selection || '').toLowerCase().indexOf(wantSide) < 0) return;
        if (num(s.best_dec) == null) return;
        if (!hit || String(s.last_seen_at || '') > String(hit.last_seen_at || '')) hit = s;
      });
      return hit;
    }

    /* ---- SPREAD --------------------------------------------------------- */
    var spread = { line: null, source: null, book: null, provider: null, observed_at: null,
      executable: false, odds_american: null, odds_decimal: null, selection: null,
      handicap: null, side: null, freshness: null, fault: null, why: null };
    var capS = capturedFor('spreads');
    if (capS) {
      var qs = quoteState({ captured_at: capS.last_seen_at, now: now, market: 'spreads', kickoff: o.kickoff });
      /* The board's own margin convention: a home selection at -3 means the
         home side must win by more than 3, which is a +3 margin line. The
         captured row's `point` is on the SELECTION, so it is oriented here. */
      spread.selection = capS.selection;
      spread.handicap = num(capS.point);
      spread.odds_decimal = num(capS.best_dec);
      spread.odds_american = fmtAmerican(decToAmerican(num(capS.best_dec)));
      spread.book = capS.best_book || null;
      spread.observed_at = capS.last_seen_at || null;
      spread.source = 'signals';
      spread.executable = true;
      spread.freshness = qs;
      spread.actionable = qs.actionable;
      /* THE HANDICAP MIRRORS; THE ODDS DO NOT.
         A spread handicap is one number seen from two ends: home -7 and away
         +7 are the same line, by definition, so deriving the margin line from
         whichever side was captured is arithmetic and not invention. The PRICE
         is the opposite case — the two sides are quoted independently and are
         routinely different — so no odds are ever mirrored here, and a side
         EdgeDesk did not capture has no price at all.
         The board's convention: margin = -(home handicap) = (away handicap). */
      var _sideHome = o.home_selection && normName(capS.selection) === normName(o.home_selection);
      var _sideAway = o.away_selection && normName(capS.selection) === normName(o.away_selection);
      spread.side = _sideHome ? 'home' : _sideAway ? 'away' : null;
      spread.line = _sideHome ? -num(capS.point) : _sideAway ? num(capS.point) : null;
      if (spread.line == null) {
        notes.push('A spread price was captured for "' + capS.selection + '", but it could not be resolved to '
          + 'either side of this game, so no margin line is derived from it. The price stands; the line does not.');
      }
      spread.why = 'A captured price: a real book, a real number and the moment it was seen.';
    }
    if (spread.line == null && line && num(line.spread) != null) {
      spread.line = lineToMargin(line.spread, conv);
      spread.source = spread.source || 'cfb.lines';
      spread.provider = line.provider || 'consensus';
      /* THE HALF THAT DOES NOT EXIST. A consensus spread is a handicap with
         no per-side odds attached, so there is nothing to bet into and
         nothing to compute an expected value from. Mirroring it into a
         synthetic price on both sides would invent exactly the thing that is
         missing, so it is left null and said out loud. */
      if (!capS) {
        spread.executable = false;
        spread.odds_american = null;
        spread.odds_decimal = null;
        spread.observed_at = null;
        spread.actionable = false;
        spread.why = 'A CONSENSUS LINE from cfb.lines. It carries no book, no per-side odds and no timestamp, '
          + 'so it is a number to compare a model against and NOT a price to bet into. No expected value can be '
          + 'computed from it, and no per-side price is invented for it.';
        notes.push('The spread on this game is a consensus line, not an executable price.');
      }
    }
    /* Orientation, last, on whichever number survived.

       THE TWO NUMBERS POINT OPPOSITE WAYS, SO BOTH ARE NAMED.
       `spread.line` above is in the engine's MARGIN convention: positive means
       the home side is favoured by that many points, which is what
       projectGame() emits as fair_spread and what the board's own line-fault
       check compares against. The FBS slate artifact publishes the other one:
       build_coverage.js writes `model_home_line = -fair_spread`, a BETTING
       number, negative for a home favourite.

       Comparing one against the other without saying so INVERTS this check.
       Pittsburgh's model line of -19.82 against a correctly joined consensus
       -19.5 reads as a 39.3-point disagreement that reconciles to 0.3 under
       negation — the exact signature of a convention fault — so every large,
       correctly oriented line on the card is dropped as broken. That is the
       same undercount this function exists to end, arriving through the guard
       meant to prevent it.

       So the caller states which number it holds and neither is inferred from
       values, because inferring a convention from values is what produced
       every board bug this project has had. */
    var modelMargin = num(o.model_margin);
    if (modelMargin == null && num(o.model_home_line) != null) modelMargin = -num(o.model_home_line);
    if (spread.line != null && modelMargin != null) {
      var f = orientationFault(modelMargin, spread.line);
      if (f) {
        spread.fault = f;
        spread.line = null;
        spread.why = f.basis;
        notes.push('The joined spread was dropped as a convention fault: ' + f.basis);
      }
    }

    /* ---- TOTAL ---------------------------------------------------------- */
    var total = { line: null, source: null, provider: null, book: null, observed_at: null,
      executable: false, odds_american: null, actionable: false, freshness: null, why: null };
    var capT = capturedFor('totals');
    if (capT) {
      var qt = quoteState({ captured_at: capT.last_seen_at, now: now, market: 'totals', kickoff: o.kickoff });
      total.line = num(capT.point);
      total.source = 'signals';
      total.book = capT.best_book || null;
      total.odds_american = fmtAmerican(decToAmerican(num(capT.best_dec)));
      total.observed_at = capT.last_seen_at || null;
      total.executable = true;
      total.freshness = qt;
      total.actionable = qt.actionable;
      total.selection = capT.selection;
      total.why = 'A captured price.';
    } else if (line && num(line.over_under) != null) {
      total.line = num(line.over_under);
      total.source = 'cfb.lines';
      total.provider = line.provider || 'consensus';
      total.why = 'A CONSENSUS TOTAL from cfb.lines: a number, with no book, no per-side odds and no timestamp.';
      notes.push('The total on this game is a consensus line, not an executable price.');
    }

    /* ---- MONEYLINE ------------------------------------------------------
       The one place a consensus row DOES carry two-sided prices. That makes a
       de-vig arithmetically possible, and the result is a genuine consensus
       fair probability — with no timestamp, so it is research, never an
       action. It is NOT synthesised from the spread. */
    var ml = { home_american: null, away_american: null, source: null, provider: null,
      executable: false, actionable: false, devig: null, observed_at: null, why: null };
    var capM = capturedFor('h2h');
    if (capM) {
      var qm = quoteState({ captured_at: capM.last_seen_at, now: now, market: 'h2h', kickoff: o.kickoff });
      ml.source = 'signals';
      ml.selection = capM.selection;
      ml.odds_american = fmtAmerican(decToAmerican(num(capM.best_dec)));
      ml.book = capM.best_book || null;
      ml.observed_at = capM.last_seen_at || null;
      ml.executable = true;
      ml.actionable = qm.actionable;
      ml.freshness = qm;
      ml.why = 'A captured moneyline price.';
    } else if (line && num(line.home_moneyline) != null && num(line.away_moneyline) != null) {
      ml.home_american = num(line.home_moneyline);
      ml.away_american = num(line.away_moneyline);
      ml.source = 'cfb.lines';
      ml.provider = line.provider || 'consensus';
      ml.devig = devigTwoWay(americanToDec(ml.home_american), americanToDec(ml.away_american));
      ml.executable = false;
      ml.actionable = false;
      ml.observed_at = null;
      ml.why = 'Two-sided CONSENSUS moneylines from cfb.lines. Both sides are real numbers, so a de-vig is '
        + 'legitimate and gives a consensus fair probability — but the row carries no book and no timestamp, '
        + 'so it is research context and can never be an action. It is NOT derived from the spread.';
    }

    var hasPrice = !!(spread.executable || total.executable || ml.executable);
    /* A captured price is a market whether or not its handicap resolved to a
       side. The earlier version tested only for a LINE, so a game with a real
       executable price and an unresolved side came back "NO MARKET" — the same
       shape of undercount this whole function exists to end, one level in. */
    var hasLine = hasPrice || spread.line != null || total.line != null || ml.devig != null;
    var actionable = !!(spread.actionable || total.actionable || ml.actionable);

    return {
      spread: spread, total: total, moneyline: ml,
      /* THE THREE COUNTS THE BOARD AND THE DESK MUST AGREE ON. */
      has_market_line: hasLine,
      has_executable_price: hasPrice,
      has_actionable_price: actionable,
      market_status: !hasLine ? 'NO MARKET' : hasPrice ? (actionable ? 'PRICED' : 'PRICED (STALE)') : 'LINE ONLY',
      lines_convention: conv,
      sources: uniq([spread.source, total.source, ml.source]),
      notes: notes,
      /* Said once, here, so no consumer has to rediscover it. */
      contract: 'has_market_line counts games with a NUMBER to compare a model against, which is what the FBS '
        + 'board counts as having a market. has_executable_price counts games with a real book price that could '
        + 'be bet into. They are different questions and the second is always the smaller number.'
    };
  }

  /* ==================================================================== */
  /* THE VALIDATION SNAPSHOT                                               */
  /*                                                                       */
  /* The browser can read football/cfb_p4/params.js directly and should:   */
  /* loadFootballValidation() against the live artifact is always current. */
  /* The edge function cannot — that artifact is a 573KB browser file that */
  /* is not deployed with the function — so the validation record it needs */
  /* is TRANSCRIBED here, stamped with the model version it came from.     */
  /*                                                                       */
  /* A transcription is only honest if drift is caught, so                 */
  /* tools/intelligence/intelligence.test.js re-reads the real artifact    */
  /* and fails when these numbers stop matching it. Retraining the model   */
  /* therefore fails CI until the snapshot is refreshed, which is the      */
  /* correct order of events: a stale validation record would let the      */
  /* decision layer permit something the new model has not earned.         */
  /* ==================================================================== */
  var FOOTBALL_SNAPSHOT = {
    "americanfootball_ncaaf": {"model_version":"edgedesk_cfb_p4_v1.0.0","built_at":"2026-08-22T17:43:03+00:00","calibration_version":"cfb_p4_cal_v1.1.0","validation_summary":{"market":{"window":"2022-2025","n_games":3127,"spread_mae_model":12.769,"spread_mae_market":12.015,"total_mae_model":12.913,"total_mae_market":12.501,"ats_vs_close":{"1":{"n":2599,"wins":1298,"win_pct":49.94,"binom_p_one_sided":0.5313},"2":{"n":2140,"wins":1053,"win_pct":49.21,"binom_p_one_sided":0.7754},"3":{"n":1652,"wins":790,"win_pct":47.82,"binom_p_one_sided":0.9638},"4":{"n":1261,"wins":594,"win_pct":47.11,"binom_p_one_sided":0.9814},"6":{"n":722,"wins":335,"win_pct":46.4,"binom_p_one_sided":0.9757},"0.5":{"n":2829,"wins":1399,"win_pct":49.45,"binom_p_one_sided":0.7263},"1.5":{"n":2366,"wins":1178,"win_pct":49.79,"binom_p_one_sided":0.5895}},"ou_vs_close":{"1":{"n":2529,"wins":1298,"win_pct":51.32,"binom_p_one_sided":0.0947},"2":{"n":1995,"wins":1039,"win_pct":52.08,"binom_p_one_sided":0.0332},"3":{"n":1543,"wins":811,"win_pct":52.56,"binom_p_one_sided":0.0235},"4":{"n":1108,"wins":592,"win_pct":53.43,"binom_p_one_sided":0.0121},"6":{"n":516,"wins":283,"win_pct":54.84,"binom_p_one_sided":0.0155},"0.5":{"n":2812,"wins":1447,"win_pct":51.46,"binom_p_one_sided":0.0633},"1.5":{"n":2265,"wins":1174,"win_pct":51.83,"binom_p_one_sided":0.0424}},"beats_closing_line":false,"max_tier":"RESEARCH_LEAN"},"winprob":{"n":3113,"window":"2022-2025","sigma":14.9,"brier":0.19016,"log_loss":0.55878,"basis":"sigma fitted on 2014-2021 and applied here unchanged"},"calibration":[{"bin":"0.0-0.1","n":36,"p_pred":0.068,"p_obs":0.083},{"bin":"0.1-0.2","n":107,"p_pred":0.154,"p_obs":0.112},{"bin":"0.2-0.3","n":217,"p_pred":0.253,"p_obs":0.249},{"bin":"0.3-0.4","n":288,"p_pred":0.352,"p_obs":0.344},{"bin":"0.4-0.5","n":360,"p_pred":0.449,"p_obs":0.397},{"bin":"0.5-0.6","n":408,"p_pred":0.55,"p_obs":0.551},{"bin":"0.6-0.7","n":477,"p_pred":0.65,"p_obs":0.591},{"bin":"0.7-0.8","n":461,"p_pred":0.75,"p_obs":0.74},{"bin":"0.8-0.9","n":434,"p_pred":0.847,"p_obs":0.82},{"bin":"0.9-1.0","n":325,"p_pred":0.944,"p_obs":0.945}],"firewall":{"layer_a":"ratings, venue HFA, travel, rivalry, conference — tuned 2001-2013","layer_b":"efficiency, matchup, blend curve, QB, schedule, total — tuned 2014-2019","layer_c":"roster continuity, volatility, confidence — tuned 2018-2021","distributional":"sigma, the residual PMFs and the spread-conditioned margin table — fitted 2014-2021, never on the headline window. Fitting sigma by maximum likelihood on 2022-2025 and then quoting that fit's own Brier score as held-out evidence is what an earlier build did; it is corrected here and the honest number is 0.19016 against the in-sample optimum of 0.17899.","headline_test":"2022-2025, untouched by every layer including the distributional one"}},"distributions":{"sigma_margin":14.9,"sigma_total":17.25,"margin_resid_pmf":{"0":0.022523,"1":0.027928,"2":0.024144,"3":0.026306,"4":0.022703,"5":0.022523,"6":0.02018,"7":0.020901,"8":0.021802,"9":0.01964,"10":0.02,"11":0.014955,"12":0.017297,"13":0.014955,"14":0.015135,"15":0.013153,"16":0.016396,"17":0.01045,"18":0.012072,"19":0.010811,"20":0.010631,"21":0.008829,"22":0.008288,"23":0.008108,"24":0.00955,"25":0.007928,"26":0.005946,"27":0.005225,"28":0.005225,"29":0.003604,"30":0.006847,"31":0.004505,"32":0.003604,"33":0.003423,"34":0.002342,"35":0.002162,"36":0.001622,"37":0.001802,"38":0.001982,"39":0.001622,"40":0.000721,"41":0.001441,"42":0.000541,"43":0.000901,"44":0.000541,"45":0.000541,"46":0.000721,"47":0.00036,"-49":0.000721,"-48":0.00018,"-47":0.00036,"-46":0.000721,"-45":0.000901,"-44":0.001261,"-43":0.001622,"-42":0.001441,"-41":0.001261,"-40":0.001441,"-39":0.002523,"-38":0.002523,"-37":0.002162,"-36":0.002883,"-35":0.002342,"-34":0.003604,"-33":0.004324,"-32":0.004685,"-31":0.004324,"-30":0.006847,"-29":0.005946,"-28":0.007387,"-27":0.007387,"-26":0.007387,"-25":0.007387,"-24":0.008829,"-23":0.01027,"-22":0.01045,"-21":0.011171,"-20":0.012973,"-19":0.01027,"-18":0.012613,"-17":0.016036,"-16":0.013694,"-15":0.017297,"-14":0.017117,"-13":0.01982,"-12":0.017297,"-11":0.018378,"-10":0.022883,"-9":0.021802,"-8":0.023964,"-7":0.025225,"-6":0.022883,"-5":0.025946,"-4":0.025946,"-3":0.023784,"-2":0.023423,"-1":0.023423},"total_resid_pmf":{"0":0.025627,"1":0.023642,"2":0.024544,"3":0.023281,"4":0.021657,"5":0.025447,"6":0.018589,"7":0.021296,"8":0.017325,"9":0.017867,"10":0.016964,"11":0.017506,"12":0.016604,"13":0.018228,"14":0.009746,"15":0.013355,"16":0.015521,"17":0.013355,"18":0.012092,"19":0.009746,"20":0.009926,"21":0.009024,"22":0.007399,"23":0.008663,"24":0.006858,"25":0.008121,"26":0.005956,"27":0.005956,"28":0.008121,"29":0.004512,"30":0.00379,"31":0.005414,"32":0.004512,"33":0.002527,"34":0.00397,"35":0.002346,"36":0.003609,"37":0.001624,"38":0.001805,"39":0.001263,"40":0.002346,"41":0.001624,"42":0.001263,"43":0.000902,"44":0.002346,"45":0.002166,"46":0.001444,"47":0.001444,"48":0.001263,"49":0.000902,"-49":0.00018,"-45":0.00018,"-44":0.000541,"-42":0.000902,"-41":0.000541,"-40":0.000722,"-39":0.000902,"-38":0.001985,"-37":0.001444,"-36":0.002888,"-35":0.001805,"-34":0.002888,"-33":0.00397,"-32":0.003429,"-31":0.004873,"-30":0.006497,"-29":0.006136,"-28":0.00758,"-27":0.007941,"-26":0.006497,"-25":0.009746,"-24":0.008121,"-23":0.010648,"-22":0.010828,"-21":0.012994,"-20":0.01155,"-19":0.012633,"-18":0.012272,"-17":0.016062,"-16":0.018408,"-15":0.016423,"-14":0.015521,"-13":0.020754,"-12":0.021296,"-11":0.020032,"-10":0.018589,"-9":0.024364,"-8":0.024003,"-7":0.027071,"-6":0.021476,"-5":0.027071,"-4":0.023101,"-3":0.023822,"-2":0.025447,"-1":0.022379}},"data_provenance":{"schedules":"sportsdataverse/cfbfastR-data schedules/csv/cfb_schedules_YYYY.csv (2001-2025; CollegeFootballData-sourced results, venue, attendance, neutral-site and season-accurate conference membership)","betting":"sportsdataverse/cfbfastR-data betting/csv/cfb_line_odds.csv.gz (2006-2025; spread, total and moneyline, OPENING and closing, multiple books including Pinnacle). This archive is the reason a real CFB market backtest exists at all — the repo previously stated that no public CFB line archive existed, and that was wrong."},"clv_proxy_vs_open":{"1":{"n":6866,"moved_toward_model_pct":53.54},"2":{"n":5444,"moved_toward_model_pct":54.21},"3":{"n":4214,"moved_toward_model_pct":54.7},"5":{"n":2313,"moved_toward_model_pct":56.07}},"calibration_basis":"cold shipped-engine replay 2002-2025 without the live efficiency feed (matchup layer unavailable, matching how the browser runs between trainings) · closing/opening lines from the cfbfastR-data betting archive"}
  };

  /** The transcribed record for a sport, or null when none is carried. */
  function validationSnapshot(sport) { return FOOTBALL_SNAPSHOT[sport] || null; }

  /**
   * Register the transcribed record. Idempotent, and the live artifact always
   * wins: a host that can read params.js should call loadFootballValidation()
   * instead, and doing both is safe because the second call overwrites.
   */
  function loadSnapshotValidation(sport) {
    var snap = FOOTBALL_SNAPSHOT[sport];
    if (!snap) return { registered: 0, why: "no transcribed validation record for " + sport };
    var r = loadFootballValidation(sport, {
      validation_summary: snap.validation_summary,
      distributions: snap.distributions,
      data_provenance: snap.data_provenance,
      model_version: snap.model_version
    }, { clv_proxy_vs_open: snap.clv_proxy_vs_open, basis: snap.calibration_basis });
    if (r) r.source = "transcribed snapshot of " + snap.model_version + " (built " + snap.built_at + ")";
    return r;
  }

  /* ==================================================================== */
  /* SLATE STATE — five different empties, and they are not the same       */
  /*                                                                       */
  /* "There are no CFB matchups to evaluate on this slate" was produced by */
  /* a board showing 75 games, because the only question anyone asked was  */
  /* "did the signals query return rows". An empty signals query means no  */
  /* PRICED SIGNAL. It says nothing whatever about whether games exist.    */
  /*                                                                       */
  /* This separates them, and hands back the exact sentence the answer is  */
  /* required to use, so the distinction cannot be lost in narration.      */
  /* ==================================================================== */

  var SLATE_STATES = ['OK', 'GAMES_NO_SIGNALS', 'LINES_NO_PRICES', 'GAMES_NO_QUOTES', 'PARTIAL_COVERAGE', 'NO_SCHEDULED_GAMES', 'RETRIEVAL_FAILED'];

  /**
   * Classify the slate from counts that were established SEPARATELY.
   *
   * `scheduled` must come from a schedule source — never from the rows that
   * happened to come back with quotes attached. Counting retrieved rows
   * against retrieved rows always reports complete, which is how a
   * half-ingested card looked finished.
   */
  function slateState(o) {
    o = o || {};
    var scheduled = num(o.scheduled_games);
    /* `quoted` is games with a MARKET NUMBER — the count the board shows.
       `priced` is the subset with a real book price that could be bet into.
       They are different questions and conflating them is how a card with
       forty-six market numbers was described as having one. */
    var quoted = num(o.games_with_quotes) || 0;
    var priced = num(o.games_with_executable_price);
    if (priced == null) priced = quoted;
    var signalled = num(o.games_with_signals) || 0;
    var errors = o.errors || [];
    var src = clean(o.schedule_source) || 'the schedule source';
    var scope = clean(o.scope_label) || 'this window';
    var sportLabel = clean(o.sport_label) || 'this sport';

    if (errors.length && scheduled == null) {
      return finish('RETRIEVAL_FAILED', 0,
        'The schedule retrieval for ' + sportLabel + ' failed (' + errors.slice(0, 2).join('; ') + '), so EdgeDesk cannot say how many games are on ' + scope + '. '
        + 'This is a retrieval failure, NOT an empty slate. Do not state that there are no games.');
    }
    if (scheduled === 0) {
      return finish('NO_SCHEDULED_GAMES', 0,
        'No ' + sportLabel + ' games are scheduled in ' + scope + ' according to ' + src + '. This is a genuine empty slate.');
    }
    if (scheduled == null) {
      return finish('RETRIEVAL_FAILED', 0,
        'No schedule source answered for ' + sportLabel + ', so the number of games on ' + scope + ' is unknown. '
        + 'An unknown count is not zero. Do not state that there are no games.');
    }
    if (quoted === 0) {
      return finish('GAMES_NO_QUOTES', scheduled,
        scheduled + ' ' + sportLabel + ' game' + (scheduled === 1 ? '' : 's') + ' ' + (scheduled === 1 ? 'is' : 'are') + ' scheduled in ' + scope + ' according to ' + src
        + ', and NONE of them carries a market number from either source. There are games; there are no lines and no prices. '
        + 'Every game can be researched and discussed. None of them can produce a priced recommendation.');
    }
    /* Lines but no prices: the ordinary state of a college card. Every game
       can be compared against the model; none can be bet into. Saying "no
       market" here would be as wrong as saying "no games". */
    if (priced === 0) {
      return finish('LINES_NO_PRICES', scheduled,
        scheduled + ' ' + sportLabel + ' game' + (scheduled === 1 ? '' : 's') + ' scheduled in ' + scope + ' according to ' + src
        + '; ' + quoted + ' carr' + (quoted === 1 ? 'ies' : 'y') + ' a market NUMBER to compare against; '
        + 'NONE carries an executable price with a book, per-side odds and a capture time. '
        + 'A consensus line is a number, not a price: it can be researched and compared, and it cannot be bet into. '
        + 'Rank and discuss all ' + quoted + '; recommend none of them at a price.');
    }
    if (signalled === 0) {
      return finish('GAMES_NO_SIGNALS', scheduled,
        scheduled + ' ' + sportLabel + ' game' + (scheduled === 1 ? '' : 's') + ' ' + (scheduled === 1 ? 'is' : 'are') + ' scheduled in ' + scope + ' and ' + quoted + ' carr' + (quoted === 1 ? 'ies' : 'y') + ' a market quote, '
        + 'but EdgeDesk has flagged NO signal on any of them. A signal is a priced opportunity EdgeDesk chose to flag; its absence means nothing was flagged, not that nothing is on. '
        + 'Research every game; recommend none on signal grounds.');
    }
    if (quoted < scheduled || priced < quoted || signalled < priced) {
      return finish('PARTIAL_COVERAGE', scheduled,
        scheduled + ' ' + sportLabel + ' game' + (scheduled === 1 ? '' : 's') + ' scheduled in ' + scope + '; '
        + quoted + ' carr' + (quoted === 1 ? 'ies' : 'y') + ' a market number; '
        + priced + ' carr' + (priced === 1 ? 'ies' : 'y') + ' an executable price; '
        + signalled + ' carr' + (signalled === 1 ? 'ies' : 'y') + ' a flagged signal. '
        + 'A statement about the slate covers ' + scheduled + ' games; about MARKETS, ' + quoted
        + '; about PRICES YOU COULD BET INTO, ' + priced + '.');
    }
    return finish('OK', scheduled,
      scheduled + ' ' + sportLabel + ' game' + (scheduled === 1 ? '' : 's') + ' scheduled in ' + scope + ', all quoted, ' + signalled + ' with a flagged signal.');

    function finish(state, n, sentence) {
      return {
        state: state,
        scheduled_games: scheduled,
        games_with_quotes: quoted,
        games_with_market_line: quoted,
        games_with_executable_price: priced,
        games_with_signals: signalled,
        games_known: n,
        schedule_source: o.schedule_source || null,
        scope_label: o.scope_label || null,
        errors: errors,
        sentence: sentence,
        /* The claim that may never be made from this state. Carried as data so
           the prompt can forbid it literally rather than in general terms. */
        forbidden_claim: state === 'NO_SCHEDULED_GAMES' ? null
          : 'that there are no games to evaluate, or that the slate is empty',
        /* A priced recommendation needs a price, not a line. */
        may_recommend: (state === 'OK' || state === 'PARTIAL_COVERAGE') && priced > 0,
        may_compare_to_model: quoted > 0,
        may_research: state !== 'NO_SCHEDULED_GAMES'
      };
    }
  }

  /* ==================================================================== */
  /* COVERAGE — three different questions, three different denominators    */
  /*                                                                       */
  /* The UI showed several disagreeing percentages because three separate  */
  /* things were all called "completeness": how many reads succeeded, how  */
  /* much of what the question NEEDS is present, and how much of what was  */
  /* retrieved actually reached the model. They are different numbers and  */
  /* they are supposed to differ. Naming them is the fix.                  */
  /* ==================================================================== */

  /**
   * @param spec.required  [{field, tier, per, applicable}]
   * @param spec.present   {field: count}
   * @param spec.universe  {entities: n, games: n}
   * @param spec.retrieval {attempted, succeeded, empty, failed}
   * @param spec.delivery  {included, withheld, withheld_subjects}
   */
  function coverageReport(spec) {
    spec = spec || {};
    var req = spec.required || [];
    var present = spec.present || {};
    var uni = spec.universe || {};
    var ret = spec.retrieval || null;
    var del = spec.delivery || null;

    var rows = [], notApplicable = [];
    req.forEach(function (r) {
      if (r.applicable === false) { notApplicable.push({ field: r.field, why: r.why || 'not available for this sport by design' }); return; }
      var denom = r.per === 'entity' ? (num(uni.entities) || 0)
        : r.per === 'game' ? (num(uni.games) || 0)
          : 1;
      if (denom === 0 && r.per !== 'one') { notApplicable.push({ field: r.field, why: 'nothing in scope to measure this against' }); return; }
      var have = Math.min(num(present[r.field]) || 0, denom);
      rows.push({
        field: r.field, tier: r.tier || 'IMPORTANT', per: r.per || 'one',
        have: have, of: denom,
        denominator: r.per === 'entity' ? 'teams/players in scope' : r.per === 'game' ? 'games in scope' : 'the question',
        complete: have >= denom,
        label: r.field + ' ' + have + '/' + denom + ' ' + (r.per === 'entity' ? 'teams' : r.per === 'game' ? 'games' : '')
      });
    });

    function ratio(tier) {
      var t = rows.filter(function (r) { return r.tier === tier; });
      if (!t.length) return null;
      var d = 0, h = 0;
      t.forEach(function (r) { d += r.of; h += r.have; });
      return d ? r4(h / d) : null;
    }
    var required = ratio('REQUIRED'), important = ratio('IMPORTANT');

    /* THREE NAMED NUMBERS. Never one blended "completeness". */
    var metrics = {
      required_field_completeness: {
        value: required, of: 'the fields this question cannot be answered without',
        detail: rows.filter(function (r) { return r.tier === 'REQUIRED'; }).map(function (r) { return r.label; })
      },
      important_field_completeness: {
        value: important, of: 'the fields that materially change the answer',
        detail: rows.filter(function (r) { return r.tier === 'IMPORTANT'; }).map(function (r) { return r.label; })
      },
      retrieval_success_rate: ret && num(ret.attempted) ? {
        value: r4((num(ret.succeeded) || 0) / num(ret.attempted)),
        of: 'reads attempted against EdgeDesk’s own sources',
        detail: (num(ret.succeeded) || 0) + ' of ' + num(ret.attempted) + ' reads answered'
          + (num(ret.empty) ? ', ' + num(ret.empty) + ' answered with no rows' : '')
          + (num(ret.failed) ? ', ' + num(ret.failed) + ' failed' : ''),
        note: 'A read that answered with no rows means the DATA is absent. A read that failed means the lookup never completed. They are different problems.'
      } : null,
      evidence_delivered: del ? {
        value: (num(del.included) || 0) + (num(del.withheld) || 0) > 0
          ? r4((num(del.included) || 0) / ((num(del.included) || 0) + (num(del.withheld) || 0))) : 1,
        of: 'retrieved evidence items that fit inside the analyst’s message',
        detail: (num(del.included) || 0) + ' of ' + ((num(del.included) || 0) + (num(del.withheld) || 0)) + ' items delivered',
        withheld_subjects: del.withheld_subjects || [],
        note: num(del.withheld)
          ? 'Conclusions cover only what was delivered. The withheld subjects are named, and no whole-slate claim may be made.'
          : null
      } : null
    };

    var gaps = rows.filter(function (r) { return !r.complete; });
    return {
      rows: rows,
      not_applicable: notApplicable,
      metrics: metrics,
      critical_gaps: gaps.filter(function (r) { return r.tier === 'REQUIRED'; }).map(function (r) { return r.label; }),
      important_gaps: gaps.filter(function (r) { return r.tier === 'IMPORTANT'; }).map(function (r) { return r.label; }),
      /* The one sentence that keeps the three numbers apart in the answer. */
      sentence: [
        required != null ? Math.round(required * 100) + '% of the required fields' : null,
        important != null ? Math.round(important * 100) + '% of the important fields' : null,
        metrics.retrieval_success_rate ? Math.round(metrics.retrieval_success_rate.value * 100) + '% of reads answered' : null,
        metrics.evidence_delivered ? Math.round(metrics.evidence_delivered.value * 100) + '% of retrieved evidence delivered' : null
      ].filter(Boolean).join(' · '),
      may_claim_whole_slate: !(del && num(del.withheld) > 0) && !gaps.length
    };
  }

  /* ==================================================================== */
  /* MODEL-VERSUS-MARKET DISAGREEMENT                                      */
  /*                                                                       */
  /* A big gap is a reason to check the plumbing before it is a reason to  */
  /* bet. These are the checks, named, in the order they actually catch    */
  /* things — and the gap itself is never converted into value.            */
  /* ==================================================================== */

  function disagreementDiagnostics(o) {
    o = o || {};
    var model = num(o.model_line), market = num(o.market_line);
    var market_k = normMarket(o.market);
    if (model == null || market == null) {
      return { gap: null, level: 'UNKNOWN', checks: [],
        why: 'A disagreement cannot be measured without both a model number and a market number.' };
    }
    /* Both must be expressed on the SAME side and in the same convention, and
       the caller is responsible for that. Orientation errors are the single
       commonest cause of an impossible-looking gap, so the check is first. */
    var gap = Math.abs(model - market);
    var level = gap >= CONFIG.disagreement_points_hard ? 'EXTREME'
      : gap >= CONFIG.disagreement_points ? 'LARGE' : 'ORDINARY';
    var checks = [];
    if (level !== 'ORDINARY') {
      checks.push({ check: 'identity', question: 'Do the model and the market rows describe the same game, the same teams and the same event id?', why: 'A join that pairs two different games produces an enormous, entirely fictional gap.' });
      checks.push({ check: 'side_orientation', question: 'Is the model line stated from the SAME side as the market line — both home, or both on the named selection?', why: 'A reversed side doubles the apparent gap and reverses its direction. On a ' + Math.abs(market) + '-point line a flip shows as a ' + (Math.abs(model - (-market))).toFixed(1) + '-point disagreement.' });
      checks.push({ check: 'handicap_sign', question: 'Is a favourite negative on both sides of the comparison?', why: 'Model spreads and book spreads do not always share a sign convention.' });
      checks.push({ check: 'quote_age', question: 'How old is the market number, and has the line moved since?', why: 'A stale quote makes the market look wrong when it is simply old.' });
      checks.push({ check: 'personnel', question: 'Has the starting quarterback, or another input the model weights heavily, changed since the model ran?', why: 'The market prices a quarterback change immediately. A model built on season inputs does not.' });
      checks.push({ check: 'opponent_adjustment', question: 'Are both teams’ inputs opponent-adjusted, and over a comparable number of games?', why: 'An unadjusted rate against a weak schedule looks like quality.' });
      checks.push({ check: 'roster_change', question: 'Has the roster turned over since the model’s training window?', why: 'Year-over-year carry-over is the weakest assumption in any preseason rating.' });
      checks.push({ check: 'rating_stability', question: 'How many games has the model actually observed for these teams this season?', why: 'Early-season ratings are mostly prior. A large gap in week 3 is usually the prior talking.' });
    }
    if (market_k === 'totals') {
      checks.push({ check: 'pace', question: 'Do both sides agree on the expected number of possessions?', why: 'A total disagreement is usually a pace disagreement, not a scoring one.' });
    }
    return {
      gap: r2(gap), level: level, model_line: r2(model), market_line: r2(market), market: market_k,
      checks: checks,
      /* The hard rule the size of the gap implies. */
      verdict: level === 'EXTREME'
        ? 'A gap this large is treated as a suspected data fault. It may not be presented as value until every check above has been answered.'
        : level === 'LARGE'
          ? 'Run the checks above before treating any part of this as value.'
          : 'An ordinary disagreement. No diagnostic is triggered.',
      blocks_recommendation: level === 'EXTREME'
    };
  }

  /* ==================================================================== */
  /* EDITORIAL ATTENTION — labelled as editorial, because that is what it is */
  /*                                                                       */
  /* "Lower-profile" is a statement about ATTENTION, not about market      */
  /* softness. EdgeDesk measures no betting volume and no limits, so it    */
  /* cannot claim a small game is softly priced, and this refuses to.      */
  /* ==================================================================== */

  var ATTENTION_TIERS = ['NATIONAL', 'REGIONAL', 'LOWER_PROFILE'];

  function attentionTier(o) {
    o = o || {};
    var score = 0, drivers = [];
    var hr = num(o.home_rank), ar = num(o.away_rank);
    if (hr != null && hr <= 25) { score += hr <= 10 ? 3 : 2; drivers.push('home side ranked #' + hr); }
    if (ar != null && ar <= 25) { score += ar <= 10 ? 3 : 2; drivers.push('away side ranked #' + ar); }
    var p4 = 0;
    if (o.home_group === 'p4') p4++;
    if (o.away_group === 'p4') p4++;
    if (p4 === 2) { score += 3; drivers.push('both programs in a Power 4 conference'); }
    else if (p4 === 1) { score += 1; drivers.push('one Power 4 program'); }
    if (o.is_rivalry) { score += 1; drivers.push('rivalry game'); }
    if (o.neutral_site) { score += 1; drivers.push('neutral site'); }
    var tv = clean(o.tv).toUpperCase();
    if (/^(ABC|ESPN|FOX|CBS|NBC)$/.test(tv)) { score += 2; drivers.push('national television window (' + tv + ')'); }
    if (num(o.book_count) != null && num(o.book_count) >= 8) { score += 1; drivers.push(num(o.book_count) + ' books quoting it'); }

    var tier = score >= 6 ? 'NATIONAL' : score >= 3 ? 'REGIONAL' : 'LOWER_PROFILE';
    return {
      tier: tier, score: score, drivers: drivers,
      basis: 'editorial',
      label: tier === 'NATIONAL' ? 'nationally prominent' : tier === 'REGIONAL' ? 'regional interest' : 'lower profile',
      /* The sentence that has to travel with the label every time it is used. */
      caveat: 'This is an EDITORIAL ATTENTION category built from rankings, conference, television window and book coverage. '
        + 'EdgeDesk measures no betting handle and no book limits, so it CANNOT say a lower-profile game is more softly priced. '
        + 'Do not equate low attention with a soft market.',
      measured_volume: null
    };
  }

  /* ==================================================================== */
  /* RESEARCH PRIORITY — what to look at, which is not what to bet         */
  /* ==================================================================== */

  function researchPriority(o) {
    o = o || {};
    var pts = [], score = 0;
    function add(n, why) { score += n; pts.push({ points: n, why: why }); }

    var dis = o.disagreement || null;
    if (dis && dis.level === 'LARGE') add(3, 'The model and the market disagree by ' + dis.gap + ' points — worth understanding, whichever is wrong.');
    if (dis && dis.level === 'EXTREME') add(2, 'A ' + dis.gap + '-point disagreement, large enough to suspect a data fault. Priority is diagnostic, not value.');

    var fm = o.fair || null;
    if (fm && fm.method === 'SHARP_CLAIMED_UNVERIFIED') add(3, 'The row claims a sharp anchor it cannot evidence — a provenance fault worth resolving before anything else.');
    if (fm && fm.method === 'UNKNOWN') add(1, 'The origin of the fair price was never recorded.');

    var q = o.quote_state || null;
    if (q && q.status === 'STALE') add(1, 'The only quote on file is ' + q.age_min + ' minutes old; a refresh would settle whether anything here is live.');

    if (o.model_directional) add(2, 'The model carries a measured directional record in this market, and this game sits in the band where it was measured.');
    if (o.missing_critical && o.missing_critical.length) add(2, 'A decision-critical input is missing (' + o.missing_critical.slice(0, 3).join(', ') + '); retrieving it could change the answer.');
    if (o.personnel_change) add(3, 'A personnel change is on file that the model’s season inputs do not reflect.');

    return {
      score: score,
      band: score >= 6 ? 'HIGH' : score >= 3 ? 'MEDIUM' : 'LOW',
      drivers: pts,
      /* Stated every time, because the two get conflated constantly. */
      caveat: 'Research priority is how much this game rewards attention. It is NOT a recommendation, it is not an edge, and a high priority with no price is still not a bet.'
    };
  }

  /* ==================================================================== */
  /* THE DECISION                                                          */
  /*                                                                       */
  /* Four outcomes, in a fixed order of precedence, each with its blockers */
  /* named. Nothing below invents a probability: every number it uses was  */
  /* computed above or handed in from the deterministic pipeline.          */
  /* ==================================================================== */

  /**
   * @param o.fair            fairMethod() result
   * @param o.quote           {dec|american, book, selection, handicap, captured_at}
   * @param o.quote_state     quoteState() result
   * @param o.model           {line, market, win_probability} optional
   * @param o.validation      validationFor() result
   * @param o.disagreement    disagreementDiagnostics() result
   * @param o.confirmation    confirmationRead() result
   * @param o.required_missing  [{field, why}]
   * @param o.game_status     'scheduled' | 'in_progress' | 'final' | null
   */
  function decide(o) {
    o = o || {};

    /* THE SWITCH, READ FIRST AND ALONE.
       Before any gate, any price, any probability. A disabled decision layer
       does not evaluate and then decline — it does not evaluate. Returning
       PASS here would assert that this selection was weighed and rejected,
       which is a claim about a bet nobody made. */
    if (CONFIG.decisions_enabled === false) {
      return {
        decision: null,
        decision_state: DECISIONS_DISABLED,
        decisions_enabled: false,
        strength: null,
        why: 'EdgeDesk\u2019s decision layer is switched off, so no recommendation was produced for this '
          + 'selection. This is NOT a judgement about the bet: nothing was evaluated, nothing was rejected, '
          + 'and there is no price at which this would have been a candidate. Research and retrieval are '
          + 'unaffected \u2014 the evidence below is real.',
        blockers: [], notes: [], gates: {}, price: null, model: null, disagreement: null,
        what_would_change_it: ['An operator re-enabling the decision layer (EDINTEL.configure({ decisions_enabled: true })).'],
        experimental: false,
        may_publish_to_ledger: false,
        config_used: { decisions_enabled: false }
      };
    }

    var blockers = [], notes = [], gates = {};
    var fair = o.fair || null;
    var qs = o.quote_state || null;
    var conf = o.confirmation || null;
    var v = o.validation || null;
    var dis = o.disagreement || null;
    var missing = (o.required_missing || []).slice();

    var dec = num(o.quote && (o.quote.dec != null ? o.quote.dec : americanToDec(o.quote.american)));
    var handicap = num(o.quote && o.quote.handicap);

    /* ---- the price arithmetic, once, from owned numbers ---------------- */
    var push = pushProbability({
      handicap: handicap, centre: num(o.model && o.model.line) != null ? -num(o.model.line) : null,
      distribution_key: o.push_distribution_key
    });
    var marketP = fair && fair.fair_probability != null ? fair.fair_probability : null;
    var marketEv = marketP != null && dec != null
      ? ev({ dec: dec, p_win: marketP, p_push: push.p_push || 0 }) : null;
    var modelP = o.model && num(o.model.win_probability) != null ? num(o.model.win_probability) : null;
    var modelEv = null;
    if (modelP != null && v && v.may_produce_model_ev && dec != null) {
      modelEv = ev({ dec: dec, p_win: modelP, p_push: push.p_push || 0 });
    }

    var price = {
      offered_decimal: r4(dec),
      offered_american: fmtAmerican(decToAmerican(dec)),
      book: (o.quote && o.quote.book) || null,
      selection: (o.quote && o.quote.selection) || null,
      handicap: handicap,
      fair_probability: marketP,
      fair_american: fair ? fair.fair_american : null,
      fair_method: fair ? fair.method : null,
      fair_label: fair ? fair.label : null,
      push_probability: push.p_push,
      push_note: push.why,
      break_even_probability: dec != null ? breakEvenProb(dec, push.p_push || 0) : null,
      market_ev: marketEv ? marketEv.ev : null,
      model_ev: modelEv ? modelEv.ev : null,
      /* Probability edge and expected return are DIFFERENT QUANTITIES and are
         reported in different units so they cannot be read as one number. */
      probability_edge_pp: (marketP != null && dec != null)
        ? r4(marketP - breakEvenProb(dec, push.p_push || 0)) : null,
      expected_return_per_unit: marketEv ? marketEv.ev : null,
      price_limit_decimal: null,
      price_limit_american: null,
      price_needed_decimal: null,
      price_needed_american: null
    };
    if (marketP != null) {
      var lim = minPlayableDec(marketP, push.p_push || 0, CONFIG.ev_floor);
      price.price_limit_decimal = lim;
      price.price_limit_american = fmtAmerican(decToAmerican(lim));
      if (marketEv && marketEv.ev != null && marketEv.ev < CONFIG.ev_floor) {
        price.price_needed_decimal = lim;
        price.price_needed_american = price.price_limit_american;
      }
    }

    /* ---- gate 1: is there enough to say anything at all? --------------- */
    if (!fair || fair.method === 'NO_FAIR' || marketP == null) {
      missing.push({ field: 'fair_price', why: 'No fair price is on file, so there is nothing to judge this number against.' });
    }
    if (dec == null) missing.push({ field: 'current_price', why: 'No current price is on file for this selection.' });
    gates.evidence = { pass: missing.length === 0, missing: missing };

    /* ---- gate 2: is the game still a pregame proposition? -------------- */
    var status = clean(o.game_status).toLowerCase();
    gates.game_status = { pass: status !== 'final' && status !== 'in_progress', status: status || 'unknown' };
    if (!gates.game_status.pass) blockers.push('The game is ' + status + '. A pregame price is not available.');

    /* ---- gate 3: is the quote live? ----------------------------------- */
    gates.freshness = { pass: !!(qs && qs.actionable), status: qs ? qs.status : 'UNKNOWN', why: qs ? qs.why : 'No quote state was computed.' };
    if (!gates.freshness.pass) blockers.push(qs ? qs.why : 'The age of this quote could not be established.');

    /* ---- gate 4: is the price defensibly better than fair? ------------- */
    var evNow = marketEv && marketEv.ev != null ? marketEv.ev : null;
    gates.price = {
      pass: evNow != null && evNow >= CONFIG.ev_floor,
      ev: evNow, floor: CONFIG.ev_floor,
      why: evNow == null ? 'No expected value could be computed.'
        : evNow >= CONFIG.ev_floor ? 'Expected return ' + pct(evNow, 2) + ' per unit, clearing the ' + pct(CONFIG.ev_floor, 2) + ' floor.'
          : 'Expected return ' + pct(evNow, 2) + ' per unit, below the ' + pct(CONFIG.ev_floor, 2) + ' floor.'
    };

    /* ---- gate 5: is the fair price itself trustworthy? ----------------- */
    gates.provenance = {
      pass: !!(fair && (fair.method === 'SHARP_REFERENCE_DEVIG' || fair.method === 'ROBUST_CONSENSUS_MEDIAN')),
      method: fair ? fair.method : null,
      sharp: !!(fair && fair.sharp),
      why: fair ? fair.why : 'No fair price.'
    };
    if (fair && fair.method === 'SHARP_CLAIMED_UNVERIFIED') blockers.push('The fair price claims a sharp anchor it cannot evidence. Resolve the provenance before pricing anything against it.');
    if (fair && fair.method === 'UNKNOWN') notes.push('The origin of this fair price was not recorded, so the edge measured against it is of unknown quality.');

    /* ---- gate 6: independent corroboration ---------------------------- */
    gates.confirmation = {
      pass: !!(conf && (conf.sharp_confirmed || conf.sufficient_families)),
      sharp_confirmed: !!(conf && conf.sharp_confirmed),
      families: conf ? conf.independent_families : null,
      why: conf ? conf.sentence : 'Confirmation was not assessed.'
    };

    /* ---- gate 7: does the model's own record permit a recommendation? -- */
    var maxDecision = 'BET CANDIDATE';
    gates.model_validation = { pass: true, tier: v ? v.tier : null, why: null };
    if (o.thesis_rests_on_model) {
      gates.model_validation.pass = !!(v && v.may_produce_probability && v.beats_market === true);
      gates.model_validation.why = v
        ? (v.beats_market === true
          ? 'The model’s own record beats the market in this market type.'
          : 'The model’s own walk-forward record does NOT beat the closing line in this market (' + (v.limitations || '').slice(0, 160) + ').')
        : 'No validation record.';
      if (!gates.model_validation.pass) {
        maxDecision = (v && v.max_decision) || 'WATCH';
        notes.push('This thesis rests on the model, and the model’s own validation caps it at ' + maxDecision + '.');
      }
    }
    if (v && v.max_decision && v.max_decision !== 'BET CANDIDATE' && o.thesis_rests_on_model) maxDecision = v.max_decision;

    /* ---- gate 8: unexplained disagreement ----------------------------- */
    gates.disagreement = { pass: !(dis && dis.blocks_recommendation), level: dis ? dis.level : null, why: dis ? dis.verdict : null };
    if (dis && dis.blocks_recommendation) blockers.push(dis.verdict);

    /* ---- gate 9: has the edge survived? ------------------------------- */
    var remaining = num(o.edge_remaining);
    gates.decay = { pass: remaining == null || remaining >= CONFIG.min_edge_remaining, remaining: remaining };
    if (remaining != null && remaining < CONFIG.min_edge_remaining) {
      notes.push('Only ' + Math.round(remaining * 100) + '% of the edge EdgeDesk first saw is left.');
    }

    /* ---- resolve ------------------------------------------------------ */
    var decision, why;
    if (!gates.evidence.pass) {
      decision = 'INSUFFICIENT DATA';
      why = 'EdgeDesk cannot evaluate this selection: ' + missing.map(function (m2) { return m2.field; }).join(', ') + ' missing.';
    } else if (!gates.game_status.pass) {
      decision = 'PASS';
      why = 'The game is ' + gates.game_status.status + '.';
    } else if (gates.price.pass === false && evNow != null && evNow < CONFIG.ev_floor) {
      decision = 'PASS';
      why = gates.price.why + (price.price_needed_american ? ' It becomes interesting again at ' + price.price_needed_american + ' or better.' : '');
    } else if (blockers.length) {
      decision = 'WATCH';
      why = blockers[0];
    } else if (!gates.freshness.pass) {
      decision = 'WATCH';
      why = gates.freshness.why;
    } else if (!gates.confirmation.pass) {
      decision = 'WATCH';
      why = 'The price clears the floor, but nothing independently confirms the fair line it is measured against. ' + gates.confirmation.why;
    } else if (!gates.decay.pass) {
      decision = 'WATCH';
      why = 'Most of the original edge has decayed.';
    } else if (maxDecision !== 'BET CANDIDATE') {
      decision = maxDecision;
      why = notes[notes.length - 1] || 'Capped by the model’s own validation record.';
    } else {
      decision = 'BET CANDIDATE';
      why = gates.price.why + ' ' + gates.confirmation.why;
    }

    /* A candidate that only just clears the floor is a candidate, and saying
       so is more useful than a second label nobody can act on. */
    var strength = decision === 'BET CANDIDATE'
      ? (evNow >= CONFIG.candidate_ev ? 'clear' : 'marginal') : null;

    return {
      decision: decision,
      strength: strength,
      why: why,
      blockers: blockers,
      notes: notes,
      gates: gates,
      price: price,
      model: o.model ? {
        line: num(o.model.line), market: normMarket(o.model.market || (o.quote && o.quote.market)),
        win_probability: modelP, model_ev: price.model_ev,
        validation_tier: v ? v.tier : null,
        experimental: !!(v && v.experimental),
        may_produce_model_ev: !!(v && v.may_produce_model_ev),
        validation_note: v ? v.limitations : null
      } : null,
      disagreement: dis,
      /* Every thing the decision would need to change. */
      what_would_change_it: buildTriggers(decision, price, gates, dis, maxDecision !== 'BET CANDIDATE' && o.thesis_rests_on_model ? maxDecision : null),
      experimental: !!(v && v.experimental && o.thesis_rests_on_model),
      config_used: {
        ev_floor: CONFIG.ev_floor, candidate_ev: CONFIG.candidate_ev,
        min_independent_families: CONFIG.min_independent_families,
        quote_ttl_min: quoteTtlMin(o.quote && o.quote.market),
        min_edge_remaining: CONFIG.min_edge_remaining
      }
    };
  }

  function buildTriggers(decision, price, gates, dis, capped) {
    var t = [];
    if (capped) {
      t.push('A validation record showing the model beats the closing line in this market. Until then the model\u2019s own walk-forward record caps this at ' + capped + ', however large the disagreement looks.');
      t.push('A market-side case for the same side — a sharp reference quoting it at a price that clears the floor — which would stand on its own rather than on the model.');
    }
    if (decision === 'BET CANDIDATE') {
      if (price.price_limit_american) t.push('A price worse than ' + price.price_limit_american + ' takes the expected return below the floor and ends this.');
      t.push('A refreshed quote that is no longer on the board withdraws it entirely.');
    }
    if (decision === 'PASS' && price.price_needed_american) t.push('A price of ' + price.price_needed_american + ' or better restores it.');
    if (decision === 'WATCH' && gates.freshness && !gates.freshness.pass) t.push('A fresh capture confirming the price is still live.');
    if (decision === 'WATCH' && gates.confirmation && !gates.confirmation.pass) t.push('A sharp reference quoting this side, or more independent books behind the fair line.');
    if (decision === 'INSUFFICIENT DATA' && gates.evidence) {
      (gates.evidence.missing || []).forEach(function (m2) { t.push('Retrieving ' + m2.field + '.'); });
    }
    if (dis && dis.blocks_recommendation) t.push('Answering the diagnostic checks on the model-market gap.');
    if (!t.length) t.push('New evidence, a changed price, or a confirmed personnel change.');
    return t;
  }

  /* ==================================================================== */
  /* THE GAME EVIDENCE PACKET                                              */
  /*                                                                       */
  /* One versioned object per matchup. Every factual field carries a        */
  /* source and a time context, and a field that is missing stays NULL      */
  /* WITH A REASON — never a league average wearing the clothes of an       */
  /* observation, and never a number the model filled in.                   */
  /*                                                                       */
  /* Two timestamps, deliberately: `observed_at` is when the fact was true, */
  /* `known_at` is when it became knowable. The pair is what makes a        */
  /* historical answer non-leaky, and collapsing them is how a backtest     */
  /* quietly learns the future.                                             */
  /* ==================================================================== */

  function fact(value, o) {
    o = o || {};
    if (value == null || value === '') {
      return { value: null, missing: true, reason: o.reason || 'not available in EdgeDesk’s current data', source: o.source || null };
    }
    return {
      value: value, missing: false,
      source: o.source || null,
      provenance: o.provenance || null,
      observed_at: o.observed_at || null,
      known_at: o.known_at || o.observed_at || null,
      unit: o.unit || null,
      basis: o.basis || null,
      note: o.note || null
    };
  }
  function missingFact(reason, source) { return { value: null, missing: true, reason: reason, source: source || null }; }

  /**
   * Assemble a matchup packet. Every section is optional; an absent section
   * becomes a declared gap rather than a silently shorter object.
   */
  function evidencePacket(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var sections = {
      identity: o.identity || null,
      market: o.market || null,
      model: o.model || null,
      previous_games: o.previous_games || null,
      efficiency: o.efficiency || null,
      matchup: o.matchup || null,
      personnel: o.personnel || null,
      situation: o.situation || null
    };
    var missing = [], present = [];
    function walk(prefix, obj) {
      if (!obj || typeof obj !== 'object') return;
      for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
        var v = obj[k];
        if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'missing')) {
          if (v.missing) missing.push({ field: prefix + k, reason: v.reason, source: v.source || null });
          else present.push(prefix + k);
        } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(prefix + k + '.', v);
      }
    }
    for (var s in sections) if (Object.prototype.hasOwnProperty.call(sections, s)) {
      if (sections[s] == null) { missing.push({ field: s, reason: 'this whole section was not retrieved for this game', source: null }); continue; }
      walk(s + '.', sections[s]);
    }

    var sources = uniq(present.concat([]).map(function () { return null; }));
    var srcSet = [];
    function collectSources(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
        var v = obj[k];
        if (v && typeof v === 'object' && v.source && srcSet.indexOf(v.source) < 0) srcSet.push(v.source);
        if (v && typeof v === 'object' && !Array.isArray(v)) collectSources(v);
      }
    }
    collectSources(sections);

    return {
      schema: PACKET_SCHEMA,
      version: num(o.version) || 1,
      packet_id: (o.game_id != null ? String(o.game_id) : 'unknown') + ':v' + (num(o.version) || 1),
      game_id: o.game_id != null ? String(o.game_id) : null,
      sport: o.sport || null,
      built_at: new Date(now).toISOString(),
      as_of: o.as_of || null,
      sections: sections,
      completeness: {
        fields_present: present.length,
        fields_missing: missing.length,
        ratio: (present.length + missing.length) ? r4(present.length / (present.length + missing.length)) : null
      },
      missing: missing,
      sources: srcSet,
      note: 'Every factual field carries a source and a time context. A missing field is null with a reason and was never filled in with a league average, a model guess or a value carried over from another game.'
    };
  }

  /**
   * Has this packet's evidence changed enough that a cached conclusion can no
   * longer be reused? Price, personnel and status move the answer; a new
   * ranking does not.
   */
  function packetStillValid(prev, cur) {
    if (!prev || !cur) return { valid: false, why: 'No earlier packet to compare against.' };
    var changed = [];
    function pick(p, path) {
      var parts = path.split('.'), o = p, i;
      for (i = 0; i < parts.length; i++) { if (!o) return undefined; o = o[parts[i]]; }
      return o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, 'value') ? o.value : o;
    }
    var WATCHED = ['market.price', 'market.book', 'market.handicap', 'market.captured_at',
      'identity.status', 'personnel.starting_qb', 'model.line', 'model.total'];
    WATCHED.forEach(function (path) {
      var a = pick(prev.sections || {}, path), b = pick(cur.sections || {}, path);
      if (JSON.stringify(a == null ? null : a) !== JSON.stringify(b == null ? null : b)) changed.push(path);
    });
    return {
      valid: changed.length === 0,
      changed: changed,
      why: changed.length
        ? 'These decision-critical fields changed since the cached analysis: ' + changed.join(', ') + '. Any price conclusion must be recomputed before it is repeated.'
        : 'No decision-critical field has changed, so the cached analysis still describes this game.'
    };
  }

  /* ==================================================================== */
  /* THE RECOMMENDATION LEDGER                                             */
  /*                                                                       */
  /* Immutable by construction: a published recommendation is written once  */
  /* and never edited. A later change is a SEPARATE row pointing back at    */
  /* the original, so the record of what was actually said at the time      */
  /* survives whatever happens afterwards. That property is the only        */
  /* reason any measurement built on it means anything.                     */
  /* ==================================================================== */

  function ledgerEntry(o) {
    o = o || {};
    var published = o.published_at || new Date(toMs(o.now) || Date.now()).toISOString();
    if (DECISIONS.indexOf(o.decision) < 0) {
      return { ok: false, why: 'Decision must be one of ' + DECISIONS.join(', ') + '; got "' + o.decision + '".' };
    }
    var dec = num(o.odds_decimal) != null ? num(o.odds_decimal) : americanToDec(o.odds_american);
    return {
      ok: true,
      schema: LEDGER_SCHEMA,
      /* A natural key, so a duplicate publish of the same decision at the same
         price is recognisable as the same row rather than stacking. */
      entry_key: [o.sport, o.game_id, normMarket(o.market), o.selection, o.handicap == null ? '' : o.handicap, published].join('|'),
      kind: 'RECOMMENDATION',
      sport: o.sport || null,
      game_id: o.game_id != null ? String(o.game_id) : null,
      matchup: o.matchup || null,
      kickoff: o.kickoff || null,
      market: normMarket(o.market),
      selection: o.selection || null,
      handicap: num(o.handicap),
      odds_decimal: r4(dec),
      odds_american: fmtAmerican(decToAmerican(dec)),
      book: o.book || null,
      quote_captured_at: o.quote_captured_at || null,
      decision: o.decision,
      strength: o.strength || null,
      probability: num(o.probability),
      probability_source: o.probability_source || null,
      expected_value: num(o.expected_value),
      price_limit_american: o.price_limit_american || null,
      evidence_version: o.evidence_version || null,
      evidence_packet_id: o.evidence_packet_id || null,
      model_version: o.model_version || null,
      engine_version: o.engine_version || null,
      decision_config: o.decision_config || null,
      /* FORWARD means published before the event, with no knowledge of it.
         Anything else is a backtest and is measured in a separate population. */
      mode: o.mode === 'BACKTEST' ? 'BACKTEST' : 'FORWARD',
      published_at: published,
      /* Set once, never updated in place. */
      immutable: true,
      supersedes: null,
      note: 'This row records what EdgeDesk said at publication time. It is never edited. A later change is a separate UPDATE row.'
    };
  }

  /** A subsequent change, recorded WITHOUT touching the original. */
  function ledgerUpdate(original, o) {
    o = o || {};
    if (!original || !original.entry_key) return { ok: false, why: 'An update must point at an original entry.' };
    return {
      ok: true, schema: LEDGER_SCHEMA, kind: 'UPDATE',
      entry_key: original.entry_key + '|u|' + (o.published_at || new Date().toISOString()),
      supersedes: original.entry_key,
      sport: original.sport, game_id: original.game_id, market: original.market,
      selection: original.selection, handicap: original.handicap,
      decision: o.decision || original.decision,
      odds_decimal: num(o.odds_decimal) != null ? r4(num(o.odds_decimal)) : original.odds_decimal,
      odds_american: o.odds_american || original.odds_american,
      reason: o.reason || null,
      published_at: o.published_at || new Date().toISOString(),
      immutable: true,
      note: 'An update to a published recommendation. The original row is unchanged and remains the record of what was said at the time.'
    };
  }

  /* ---- measurement ---------------------------------------------------- */

  /** Wilson score interval — honest at the sample sizes this actually sees. */
  function wilson(wins, n, z) {
    if (!n) return null;
    z = z || 1.96;
    var p = wins / n, z2 = z * z;
    var d = 1 + z2 / n;
    var c = p + z2 / (2 * n);
    var s = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return { lo: r4((c - s) / d), hi: r4((c + s) / d), z: z };
  }

  /**
   * Measure a set of settled ledger rows.
   *
   * Forward recommendations and backtests are counted in SEPARATE populations
   * and never blended, because a backtest cannot be wrong about a game it was
   * fitted on and mixing the two manufactures a record.
   */
  function measure(rows, o) {
    o = o || {};
    var all = (rows || []).filter(function (r) { return r && r.kind !== 'UPDATE'; });
    var out = { forward: bucket(all.filter(function (r) { return r.mode !== 'BACKTEST'; })),
      backtest: bucket(all.filter(function (r) { return r.mode === 'BACKTEST'; })) };
    out.by_sport = split(all, 'sport');
    out.by_market = split(all, 'market');
    out.by_decision = split(all, 'decision');
    out.separation_note = 'Forward recommendations and backtests are counted separately and are never combined. '
      + 'A backtest result is not evidence about future performance and is reported only to show what was fitted.';
    return out;

    function split(list, key) {
      var groups = {}, i, k;
      for (i = 0; i < list.length; i++) {
        k = list[i][key] == null ? 'unknown' : String(list[i][key]);
        (groups[k] = groups[k] || []).push(list[i]);
      }
      var o2 = {};
      for (k in groups) if (Object.prototype.hasOwnProperty.call(groups, k)) o2[k] = bucket(groups[k].filter(function (r) { return r.mode !== 'BACKTEST'; }));
      return o2;
    }

    function bucket(list) {
      var settled = list.filter(function (r) { return r.result != null && r.result !== ''; });
      var w = 0, l = 0, p = 0, v = 0, units = 0, staked = 0;
      var clvs = [], briers = [], probs = 0;
      settled.forEach(function (r) {
        var res = clean(r.result).toLowerCase();
        var d = num(r.odds_decimal);
        if (res === 'win') { w++; staked += 1; units += d != null ? d - 1 : 0; }
        else if (res === 'loss') { l++; staked += 1; units -= 1; }
        else if (res === 'push') { p++; staked += 1; }
        else if (res === 'void' || res === 'cancelled') { v++; }
        var c = num(r.clv);
        if (c != null) clvs.push(c);
        var pr = num(r.probability);
        if (pr != null && (res === 'win' || res === 'loss')) {
          probs++;
          briers.push(Math.pow(pr - (res === 'win' ? 1 : 0), 2));
        }
      });
      var decided = w + l;
      return {
        n_published: list.length,
        n_settled: settled.length,
        wins: w, losses: l, pushes: p, voids: v,
        /* A push is not a win and not a loss. It is excluded from the win rate
           and included in the stake, which is what actually happened. */
        win_rate: decided ? r4(w / decided) : null,
        win_rate_interval: decided ? wilson(w, decided) : null,
        units: r2(units),
        /* ROI is on AMOUNT STAKED, which includes pushed stakes, because that
           is the money that was actually at risk. */
        roi_on_staked: staked ? r4(units / staked) : null,
        amount_staked: r2(staked),
        clv: clvs.length ? {
          n: clvs.length,
          mean: r4(clvs.reduce(function (a, b) { return a + b; }, 0) / clvs.length),
          beat_rate: r4(clvs.filter(function (c) { return c > 0; }).length / clvs.length),
          reference: o.clv_reference || 'the de-vigged closing fair price recorded by the settle job, measured from the entry price on the row',
          note: 'CLV is measured against one reference method for every row in this population. Rows graded against a different reference are not mixed in.'
        } : null,
        brier: briers.length ? { n: briers.length, value: r4(briers.reduce(function (a, b) { return a + b; }, 0) / briers.length),
          note: 'Measured only over rows that carried a published probability and settled to a win or a loss (n=' + probs + ').' } : null,
        sufficient_sample: decided >= 100,
        caveat: decided < 100
          ? 'n=' + decided + ' decided outcomes. At this sample size the interval is wide enough that neither a positive nor a negative record means anything yet. Report the interval, never the point estimate alone.'
          : null
      };
    }
  }

  /**
   * Refuse to grade a recommendation against information it could not have had.
   *
   * A row published after kickoff, or graded against a closing price captured
   * before it was published, is leakage and is excluded with a reason rather
   * than quietly included.
   */
  function validateNoLookahead(row) {
    var pub = toMs(row && row.published_at);
    var kick = toMs(row && row.kickoff);
    var problems = [];
    if (pub == null) problems.push('no publication timestamp, so it cannot be shown to precede the event');
    if (kick != null && pub != null && pub > kick) problems.push('published after kickoff');
    if (row && row.mode === 'BACKTEST') problems.push('a backtest, which is measured in its own population');
    var closeAt = toMs(row && row.closing_captured_at);
    if (closeAt != null && pub != null && closeAt < pub) problems.push('graded against a closing price captured before publication');
    return {
      clean: problems.length === 0,
      problems: problems,
      why: problems.length ? 'Excluded from the forward record: ' + problems.join('; ') + '.' : null
    };
  }

  return {
    VERSION: VERSION, PACKET_SCHEMA: PACKET_SCHEMA, LEDGER_SCHEMA: LEDGER_SCHEMA, DECISIONS: DECISIONS,
    DECISIONS_DISABLED: DECISIONS_DISABLED, decisionsEnabled: function () { return CONFIG.decisions_enabled !== false; },
    configure: configure, config: config,
    num: num, toMs: toMs, normName: normName, normMarket: normMarket, marketLabel: marketLabel, titleCase: titleCase,
    americanToDec: americanToDec, decToAmerican: decToAmerican, fmtAmerican: fmtAmerican,
    impliedProb: impliedProb, devigTwoWay: devigTwoWay,
    ev: ev, breakEvenProb: breakEvenProb, priceForEv: priceForEv, minPlayableDec: minPlayableDec,
    registerDistribution: registerDistribution, distribution: distribution, distributions: distributions,
    clearDistributions: clearDistributions, pushProbability: pushProbability,
    MODEL_VALIDATION: MODEL_VALIDATION, registerValidation: registerValidation, validationFor: validationFor,
    loadFootballValidation: loadFootballValidation, modelWinProbability: modelWinProbability,
    validationSnapshot: validationSnapshot, loadSnapshotValidation: loadSnapshotValidation,
    fairMethod: fairMethod, confirmationRead: confirmationRead,
    quoteTtlMin: quoteTtlMin, quoteState: quoteState, applyRefresh: applyRefresh,
    orientationFault: orientationFault, lineToMargin: lineToMargin, resolveMarket: resolveMarket,
    fbsIndexFor: fbsIndexFor, joinSignalsToGames: joinSignalsToGames, canonKey: canonKey,
    availabilityRead: availabilityRead, AVAIL_STATES: AVAIL_STATES, AVAIL_STALE_H: AVAIL_STALE_H,
    normKey: normKey, aliasKey: aliasKey, resolveTeam: resolveTeam, matchesEvent: matchesEvent,
    teamIndex: teamIndex, expandState: expandState, TEAM_ALIASES: TEAM_ALIASES,
    SLATE_STATES: SLATE_STATES, slateState: slateState, coverageReport: coverageReport,
    disagreementDiagnostics: disagreementDiagnostics,
    ATTENTION_TIERS: ATTENTION_TIERS, attentionTier: attentionTier, researchPriority: researchPriority,
    decide: decide,
    fact: fact, missingFact: missingFact, evidencePacket: evidencePacket, packetStillValid: packetStillValid,
    ledgerEntry: ledgerEntry, ledgerUpdate: ledgerUpdate, measure: measure, wilson: wilson,
    validateNoLookahead: validateNoLookahead
  };
});
/*__EDINTEL_END__*/
