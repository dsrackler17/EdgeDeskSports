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

  /* ====================================================================== */
  /* THE OTHER FOOTBALL LEAGUE                                              */
  /*                                                                        */
  /* The FBS resolver above is the college card. The reader's football      */
  /* board carries BOTH leagues, and a desk that can only resolve one of    */
  /* them answers "there is no such game" about a game the page behind it   */
  /* is displaying. That is the same board/desk split §1.1 of docs/         */
  /* intelligence.md describes, one league over.                            */
  /*                                                                        */
  /* The two indexes are kept SEPARATE on purpose. Merged, the prefix rule  */
  /* that protects Miami (OH) from Miami (FL) would start reaching across   */
  /* leagues, and "Houston" — a real college programme and a real NFL city  */
  /* — would silently become whichever row happened to be indexed first.    */
  /* Two indexes make that collision a question to ask rather than a guess. */
  /* ====================================================================== */
  var CFB_SPORT = 'americanfootball_ncaaf';
  var NFL_SPORT = 'americanfootball_nfl';

  /* Keyed on the club's abbreviation, because that is what the NFL board
     stores and what nflverse writes. The club NAME is indexed automatically
     by teamIndex(), so only the spellings a reader actually types are listed.

     A CITY IS ONLY AN ALIAS WHERE IT IS UNAMBIGUOUS. "Houston", "Buffalo",
     "Cincinnati", "Miami", "Arizona", "Washington", "Pittsburgh", "Tennessee",
     "Minnesota", "Jacksonville", "Las Vegas" and "Carolina" are all college
     programmes (or, for Los Angeles and New York, two NFL clubs at once), so
     none of them is aliased to a club here. The nickname is unique across the
     NFL and is always safe; the city is listed only when nothing else wants
     it. A name left out resolves through the club's full name instead, which
     is indexed either way — the cost of leaving one out is a question, and
     the cost of putting one in wrongly is the wrong team's number. */
  var NFL_ALIASES = {
    ari: ['cardinals', 'arizona cardinals'],
    atl: ['falcons', 'atlanta', 'atlanta falcons'],
    bal: ['ravens', 'baltimore', 'baltimore ravens'],
    buf: ['bills', 'buffalo bills'],
    car: ['panthers', 'carolina panthers'],
    chi: ['bears', 'chicago', 'chicago bears'],
    cin: ['bengals', 'cincinnati bengals'],
    cle: ['browns', 'cleveland', 'cleveland browns'],
    dal: ['cowboys', 'dallas', 'dallas cowboys'],
    den: ['broncos', 'denver', 'denver broncos'],
    det: ['lions', 'detroit', 'detroit lions'],
    gb: ['packers', 'green bay', 'green bay packers'],
    hou: ['texans', 'houston texans'],
    ind: ['colts', 'indianapolis', 'indianapolis colts'],
    jax: ['jaguars', 'jags', 'jacksonville jaguars'],
    kc: ['chiefs', 'kansas city', 'kansas city chiefs'],
    la: ['rams', 'los angeles rams'],
    lac: ['chargers', 'los angeles chargers'],
    lv: ['raiders', 'las vegas raiders'],
    mia: ['dolphins', 'miami dolphins'],
    min: ['vikings', 'minnesota vikings'],
    ne: ['patriots', 'pats', 'new england', 'new england patriots'],
    no: ['saints', 'new orleans', 'new orleans saints'],
    nyg: ['giants', 'new york giants', 'ny giants'],
    nyj: ['jets', 'new york jets', 'ny jets'],
    phi: ['eagles', 'philadelphia', 'philadelphia eagles'],
    pit: ['steelers', 'pittsburgh steelers'],
    sea: ['seahawks', 'seattle', 'seattle seahawks'],
    sf: ['49ers', 'niners', 'san francisco', 'san francisco 49ers'],
    tb: ['buccaneers', 'bucs', 'tampa bay', 'tampa bay buccaneers'],
    ten: ['titans', 'tennessee titans'],
    was: ['commanders', 'washington commanders']
  };

  /* The NFL twin of fbsIndexFor: the card's own clubs, plus every club the
     alias table knows, so a club that is on a bye still RESOLVES and is then
     reported as having no game in the window rather than as an unknown name. */
  function nflIndexFor(games) {
    var universe = { teams: {}, order: [] };
    function add(key, name, aliases, offCard) {
      if (!key || universe.teams[key]) return;
      universe.teams[key] = { key: key, name: name || key, aliases: aliases || [], off_card: !!offCard };
      universe.order.push(key);
    }
    (games || []).forEach(function (g) {
      [[g.home_team, g.home_id], [g.away_team, g.away_id]].forEach(function (pair) {
        var name = clean(pair[0]);
        if (!name) return;
        var key = canonKey(pair[1], name);
        add(key, name, NFL_ALIASES[key] || []);
      });
    });
    Object.keys(NFL_ALIASES).forEach(function (key) { add(key, key, NFL_ALIASES[key], true); });
    return teamIndex(universe);
  }

  /** The resolver index for a football league. Unknown sports read as college,
      because that is the only card this kernel has ever carried and a silent
      change of default is how a question ends up in the wrong sport. */
  function footballIndexFor(sport, games) {
    return String(sport || '') === NFL_SPORT ? nflIndexFor(games) : fbsIndexFor(games);
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

  /* ====================================================================== */
  /* THE PRICE BOARD FOR ONE GAME                                           */
  /*                                                                        */
  /* resolveMarket() above answers "what is the number on this game" in one */
  /* line per market, which is what a decision needs. A RESEARCHER needs     */
  /* something else: both sides of each market, the book behind each one,    */
  /* when it was seen, what it opened at, and an honest statement of how     */
  /* wide "best price" actually reaches.                                     */
  /*                                                                        */
  /* WHAT "BEST" MEANS HERE, EXACTLY. Capture writes one `signals` row per   */
  /* (event, market, selection, handicap) and stores the BEST decimal price  */
  /* it saw across the books it polled, together with the book that offered  */
  /* it and how many books quoted the selection. So `best_dec` already IS    */
  /* the best observed price for that exact selection — across EdgeDesk'S    */
  /* COVERED BOOKS and no further. It is never described as the best price   */
  /* in the market, because EdgeDesk does not poll the market; it polls a    */
  /* list, and the list is reported with the number.                         */
  /* ====================================================================== */
  var MARKET_BOARD_SCHEMA = 'edgedesk_market_board_v1';

  /* The five things that look identical from the outside and need opposite
     responses. Conflating any two of them is how "no quote" becomes "0". */
  var MARKET_STATES = {
    LIVE: 'a book price was captured and is inside its freshness limit',
    STALE: 'a book price was captured and is past its freshness limit',
    LINE_ONLY: 'a consensus number exists with no book, no per-side price and no capture time',
    NO_QUOTE: 'the price feed answered and no book it covers is quoting this game',
    JOIN_FAILED: 'quotes existed in the window and none of them could be matched to this game',
    CAPTURE_FAILED: 'the price read itself failed, so nothing is known either way',
    NOT_ATTEMPTED: 'no price read was made on this turn'
  };

  /**
   * Which of the five states this game is in, with the sentence a reader gets
   * and the detail an operator needs.
   *
   * THE DISTINCTION THAT MATTERS MOST is between CAPTURE_FAILED / JOIN_FAILED
   * and NO_QUOTE. The first two are EdgeDesk failing; the third is the market.
   * A reader told "no book is pricing this" when the truth is "the read threw"
   * has been handed a fact about football that is really a fact about a server.
   */
  function marketStatusRead(o) {
    o = o || {};
    var state, user, operator = o.operator_detail || null;
    var rowsInWindow = num(o.rows_in_window);
    var joined = num(o.rows_joined);
    if (o.executable) {
      state = o.actionable ? 'LIVE' : 'STALE';
      user = o.actionable
        ? 'A book price EdgeDesk captured, inside its freshness limit.'
        : 'The last book price EdgeDesk captured is past its freshness limit. It is kept as research with its '
          + 'timestamp; it is not a price you can be told is still on the board.';
    } else if (o.has_line) {
      state = 'LINE_ONLY';
      user = 'A consensus number with no book, no per-side price and no capture time. It is something to compare '
        + 'the model against, not something to bet into.';
    } else if (o.read_failed) {
      state = 'CAPTURE_FAILED';
      user = 'EdgeDesk could not read the price feed for this game on this turn, so it does not know whether a '
        + 'price exists. That is a retrieval failure, not an absence of a market.';
    } else if (rowsInWindow != null && rowsInWindow > 0 && (joined == null || joined === 0)) {
      state = 'JOIN_FAILED';
      user = 'Quotes were returned for this window and none of them could be matched to this fixture, so EdgeDesk '
        + 'is not showing a price rather than showing one that may belong to another game.';
      operator = operator || (rowsInWindow + ' captured rows were in the kickoff window and 0 joined to this game.');
    } else if (o.attempted === false) {
      state = 'NOT_ATTEMPTED';
      user = 'No price read was made for this game on this turn.';
    } else {
      state = 'NO_QUOTE';
      user = 'No book EdgeDesk covers is quoting this game yet. That is an absence of a quote, not a quote of zero.';
    }
    return {
      state: state, basis: MARKET_STATES[state], user: user, operator: operator,
      executable: !!o.executable, actionable: !!(o.executable && o.actionable),
      /* An absence EdgeDesk caused is never reported as an absence the market
         caused, and both are reported as absences rather than as zeros. */
      is_edgedesk_fault: state === 'CAPTURE_FAILED' || state === 'JOIN_FAILED',
      may_quote_a_price: state === 'LIVE' || state === 'STALE',
      may_call_it_live: state === 'LIVE'
    };
  }

  function sideOf(selection, homeTeam, awayTeam) {
    var s = normName(selection);
    if (!s) return null;
    if (/^over$|^o$/.test(s)) return 'over';
    if (/^under$|^u$/.test(s)) return 'under';
    if (homeTeam && s === normName(homeTeam)) return 'home';
    if (awayTeam && s === normName(awayTeam)) return 'away';
    if (/over/.test(s)) return 'over';
    if (/under/.test(s)) return 'under';
    return null;
  }

  /**
   * Every captured selection on one game, best price first, with provenance.
   *
   * @param o.signals     captured rows for THIS game (already joined)
   * @param o.lines       consensus rows for this game, if any
   * @param o.home_team / o.away_team   the schedule's own names
   * @param o.rows_in_window / o.rows_joined / o.read_failed   retrieval facts
   */
  function marketBoard(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var sigs = o.signals || [], lines = o.lines || [];
    var home = o.home_team || null, away = o.away_team || null;

    /* One group per (market, selection, handicap): those are different bets
       and merging them would put an alternate line's price on the main one. */
    var groups = {};
    sigs.forEach(function (s) {
      if (!s) return;
      var mk = normMarket(s.market);
      if (!mk) return;
      var dec = num(s.best_dec);
      if (dec == null || dec <= 1) return;
      var pt = num(s.point);
      var key = mk + '|' + normName(s.selection) + '|' + (pt == null ? '' : pt);
      var g = groups[key];
      var seen = String(s.last_seen_at || '');
      if (!g || seen > g._seen || (seen === g._seen && dec > g.price_decimal)) {
        groups[key] = {
          _seen: seen,
          market: mk, market_label: marketLabel(mk),
          selection: s.selection || null,
          side: sideOf(s.selection, home, away),
          handicap: pt,
          price_decimal: dec,
          price_american: fmtAmerican(decToAmerican(dec)),
          book: s.best_book || null,
          observed_at: s.last_seen_at || null,
          books_quoting: num(s.n_books),
          book_families: num(s.n_books_eff),
          opened: (num(s.first_best_dec) != null && num(s.first_best_dec) > 1) ? {
            price_decimal: num(s.first_best_dec),
            price_american: fmtAmerican(decToAmerican(num(s.first_best_dec))),
            observed_at: s.first_seen_at || null
          } : null,
          source: 'captured signals',
          provenance: 'A price a book was actually showing when EdgeDesk captured it.'
        };
      }
    });

    var rows = Object.keys(groups).map(function (k) {
      var g = groups[k];
      delete g._seen;
      g.freshness = quoteState({ captured_at: g.observed_at, now: now, market: g.market, kickoff: o.kickoff });
      g.age_min = g.freshness.age_min;
      g.actionable = g.freshness.actionable;
      /* MOVEMENT IS ONLY EVER TWO OBSERVATIONS EdgeDesk ACTUALLY MADE. There
         is no reconstruction of an opening line here: `first_best_dec` is the
         first price capture saw, which is not necessarily the market's open,
         and it is labelled as the first OBSERVED price for exactly that
         reason. */
      if (g.opened && g.opened.price_decimal && g.price_decimal) {
        var d = g.price_decimal - g.opened.price_decimal;
        g.movement = {
          direction: Math.abs(d) < 1e-9 ? 'unchanged' : (d > 0 ? 'lengthened' : 'shortened'),
          from_american: g.opened.price_american, to_american: g.price_american,
          first_observed_at: g.opened.observed_at,
          basis: 'first observed price against the latest observed price, both from EdgeDesk’s own captures. '
            + 'It is not an opening line from the book and is not described as one.'
        };
      } else {
        g.movement = null;
      }
      return g;
    });

    function pickMarket(mk) {
      var mine = rows.filter(function (r) { return r.market === mk; });
      if (!mine.length) return null;
      /* The freshest capture is the current line; a tie goes to the better
         price, which is the only tie-break that can never mislead. */
      mine.sort(function (a, b) {
        var t = String(b.observed_at || '').localeCompare(String(a.observed_at || ''));
        return t !== 0 ? t : (b.price_decimal - a.price_decimal);
      });
      var lead = mine[0];
      var sides = {};
      mine.forEach(function (r) {
        if (!r.side) return;
        var cur = sides[r.side];
        if (!cur || String(r.observed_at || '') > String(cur.observed_at || '')) sides[r.side] = r;
      });
      return { current: lead, by_side: sides, all: mine, alternates: mine.length - Object.keys(sides).length };
    }

    var spreads = pickMarket('spreads'), totals = pickMarket('totals'), h2h = pickMarket('h2h');

    /* The consensus row, when there is one. Named separately and NEVER merged
       into the captured rows above. */
    var cons = null;
    lines.forEach(function (l) { if (!cons || String(l.provider || '').toLowerCase().indexOf('consensus') >= 0) cons = l; });
    var consensus = cons ? {
      provider: cons.provider || 'consensus',
      spread_home_handicap: num(cons.spread),
      total: num(cons.over_under),
      home_moneyline: num(cons.home_moneyline),
      away_moneyline: num(cons.away_moneyline),
      source: 'cfb.lines',
      provenance: 'A consensus number. No book, no per-side price, no capture time — a reference to compare a '
        + 'model against, and not something to bet into.'
    } : null;

    var executable = !!(spreads || totals || h2h);
    var actionable = rows.some(function (r) { return r.actionable; });
    var hasLine = executable || !!(consensus && (consensus.spread_home_handicap != null || consensus.total != null
      || (consensus.home_moneyline != null && consensus.away_moneyline != null)));

    var books = {};
    rows.forEach(function (r) { if (r.book) books[r.book] = 1; });
    var bookList = Object.keys(books).sort();
    var maxBooks = rows.reduce(function (a, r) { return Math.max(a, num(r.books_quoting) || 0); }, 0);

    return {
      schema: MARKET_BOARD_SCHEMA,
      built_at: new Date(now).toISOString(),
      game_id: o.game_id || null,
      home_team: home, away_team: away,
      spreads: spreads, totals: totals, moneyline: h2h,
      rows: rows,
      consensus: consensus,
      status: marketStatusRead({
        executable: executable, actionable: actionable, has_line: hasLine,
        read_failed: !!o.read_failed, attempted: o.attempted !== false,
        rows_in_window: o.rows_in_window, rows_joined: o.rows_joined,
        operator_detail: o.operator_detail || null
      }),
      coverage: {
        books_offering_best: bookList,
        books_quoting_max: maxBooks || null,
        note: bookList.length
          ? 'Best of the ' + (maxBooks || bookList.length) + ' book' + ((maxBooks || bookList.length) === 1 ? '' : 's')
            + ' EdgeDesk captured on this selection. EdgeDesk polls a list of books, not the whole market, so this '
            + 'is the best price OBSERVED and is not claimed to be the best price available anywhere.'
          : 'No book price was captured for this game, so there is no best price to report.'
      },
      contract: 'A captured price and a consensus number are never merged. No price is ever mirrored from the other '
        + 'side of a handicap: a handicap is one number seen from two ends, but the two sides are priced '
        + 'independently, so a side EdgeDesk did not capture has no price at all.'
    };
  }

  /* ====================================================================== */
  /* A PRICE THE READER SAYS THEY CAN GET                                   */
  /*                                                                        */
  /* "I can get -13.5 at -110" is evidence, and it is evidence of a         */
  /* different KIND from a captured quote: EdgeDesk did not observe it,     */
  /* cannot timestamp it beyond the moment it was typed, and cannot say     */
  /* which book it came from unless told. It therefore travels with its own */
  /* provenance and can never be counted in book coverage, in a best-price  */
  /* claim, or in anything that says "EdgeDesk observed".                   */
  /* ====================================================================== */
  var USER_QUOTE_PATTERNS = [
    /* -13.5 at -110 / -13.5 @ -110 / +3 -105 */
    /([+-]?\d+(?:\.\d+)?)\s*(?:at|@|for)\s*([+-]\d{3,4})/i,
    /* 13.5 at -110 with the side named elsewhere */
    /([+-]?\d+(?:\.\d+)?)\s*\(\s*([+-]\d{3,4})\s*\)/
  ];

  /**
   * Parse a reader-entered price out of their own sentence.
   *
   * Deliberately narrow. A number with no odds beside it is not read as a
   * price — a reader saying "they should be -14" is stating an opinion, and
   * turning that into a quote would be the same invention this whole layer
   * exists to prevent.
   */
  function parseUserQuote(text, o) {
    o = o || {};
    var t = String(text == null ? '' : text);
    if (!t.trim()) return null;
    var m = null, i;
    for (i = 0; i < USER_QUOTE_PATTERNS.length; i++) { m = USER_QUOTE_PATTERNS[i].exec(t); if (m) break; }
    if (!m) return null;
    var handicap = num(m[1]), odds = num(m[2]);
    if (handicap == null || odds == null) return null;
    var market = /total|over|under|o\/u/i.test(t) ? 'totals' : 'spreads';
    if (/\bml\b|moneyline|money line/i.test(t)) market = 'h2h';
    var bookM = /\b(?:at|on|with)\s+(draftkings|fanduel|betmgm|caesars|pinnacle|bet365|espn ?bet|fanatics|betrivers|pointsbet|bovada|circa|westgate)\b/i.exec(t);
    return userQuote({
      market: market, handicap: market === 'h2h' ? null : handicap,
      price_american: odds, book: bookM ? titleCase(bookM[1]) : null,
      text: t.slice(0, 200), now: o.now, team: o.team || null
    });
  }

  function userQuote(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var am = num(o.price_american);
    var dec = am == null ? null : americanToDec(am);
    return {
      schema: 'edgedesk_user_quote_v1',
      market: normMarket(o.market) || 'spreads',
      market_label: marketLabel(o.market) || 'Spread',
      team: o.team || null,
      handicap: num(o.handicap),
      price_american: am, price_decimal: dec,
      book: o.book || null,
      entered_at: new Date(now).toISOString(),
      source: 'reader',
      observed_by_edgedesk: false,
      provenance: 'A price the reader entered. EdgeDesk has not observed it, cannot timestamp it beyond the moment '
        + 'it was typed, and does not count it as a captured quote, as book coverage, or in any best-price claim.',
      verbatim: o.text || null
    };
  }

  /**
   * Compare a reader's price against the model and against what EdgeDesk has
   * actually observed — and refuse the comparisons the evidence cannot carry.
   *
   * THE REFUSAL IS THE POINT. A fair spread is not a cover probability. The
   * CFB spread model's own walk-forward record (49.9% ATS at one point of
   * disagreement, falling to 46.4% at six) is why `validationFor` caps it at
   * RESEARCH, and a number that cannot produce a probability cannot produce an
   * expected value or a price threshold either. What CAN be said is the line
   * difference, the price difference against an observed quote, and the
   * break-even the reader's own price implies — all of which are arithmetic.
   */
  function compareUserQuote(o) {
    o = o || {};
    var q = o.quote, out = { quote: q, comparisons: [], refused: [], schema: 'edgedesk_user_quote_compare_v1' };
    if (!q) return out;
    var val = o.validation || validationFor(o.sport || CFB_SPORT, q.market);
    var modelLine = num(o.model_line);              /* same convention as the quote */
    var observed = o.observed || null;              /* a row from marketBoard */

    if (modelLine != null && q.handicap != null) {
      var d = r2(Math.abs(modelLine - q.handicap));
      out.comparisons.push({
        id: 'model_vs_quote', label: 'Against EdgeDesk’s number',
        detail: 'EdgeDesk’s model line is ' + (modelLine > 0 ? '+' : '') + r2(modelLine)
          + ' and the price you have is ' + (q.handicap > 0 ? '+' : '') + q.handicap + ' — '
          + (d === 0 ? 'the same number.' : d + ' point' + (d === 1 ? '' : 's') + ' apart.'),
        points: d,
        basis: 'A difference between two numbers. It is not an edge, because the model that produced one of them '
          + 'has no validated outcome probability in this market.'
      });
    }
    if (observed && observed.price_american != null) {
      out.comparisons.push({
        id: 'quote_vs_observed', label: 'Against the best price EdgeDesk observed',
        detail: 'EdgeDesk’s best observed price on this selection is ' + observed.price_american
          + (observed.book ? ' at ' + observed.book : '')
          + (observed.handicap != null ? ' on ' + (observed.handicap > 0 ? '+' : '') + observed.handicap : '')
          + (observed.observed_at ? ', captured ' + (observed.freshness && observed.freshness.age_min != null
            ? Math.round(observed.freshness.age_min) + ' minutes ago' : 'earlier') : '')
          + '. Yours is ' + fmtAmerican(q.price_american)
          + (q.handicap != null ? ' on ' + (q.handicap > 0 ? '+' : '') + q.handicap : '') + '.',
        same_selection: observed.handicap != null && q.handicap != null && Math.abs(observed.handicap) === Math.abs(q.handicap),
        basis: 'Two prices, one observed by EdgeDesk and one reported by you. They are shown side by side and not '
          + 'merged: your price is not added to book coverage and does not change the best OBSERVED price.'
      });
    }
    if (q.price_decimal) {
      out.comparisons.push({
        id: 'break_even', label: 'What your price needs to break even',
        detail: 'At ' + fmtAmerican(q.price_american) + ' you need to win '
          + pct(breakEvenProb(q.price_decimal, 0), 1) + ' of the time to break even before any push.',
        break_even: r4(breakEvenProb(q.price_decimal, 0)),
        basis: 'Arithmetic on the price alone. It says nothing about whether this selection wins that often.'
      });
    }
    /* What cannot be computed, named rather than quietly skipped. */
    if (!val || val.probability !== true) {
      out.refused.push({
        id: 'cover_probability',
        why: 'EdgeDesk cannot give you a cover probability or an expected value on this. Its ' + (marketLabel(q.market) || 'market')
          + ' model is validated at ' + ((val && val.tier) || 'RESEARCH') + ' — ' + ((val && val.limitations) || 'it has no validated outcome probability in this market')
          + ' — and a fair spread on its own establishes neither. Quoting one would be inventing the number this '
          + 'system exists not to invent.'
      });
    }
    return out;
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
  /* ====================================================================== */
  /* WHEN A RATING WAS TRUE, WHICH IS NOT THE SAME AS WHAT IT SAYS NOW       */
  /*                                                                        */
  /* The packets attach each previous opponent's SP+ rating so a 45-point    */
  /* win can be read against who it came against. That rating comes from     */
  /* cfb.ratings, whose key is (season, team): ONE row per program per       */
  /* season, carrying where the rating stands NOW. There is no week column   */
  /* and no as-of column, so this database holds no historical version of a  */
  /* rating at all.                                                          */
  /*                                                                        */
  /* That makes the number a RETROSPECTIVE assessment, and it is a perfectly */
  /* good one for the question "how good was that opponent, really?" -- it   */
  /* has more information than any contemporary rating did. It is the WRONG  */
  /* number for "what did EdgeDesk know at the time", and attaching it to a  */
  /* past recommendation as though it had been available then is lookahead   */
  /* wearing a timestamp. Both readings are legitimate; conflating them is   */
  /* not, so the basis travels with the number.                              */
  /* ====================================================================== */

  var RATING_TIME_BASES = ['AS_ASSESSED_NOW', 'AT_THE_TIME', 'UNKNOWN'];

  /**
   * Describe the time basis of a rating attached to a past event.
   *
   * @param o.basis        'AS_ASSESSED_NOW' | 'AT_THE_TIME' | 'UNKNOWN'
   * @param o.source       where the rating came from
   * @param o.event_when   the date of the thing the rating is attached to
   * @param o.for_evaluation  true when this feeds a backtest or a graded record
   */
  function ratingTimeBasis(o) {
    o = o || {};
    var basis = RATING_TIME_BASES.indexOf(o.basis) >= 0 ? o.basis : 'UNKNOWN';
    var src = clean(o.source) || 'the ratings source';
    var when = clean(o.event_when);
    var now = basis === 'AS_ASSESSED_NOW';
    return {
      basis: basis,
      source: src,
      /* The one thing a consumer must not do with a retrospective rating. */
      usable_for_reading_a_past_result: basis !== 'UNKNOWN',
      usable_for_leakage_free_evaluation: basis === 'AT_THE_TIME',
      sentence: now
        ? 'This opponent rating is SP+ AS IT STANDS NOW, from ' + src + ', not as it stood '
          + (when ? 'on ' + when : 'at the time of that game') + '. '
          + 'It is keyed on (season, team) with no week and no as-of column, so this database carries no '
          + 'historical version of it. Read it as "how good was that opponent, really" -- a question it '
          + 'answers better than any contemporary rating could, because it has seen the whole season. '
          + 'It is NOT what EdgeDesk knew at the time and must not be used to judge a past recommendation '
          + 'as though it had been.'
        : basis === 'AT_THE_TIME'
          ? 'This opponent rating is the version that was current ' + (when ? 'on ' + when : 'at the time of that game')
            + ', from ' + src + ', so it is what was actually knowable then.'
          : 'The time basis of this rating is unknown, so it may be neither a contemporary view nor a '
            + 'reliable retrospective one. It is not used to evaluate a past recommendation.',
      evaluation_note: o.for_evaluation && basis !== 'AT_THE_TIME'
        ? 'EXCLUDED FROM ANY LEAKAGE-FREE CLAIM: a retrospective rating attached to a past decision is '
          + 'information that did not exist when the decision was made. Any accuracy figure computed with it '
          + 'is optimistic by an unknown amount and may not be described as out-of-sample.'
        : null
    };
  }

  function validateNoLookahead(row) {
    var pub = toMs(row && row.published_at);
    var kick = toMs(row && row.kickoff);
    var problems = [];
    if (pub == null) problems.push('no publication timestamp, so it cannot be shown to precede the event');
    if (kick != null && pub != null && pub > kick) problems.push('published after kickoff');
    if (row && row.mode === 'BACKTEST') problems.push('a backtest, which is measured in its own population');
    var closeAt = toMs(row && row.closing_captured_at);
    if (closeAt != null && pub != null && closeAt < pub) problems.push('graded against a closing price captured before publication');
    /* A clean timestamp is not a clean evaluation. A row whose EVIDENCE carries
       ratings as they stand now was judged with information that did not exist
       when it was published, and no timestamp check can see that. */
    var rb = row && row.rating_time_basis;
    if (rb && rb !== 'AT_THE_TIME') {
      problems.push('evaluated against opponent ratings ' + (rb === 'AS_ASSESSED_NOW'
        ? 'as they stand NOW rather than as they stood at the time'
        : 'of unknown vintage') + ', which is information that was not available when it was published');
    }
    return {
      clean: problems.length === 0,
      problems: problems,
      leakage_free: problems.length === 0,
      why: problems.length ? 'Excluded from the forward record: ' + problems.join('; ') + '.' : null
    };
  }

  /* ==================================================================
     WHO IS THE READER ASKING ABOUT?

     The website used to answer this question nowhere. app.html's chat had
     three routes — a daily-scan follow-up, a loaded signal, or "the board" —
     and a question that named a team matched none of them, so it fell to the
     board. The board is whatever card is loaded, which in September is
     baseball. "How does Texas State look this week?" therefore arrived at the
     reasoning function as an MLB board packet with no football anywhere in
     it, and every symptom followed from that one routing decision: the sport
     came back baseball, "Texas" was resolved against the only team list in
     scope (MLB clubs), the research was about starting pitchers, and the
     decision card belonged to a Padres game.

     So resolution happens HERE, in the kernel both the browser and the edge
     function already load, against the card the site itself publishes. No
     second alias table: resolveTeam and TEAM_ALIASES above are the same ones
     the board joins its market with.
     ================================================================== */

  /* Words that are never part of a school name, trimmed from the ENDS of a
     candidate phrase. Deliberately not applied in the middle — "Miami of
     Ohio" and "Texas A and M" keep their connectives. */
  var NOT_A_NAME = {};
  ('a an the is it its was are am do does did how what which who whom whose why when where '
    + 'this that these those there here look looks looking looked play plays playing played '
    + 'week weekend tonight today tomorrow season game games matchup matchups line lines odds '
    + 'price prices spread total bet bets betting worth anything something nothing good bad '
    + 'about against over under vs versus at on in for of and or but so if then than i we you '
    + 'they them their my me us he she his her think thinks thought like likes want need have '
    + 'has had be been being get gets got make makes made take takes took give gives gave say '
    + 'says said tell tells told show shows showed any some all both each few more most other '
    + 'such only own same too very can will just should now next last first second '
    + 'were been being had having could would might must shall may who whom whose whats hows '
    + 'anything something nothing everything anyone someone everybody nobody').split(/\s+/)
    .forEach(function (w) { NOT_A_NAME[w] = 1; });

  /* A single word only counts as a team when the writer capitalised it, or
     when nothing in the sentence is capitalised and capitalisation therefore
     carries no signal at all. Without this rule an ordinary sentence
     containing "army", "rice" or "temple" names a football team. */
  function soloAllowed(word, text) {
    if (!word || word.length < 3) return false;
    if (/^[A-Z]/.test(word)) return true;
    return !/[A-Z]/.test(String(text || ''));
  }

  /* Capitalised runs that LOOK like a proper name, whether or not this card
     knows them. Used for one thing only: telling "who have they played?"
     (which names nobody, so the conversation's subject stands) apart from
     "what about the Padres?" (which names somebody else, so it must not be
     answered as the football game that was under discussion). A question in
     all lower case yields nothing here, because capitalisation carries no
     signal in it and guessing would be worse than declining. */
  /* A CONTRACTION IS THE SAME ORDINARY WORD. "What's the line?" was reading as
     a question about somebody called What's — the apostrophe form was not in
     the stop list — so a market follow-up dropped the subject the conversation
     had just established. Strip the clitic before the lookup rather than
     enumerating every contraction. */
  function plainWord(w) {
    return String(w == null ? '' : w).toLowerCase()
      .replace(/n['’]t$/, '').replace(/['’](s|re|ve|ll|d|m)$/, '').replace(/[^a-z]/g, '');
  }
  function isFiller(w) { var k = plainWord(w); return !k || !!NOT_A_NAME[k]; }

  function nameCandidates(text) {
    var raw = String(text == null ? '' : text);
    if (!/[A-Z]/.test(raw)) return [];
    var out = [], seen = {};
    var re = /([A-Z][A-Za-z'&.()-]*(?:[ ](?:of|and|de|the)?[ ]?[A-Z][A-Za-z'&.()-]*)*)/g, m;
    while ((m = re.exec(raw)) != null) {
      var words = m[1].split(/\s+/);
      while (words.length && isFiller(words[0])) words = words.slice(1);
      while (words.length && isFiller(words[words.length - 1])) words = words.slice(0, -1);
      if (!words.length) continue;
      var phrase = words.join(' ');
      if (words.length === 1 && phrase.length < 3) continue;
      /* A SENTENCE-INITIAL SINGLE WORD IS GRAMMAR, NOT A NAME, and no stop
         list can be relied on to know which words those are. "What's the
         line?" and "Were those teams any good?" each broke the carried subject
         once, because each begins with a capitalised word that happened not to
         be in the list; the answer is not a longer list, it is that this test
         is structural. It is safe because this function is only consulted
         AFTER the card resolver has found nothing: a sentence-initial word
         that really is a team ("Oregon looks good?") has already resolved and
         never reaches here. */
      var before = raw.slice(0, m.index).replace(/\s+$/, '');
      var initial = !before || /[.!?]$/.test(before);
      /* TWO TESTS, EACH COVERING THE OTHER'S GAP. The first word of the whole
         message is dropped outright when it stands alone — it is the one
         position where capitalisation is pure grammar. A word opening a LATER
         sentence is only dropped when the stop list agrees it is ordinary, so
         "Forget that. Padres tonight?" still changes the subject while
         "Who have they played? Were those any good?" does not. Neither test
         alone was enough: the stop list missed "Were", and position alone
         would have swallowed a real name. */
      if (words.length === 1 && (!before || (initial && isFiller(phrase)))) continue;
      var k = phrase.toLowerCase();
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(phrase);
    }
    return out.slice(0, 6);
  }

  /**
   * Every team named in a piece of text, LONGEST NAME FIRST.
   *
   * This is the rule the brief asks for in one line: "Texas State" must not
   * become "Texas". A phrase is tested at every length from four words down
   * to one and the longest hit wins its words outright, so the two-word
   * school is found before the one-word school that is a prefix of it, and
   * "North Texas vs Texas State" yields both programs rather than one team
   * twice. Only exact, alias and St./State expansions count — a loose prefix
   * match on a bare word is precisely how a college question ends up on a
   * professional club.
   *
   * @param text  the reader's question
   * @param ix    a resolver index (fbsIndexFor / teamIndex)
   * @returns [{phrase, key, name, how, start, end}] in reading order
   */
  function teamPhrases(text, ix) {
    var raw = String(text == null ? '' : text);
    if (!raw.trim() || !ix) return [];
    var words = raw.split(/[\s]+/).map(function (w) {
      return w.replace(/^[^A-Za-z0-9'&.()-]+/, '').replace(/[^A-Za-z0-9'&.()-]+$/, '');
    });
    var taken = {}, found = [], MAXN = 4, n, i, j, phrase, r, blocked, ok;
    for (n = MAXN; n >= 1; n--) {
      for (i = 0; i + n <= words.length; i++) {
        blocked = false;
        for (j = i; j < i + n; j++) if (taken[j] || !words[j]) { blocked = true; break; }
        if (blocked) continue;
        /* Ordinary words are trimmed from both ends of a MULTI-word window,
           which is how "does Texas State" becomes "Texas State" without a
           separate pass; a window that is all filler is skipped. */
        var a = i, b = i + n - 1;
        while (a <= b && isFiller(words[a])) a++;
        while (b >= a && isFiller(words[b])) b--;
        if (b < a || (b - a + 1) !== n) continue;     /* trimmed: a shorter window will catch it */
        phrase = words.slice(a, b + 1).join(' ');
        if (n === 1 && !soloAllowed(phrase, raw)) continue;
        if (n === 1 && isFiller(phrase)) continue;
        r = resolveTeam(phrase, ix);
        ok = r && r.key && (r.how === 'exact' || r.how === 'alias' || r.how === 'state-expansion');
        if (!ok) continue;
        for (j = a; j <= b; j++) taken[j] = 1;
        found.push({ phrase: phrase, key: r.key, name: (r.team && r.team.name) || phrase, how: r.how, start: a, end: b });
      }
    }
    found.sort(function (x, y) { return x.start - y.start; });
    return found;
  }

  /* AN EXPLICIT MATCHUP, whether or not this card knows either side. "A vs B"
     is a claim about a specific game, so two sides that resolve to nothing are
     a matchup EdgeDesk does not carry — a thing to ask about — and NOT a
     wandering subject to be quietly dropped. Those are different answers and
     the difference has to survive into the state below. */
  var MATCHUP_LEAD = /^(?:analyz|analys|compar|previewi?|research|break down|look at|tell me about|show me|explain|give me|what about|how about|thoughts on|take on)\w*\s+/i;
  function matchupPair(text) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!t) return [];
    var SIDE = "[A-Z][A-Za-z'&.()-]*(?:[ -](?:of|and|&|the|at)?[ ]?[A-Z][A-Za-z'&.()-]*)*";
    var m = new RegExp('(' + SIDE + ')\\s+(?:versus|vs\\.?|@|at)\\s+(' + SIDE + ')').exec(t);
    if (!m) return [];
    function cut(v) { return v.replace(MATCHUP_LEAD, '').replace(/[.,;:!?]+$/, '').trim(); }
    var a = cut(m[1]), b = cut(m[2]);
    if (!a || !b || normName(a) === normName(b)) return [];
    if (a.split(' ').length > 5 || b.split(' ').length > 5) return [];
    return [a, b];
  }

  var MATCHUP_STATES = {
    RESOLVED: 'a named team was found on the published card',
    AMBIGUOUS: 'the team plays more than one game in this window',
    NOT_ON_CARD: 'the team resolved but plays no game in the published window',
    NONE_NAMED: 'the question named no team this card knows',
    SUBJECT_CHANGED: 'the question named somebody this card does not carry, so the previous subject does not stand',
    NO_CARD: 'the published card could not be read, so absence cannot be claimed'
  };

  /**
   * Resolve the matchup a question is about, against a published slate.
   *
   * PURE. The caller supplies the games — the browser from the static slate
   * artifact it already publishes, the edge function from the same artifact
   * through its DAL — so there is one resolution rule and one alias table for
   * both, and a test can drive it with the real card and no network.
   *
   * Precedence, in the order the brief sets out:
   *   1. two teams named in THIS question that share a scheduled game
   *   2. one team named in THIS question with exactly one game in the window
   *   3. the subject the conversation already established (`carried`)
   * A board that happens to be open is NOT consulted here and cannot win: an
   * MLB tab must not override an explicit college football matchup.
   *
   * @param o.question  the reader's text
   * @param o.games     [{game_id, home_team, away_team, home_id, away_id, kickoff, week}]
   * @param o.carried   a previous resolution to fall back to on a follow-up
   * @param o.card_error  why the card could not be read, if it could not
   */
  /* The CFB wording, kept verbatim as the default so a college answer reads
     exactly as it did before this card carried two leagues. */
  var CFB_CARD = {
    sport: CFB_SPORT, source: 'football/fbs/slate.json',
    card: 'the FBS slate', card_the: 'the published FBS card',
    programme: 'a college football program on the card EdgeDesk publishes',
    on_card: 'is on the FBS card but has no game inside the published window.',
    off_card: 'is not on the published FBS card',
    sport_note: 'The SPORT is settled — this is a college football question and must not be answered from any other '
      + 'sport\u2019s board — but the GAME is not. Ask which one is meant, in one short sentence, and do not pick.'
  };
  var NFL_CARD = {
    sport: NFL_SPORT, source: 'the NFL board',
    card: 'the NFL card', card_the: 'the NFL card',
    programme: 'an NFL club on the card EdgeDesk publishes',
    on_card: 'is an NFL club but has no game inside the published window.',
    off_card: 'is not on the NFL card',
    sport_note: 'The SPORT is settled — this is an NFL question and must not be answered from any other '
      + 'sport\u2019s board — but the GAME is not. Ask which one is meant, in one short sentence, and do not pick.'
  };
  function cardFor(sport) { return String(sport || '') === NFL_SPORT ? NFL_CARD : CFB_CARD; }

  function resolveOnCard(o) {
    o = o || {};
    var CARD = o.card_spec || CFB_CARD;
    var SPORT = CARD.sport, SOURCE = o.source || CARD.source;
    var games = o.games || [], question = String(o.question == null ? '' : o.question);
    var carried = o.carried && o.carried.game_id ? o.carried : null;
    var none = {
      state: 'NONE_NAMED', named: [], sport: null, game_id: null, home: null, away: null,
      home_id: null, away_id: null, kickoff: null, week: null, subject: null, subject_id: null,
      source: null, how: null, note: null, candidates: null
    };
    if (!games.length) {
      if (o.card_error) {
        return Object.assign({}, none, {
          state: 'NO_CARD', sport: SPORT, note: CARD.card_the + ' could not be read (' + o.card_error
            + '), so EdgeDesk cannot tell whether that game exists. This is a retrieval failure, '
            + 'not a finding that the matchup is absent, and may not be reported as one.'
        });
      }
      return carried ? Object.assign({}, carried, { how: 'carried' }) : none;
    }
    var rows = games.map(function (g) {
      return {
        game_id: String(g.game_id == null ? '' : g.game_id),
        home_team: String(g.home_team == null ? '' : g.home_team),
        away_team: String(g.away_team == null ? '' : g.away_team),
        home_key: canonKey(g.home_id != null ? g.home_id : g.home_team_id, g.home_team),
        away_key: canonKey(g.away_id != null ? g.away_id : g.away_team_id, g.away_team),
        kickoff: g.kickoff || null, week: g.week == null ? null : g.week
      };
    });
    var ix = footballIndexFor(SPORT, games.map(function (g) {
      return {
        home_team: g.home_team, away_team: g.away_team,
        home_id: g.home_id != null ? g.home_id : g.home_team_id,
        away_id: g.away_id != null ? g.away_id : g.away_team_id
      };
    }));
    var named = teamPhrases(question, ix);
    function hit(row, how, subject) {
      /* HOW MUCH OF THE QUESTION THIS MATCH ACTUALLY USED. Within one card the
         longest name already wins, because teamPhrases takes its words
         outright. Across two cards nothing compared them, so "Washington
         Commanders" — two words on the NFL card — tied with "Washington", one
         word on the college card, and a settled question came back as an
         ambiguity. The same rule, applied at the same place it always was. */
      var matched = subject ? subject.phrase : null;
      if (!matched && named.length) {
        matched = named.map(function (t) { return t.phrase; }).join(' ');
      }
      return {
        state: 'RESOLVED', named: named.map(function (t) { return t.phrase; }),
        matched_phrase: matched,
        matched_words: matched ? clean(matched).split(/\s+/).length : 0,
        matched_chars: matched ? clean(matched).replace(/\s+/g, '').length : 0,
        sport: SPORT, game_id: row.game_id,
        home: row.home_team, away: row.away_team, home_id: row.home_key, away_id: row.away_key,
        kickoff: row.kickoff, week: row.week, subject: subject ? subject.name : null,
        subject_id: subject ? subject.key : null,
        source: SOURCE, how: how, note: null, candidates: null
      };
    }
    /* ---- 1. two named teams that share a game ---------------------- */
    var i, j, a, b, k;
    for (i = 0; i < named.length; i++) {
      for (j = i + 1; j < named.length; j++) {
        a = named[i]; b = named[j];
        for (k = 0; k < rows.length; k++) {
          if ((rows[k].home_key === a.key && rows[k].away_key === b.key)
            || (rows[k].home_key === b.key && rows[k].away_key === a.key)) return hit(rows[k], 'both-teams-named', null);
        }
      }
    }
    /* ---- 1b. AN EXPLICIT PAIR IS ANSWERED AS A PAIR, OR NOT AT ALL ----
       "Texas State vs Boise State" names a specific game. When no such game is
       on the card, resolving it to Texas State's OTHER game is substitution —
       the reader is handed a different matchup under the name of the one they
       asked for, which is the exact failure this whole resolver exists to
       stop. Step 2 below is for a question that named ONE team; a question
       that named two and matched none stops here. */
    var explicit = matchupPair(question);
    if (explicit.length === 2) {
      return Object.assign({}, none, {
        state: 'NOT_ON_CARD', named: explicit, sport: null,
        source: SOURCE,
        note: '"' + explicit[0] + '" and "' + explicit[1] + '" were named as a matchup, and no scheduled game '
          + 'with BOTH of those sides is on any card EdgeDesk publishes (' + rows.length
          + ' games were checked on ' + CARD.card + ').'
      });
    }

    /* ---- 2. one named team with exactly one game in the window -----
       Every named team is tried before any of them is reported as absent: a
       question that names a program on the card and one that is not ("Texas
       State against somebody") must answer about the one that is playing,
       not stop at the first name that missed. */
    var ambiguous = null, offCard = null;
    for (i = 0; i < named.length; i++) {
      var subj = named[i];
      var mine = rows.filter(function (r) { return r.home_key === subj.key || r.away_key === subj.key; });
      /* A PROGRAM PLAYING TWICE IS NOT AMBIGUOUS IF THE CONVERSATION ALREADY
         PICKED ONE. "How does Texas State look now?" on turn four names the
         same team and means the same game; asking which one again would be
         the resolver forgetting what it just answered. */
      if (mine.length > 1 && carried) {
        var same = mine.filter(function (r) { return r.game_id === String(carried.game_id); });
        if (same.length === 1) return hit(same[0], 'carried-subject-named', subj);
      }
      if (mine.length === 1) return hit(mine[0], 'one-team-named', subj);
      if (mine.length > 1 && !ambiguous) {
        ambiguous = Object.assign({}, none, {
          state: 'AMBIGUOUS', named: [subj.phrase], sport: SPORT,
          subject: subj.name, subject_id: subj.key, source: SOURCE,
          candidates: mine.map(function (r) {
            return { game_id: r.game_id, home: r.home_team, away: r.away_team, kickoff: r.kickoff };
          }),
          note: '"' + subj.phrase + '" is ' + CARD.programme + ', and it '
            + 'appears in ' + mine.length + ' scheduled games in this window ('
            + mine.map(function (r) { return r.away_team + ' @ ' + r.home_team; }).join(', ') + '). '
            + CARD.sport_note
        });
      } else if (!mine.length && !offCard) {
        /* Resolved to a real program that is not playing inside the window. */
        offCard = Object.assign({}, none, {
          state: 'NOT_ON_CARD', named: [subj.phrase], sport: SPORT,
          subject: subj.name, subject_id: subj.key, source: SOURCE,
          note: subj.phrase + ' ' + CARD.on_card
        });
      }
    }
    if (ambiguous) return ambiguous;
    if (offCard) return offCard;
    /* ---- 2b. an explicit "A vs B" whose sides this card does not know -
       Step 1b above catches a pair whose names DID resolve. This catches the
       pair whose names resolved to nothing at all, which is the same answer
       for a different reason: ask, never substitute. */
    var pair = matchupPair(question);
    if (pair.length === 2) {
      return Object.assign({}, none, {
        state: 'NOT_ON_CARD', named: pair, sport: null,
        source: SOURCE,
        note: '"' + pair[0] + '" and "' + pair[1] + '" were named as a matchup, and no scheduled game with '
          + 'BOTH of those sides is on any card EdgeDesk publishes (' + rows.length
          + ' games were checked on ' + CARD.card + ').'
      });
    }
    /* ---- 3. the subject the conversation already established -------
       A follow-up names nobody, so the subject stands. A question that names
       SOMEBODY ELSE — a club from another sport, a player, a program this
       card does not carry — must not be answered as the game that happened to
       be under discussion, which is the same "whatever is loaded wins" bug
       one turn later. */
    var other = nameCandidates(question).filter(function (p) {
      var r = resolveTeam(p, ix);
      return !(r && r.key && (r.how === 'exact' || r.how === 'alias' || r.how === 'state-expansion'));
    });
    if (carried && !other.length) {
      /* THE TRACE MUST NOT CLAIM THIS WAS NAMED IN THIS MESSAGE. It is the
         subject the conversation is on, which is a true and different thing,
         and a reader of the trace should be able to tell them apart. */
      return Object.assign({}, carried, {
        how: 'carried', named: [],
        source: String(carried.source || SOURCE).replace(/ \(carried subject\)$/, '')
          + ' (carried subject)',
      });
    }
    if (other.length) {
      return Object.assign({}, none, {
        state: 'SUBJECT_CHANGED', named: other,
        note: other[0] + ' ' + CARD.off_card + ', so this is not a follow-up about '
          + (carried ? (carried.away + ' @ ' + carried.home) : 'the previous subject') + '.'
      });
    }
    return none;
  }

  /**
   * The college card, resolved exactly as it always was.
   *
   * Kept as its own entry point because every existing caller, test and
   * fixture speaks it, and because a one-league question should not have to
   * describe a league to be answered.
   */
  function resolveMatchup(o) {
    o = o || {};
    return resolveOnCard({
      question: o.question, games: o.games, carried: o.carried,
      card_error: o.card_error, source: o.source, card_spec: o.card_spec || CFB_CARD
    });
  }

  /**
   * THE WHOLE FOOTBALL BOARD, RESOLVED ONCE.
   *
   * The reader's football page carries college and professional games side by
   * side. A desk that resolves only one of them reports "no such game" about a
   * fixture the page behind it is displaying — which is the board/desk split
   * that started this work, one league over.
   *
   * Each league is resolved on its OWN card with its OWN index, and the
   * results are then combined under a stated precedence:
   *
   *   1. exactly one league resolved a game the question NAMED  -> that game
   *   2. more than one did                                       -> ASK, with
   *      both candidates listed. A name that is a college programme AND an NFL
   *      city ("Washington", "Houston", "Miami") is a real ambiguity, and
   *      picking one silently is how a reader gets the wrong team's number.
   *   3. a league knows the team but not which game                -> ASK
   *   4. a league knows the team and it is not playing             -> say so
   *   5. the subject the conversation already established          -> stands
   *   6. the question named somebody no card carries               -> hand back
   *
   * `carried` is only ever offered to the league it belongs to. A carried
   * college subject cannot resolve against the NFL card and must not look as
   * though it did.
   *
   * @param o.question   the reader's text
   * @param o.leagues    [{sport, games, source, card_error}]
   * @param o.carried    a previous resolution, with its own `sport`
   */
  function resolveFootballMatchup(o) {
    o = o || {};
    var leagues = (o.leagues || []).filter(function (L) { return L && (L.games || L.card_error); });
    if (!leagues.length) leagues = [{ sport: CFB_SPORT, games: o.games || [], card_error: o.card_error || null }];
    var carried = o.carried && o.carried.game_id ? o.carried : null;
    var carriedSport = carried ? (carried.sport || CFB_SPORT) : null;

    var runs = leagues.map(function (L) {
      var spec = L.card_spec || cardFor(L.sport);
      return {
        league: L, spec: spec,
        r: resolveOnCard({
          question: o.question, games: L.games || [],
          carried: (carriedSport && String(L.sport || CFB_SPORT) === String(carriedSport)) ? carried : null,
          card_error: L.card_error || null, source: L.source, card_spec: spec
        })
      };
    });

    function pick(fn) { for (var i = 0; i < runs.length; i++) if (fn(runs[i].r)) return runs[i].r; return null; }

    /* 1 & 2 — a game NAMED in this question. `carried-subject-named` counts:
       the reader said the team out loud, and the conversation only decided
       WHICH of that team's games was meant. */
    var named = runs.filter(function (x) { return x.r.state === 'RESOLVED' && x.r.how !== 'carried'; });
    if (named.length === 1) return named[0].r;
    if (named.length > 1) {
      /* THE LONGEST NAME WINS, ACROSS CARDS AS WELL AS WITHIN ONE. A reader
         who wrote "Washington Commanders" named a club, and a college card
         that also answers to "Washington" has not matched what they wrote. It
         is only an ambiguity when the two cards matched the SAME words. */
      var best = named.slice().sort(function (a, b) {
        return (b.r.matched_words || 0) - (a.r.matched_words || 0)
          || (b.r.matched_chars || 0) - (a.r.matched_chars || 0);
      });
      if ((best[0].r.matched_words || 0) > (best[1].r.matched_words || 0)
        || ((best[0].r.matched_words || 0) === (best[1].r.matched_words || 0)
          && (best[0].r.matched_chars || 0) > (best[1].r.matched_chars || 0))) return best[0].r;
      named = best;
      return {
        state: 'AMBIGUOUS', named: named[0].r.named || [], sport: null,
        game_id: null, home: null, away: null, home_id: null, away_id: null,
        kickoff: null, week: null, subject: named[0].r.subject || null, subject_id: null,
        source: 'the football board', how: 'two-leagues', ambiguous_leagues: true,
        candidates: named.map(function (x) {
          return { game_id: x.r.game_id, home: x.r.home, away: x.r.away, kickoff: x.r.kickoff,
            sport: x.r.sport, league: x.r.sport === NFL_SPORT ? 'NFL' : 'college football' };
        }),
        note: 'That name belongs to a team in more than one league on EdgeDesk’s football board ('
          + named.map(function (x) { return (x.r.sport === NFL_SPORT ? 'NFL: ' : 'college: ') + x.r.away + ' @ ' + x.r.home; }).join('; ')
          + '). The SPORT is not settled, so the game is not either. Ask which one is meant and do not pick.'
      };
    }
    /* 3, 4 — the team resolved, the game did not. */
    var amb = pick(function (r) { return r.state === 'AMBIGUOUS'; });
    if (amb) return amb;
    var off = pick(function (r) { return r.state === 'NOT_ON_CARD' && r.subject; });
    if (off) return off;
    /* 5 — the subject the conversation is already on. */
    var held = pick(function (r) { return r.how === 'carried'; });
    if (held) return held;
    /* An explicit "A vs B" neither card carries. */
    var pair = pick(function (r) { return r.state === 'NOT_ON_CARD'; });
    if (pair) return pair;
    /* 6 — somebody else was named, on EVERY card. One league not knowing a
       name proves nothing; all of them not knowing it is the finding. */
    var changed = runs.filter(function (x) { return x.r.state === 'SUBJECT_CHANGED'; });
    if (changed.length && changed.length === runs.length) return changed[0].r;
    var noCard = pick(function (r) { return r.state === 'NO_CARD'; });
    if (noCard) return noCard;
    return runs[0].r;
  }

  /* ====================================================================== */
  /* WHAT THE NUMBERS MEAN, AND HOW THE GAME PRODUCES THEM                  */
  /*                                                                        */
  /* The ratings build already publishes, per team and per metric, the RAW  */
  /* rate, the OPPONENT-ADJUSTED rate, the league mean, the sample it rests */
  /* on and a reliability weight. Nothing read it: the desk printed a       */
  /* ratings table and left the reader to supply the football.              */
  /*                                                                        */
  /* This dictionary is the missing half. Every entry says what the metric  */
  /* IS in ordinary language and, separately, the MECHANISM by which it     */
  /* shows up on a field — because "Texas Tech is 1.4 z above the mean in   */
  /* sack rate allowed" is not analysis and "their protection holds, so     */
  /* they reach third-and-short instead of third-and-long" is.              */
  /*                                                                        */
  /* It is a dictionary and not a model. No entry here moves any number.    */
  /* ====================================================================== */
  var METRIC_FAMILIES = {
    efficiency: 'staying on schedule',
    passing: 'the passing game',
    rushing: 'the running game',
    disruption: 'pressure and negative plays',
    finishing: 'finishing drives',
    turnovers: 'turnovers'
  };

  function met(id, o) { o.id = id; return o; }
  var METRIC_DICTIONARY = {};
  (function () {
    var D = [
      met('success_rate', { unit: 'rate', family: 'efficiency', side: 'offense', counter: 'def_success_allowed',
        label: 'Success rate',
        plain: 'the share of plays that keep an offence on schedule — roughly half the yards needed on first down, '
          + 'seventy per cent on second, and all of them on third or fourth.',
        mechanism: 'An offence that stays on schedule keeps facing second-and-five instead of second-and-nine, and '
          + 'third-and-short instead of third-and-long. Third-and-long is where sacks, pressure and interceptions '
          + 'concentrate, so success rate moves the whole rest of the drive.' }),
      met('early_down_success', { unit: 'rate', family: 'efficiency', side: 'offense', counter: 'def_early_down_allowed',
        label: 'Early-down success',
        plain: 'success rate on first and second down only.',
        mechanism: 'First and second down are the downs a coach CHOOSES; third down is mostly the consequence. A team '
          + 'that wins early downs is calling from its whole playbook, and the defence cannot commit to a rush.' }),
      met('explosive_pass_rate', { unit: 'rate', family: 'passing', side: 'offense', counter: 'def_explosive_pass_allowed',
        label: 'Explosive pass rate',
        plain: 'the share of dropbacks that gain a chunk — the big plays rather than the steady ones.',
        mechanism: 'College scoring margin comes disproportionately from explosives. One of them replaces a whole '
          + 'drive of successful plays, which is why a defence that gives them up can hold a good success rate and '
          + 'still lose the scoreboard.' }),
      met('yards_per_attempt', { unit: 'yards', family: 'passing', side: 'offense', counter: 'def_yards_per_attempt',
        label: 'Yards per pass attempt',
        plain: 'passing yards divided by attempts — the volume-free measure of how far the passing game moves the ball.',
        mechanism: 'It separates an offence that throws a lot from one that throws well. A high number against a '
          + 'defence that concedes one is the single most direct route to points.' }),
      met('explosive_rush_rate', { unit: 'rate', family: 'rushing', side: 'offense', counter: 'def_explosive_rush_allowed',
        label: 'Explosive rush rate',
        plain: 'the share of carries that break for a chunk.',
        mechanism: 'Breakaway running is a front-and-second-level failure, not a yards-per-carry story. A defence that '
          + 'concedes them is being beaten after the line of scrimmage, which safeties and pursuit angles decide.' }),
      met('sack_rate_allowed', { unit: 'rate', family: 'disruption', side: 'offense', counter: 'def_sack_rate',
        label: 'Sack rate allowed', invert: true,
        plain: 'the share of dropbacks that end in a sack — protection and the quarterback’s pocket management together.',
        mechanism: 'A sack is a drive-killer twice over: the yardage and the down. An offence that protects turns '
          + 'third-and-seven into third-and-three; one that does not is pushed into the exact down-and-distance '
          + 'where the defence already has the advantage.' }),
      met('yards_per_rush', { unit: 'yards', family: 'rushing', side: 'offense', counter: 'def_yards_per_rush',
        label: 'Yards per carry',
        plain: 'rushing yards divided by attempts.',
        mechanism: 'The blunt measure of whether the run game works against this front. It is noisier than success '
          + 'rate because one long run moves it, which is why both are read together rather than either alone.' }),
      met('third_success', { unit: 'rate', family: 'efficiency', side: 'offense', counter: 'def_third_allowed',
        label: 'Third-down conversion',
        plain: 'the share of third downs converted.',
        mechanism: 'Largely a consequence of the first two downs rather than a skill of its own, so a third-down number '
          + 'that disagrees with early-down success is usually distance, not clutch.' }),
      met('stuff_rate', { unit: 'rate', family: 'disruption', side: 'offense', counter: 'def_stuff_rate',
        label: 'Stuff rate (runs stopped at or behind the line)', invert: true,
        plain: 'the share of carries stopped at or behind the line of scrimmage.',
        mechanism: 'The clearest read on whether a line is being beaten at the point of attack. A stuffed run on first '
          + 'down produces exactly the long-yardage down a defence wants.' }),
      met('rz_success', { unit: 'rate', family: 'finishing', side: 'offense', counter: 'def_rz_allowed',
        label: 'Red-zone success',
        plain: 'how well an offence converts trips inside the twenty into points.',
        mechanism: 'The field shortens and explosives disappear, so finishing is a different skill from moving the '
          + 'ball. A team that moves well and finishes badly leaves points on the field that the margin will show.' }),
      met('turnover_rate', { unit: 'rate', family: 'turnovers', side: 'offense', counter: 'def_turnovers_forced',
        label: 'Turnover rate', invert: true,
        plain: 'giveaways per play.',
        mechanism: 'The least repeatable thing on this list. It decides games and predicts them badly, so it is read '
          + 'as something that HAPPENED rather than as something a team reliably does.' })
    ];
    var DEF = {
      def_success_allowed: ['Success rate allowed', 'the share of opponent plays that stayed on schedule.'],
      def_early_down_allowed: ['Early-down success allowed', 'opponent success rate on first and second down.'],
      def_explosive_pass_allowed: ['Explosive passes allowed', 'the share of opponent dropbacks that broke for a chunk.'],
      def_yards_per_attempt: ['Yards per attempt allowed', 'opponent passing yards per attempt.'],
      def_explosive_rush_allowed: ['Explosive runs allowed', 'the share of opponent carries that broke for a chunk.'],
      def_sack_rate: ['Sack rate', 'the share of opponent dropbacks this defence sacks.'],
      def_yards_per_rush: ['Yards per carry allowed', 'opponent rushing yards per carry.'],
      def_third_allowed: ['Third downs allowed', 'the share of opponent third downs converted.'],
      def_stuff_rate: ['Stuff rate', 'the share of opponent carries stopped at or behind the line.'],
      def_rz_allowed: ['Red zone allowed', 'how well opponents finish trips inside the twenty.'],
      def_turnovers_forced: ['Turnovers forced', 'takeaways per opponent play.']
    };
    D.forEach(function (m) {
      METRIC_DICTIONARY[m.id] = m;
      var c = m.counter, d = DEF[c];
      if (c && d) {
        METRIC_DICTIONARY[c] = met(c, {
          unit: m.unit, family: m.family, side: 'defense', counter: m.id,
          label: d[0], plain: d[1], mechanism: m.mechanism
        });
      }
    });
    /* The sub-unit metrics carry the same meanings under shorter ids. */
    var SUB = { po_success: 'success_rate', po_explosive: 'explosive_pass_rate', po_ypa: 'yards_per_attempt',
      po_sacks: 'sack_rate_allowed', pd_success: 'def_success_allowed', pd_explosive: 'def_explosive_pass_allowed',
      pd_ypa: 'def_yards_per_attempt', pd_sacks: 'def_sack_rate',
      ro_success: 'success_rate', ro_explosive: 'explosive_rush_rate', ro_ypc: 'yards_per_rush',
      ro_stuffed: 'stuff_rate', rd_success: 'def_success_allowed', rd_explosive: 'def_explosive_rush_allowed',
      rd_ypc: 'def_yards_per_rush', rd_stuffed: 'def_stuff_rate' };
    Object.keys(SUB).forEach(function (k) {
      var base = METRIC_DICTIONARY[SUB[k]];
      if (base) METRIC_DICTIONARY[k] = met(k, { unit: base.unit, family: base.family, side: base.side,
        label: base.label, plain: base.plain, mechanism: base.mechanism, alias_of: SUB[k] });
    });
  })();

  /** The reader-facing meaning of a metric, or null rather than a guess. */
  function explainMetric(id) { return METRIC_DICTIONARY[String(id || '')] || null; }

  /* ====================================================================== */
  /* THE SAMPLE, LABELLED FOR WHAT IT IS                                    */
  /*                                                                        */
  /* The ratings build weights a game against a non-FBS opponent at 0.45 of */
  /* an FBS one, so a team that has played one of each carries 1.45. The    */
  /* desk printed that as "1.45 games in the rating", which reads as an     */
  /* arithmetic error rather than as a weighted sample size. It is a real   */
  /* number with a real meaning and it needs its name.                      */
  /* ====================================================================== */
  var NON_FBS_GAME_WEIGHT = 0.45;
  function sampleRead(o) {
    o = o || {};
    var eff = num(o.effective_games);
    var played = num(o.games_played);
    var fbs = num(o.fbs_games);
    var share = num(o.non_fbs_share);
    if (eff == null) {
      return { effective_games: null, label: null, missing: true,
        reason: 'the ratings build published no sample count for this team' };
    }
    var whole = Math.abs(eff - Math.round(eff)) < 1e-9;
    var nonFbs = (played != null && fbs != null) ? Math.max(0, played - fbs) : null;
    var label = eff + ' FBS-equivalent game' + (eff === 1 ? '' : 's');
    var expl = 'Effective sample size, not a count of games. EdgeDesk weights a game against a non-FBS opponent at '
      + NON_FBS_GAME_WEIGHT + ' of an FBS game, because that opponent pool is solved as a single team and one result '
      + 'against it says much less about where a team sits among FBS teams.';
    if (played != null) {
      expl += ' ' + played + ' game' + (played === 1 ? '' : 's') + ' played'
        + (nonFbs ? (', ' + nonFbs + ' of them against a non-FBS opponent') : '')
        + ' — so the rating is leaning on ' + label + ' of evidence.';
    }
    return {
      effective_games: eff, games_played: played, fbs_games: fbs,
      non_fbs_games: nonFbs, non_fbs_share: share,
      whole_number: whole,
      label: label,
      short: label,
      explanation: expl,
      /* What the weight buys the reader: how much of the rating is this
         season at all. The ramp is w = g/(g+k) with k = 3. */
      prior_weight: r2(3 / (eff + 3)),
      performance_weight: r2(eff / (eff + 3)),
      weight_basis: 'The rating mixes a preseason prior with this season’s play on a continuous ramp, '
        + 'w = g/(g+3) in FBS-equivalent games. At ' + eff + ' that is '
        + Math.round((eff / (eff + 3)) * 100) + '% this season and '
        + Math.round((3 / (eff + 3)) * 100) + '% preseason prior — which is why an early-season rating moves so '
        + 'little on one result, and why it should not be read as a settled measurement of this team.',
      source: o.source || 'football/rankings/current.json'
    };
  }

  /* ====================================================================== */
  /* THE RATING, INTERPRETED                                                */
  /* ====================================================================== */
  function ratingRead(o) {
    o = o || {};
    var t = o.team_record || null;
    if (!t) return null;
    var etsr = num(t.etsr);
    var rank = num(t.rank != null ? t.rank : (t.ranks && t.ranks.overall && t.ranks.overall.rank));
    var conf = t.confidence ? num(t.confidence.value) : null;
    var perf = t.performance || {};
    var sample = sampleRead({
      effective_games: (t.weights && num(t.weights.games_used)) != null ? num(t.weights.games_used)
        : (perf.sample ? num(perf.sample.fbs_equivalent_games) : null),
      games_played: perf.sample ? num(perf.sample.games_played) : null,
      fbs_games: perf.sample ? num(perf.sample.fbs_games) : null,
      non_fbs_share: perf.sample ? num(perf.sample.non_fbs_share) : null,
      source: o.source
    });
    var gates = (t.gates || []).map(function (g) {
      return { id: g.id, severity: g.severity, detail: g.detail || null, basis: g.basis || null };
    });
    /* RATED BUT UNRANKED IS NOT UNRATED. The build holds a team out of the
       national rank when its confidence gate fires, and the artifact says why.
       Printed as a dash, that reads as "EdgeDesk has nothing on this team",
       which is a different and worse claim than the true one. */
    var rankNote = null;
    if (rank == null) {
      var ro = t.ranks && t.ranks.overall;
      rankNote = (ro && ro.reason) ? String(ro.reason)
        : (etsr != null ? 'rated, but held out of the national rank by the confidence gate' : 'no rating was published for this team');
    }
    return {
      team: t.team || o.team || null,
      etsr: etsr, rank: rank, ranked_of: num(o.ranked_of), rank_note: rankNote,
      conference: t.conference || null,
      meaning: etsr == null ? null
        : 'ETSR is points against an average FBS team on a neutral field: '
          + (etsr >= 0 ? '+' : '') + r2(etsr) + ' means EdgeDesk would make them '
          + Math.abs(r2(etsr)) + ' point' + (Math.abs(r2(etsr)) === 1 ? '' : 's') + ' '
          + (etsr >= 0 ? 'better' : 'worse') + ' than that average team before home field, travel or rest. '
          + 'It is a rating, not a spread: two ratings subtracted give a neutral-field margin, which is where a '
          + 'projection starts and not where it ends.',
      confidence: conf,
      confidence_meaning: conf == null ? null
        : 'Confidence is how much EdgeDesk KNOWS about this team, not how good they are — '
          + Math.round(conf * 100) + '% here. A +8 at 40% and a +8 at 90% are different statements and this system '
          + 'never merges them.',
      sample: sample,
      units: {
        offense: num(perf.offense), defense: num(perf.defense), special_teams: num(perf.special_teams),
        run_offense: num(perf.run_offense), pass_offense: num(perf.pass_offense),
        run_defense: num(perf.run_defense), pass_defense: num(perf.pass_defense),
        scale: 'Unit ratings are on a 0-100 scale where 50 is the FBS average and higher is better, including for '
          + 'defence — a defence rated 64 is a good defence, not a bad one.'
      },
      opponent_adjusted: true,
      adjustment_note: 'Every unit number here is opponent-adjusted: the build compares what a team did against what '
        + 'its specific opponents usually concede. The raw rate and the adjusted rate are both published, and where '
        + 'they disagree the difference is the schedule.',
      achievement: t.achievement ? { state: t.achievement.state, basis: t.achievement.basis } : null,
      gates: gates,
      source: o.source || 'football/rankings/current.json'
    };
  }

  /* ====================================================================== */
  /* THE DRIVERS — ONE SIDE'S UNIT AGAINST THE UNIT THAT HAS TO STOP IT     */
  /*                                                                        */
  /* Built ONLY from pairs where both halves cleared their own observation  */
  /* floor in the ratings build. A driver that rests on one side's number   */
  /* and a guess about the other is exactly the "two results against        */
  /* different opponents" inference this must not make.                     */
  /* ====================================================================== */
  function detailIndex(team) {
    var ix = {};
    if (!team) return ix;
    var p = team.performance || {};
    [p.offense_detail, p.defense_detail].forEach(function (d) {
      if (!d || !d.used) return;
      d.used.forEach(function (u) { ix[u.id] = u; });
    });
    Object.keys(p.sub_units || {}).forEach(function (k) {
      (p.sub_units[k].used || []).forEach(function (u) { if (!ix[u.id]) ix[u.id] = u; });
    });
    return ix;
  }

  function fmtMetric(v, unit) {
    var n2 = num(v);
    if (n2 == null) return null;
    if (unit === 'rate') return (n2 * 100).toFixed(1) + '%';
    return n2.toFixed(2);
  }
  /* THE OPPONENT ADJUSTMENT IS LINEAR AND A RATE IS NOT. A team that has faced
     one front and given up nothing can come out of the adjustment below zero,
     and "-2.2% of dropbacks" is not a thing that happened. The z is still the
     right ordering - it is what the build ranks on - so the RAW rate is what
     gets printed and the adjustment is reported as a direction. Clamping the
     number to 0 and printing it as though it were measured would be worse: it
     would look like a fact. */
  function metricShow(u, unit) {
    var adj = num(u.adjusted), raw = num(u.raw);
    var out = { raw: fmtMetric(raw, unit), adjusted: fmtMetric(adj, unit), league: fmtMetric(u.league, unit),
      z: r2(num(u.z)), plays: num(u.n_obs), weighted_plays: num(u.n), out_of_range: false };
    if (unit === 'rate' && adj != null && (adj < 0 || adj > 1)) {
      out.out_of_range = true;
      out.show = out.raw;
      out.show_basis = 'raw rate: the opponent adjustment put the adjusted figure outside the range a rate can take ('
        + out.adjusted + '), so the measured number is shown and the adjustment is reported as direction only';
    } else {
      out.show = out.adjusted != null ? out.adjusted : out.raw;
      out.show_basis = out.adjusted != null ? 'opponent-adjusted' : 'raw rate - no adjusted figure was published';
    }
    return out;
  }

  /**
   * Up to `limit` matchup drivers, strongest first, one per football family.
   *
   * @param o.attacker / o.defender   rating records, the artifact's own shape
   * @param o.attacker_name / o.defender_name
   * @param o.min_reliability   both sides must clear this (default 0.35)
   */
  function matchupDrivers(o) {
    o = o || {};
    var A = o.attacker, B = o.defender;
    var aName = o.attacker_name || (A && A.team) || 'the offence';
    var bName = o.defender_name || (B && B.team) || 'the defence';
    var limit = num(o.limit) != null ? num(o.limit) : 3;
    var minRel = num(o.min_reliability) != null ? num(o.min_reliability) : 0.35;
    if (!A || !B) return { drivers: [], missing: [{ field: 'matchup_drivers', reason: 'a rating record is missing for one side, so no unit pair can be compared' }] };
    var ai = detailIndex(A), bi = detailIndex(B), out = [], skipped = [];

    Object.keys(METRIC_DICTIONARY).forEach(function (id) {
      var m = METRIC_DICTIONARY[id];
      if (m.side !== 'offense' || m.alias_of || !m.counter) return;
      var off = ai[id], def = bi[m.counter];
      if (!off || !def) {
        skipped.push({ id: id, reason: !off ? aName + ' has no published ' + m.label.toLowerCase()
          : bName + ' has no published ' + (METRIC_DICTIONARY[m.counter] || {}).label });
        return;
      }
      var zo = num(off.z), zd = num(def.z);
      if (zo == null || zd == null) { skipped.push({ id: id, reason: 'one side cleared no observation floor on this metric' }); return; }
      var rel = Math.min(num(off.reliability) == null ? 1 : num(off.reliability), num(def.reliability) == null ? 1 : num(def.reliability));
      if (rel < minRel) { skipped.push({ id: id, reason: 'the sample behind it is too thin to read (reliability ' + r2(rel) + ')' }); return; }
      /* Both z values are already direction-corrected by the build, so higher
         is better FOR THAT UNIT on every metric. The attacker's advantage is
         therefore the simple difference. */
      var adv = zo - zd;
      var w = num(off.w) == null ? 0.1 : num(off.w);
      out.push({
        id: id, family: m.family, family_label: METRIC_FAMILIES[m.family] || m.family,
        label: m.label, plain: m.plain, mechanism: m.mechanism,
        attacker: aName, defender: bName,
        advantage_z: r2(adv), advantage_side: adv >= 0 ? 'attacker' : 'defender',
        weight: w, reliability: r2(rel),
        strength: Math.abs(adv) * w * rel,
        defender_label: (METRIC_DICTIONARY[m.counter] || {}).label || m.label,
        attacker_value: metricShow(off, m.unit),
        defender_value: metricShow(def, m.unit),
        opponent_adjustment: {
          attacker_delta: fmtMetric(off.delta, m.unit), defender_delta: fmtMetric(def.delta, m.unit),
          note: 'The adjusted figure is what the build makes of the raw one after the opponents faced. Where the two '
            + 'differ, the difference IS the schedule.'
        },
        source: o.source || 'football/rankings/current.json'
      });
    });

    out.sort(function (x, y) { return y.strength - x.strength; });
    /* One per family, so three passing metrics do not become three drivers. */
    var seen = {}, picked = [];
    out.forEach(function (d) {
      if (picked.length >= limit || seen[d.family]) return;
      seen[d.family] = 1; picked.push(d);
    });
    picked.forEach(function (d) {
      var favoured = d.advantage_side === 'attacker' ? d.attacker : d.defender;
      var mag = Math.abs(d.advantage_z);
      var word = mag >= 1.5 ? 'a wide gap' : mag >= 0.8 ? 'a clear gap' : mag >= 0.3 ? 'a modest gap' : 'close to level';
      d.gap_word = word;
      d.statement = d.attacker + ' ' + d.label.toLowerCase() + ' ' + d.attacker_value.show
        + ' (league ' + d.attacker_value.league + ') against ' + d.defender + ' '
        + d.defender_label.toLowerCase() + ' ' + d.defender_value.show
        + ' (league ' + d.defender_value.league + ') \u2014 ' + word
        + (mag < 0.3 ? '.' : ' in ' + favoured + '\u2019s favour.');
      if (d.attacker_value.out_of_range || d.defender_value.out_of_range) {
        d.statement += ' One of these is the raw rate: the opponent adjustment put it outside the range a rate can '
          + 'take, so the measured number is shown rather than an impossible one.';
      }
      d.reading = d.mechanism;
    });
    return {
      drivers: picked, considered: out.length, skipped: skipped.slice(0, 12),
      basis: 'Each driver is one side’s unit against the unit that has to stop it, from opponent-adjusted rates '
        + 'the ratings build published for BOTH sides. A pair where either half cleared no observation floor is '
        + 'skipped and named rather than half-answered.',
      contract: 'These explain the matchup. They do not move EdgeDesk’s number: the projection comes from the '
        + 'validated engine and nothing here is added to it.'
    };
  }

  /* ====================================================================== */
  /* AVAILABILITY, IN ONE LINE FOR THE READER AND IN FULL FOR AN OPERATOR   */
  /*                                                                        */
  /* availabilityRead() produces the whole finding, including the source    */
  /* counts. Printed in full, under both teams, on every answer, it is the  */
  /* caveat wall the research is supposed to be replacing - and "276 failed */
  /* source reads" is an operator's number, not a reader's. So the finding  */
  /* is unchanged and the PRESENTATION is split: a short state, one short   */
  /* reason, and the diagnostics behind a fold.                             */
  /*                                                                        */
  /* UNKNOWN NEVER BECOMES HEALTHY. That is the one thing this split may    */
  /* not cost, so may_claim_healthy travels with the headline.              */
  /* ====================================================================== */
  var AVAIL_HEADLINES = {
    VERIFIED_FLAGS: 'Reported',
    PARTIAL: 'Partly reported',
    NO_REPORTED_INJURIES: 'Clean official report',
    UNKNOWN: 'Not reported',
    NOT_RETRIEVED: 'Not retrieved'
  };
  function availabilityHeadline(read) {
    if (!read) {
      return { state: 'NOT_RETRIEVED', label: 'Not retrieved', short: 'EdgeDesk did not read an availability record for this team on this turn.',
        may_claim_healthy: false, operator: null, tone: 'unknown' };
    }
    var st = read.state, counts = read.counts || {};
    var flagged = num(counts.flagged) || 0, records = num(counts.records) || 0;
    var short;
    if (st === 'VERIFIED_FLAGS' || st === 'PARTIAL') {
      short = records + ' player' + (records === 1 ? '' : 's') + ' carried an availability note'
        + (flagged ? ', ' + flagged + ' of them in doubt' : '')
        + '. Anyone not named is unreported, which is not the same as fit.';
    } else if (st === 'NO_REPORTED_INJURIES') {
      short = 'An official report was read and listed nobody. This is the only case where "no reported injuries" is a fact.';
    } else if (st === 'UNKNOWN') {
      short = 'No availability record is on file. That is unknown, not healthy.';
    } else {
      short = 'No availability record was retrieved on this turn. That is a retrieval result, not a medical one.';
    }
    if (read.stale && read.artifact_age_hours != null) {
      short += ' The build is ' + read.artifact_age_hours + 'h old, so read it as history.';
    }
    return {
      state: st, label: AVAIL_HEADLINES[st] || st, short: short,
      may_claim_healthy: read.may_claim_healthy === true,
      tone: st === 'NO_REPORTED_INJURIES' ? 'ok' : (st === 'VERIFIED_FLAGS' || st === 'PARTIAL') ? 'note' : 'unknown',
      players: (read.players || []).slice(0, 12),
      /* An operator's number, kept out of the reader's way and not deleted. */
      operator: {
        sources_checked: read.sources_checked, sources_failed: read.sources_failed,
        data_quality: read.data_quality, official_report_found: read.official_report_found,
        artifact_age_hours: read.artifact_age_hours, stale: read.stale,
        full_sentence: read.sentence, source: read.source
      }
    };
  }

  /* ====================================================================== */
  /* THE CASE AGAINST                                                        */
  /*                                                                        */
  /* Ordered by what it would COST to be wrong about, not by how easy it is  */
  /* to say. Every item names the evidence it rests on, so a reader can go   */
  /* and check it rather than take it.                                       */
  /* ====================================================================== */
  function counterCase(o) {
    o = o || {};
    var out = [];
    function add(id, weight, headline, detail, evidence) {
      out.push({ id: id, weight: weight, headline: headline, detail: detail, evidence: evidence || null });
    }
    var R = o.research || {}, board = o.market_board || null;
    var subj = o.subject || R.subject || 'this team', opp = o.opponent || R.opponent || 'the opponent';

    /* 1. The model's own record. The largest structural argument there is. */
    var val = o.validation || validationFor(o.sport || R.sport || CFB_SPORT, 'spreads');
    if (val && val.max_decision === 'WATCH') {
      add('model_validation', 100,
        'EdgeDesk’s number is not evidence that the market is wrong.',
        'In this market the model is validated at ' + val.tier + ': ' + val.limitations
        + ' A gap between it and the price is a research lead, not an edge, and it gets LESS reliable as it gets bigger.',
        { source: 'EDINTEL.MODEL_VALIDATION', field: 'validation_summary.market' });
    }
    /* 2. A thin effective sample on either side. */
    [['subject', o.subject_sample, subj], ['opponent', o.opponent_sample, opp]].forEach(function (p) {
      var s2 = p[1];
      if (!s2 || s2.effective_games == null) return;
      if (s2.effective_games < 3) {
        add('thin_sample_' + p[0], 90 - s2.effective_games,
          p[2] + '’s rating is mostly preseason prior, not this season.',
          s2.label + ' of evidence puts roughly ' + Math.round((s2.prior_weight || 0) * 100)
          + '% of the rating on the preseason prior. Every unit number below inherits that, so a driver built on '
          + 'it is a statement about what EdgeDesk expected as much as about what has happened.',
          { source: s2.source, field: 'weights.games_used' });
      }
    });
    /* 3. Availability unknown. Never softened, never converted. */
    ['home', 'away'].forEach(function (side) {
      var h = o.availability && o.availability[side];
      if (!h) return;
      if (h.state === 'UNKNOWN' || h.state === 'NOT_RETRIEVED') {
        add('availability_' + side, 80,
          'Nobody has been confirmed available for ' + (h.team || side) + '.',
          h.short + ' A starter could be out and EdgeDesk would not know. This is the largest unmodelled input in '
          + 'college football and it is unknown here, not clean.',
          { source: (h.operator && h.operator.source) || 'football/availability/current.json' });
      } else if (h.state === 'VERIFIED_FLAGS' || h.state === 'PARTIAL') {
        add('availability_' + side, 70,
          'There are availability notes on ' + (h.team || side) + '.',
          h.short + ' EdgeDesk does not move its projection on them, so whatever they are worth is not in the number.',
          { source: (h.operator && h.operator.source) || 'football/availability/current.json' });
      }
    });
    /* 4. The market disagrees, and the market is the better forecaster here. */
    if (o.model_margin != null && o.market_margin != null) {
      var gap = Math.abs(num(o.model_margin) - num(o.market_margin));
      if (gap >= (CONFIG.disagreement_points || 3)) {
        add('market_disagreement', 85,
          'The market is ' + r2(gap) + ' points away from EdgeDesk, and the market has the better record here.',
          'Against the closing line this model does not win, and its ATS record gets WORSE as the disagreement '
          + 'widens. A gap this size is more often a fault in EdgeDesk’s inputs than a mispriced game, which is '
          + 'why a large gap raises research priority and can never raise a recommendation.',
          { source: 'EDINTEL.MODEL_VALIDATION', field: 'ats_vs_close' });
      }
    }
    /* 5. The strongest driver, pointed the other way. */
    (o.drivers || []).forEach(function (d, i) {
      if (i > 0) return;
      if (!d || Math.abs(d.advantage_z) < 0.3) return;
      add('driver_reversed', 60,
        'The read leans on one unit matchup that a small sample could reverse.',
        d.statement + ' It rests on ' + (d.attacker_value.plays || '?') + ' and '
        + (d.defender_value.plays || '?') + ' observed plays with a reliability of ' + d.reliability
        + '. At that sample the ordering is real and the SIZE of it is not settled.',
        { source: d.source, field: d.id });
    });
    /* 6. The price itself. */
    if (board && board.status) {
      if (board.status.state === 'STALE') {
        add('stale_price', 75,
          'The price this rests on is past its freshness limit.',
          board.status.user, { source: 'captured signals' });
      } else if (board.status.state === 'LINE_ONLY') {
        add('no_executable_price', 65,
          'There is a number but nothing to bet into.',
          board.status.user, { source: 'cfb.lines' });
      } else if (board.status.state === 'NO_QUOTE' || board.status.is_edgedesk_fault) {
        add('no_price', 60, 'There is no price to test this against.', board.status.user, null);
      }
    }
    /* 7. Distance from kickoff. */
    var kick = toMs(o.kickoff), now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    if (kick != null && kick > now) {
      var hrs = Math.round((kick - now) / 3600e3);
      if (hrs >= 48) {
        add('time_to_kickoff', 40,
          'Kickoff is ' + hrs + ' hours away.',
          'Most of the information that will move this number - availability, weather and late money - has not '
          + 'arrived yet. A conclusion taken now is a conclusion taken on less than will be available.', null);
      }
    }
    out.sort(function (a, b) { return b.weight - a.weight; });
    return {
      strongest: out.length ? out[0] : null,
      others: out.slice(1),
      all: out,
      basis: 'Ordered by what it would cost to be wrong about, not by how easy it is to say. Every item names the '
        + 'evidence it rests on.'
    };
  }

  /* ====================================================================== */
  /* WHAT WOULD CHANGE THE ASSESSMENT                                       */
  /*                                                                        */
  /* Falsifiers only: each one is a thing that can actually be observed and */
  /* that would move the read if it were. "More information" is not on this */
  /* list, because it is not checkable.                                     */
  /* ====================================================================== */
  function whatWouldChange(o) {
    o = o || {};
    var out = [], board = o.market_board || null;
    function add(id, kind, text, watch) { out.push({ id: id, kind: kind, text: text, watch: watch || null }); }

    var cur = o.market_row || (board && board.spreads && board.spreads.current);
    if (cur && cur.handicap != null) {
      add('line_move', 'price',
        'The handicap moving off ' + (cur.handicap > 0 ? '+' : '') + cur.handicap
        + '. A point either way changes which side the comparison favours, and EdgeDesk re-reads the price on every '
        + 'turn rather than reusing the one above.',
        { market: 'spreads', handicap: cur.handicap, book: cur.book });
    } else if (board && board.status && board.status.state !== 'LIVE') {
      add('price_appears', 'price',
        'A book posting a price at all. There is nothing to compare the model against until one does, and EdgeDesk '
        + 'will not invent one from the other side of a handicap.', null);
    }
    ['home', 'away'].forEach(function (side) {
      var h = o.availability && o.availability[side];
      if (h && (h.state === 'UNKNOWN' || h.state === 'NOT_RETRIEVED')) {
        add('availability_' + side, 'information',
          'An availability report landing for ' + (h.team || side) + '. Unknown is doing real work in this read, and '
          + 'a named starter either way would move it more than any number below.', null);
      }
    });
    (o.drivers || []).slice(0, 2).forEach(function (d) {
      add('driver_' + d.id, 'evidence',
        'Another game’s worth of ' + d.label.toLowerCase() + '. At reliability ' + d.reliability
        + ' the ordering is established and the margin is not; one more opponent would settle it either way.',
        { metric: d.id });
    });
    var samp = o.subject_sample;
    if (samp && samp.effective_games != null && samp.effective_games < 4) {
      add('sample_grows', 'evidence',
        'The rating passing about four FBS-equivalent games, which is where this season overtakes the preseason '
        + 'prior in the ramp. Until then the rating is describing expectation as much as evidence.', null);
    }
    if (o.weather_missing) {
      add('weather', 'information',
        'A wind or precipitation read at kickoff. EdgeDesk has none for this game, and wind is the one weather '
        + 'variable that reliably moves a total.', null);
    }
    return { items: out, basis: 'Each is observable. A thing EdgeDesk cannot check is not a falsifier and is not listed.' };
  }

  /* ====================================================================== */
  /* KICKOFF, WITH ITS TIMEZONE                                             */
  /* A time with no zone on it is a time somebody will read wrongly, and a  */
  /* reader in Lubbock and a reader in Boston do not have the same 7pm.     */
  /* ====================================================================== */
  function kickoffText(iso, tz) {
    var ms = toMs(iso);
    if (ms == null) return null;
    var d = new Date(ms);
    try {
      var opt = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
      if (tz) opt.timeZone = tz;
      return d.toLocaleString('en-US', opt).replace(/,\s*(?=\d?\d:)/, ' ');
    } catch (_) { return d.toISOString(); }
  }

  /* ====================================================================== */
  /* THE MATCHUP BRIEF - the default answer to "how does X look this week?"  */
  /*                                                                        */
  /* The old card answered with a ratings table and a wall of caveats. A     */
  /* reader asking about a matchup wants, in this order: what this game IS,  */
  /* the two numbers, three reasons rooted in football, the best reason to   */
  /* disbelieve it, and what would change it. Everything else is depth and   */
  /* belongs behind a fold.                                                  */
  /*                                                                         */
  /* NOTHING HERE COMPUTES A FOOTBALL NUMBER. Every figure is read from      */
  /* matchupResearch (the model artifact), marketBoard (captured prices) or  */
  /* the ratings build. This function ORDERS and EXPLAINS them, which is     */
  /* exactly the boundary the model guardrails draw.                         */
  /* ====================================================================== */
  var BRIEF_SCHEMA = 'edgedesk_matchup_brief_v1';

  function matchupBrief(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var R = o.research || {};
    var board = o.market_board || null;
    var subj = R.subject || null, opp = R.opponent || null;
    var subjIsHome = R.subject_is_home !== false;
    var id = R.identity || {};
    var f = function (x) { return (x && !x.missing) ? x.value : null; };

    var subjRec = subjIsHome ? o.home_record : o.away_record;
    var oppRec = subjIsHome ? o.away_record : o.home_record;
    var subjRating = subjRec ? ratingRead({ team_record: subjRec, ranked_of: o.ranked_of, source: o.ratings_source }) : null;
    var oppRating = oppRec ? ratingRead({ team_record: oppRec, ranked_of: o.ranked_of, source: o.ratings_source }) : null;

    /* BOTH DIRECTIONS. A matchup is two offences against two defences, and a
       read built from one of them is half a read. Each side contributes its
       own strongest unit pairs and the merged list is trimmed to `limit`. */
    var dSubj = matchupDrivers({ attacker: subjRec, defender: oppRec, attacker_name: subj, defender_name: opp,
      limit: 3, source: o.ratings_source });
    var dOpp = matchupDrivers({ attacker: oppRec, defender: subjRec, attacker_name: opp, defender_name: subj,
      limit: 3, source: o.ratings_source });
    var merged = [];
    (dSubj.drivers || []).forEach(function (d) { d.direction = 'subject_offense'; merged.push(d); });
    (dOpp.drivers || []).forEach(function (d) { d.direction = 'opponent_offense'; merged.push(d); });
    merged.sort(function (a, b) { return b.strength - a.strength; });
    /* BOTH OFFENCES GET A HEARING. Ranked purely on strength, one team's units
       can take all three slots, and a matchup read that never mentions what
       the other side does with the ball is half a read presented as a whole
       one. The strongest pair from each direction is seated first; the last
       slot goes to whatever is strongest overall. */
    var limitN = num(o.driver_limit) != null ? num(o.driver_limit) : 3;
    var drivers = [], famSeen = {}, dirSeen = {};
    function seat(d) {
      var k = d.family + '|' + d.direction;
      if (drivers.length >= limitN || famSeen[k]) return false;
      famSeen[k] = 1; dirSeen[d.direction] = 1; drivers.push(d); return true;
    }
    ['subject_offense', 'opponent_offense'].forEach(function (dir) {
      for (var i = 0; i < merged.length; i++) if (merged[i].direction === dir) { seat(merged[i]); return; }
    });
    merged.forEach(function (d) { if (drivers.indexOf(d) < 0) seat(d); });

    var avail = {
      home: availabilityHeadline(R.availability && R.availability.home),
      away: availabilityHeadline(R.availability && R.availability.away)
    };
    avail.home.team = f(id.home); avail.away.team = f(id.away);

    /* ---- the two numbers, in ONE convention, named --------------------- */
    var modelHomeLine = R.model ? f(R.model.home_line) : null;       /* betting: negative = home favourite */
    var marketHomeHandicap = null, marketRow = null;
    if (board && board.spreads && board.spreads.by_side && board.spreads.by_side.home) {
      marketRow = board.spreads.by_side.home;
      marketHomeHandicap = num(marketRow.handicap);
    } else if (board && board.spreads && board.spreads.by_side && board.spreads.by_side.away) {
      marketRow = board.spreads.by_side.away;
      marketHomeHandicap = num(marketRow.handicap) == null ? null : -num(marketRow.handicap);
    } else if (board && board.consensus && board.consensus.spread_home_handicap != null) {
      marketHomeHandicap = num(board.consensus.spread_home_handicap);
    } else if (R.market && f(R.market.spread) != null) {
      /* matchupResearch publishes the MARGIN convention; flip it to betting. */
      marketHomeHandicap = -num(f(R.market.spread));
    }
    /* A SPREAD IS QUOTED IN HALF POINTS. Reporting a difference to two
       decimals implies a precision neither number has, and reads as though
       the model were measuring something it is not. */
    function pt1(v) { var n2 = num(v); return n2 == null ? null : Math.round(n2 * 10) / 10; }
    var diff = (modelHomeLine != null && marketHomeHandicap != null) ? pt1(Math.abs(modelHomeLine - marketHomeHandicap)) : null;
    var comparison = null;
    if (diff != null) {
      var modelSide = modelHomeLine < marketHomeHandicap ? f(id.home) : modelHomeLine > marketHomeHandicap ? f(id.away) : null;
      comparison = {
        points: diff,
        model_home_line: modelHomeLine, market_home_handicap: marketHomeHandicap,
        model_leans: modelSide,
        convention: 'Both numbers are written the betting way: negative is the home side favoured by that many points.',
        meaning: diff === 0
          ? 'EdgeDesk and the market are on the same number.'
          : 'EdgeDesk’s number is ' + diff + ' point' + (diff === 1 ? '' : 's') + ' '
            + (modelSide ? 'toward ' + modelSide : 'away from the market')
            + '. That is a difference between two numbers and not an edge: in this market EdgeDesk’s model does '
            + 'not beat the closing line, and its record gets worse as the gap widens.'
      };
    }

    var counter = counterCase({
      research: R, market_board: board, drivers: drivers, subject: subj, opponent: opp,
      sport: R.sport, availability: avail,
      subject_sample: subjRating && subjRating.sample, opponent_sample: oppRating && oppRating.sample,
      model_margin: modelHomeLine == null ? null : -modelHomeLine,
      market_margin: marketHomeHandicap == null ? null : -marketHomeHandicap,
      kickoff: f(id.kickoff), now: now
    });
    var change = whatWouldChange({
      market_board: board, market_row: marketRow, availability: avail, drivers: drivers,
      subject_sample: subjRating && subjRating.sample,
      weather_missing: !o.weather, now: now
    });

    /* ---- the takeaway: description only, never a lean ------------------ */
    var when = kickoffText(f(id.kickoff), o.timezone);
    var lines = [];
    lines.push(subj + (subjIsHome ? ' host ' : ' visit ') + opp
      + (when ? ' on ' + when : '')
      + (f(id.venue) && subjIsHome ? ' at ' + f(id.venue) : '')
      + (f(id.week) != null ? ', week ' + f(id.week) : '') + '.');
    if (R.model && f(R.model.favourite)) {
      lines.push('EdgeDesk makes it ' + f(R.model.favourite) + ' by ' + pt1(f(R.model.by_points))
        + (f(R.model.fair_total) != null ? ', total ' + pt1(f(R.model.fair_total)) : '') + '.');
    } else {
      lines.push('EdgeDesk has no projection published for this game.');
    }
    if (marketRow && marketRow.price_american != null) {
      lines.push('The market has ' + (marketRow.side === 'home' ? f(id.home) : f(id.away)) + ' '
        + (marketRow.handicap > 0 ? '+' : '') + marketRow.handicap + ' at ' + marketRow.price_american
        + (marketRow.book ? ' (' + marketRow.book + ')' : '')
        + (marketRow.freshness && marketRow.freshness.age_min != null
          ? ', seen ' + Math.round(marketRow.freshness.age_min) + ' minutes ago' : '') + '.'
        + (comparison ? ' That is ' + comparison.points + ' point' + (comparison.points === 1 ? '' : 's')
          + ' from EdgeDesk’s number.' : ''));
    } else if (board && board.consensus && marketHomeHandicap != null) {
      lines.push('The only number on file is a consensus ' + (marketHomeHandicap > 0 ? '+' : '') + marketHomeHandicap
        + ' for ' + f(id.home) + ' - a reference with no book and no capture time, so it is not a price.');
    } else if (board && board.status) {
      lines.push(board.status.user);
    }
    if (drivers.length) lines.push('The matchup turns most on ' + drivers[0].family_label + ': ' + drivers[0].statement);

    return {
      schema: BRIEF_SCHEMA,
      built_at: new Date(now).toISOString(),
      game_id: R.game_id || null,
      sport: R.sport || CFB_SPORT,
      subject: subj, opponent: opp, subject_is_home: subjIsHome,
      takeaway: {
        text: lines.join(' '),
        lines: lines,
        basis: 'Description only. EdgeDesk’s model is not validated to a probability in this market, so the '
          + 'strongest thing this paragraph is allowed to do is describe.'
      },
      verified: {
        home: f(id.home), away: f(id.away),
        kickoff_iso: f(id.kickoff), kickoff_text: when,
        venue: f(id.venue), neutral_site: f(id.neutral_site),
        week: f(id.week), season: f(id.season),
        source: (id.home && id.home.source) || R.resolution && R.resolution.source || null
      },
      numbers: {
        model: R.model || null,
        market_row: marketRow, market_status: board ? board.status : null,
        consensus: board ? board.consensus : null,
        comparison: comparison
      },
      /* The full price board, carried so a renderer never has to go and get
         it a second time and risk showing a different number than the one the
         takeaway above was written from. */
      market_rows: board ? board.rows : [],
      market_coverage: board ? board.coverage : null,
      market_contract: board ? board.contract : null,
      resolution_how: R.resolution ? ((R.resolution.how || 'resolved') + ' from ' + (R.resolution.source || 'the published card')) : null,
      ratings: { subject: subjRating, opponent: oppRating },
      drivers: drivers,
      drivers_meta: { subject_offense: dSubj, opponent_offense: dOpp },
      counter: counter.strongest, counter_others: counter.others, counter_all: counter.all,
      what_would_change: change.items,
      availability: avail,
      previous_games: R.previous_games || null,
      /* ONE CAVEAT, ONCE. matchupResearch, counterCase and the availability
         headline all legitimately reach the same conclusion about the same
         gap; printing all three is the wall this is replacing. The counter
         case is the place a reader is told, so a limit already stated there
         is dropped from this list rather than repeated. */
      limits: uniq((R.limits || []).filter(function (l) {
        var t = String(l).toLowerCase();
        if (/availability for .* is unknown/.test(t) && (counter.all || []).some(function (c) { return /^availability_/.test(c.id); })) return false;
        if (/has not cleared validation/.test(t) && (counter.all || []).some(function (c) { return c.id === 'model_validation'; })) return false;
        return true;
      })),
      missing: R.missing || [],
      sources: uniq([
        R.resolution && R.resolution.source,
        (subjRating || oppRating) ? (o.ratings_source || 'football/rankings/current.json') : null,
        board && board.rows && board.rows.length ? 'captured signals' : null,
        board && board.consensus ? board.consensus.source : null,
        (R.availability && (R.availability.home || R.availability.away)) ? 'football/availability/current.json' : null,
        (R.previous_games && (R.previous_games.home || R.previous_games.away)) ? o.results_source || 'cfb.games' : null
      ].filter(Boolean)),
      contract: 'Facts, model output, and interpretation are separate fields and stay separate. `verified` is read '
        + 'from published artifacts, `numbers.model` is the tested engine’s own output, `drivers` and `counter` '
        + 'are interpretation built only from figures in this object, and nothing here produces a probability, an '
        + 'expected value or an adjustment.'
    };
  }

  /* ====================================================================== */
  /* SAVED RESEARCH                                                          */
  /*                                                                        */
  /* A RESEARCH SNAPSHOT IS NOT A WAGER, and this system keeps the two       */
  /* apart on purpose. `recommendation_ledger` records a decision EdgeDesk   */
  /* made and is the official performance record; a snapshot records what a  */
  /* READER was looking at when they saved it. Mixing them would let saved   */
  /* reading count as measured performance, which is the one thing the       */
  /* record must never absorb.                                              */
  /*                                                                        */
  /* It is frozen. A snapshot that changes is not a snapshot, so the         */
  /* pregame explanation is never rewritten after the result: a later view   */
  /* is a SECOND snapshot and the pair is what a comparison reads.           */
  /* ====================================================================== */
  var SNAPSHOT_SCHEMA = 'edgedesk_research_snapshot_v1';

  function snapshotDigest(o) {
    /* Small, stable, and dependency-free - the same idea the editorial
       snapshots use: a value identified by a hash of itself, so a snapshot
       that was edited stops matching its own id. */
    var s = JSON.stringify(o), h1 = 0x811c9dc5, h2 = 0x01000193, i;
    for (i = 0; i < s.length; i++) {
      h1 = (h1 ^ s.charCodeAt(i)) >>> 0;
      h1 = (h1 * 0x01000193) >>> 0;
      h2 = (h2 + s.charCodeAt(i) * (i + 7)) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  /**
   * Freeze one matchup's research.
   *
   * @param o.brief        a matchupBrief
   * @param o.model_version   the exact engine build the projection came from
   * @param o.question     what the reader asked
   * @param o.user_quote   a reader-entered price, if one was in play
   * @param o.note         the reader's own note
   * @param o.open_questions  what the reader still wants answered
   */
  function researchSnapshot(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var B = o.brief || {};
    var mrow = B.numbers && B.numbers.market_row;
    var body = {
      schema: SNAPSHOT_SCHEMA,
      kind: 'RESEARCH',
      saved_at: new Date(now).toISOString(),
      game_id: B.game_id || null,
      sport: B.sport || CFB_SPORT,
      matchup: (B.verified && B.verified.away ? B.verified.away + ' @ ' + B.verified.home : null),
      subject: B.subject || null, opponent: B.opponent || null,
      kickoff: B.verified ? B.verified.kickoff_iso : null,
      question: o.question || null,
      note: o.note || null,
      open_questions: (o.open_questions || []).slice(0, 12),
      /* WHAT THE NUMBERS WERE, EXACTLY, AND WHERE THEY CAME FROM. */
      model: {
        version: o.model_version || null,
        home_line: B.numbers && B.numbers.model ? (B.numbers.model.home_line || {}).value : null,
        fair_total: B.numbers && B.numbers.model ? (B.numbers.model.fair_total || {}).value : null,
        tier: B.numbers && B.numbers.model ? (B.numbers.model.tier || {}).value : null,
        data_completeness: B.numbers && B.numbers.model ? (B.numbers.model.data_completeness || {}).value : null
      },
      observed_price: mrow ? {
        market: mrow.market, selection: mrow.selection, side: mrow.side, handicap: mrow.handicap,
        price_american: mrow.price_american, book: mrow.book, observed_at: mrow.observed_at,
        books_quoting: mrow.books_quoting, source: 'captured signals',
        freshness_at_save: mrow.freshness ? mrow.freshness.status : null
      } : null,
      market_status: B.numbers && B.numbers.market_status ? B.numbers.market_status.state : null,
      consensus: B.numbers ? B.numbers.consensus : null,
      user_quote: o.user_quote || null,
      comparison: B.numbers ? B.numbers.comparison : null,
      drivers: (B.drivers || []).map(function (d) {
        return { id: d.id, family: d.family, direction: d.direction, statement: d.statement,
          advantage_z: d.advantage_z, reliability: d.reliability,
          attacker: d.attacker, defender: d.defender,
          attacker_value: d.attacker_value ? d.attacker_value.show : null,
          defender_value: d.defender_value ? d.defender_value.show : null };
      }),
      counter: B.counter ? { id: B.counter.id, headline: B.counter.headline, detail: B.counter.detail } : null,
      what_would_change: (B.what_would_change || []).map(function (c) { return { id: c.id, kind: c.kind, text: c.text }; }),
      availability: {
        home: B.availability && B.availability.home ? { state: B.availability.home.state, short: B.availability.home.short } : null,
        away: B.availability && B.availability.away ? { state: B.availability.away.state, short: B.availability.away.short } : null
      },
      ratings: {
        subject: B.ratings && B.ratings.subject ? { etsr: B.ratings.subject.etsr, rank: B.ratings.subject.rank,
          effective_games: B.ratings.subject.sample ? B.ratings.subject.sample.effective_games : null } : null,
        opponent: B.ratings && B.ratings.opponent ? { etsr: B.ratings.opponent.etsr, rank: B.ratings.opponent.rank,
          effective_games: B.ratings.opponent.sample ? B.ratings.opponent.sample.effective_games : null } : null
      },
      sources: B.sources || [],
      /* Said on the object itself so no consumer has to be trusted to know. */
      is_a_wager: false,
      record_note: 'A research snapshot. It is not a wager, it is not in EdgeDesk’s performance record, and it '
        + 'is never counted as one.'
    };
    body.id = snapshotDigest(body);
    return body;
  }

  /* What counts as a material change, and the size it has to reach. */
  var SNAPSHOT_DELTAS = { spread_points: 0.5, total_points: 1, price_american: 10, etsr_points: 1 };

  /**
   * What changed between a saved snapshot and a later one.
   *
   * ONLY FROM TWO OBSERVATIONS THAT EXIST. Where the earlier snapshot has no
   * price, this reports that there was nothing to compare rather than
   * inventing an opening number and a movement story to go with it.
   */
  function compareSnapshots(before, after, o) {
    o = o || {};
    var out = { schema: 'edgedesk_snapshot_diff_v1', before_id: before && before.id, after_id: after && after.id,
      before_at: before && before.saved_at, after_at: after && after.saved_at,
      changes: [], unchanged: [], gaps: [], material: false };
    if (!before || !after) { out.gaps.push('two snapshots are needed and only one was supplied'); return out; }
    if (before.game_id && after.game_id && String(before.game_id) !== String(after.game_id)) {
      out.gaps.push('these snapshots are of different games (' + before.game_id + ' vs ' + after.game_id
        + '), so nothing is compared. A change report across two fixtures would be meaningless.');
      return out;
    }
    function add(kind, field, headline, detail, material) {
      out.changes.push({ kind: kind, field: field, headline: headline, detail: detail, material: !!material });
      if (material) out.material = true;
    }

    /* ---- the market ---------------------------------------------------- */
    var pb = before.observed_price, pa = after.observed_price;
    if (!pb && !pa) {
      out.gaps.push('Neither reading carried a captured price, so there is no market movement to report. EdgeDesk '
        + 'does not reconstruct an opening line and will not narrate a move it did not observe.');
    } else if (!pb && pa) {
      add('market', 'observed_price', 'A price appeared.',
        'There was no captured price when this was saved. There is one now: ' + pa.price_american
        + (pa.book ? ' at ' + pa.book : '') + (pa.handicap != null ? ' on ' + (pa.handicap > 0 ? '+' : '') + pa.handicap : '')
        + '.', true);
    } else if (pb && !pa) {
      add('market', 'observed_price', 'The price is gone.',
        'A price was captured when this was saved (' + pb.price_american + (pb.book ? ' at ' + pb.book : '')
        + ') and no book EdgeDesk covers is quoting this selection now. That is an absence, not a move to zero.', true);
    } else {
      var dh = (num(pb.handicap) != null && num(pa.handicap) != null) ? r2(num(pa.handicap) - num(pb.handicap)) : null;
      if (dh != null && Math.abs(dh) >= SNAPSHOT_DELTAS.spread_points) {
        add('market', 'handicap', 'The number moved ' + Math.abs(dh) + ' point' + (Math.abs(dh) === 1 ? '' : 's') + '.',
          'From ' + (pb.handicap > 0 ? '+' : '') + pb.handicap + ' to ' + (pa.handicap > 0 ? '+' : '') + pa.handicap
          + ' on ' + (pa.selection || 'this selection') + '. Both are prices EdgeDesk observed, at '
          + (pb.observed_at || 'an unknown time') + ' and ' + (pa.observed_at || 'an unknown time') + '.', true);
      } else if (dh != null) {
        out.unchanged.push('The handicap is still ' + (pa.handicap > 0 ? '+' : '') + pa.handicap + '.');
      }
      var oldAm = num(String(pb.price_american).replace('+', '')), newAm = num(String(pa.price_american).replace('+', ''));
      if (oldAm != null && newAm != null && Math.abs(newAm - oldAm) >= SNAPSHOT_DELTAS.price_american) {
        add('market', 'price', 'The price moved.',
          'From ' + pb.price_american + ' to ' + pa.price_american
          + (pa.book && pb.book && pa.book !== pb.book ? ' (best book changed from ' + pb.book + ' to ' + pa.book + ')' : ''),
          true);
      }
      if (pb.freshness_at_save !== pa.freshness_at_save) {
        add('market', 'freshness', 'The quote’s freshness changed.',
          'It was ' + pb.freshness_at_save + ' and is now ' + pa.freshness_at_save + '.',
          pa.freshness_at_save === 'STALE');
      }
    }

    /* ---- the model ----------------------------------------------------- */
    var mb = (before.model || {}).home_line, ma = (after.model || {}).home_line;
    if (num(mb) != null && num(ma) != null && Math.abs(num(ma) - num(mb)) >= SNAPSHOT_DELTAS.spread_points) {
      add('model', 'home_line', 'EdgeDesk’s own number moved.',
        'From ' + r2(mb) + ' to ' + r2(ma) + ' (betting convention, negative is the home favourite).', true);
    }
    if ((before.model || {}).version && (after.model || {}).version
      && before.model.version !== after.model.version) {
      add('model', 'version', 'The model build changed.',
        'The saved reading came from ' + before.model.version + ' and this one from ' + after.model.version
        + '. Two builds are not the same forecaster and their numbers are not directly comparable.', true);
    }

    /* ---- availability --------------------------------------------------- */
    ['home', 'away'].forEach(function (side) {
      var b = before.availability && before.availability[side], a = after.availability && after.availability[side];
      if (!b || !a) return;
      if (b.state !== a.state) {
        add('availability', side, 'Availability for the ' + side + ' side changed state.',
          'It was ' + b.state + ' and is now ' + a.state + '. ' + (a.short || ''), true);
      }
    });

    /* ---- the ratings ---------------------------------------------------- */
    ['subject', 'opponent'].forEach(function (k) {
      var b = before.ratings && before.ratings[k], a = after.ratings && after.ratings[k];
      if (!b || !a || num(b.etsr) == null || num(a.etsr) == null) return;
      var d = r2(num(a.etsr) - num(b.etsr));
      if (Math.abs(d) >= SNAPSHOT_DELTAS.etsr_points) {
        add('rating', k, 'The ' + k + '’s rating moved ' + (d > 0 ? 'up ' : 'down ') + Math.abs(d) + '.',
          'ETSR from ' + b.etsr + ' to ' + a.etsr
          + (num(a.effective_games) != null && num(b.effective_games) != null && a.effective_games !== b.effective_games
            ? ', on ' + a.effective_games + ' FBS-equivalent games against ' + b.effective_games + ' before' : ''), true);
      }
    });

    /* ---- does the saved conclusion still stand? ------------------------- */
    var cb = before.comparison, ca = after.comparison;
    if (cb && ca && cb.model_leans && ca.model_leans && cb.model_leans !== ca.model_leans) {
      add('conclusion', 'side', 'The comparison now favours the other side.',
        'It leaned toward ' + cb.model_leans + ' when you saved it and toward ' + ca.model_leans + ' now.', true);
    }
    out.conclusion_still_applies = !out.changes.some(function (c) {
      return c.material && (c.kind === 'conclusion' || c.field === 'handicap' || c.kind === 'availability' || c.field === 'version');
    });
    out.summary = out.material
      ? out.changes.filter(function (c) { return c.material; }).length + ' material change'
        + (out.changes.filter(function (c) { return c.material; }).length === 1 ? '' : 's') + ' since you saved this.'
      : 'Nothing material moved since you saved this.';
    out.basis = 'Every line here is a comparison of two observations EdgeDesk actually stored. Where an observation '
      + 'is missing at one end, that is reported as a gap and no movement is narrated across it.';
    return out;
  }

  /* ====================================================================== */
  /* AFTER THE GAME                                                          */
  /*                                                                        */
  /* Three questions that get conflated constantly and are reported          */
  /* separately here, and allowed to disagree:                               */
  /*   OUTCOME        did the side you were looking at cover?                */
  /*   PRICE QUALITY  was the number you saw better than the close? (CLV)    */
  /*   FORECAST       was EdgeDesk's projection any good, result aside?      */
  /* A winning side on a bad number is published as exactly that.            */
  /* ====================================================================== */
  function postgameReview(o) {
    o = o || {};
    var snap = o.snapshot || null, res = o.result || null;
    var out = { schema: 'edgedesk_postgame_review_v1', snapshot_id: snap && snap.id,
      game_id: snap && snap.game_id, matchup: snap && snap.matchup,
      outcome: null, price_quality: null, forecast: null, gaps: [],
      pregame_text_preserved: true };
    if (!snap) { out.gaps.push('no saved research to grade'); return out; }
    if (!res || num(res.home_points) == null || num(res.away_points) == null) {
      out.gaps.push('no verified final score is on file for this game yet, so nothing is graded. A review is not '
        + 'estimated from a projection.');
      return out;
    }
    var hp = num(res.home_points), ap = num(res.away_points);
    var margin = hp - ap;                       /* positive = home won by that much */
    out.final = { home: res.home_team || null, away: res.away_team || null, home_points: hp, away_points: ap,
      margin: margin, total: hp + ap, source: res.source || 'verified box score' };

    /* ---- 1. the outcome, on the price that was saved ------------------- */
    var p = snap.observed_price || snap.user_quote || null;
    if (p && num(p.handicap) != null && (p.side === 'home' || p.side === 'away' || p.team)) {
      var side = p.side || null;
      var hcap = num(p.handicap);
      var cover = side === 'home' ? (margin + hcap) : side === 'away' ? (-margin + hcap) : null;
      if (cover != null) {
        out.outcome = {
          side: side, handicap: hcap,
          result: Math.abs(cover) < 1e-9 ? 'PUSH' : cover > 0 ? 'COVERED' : 'DID NOT COVER',
          by_points: r2(Math.abs(cover)),
          basis: 'The saved handicap against the verified final margin. A push returns the stake and is neither a '
            + 'win nor a loss.',
          is_a_wager: false,
          note: 'This grades the NUMBER that was on screen when the research was saved. EdgeDesk has no record that '
            + 'anybody bet it, and this is not counted in the performance record.'
        };
      }
    } else {
      out.gaps.push('the saved research carried no priced selection, so there is no side to grade.');
    }

    /* ---- 2. price quality, only where a comparable close exists -------- */
    var close = o.closing || null;
    if (!close || num(close.handicap) == null) {
      out.price_quality = { available: false,
        why: 'No closing observation of the same event, market and selection is on file, so closing-line value '
          + 'cannot be computed. It is left absent rather than estimated from the last price EdgeDesk happened to see.' };
    } else if (!p || num(p.handicap) == null) {
      out.price_quality = { available: false, why: 'No saved price to compare against the close.' };
    } else if (close.market && p.market && normMarket(close.market) !== normMarket(p.market)) {
      out.price_quality = { available: false,
        why: 'The closing observation is on a different market (' + close.market + ' against ' + p.market
          + '), so the two are not comparable and no CLV is reported.' };
    } else {
      var moved = r2(num(close.handicap) - num(p.handicap));
      var better = p.side === 'home' ? moved < 0 : p.side === 'away' ? moved > 0 : null;
      out.price_quality = {
        available: true, saved_handicap: num(p.handicap), closing_handicap: num(close.handicap),
        points: Math.abs(moved), direction: moved === 0 ? 'unchanged' : (moved > 0 ? 'toward the away side' : 'toward the home side'),
        beat_close: better,
        closing_source: close.source || null, closing_observed_at: close.observed_at || null,
        basis: 'The closing number is defined here as the LAST observation EdgeDesk captured on this event, market '
          + 'and selection before kickoff. That definition is used everywhere in this report and is stated because '
          + 'two different definitions of "close" produce two different CLV numbers.',
        note: 'Price quality is a separate question from whether the side won. Over a large sample it is the only '
          + 'one of the three that says whether the process works.'
      };
    }

    /* ---- 3. the forecast, result aside -------------------------------- */
    var ml = snap.model && num(snap.model.home_line);
    if (ml != null) {
      var predictedMargin = -ml;               /* betting -> margin */
      var err = r2(Math.abs(predictedMargin - margin));
      out.forecast = {
        model_version: snap.model.version || null,
        projected_home_margin: r2(predictedMargin), actual_home_margin: margin,
        absolute_error: err,
        total_error: (num(snap.model.fair_total) != null) ? r2(Math.abs(num(snap.model.fair_total) - (hp + ap))) : null,
        basis: 'One game. The engine’s own walk-forward mean absolute error on college spreads is about 12.8 '
          + 'points against the market’s 12.0, so a single error of any size is inside ordinary noise and says '
          + 'nothing on its own. It is recorded so a season of them can say something.',
        proves_nothing_alone: true
      };
    }

    /* ---- the three, kept apart ---------------------------------------- */
    var bits = [];
    if (out.outcome) bits.push('the saved side ' + out.outcome.result.toLowerCase());
    if (out.price_quality && out.price_quality.available) {
      bits.push('the number you saw was ' + (out.price_quality.beat_close ? 'better' : out.price_quality.points === 0 ? 'the same as' : 'worse') + ' than the close');
    }
    if (out.forecast) bits.push('EdgeDesk’s projection missed the margin by ' + out.forecast.absolute_error);
    out.summary = bits.length ? bits.join('; ') + '.' : 'Nothing could be graded from this snapshot.';
    out.separation_note = 'Outcome, price quality and forecast quality are three different questions and they are '
      + 'allowed to disagree. A side that covered on a number that lost to the close is a good result from a poor '
      + 'entry, and is reported as exactly that.';
    out.pregame_note = 'The pregame research above is reproduced unchanged. Nothing in it is rewritten in the light '
      + 'of the result.';
    return out;
  }

  /* ====================================================================== */
  /* THE FOOTBALL CARD, RANKED FOR RESEARCH                                 */
  /*                                                                        */
  /* "Today's research" built its candidate pool from `signals` — priced,    */
  /* flagged rows — so a board showing a full week of scheduled football     */
  /* produced a research queue of whatever happened to carry a quote, which  */
  /* on a quiet capture is one game, and a stale one at that. The board and  */
  /* the desk were reading two different repositories again.                 */
  /*                                                                        */
  /* THE DENOMINATOR IS THE SCHEDULE. Every scheduled game is a candidate;   */
  /* a quote raises what can be SAID about a game and never whether it is    */
  /* on the list. The three counts travel together everywhere, because       */
  /* conflating any two of them is how a 75-game card was described as       */
  /* having one game on it.                                                  */
  /*                                                                        */
  /* AND IT IS NOT SORTED ON THE BIGGEST GAP. This model's own walk-forward  */
  /* record gets WORSE as its disagreement with the market widens, so a      */
  /* queue sorted on gap size is sorted on where the model is least          */
  /* trustworthy. researchPriority() scores the reasons a game rewards       */
  /* attention and caps what a gap can earn.                                 */
  /* ====================================================================== */
  function rankFootballCard(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var games = o.games || [];
    var withinH = num(o.within_hours);
    var counts = { scheduled: 0, with_market_number: 0, with_executable_price: 0, stale_price: 0, in_window: 0 };
    var rows = [];
    games.forEach(function (g) {
      counts.scheduled++;
      var kick = toMs(g.kickoff);
      if (withinH != null && kick != null && (kick < now - 6 * 3600e3 || kick > now + withinH * 3600e3)) return;
      counts.in_window++;
      var hasNumber = num(g.market_home_handicap) != null;
      var hasPrice = !!g.quote_observed_at;
      if (hasNumber) counts.with_market_number++;
      if (hasPrice) counts.with_executable_price++;
      var qs = hasPrice ? quoteState({ captured_at: g.quote_observed_at, now: now, market: 'spreads', kickoff: g.kickoff }) : null;
      if (qs && !qs.actionable) counts.stale_price++;
      var dis = null;
      if (num(g.model_home_line) != null && hasNumber) {
        /* Both onto the MARGIN convention before they are compared. A model
           line and a book handicap are the same number seen from opposite
           ends, and comparing them raw is how a correctly joined 19.8 became
           a 39-point disagreement. */
        dis = disagreementDiagnostics({ model_line: -num(g.model_home_line), market_line: -num(g.market_home_handicap), market: 'spreads' });
      }
      var missing = [];
      if (!hasNumber) missing.push('a market number');
      if (num(g.data_completeness) === 0) missing.push('this week’s model inputs');
      if (g.availability_unknown) missing.push('availability');
      var pr = researchPriority({
        disagreement: dis, quote_state: qs, missing_critical: missing,
        model_directional: !!g.model_directional, personnel_change: !!g.personnel_change
      });
      rows.push({
        game_id: g.game_id, sport: g.sport || CFB_SPORT,
        home: g.home, away: g.away, kickoff: g.kickoff, week: g.week == null ? null : g.week,
        model_home_line: num(g.model_home_line),
        market_home_handicap: num(g.market_home_handicap),
        market_state: hasPrice ? (qs && qs.actionable ? 'PRICED' : 'PRICED (STALE)') : hasNumber ? 'LINE ONLY' : 'NO MARKET',
        quote: hasPrice ? { book: g.quote_book || null, price_american: g.quote_price_american || null,
          observed_at: g.quote_observed_at, age_min: qs ? qs.age_min : null, actionable: qs ? qs.actionable : false } : null,
        disagreement: dis,
        priority: pr.score, band: pr.band, drivers: pr.drivers,
        why: pr.drivers.length ? pr.drivers[0].why
          : 'Nothing about this game raises its research priority above the rest of the card. It is still researchable; it is simply not first.'
      });
    });
    /* Priority first, then the game that kicks off soonest — a tie broken by
       the clock is a tie broken by something real. */
    rows.sort(function (a, b) {
      if (b.priority !== a.priority) return b.priority - a.priority;
      var ta = toMs(a.kickoff), tb = toMs(b.kickoff);
      if (ta != null && tb != null && ta !== tb) return ta - tb;
      return String(a.game_id).localeCompare(String(b.game_id));
    });
    return {
      schema: 'edgedesk_football_card_rank_v1',
      built_at: new Date(now).toISOString(),
      ranked: rows, counts: counts,
      statement: counts.in_window + ' football game' + (counts.in_window === 1 ? '' : 's') + ' in this window; '
        + counts.with_market_number + ' carr' + (counts.with_market_number === 1 ? 'ies' : 'y') + ' a market number; '
        + counts.with_executable_price + ' carr' + (counts.with_executable_price === 1 ? 'ies' : 'y') + ' a book price'
        + (counts.stale_price ? ' (' + counts.stale_price + ' of them past its freshness limit)' : '') + '. '
        + 'Any statement about the card covers ' + counts.in_window + '; about PRICES, ' + counts.with_executable_price + '.',
      contract: 'Every scheduled game is researchable. A quote changes what can be SAID about a game, never whether '
        + 'it is on this list, and this list is NOT sorted on the size of the model-market gap: on this model a '
        + 'bigger gap is a weaker signal, not a stronger one.'
    };
  }

  var RESEARCH_SCHEMA = 'edgedesk_matchup_research_v1';

  /**
   * The research context for one resolved matchup — the facts, with no prose.
   *
   * PURE, and deliberately so. The website calls it with what it already
   * holds and renders the result in the browser; the edge function calls it
   * with what its DAL read and narrates the same object. That is the whole
   * point of putting it here: the card a reader sees when the model is
   * unreachable and the card they see when it answers are built from ONE
   * assembly, so the two can never disagree about a number, a book or a gap.
   *
   * Every field is a fact() — a value with a source and a time context, or a
   * declared absence with a reason. Nothing is defaulted, averaged or carried
   * over from another game, and the model's decision ceiling travels with it.
   */
  function matchupResearch(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var res = o.resolution || {};
    var row = o.slate_row || null;
    /* THE SPORT IS CARRIED, NOT ASSUMED. This assembly was college-only and
       its every source label said so; the reader's football board carries two
       leagues, so the sport rides in from the resolution and the labels follow
       it. College stays the default because it is the only card this function
       has ever had, and a silent change of default is how an answer ends up in
       the wrong sport. */
    var SPORT = o.sport || res.sport || CFB_SPORT;
    var SLATE = o.slate_source || (SPORT === NFL_SPORT ? 'the NFL board' : 'football/fbs/slate.json');
    var CONSENSUS = o.consensus_source || (SPORT === NFL_SPORT ? 'the nflverse reference line' : 'cfb.lines');
    var subjectKey = res.subject_id || null;
    var homeKey = res.home_id || (row ? canonKey(row.home_team_id, row.home_team) : null);
    var awayKey = res.away_id || (row ? canonKey(row.away_team_id, row.away_team) : null);
    var home = res.home || (row && row.home_team) || null;
    var away = res.away || (row && row.away_team) || null;
    /* The subject is the team the reader named; the opponent is the other
       side. With no named subject (a "A vs B" question) the home team is the
       frame, because that is the side every line in this system is written
       from. */
    var subjectIsHome = subjectKey ? (subjectKey === homeKey) : true;
    var missing = [], limits = [];
    function gap(field, reason) { missing.push({ field: field, reason: reason }); }

    /* ---- identity ---------------------------------------------------- */
    var identity = {
      game_id: fact(res.game_id || (row && String(row.game_id)) || null, { source: SLATE }),
      home: fact(home, { source: SLATE }), away: fact(away, { source: SLATE }),
      kickoff: fact(res.kickoff || (row && row.kickoff) || null, { source: SLATE, unit: 'ISO-8601 UTC' }),
      week: fact(res.week != null ? res.week : (row ? row.week : null), { source: SLATE }),
      season: fact(row ? row.season : null, { source: SLATE }),
      venue: fact(row ? row.venue : null, { source: SLATE }),
      neutral_site: fact(row ? !!row.neutral_site : null, { source: SLATE }),
      matchup_type: fact(row ? row.matchup_type : null, { source: SLATE }),
      home_conference: fact(row ? row.home_conference : null, { source: SLATE }),
      away_conference: fact(row ? row.away_conference : null, { source: SLATE })
    };

    /* ---- model ------------------------------------------------------- */
    var val = validationFor(SPORT, 'spreads');
    var model = null;
    if (row && row.model_status === 'PREDICTED' && num(row.model_home_line) != null) {
      var hl = num(row.model_home_line);
      /* THE TWO CONVENTIONS, NAMED RATHER THAN ASSUMED. The artifact publishes
         a BETTING line: negative means the home side is favoured. The margin
         is its mirror. Both are carried so no reader and no prompt has to
         infer which one it is looking at. */
      model = {
        status: fact(row.model_status, { source: SLATE }),
        home_line: fact(hl, { source: SLATE, unit: 'points', basis: 'betting convention — negative is the home favourite' }),
        home_margin: fact(num(row.model_home_margin) != null ? num(row.model_home_margin) : -hl,
          { source: SLATE, unit: 'points', basis: 'margin convention — positive is the home side favoured' }),
        favourite: fact(hl < 0 ? home : (hl > 0 ? away : null), { source: SLATE }),
        by_points: fact(Math.abs(r2(hl)), { source: SLATE, unit: 'points' }),
        fair_total: fact(num(row.model_fair_total), { source: SLATE, unit: 'points' }),
        data_completeness: fact(num(row.data_completeness), { source: SLATE, unit: 'ratio 0-1' }),
        tier: fact(val.tier, { source: 'EDINTEL.MODEL_VALIDATION' }),
        max_decision: fact(val.max_decision, { source: 'EDINTEL.MODEL_VALIDATION' })
      };
      limits.push(val.limitations);
      if (val.max_decision === 'WATCH') {
        limits.push('This model has not cleared validation for this market, so its strongest possible '
          + 'output is WATCH. It may order research and may be quoted as an estimate; it may not become '
          + 'a probability, an expected value, or a reason to bet.');
      }
      if (num(row.data_completeness) === 0) {
        limits.push('The projection carries a data completeness of 0 for this game, so it is running on '
          + 'the season rating alone rather than on this week’s inputs.');
      }
    } else {
      gap('model', row ? ('the published card carries model_status ' + (row.model_status || 'NONE')
        + ' for this game, so there is no projection to quote') : 'no row for this game on the published card');
    }

    /* ---- market ------------------------------------------------------ */
    var market = null, mk = null;
    if ((o.signals && o.signals.length) || (o.lines && o.lines.length)) {
      mk = resolveMarket({
        signals: o.signals || [], lines: o.lines || [], now: now,
        kickoff: res.kickoff || (row && row.kickoff) || null,
        home_team: home, away_team: away,
        model_home_line: row ? num(row.model_home_line) : null,
        lines_convention: o.lines_convention || 'betting'
      });
    }
    if (mk && mk.spread && mk.spread.line != null) {
      market = {
        spread: fact(mk.spread.line, {
          source: mk.spread.source === 'signals' ? 'captured signals' : CONSENSUS,
          unit: 'points', observed_at: mk.spread.observed_at,
          provenance: mk.spread.executable ? 'executable quote' : 'consensus number',
          basis: mk.spread.executable
            ? 'a price a book was actually showing when it was captured'
            : 'a consensus number with no book and no capture time — a reference, not something you can bet'
        }),
        book: mk.spread.executable ? fact(mk.spread.book, { source: 'captured signals' })
          : missingFact('a consensus line carries no book', CONSENSUS),
        odds: mk.spread.executable ? fact(mk.spread.odds_american, { source: 'captured signals' })
          : missingFact('a consensus line carries no price', CONSENSUS),
        executable: fact(!!mk.spread.executable, { source: mk.spread.source || null }),
        freshness: mk.spread.freshness || null,
        total: mk.total && mk.total.line != null
          ? fact(mk.total.line, { source: mk.total.source === 'signals' ? 'captured signals' : CONSENSUS, unit: 'points', observed_at: mk.total.observed_at })
          : missingFact('no total on file for this game', 'signals + ' + CONSENSUS),
        fault: mk.spread.fault || null
      };
      if (!mk.spread.executable) {
        limits.push('The number on file is a consensus line, not a price. Nothing here has been confirmed '
          + 'as still available at a book, so no quote may be described as executable.');
      }
    } else {
      gap('market', 'no captured quote and no consensus line joined to this game — the board shows it as NO MARKET, '
        + 'which is an absence of a joined price, not a price of zero');
    }

    /* ---- ratings ------------------------------------------------------ */
    function ratingOf(key, label) {
      var t = key && o.ratings ? o.ratings[key] : null;
      if (!t) { gap('ratings.' + label, 'no rating row on file for ' + label); return null; }
      var p = t.performance || {};
      return {
        team: fact(t.team || label, { source: o.ratings_source || 'football/rankings/current.json' }),
        rank: fact(num(t.rank), { source: o.ratings_source || 'football/rankings/current.json' }),
        etsr: fact(num(t.etsr), { source: o.ratings_source || 'football/rankings/current.json', unit: 'points vs the league mean' }),
        confidence: fact(t.confidence ? num(t.confidence.value) : null, { source: o.ratings_source || 'football/rankings/current.json', unit: 'ratio 0-1' }),
        offense: fact(num(p.offense), { source: o.ratings_source || 'football/rankings/current.json' }),
        defense: fact(num(p.defense), { source: o.ratings_source || 'football/rankings/current.json' }),
        special_teams: fact(num(p.special_teams), { source: o.ratings_source || 'football/rankings/current.json' }),
        games_used: fact(t.weights ? num(t.weights.games_used) : null, { source: o.ratings_source || 'football/rankings/current.json' }),
        achievement: fact(t.achievement ? t.achievement.state : null, { source: o.ratings_source || 'football/rankings/current.json', note: t.achievement ? t.achievement.basis : null }),
        conference: fact(t.conference || null, { source: o.ratings_source || 'football/rankings/current.json' })
      };
    }
    var ratings = { home: ratingOf(homeKey, home || 'the home side'), away: ratingOf(awayKey, away || 'the away side') };

    /* ---- previous games ---------------------------------------------- */
    function priorOf(list, key, label) {
      if (!list) { gap('previous_games.' + label, 'the completed-games table was not read for this answer'); return null; }
      var rows = list.filter(function (g) { return g && g.completed; }).map(function (g) {
        var isHome = canonKey(g.home_id, g.home_team) === key;
        var us = num(isHome ? g.home_points : g.away_points), them = num(isHome ? g.away_points : g.home_points);
        return {
          week: g.week == null ? null : num(g.week),
          opponent: isHome ? g.away_team : g.home_team,
          site: g.neutral_site ? 'neutral' : (isHome ? 'home' : 'away'),
          points_for: us, points_against: them,
          result: (us == null || them == null) ? null : (us > them ? 'W' : us < them ? 'L' : 'T'),
          margin: (us == null || them == null) ? null : us - them,
          date: g.start_date || null
        };
      }).sort(function (a, b) { return (b.week || 0) - (a.week || 0); });
      if (!rows.length) { gap('previous_games.' + label, 'no completed games on file for ' + label + ' this season'); return null; }
      return rows.slice(0, 6);
    }
    var previous = {
      home: priorOf(o.previous && o.previous.home, homeKey, home || 'the home side'),
      away: priorOf(o.previous && o.previous.away, awayKey, away || 'the away side')
    };

    /* ---- availability -------------------------------------------------- */
    function availOf(key, label) {
      var rec = key && o.availability ? o.availability[key] : null;
      if (!rec) { gap('availability.' + label, 'no availability record reached ' + label + '’s roster'); return null; }
      var read = availabilityRead({ team: label, record: rec, now: now, generated_at: o.availability_generated_at || null });
      if (read && read.state === 'UNKNOWN') {
        limits.push('Availability for ' + label + ' is UNKNOWN, and unknown is carried as unknown — it is never read as healthy.');
      }
      return read;
    }
    var availability = { home: availOf(homeKey, home || 'the home side'), away: availOf(awayKey, away || 'the away side') };

    /* ---- what this can and cannot answer ------------------------------ */
    var answerable = !!(identity.home.value && identity.away.value);
    return {
      schema: RESEARCH_SCHEMA,
      built_at: new Date(now).toISOString(),
      sport: SPORT,
      game_id: identity.game_id.value,
      subject: res.subject || (subjectIsHome ? home : away),
      opponent: subjectIsHome ? away : home,
      subject_is_home: subjectIsHome,
      resolution: { state: res.state || null, how: res.how || null, named: res.named || [], source: res.source || SLATE },
      identity: identity, model: model, market: market, ratings: ratings,
      previous_games: previous, availability: availability,
      missing: missing, limits: uniq(limits.filter(Boolean)),
      status: {
        answerable: answerable,
        narration: 'pending',
        why: answerable ? null : 'the matchup did not resolve to two named teams'
      }
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
    marketBoard: marketBoard, marketStatusRead: marketStatusRead, MARKET_STATES: MARKET_STATES,
    MARKET_BOARD_SCHEMA: MARKET_BOARD_SCHEMA, sideOf: sideOf,
    userQuote: userQuote, parseUserQuote: parseUserQuote, compareUserQuote: compareUserQuote,
    fbsIndexFor: fbsIndexFor, joinSignalsToGames: joinSignalsToGames, canonKey: canonKey,
    availabilityRead: availabilityRead, AVAIL_STATES: AVAIL_STATES, AVAIL_STALE_H: AVAIL_STALE_H,
    ratingTimeBasis: ratingTimeBasis, RATING_TIME_BASES: RATING_TIME_BASES,
    normKey: normKey, aliasKey: aliasKey, resolveTeam: resolveTeam, matchesEvent: matchesEvent,
    teamPhrases: teamPhrases, nameCandidates: nameCandidates, matchupPair: matchupPair,
    resolveMatchup: resolveMatchup, MATCHUP_STATES: MATCHUP_STATES,
    resolveFootballMatchup: resolveFootballMatchup, resolveOnCard: resolveOnCard,
    CFB_SPORT: CFB_SPORT, NFL_SPORT: NFL_SPORT, NFL_ALIASES: NFL_ALIASES,
    nflIndexFor: nflIndexFor, footballIndexFor: footballIndexFor, cardFor: cardFor,
    matchupResearch: matchupResearch, RESEARCH_SCHEMA: RESEARCH_SCHEMA,
    METRIC_DICTIONARY: METRIC_DICTIONARY, METRIC_FAMILIES: METRIC_FAMILIES, explainMetric: explainMetric,
    sampleRead: sampleRead, ratingRead: ratingRead, matchupDrivers: matchupDrivers,
    availabilityHeadline: availabilityHeadline, AVAIL_HEADLINES: AVAIL_HEADLINES,
    counterCase: counterCase, whatWouldChange: whatWouldChange,
    matchupBrief: matchupBrief, BRIEF_SCHEMA: BRIEF_SCHEMA, kickoffText: kickoffText,
    researchSnapshot: researchSnapshot, SNAPSHOT_SCHEMA: SNAPSHOT_SCHEMA, snapshotDigest: snapshotDigest,
    compareSnapshots: compareSnapshots, SNAPSHOT_DELTAS: SNAPSHOT_DELTAS, postgameReview: postgameReview,
    NON_FBS_GAME_WEIGHT: NON_FBS_GAME_WEIGHT, detailIndex: detailIndex,
    teamIndex: teamIndex, expandState: expandState, TEAM_ALIASES: TEAM_ALIASES,
    SLATE_STATES: SLATE_STATES, slateState: slateState, coverageReport: coverageReport,
    disagreementDiagnostics: disagreementDiagnostics,
    ATTENTION_TIERS: ATTENTION_TIERS, attentionTier: attentionTier, researchPriority: researchPriority,
    rankFootballCard: rankFootballCard,
    decide: decide,
    fact: fact, missingFact: missingFact, evidencePacket: evidencePacket, packetStillValid: packetStillValid,
    ledgerEntry: ledgerEntry, ledgerUpdate: ledgerUpdate, measure: measure, wilson: wilson,
    validateNoLookahead: validateNoLookahead
  };
});
/*__EDINTEL_END__*/
