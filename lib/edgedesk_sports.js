// deno-lint-ignore-file
/*__EDSPORTS_START__*/
/* ===========================================================================
   EdgeDesk SPORTS — which sports are a current product, and which are retired.

   ONE FILE, EVERY HOST. This exact block is inlined into
     - app.html                               (research routes, live pools, record)
     - record.html                            (the public record's default view)
     - supabase/functions/edgedesk_ai/index.ts (the desk's support boundary)
     - supabase/functions/capture/index.ts    (never buy odds for a retired sport)
     - supabase/functions/close/index.ts      (never buy a live close for one)
   by tools/presentation/inline.js; presentation_sync.test.js and
   tools/app/sports_config.test.js fail when a copy drifts or a host stops
   honouring it. Edit THIS file, then `node tools/presentation/inline.js`.

   RETIRING A SPORT IS AN EDIT HERE, NOT A HUNT. Add an entry to RETIRED and
   every host above follows: capture stops requesting its odds, close stops
   requesting its closes, the desk answers questions about it with the support
   boundary instead of research, the terminal's live pools and default record
   drop it, and its old research routes land on RESEARCH_DEFAULT. What is NOT
   automatic, and is pinned by tests instead: removing its tab and panel from
   the Research navigation, and removing it from the board's SUPPORTED list.

   RETIRED IS NOT DELETED. Nothing here touches stored rows. Historical signals,
   grades, model outputs and research records stay exactly where they are; a
   retired sport is only excluded from what the product offers today, and the
   terminal's record keeps an explicit archive view that includes it.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDSPORTS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;

  /* What the Research shell covers today, in its navigation order. This is the
     list the desk quotes when it declines a retired sport, and the list the
     navigation test holds the Research tabs to. */
  var RESEARCH_COVERAGE = [
    { id: 'football', label: 'Football' },
    { id: 'ufc', label: 'UFC' },
    { id: 'baseball', label: 'Baseball' }
  ];
  /* Where a retired research module's old route lands: the shell's default. */
  var RESEARCH_DEFAULT = 'football';

  /* Retired sports. `key_prefixes` match an Odds API sport_key; `modules` are
     the Research shell ids that once served it; `title` catches stored rows
     written before capture kept a sport_key; `words` recognise a question that
     is about the sport (tour and event names, never a bare "match" or "set"). */
  var RETIRED = [
    {
      id: 'tennis', label: 'Tennis', retired_on: '2026-09-27',
      key_prefixes: ['tennis_'],
      modules: ['tennis', 'wta'],
      title: /^(ATP|WTA)\b|\btennis\b/i,
      words: /\b(tennis|atp|wta|wimbledon|roland[- ]garros|french open|us open tennis|australian open|davis cup|billie jean king cup)\b/i
    }
  ];

  function str(v) { return v == null ? '' : String(v); }

  /* The retired entry a sport key (or a bare sport id such as "tennis") belongs to. */
  function retiredByKey(key) {
    var k = str(key).toLowerCase();
    if (!k) return null;
    for (var i = 0; i < RETIRED.length; i++) {
      var s = RETIRED[i];
      if (k === s.id) return s;
      for (var j = 0; j < s.key_prefixes.length; j++) if (k.indexOf(s.key_prefixes[j]) === 0) return s;
    }
    return null;
  }
  function isRetiredKey(key) { return !!retiredByKey(key); }

  /* A stored row: its sport_key decides; a row with no key falls back to its title. */
  function retiredOfRow(r) {
    if (!r) return null;
    var k = str(r.sport_key);
    if (k) return retiredByKey(k);
    var t = str(r.sport_title);
    for (var i = 0; i < RETIRED.length; i++) if (t && RETIRED[i].title.test(t)) return RETIRED[i];
    return null;
  }
  function isRetiredRow(r) { return !!retiredOfRow(r); }
  function dropRetired(rows) {
    var out = [];
    if (!rows || !rows.length) return out;
    for (var i = 0; i < rows.length; i++) if (!retiredOfRow(rows[i])) out.push(rows[i]);
    return out;
  }
  /* Keep only the sport keys a current product may use. */
  function keepCurrentKeys(keys) {
    var out = [];
    for (var i = 0; i < (keys || []).length; i++) if (!isRetiredKey(keys[i])) out.push(keys[i]);
    return out;
  }
  function retiredPrefixes() {
    var out = [];
    for (var i = 0; i < RETIRED.length; i++) out = out.concat(RETIRED[i].key_prefixes);
    return out;
  }

  /* The retired sport a piece of text is about, or null. */
  function retiredNamedIn(text) {
    var q = str(text);
    if (!q) return null;
    for (var i = 0; i < RETIRED.length; i++) if (RETIRED[i].words.test(q)) return RETIRED[i];
    return null;
  }

  /* THE DESK'S SUPPORT BOUNDARY: which retired sport, if any, a turn is about.
     It is a product boundary, not a language rule. A question plainly about
     history ("why did you stop covering tennis?") is not refused; a question
     asking for research, a price, an edge or a bet on a retired sport — or a
     turn whose open game resolved to one — is answered with unsupportedAnswer.
     The server (edgedesk_ai) and the browser panel both decide with this. */
  var HISTORY_ASK = /\b(histor(y|ical|ically)|archived?|retired|no longer|stop(ped)? (covering|supporting|offering)|used to (cover|support|offer)|(why|when) (did|do|does) (you|edgedesk))\b/i;
  function supportBoundary(o) {
    var q = str(o && o.question);
    if (HISTORY_ASK.test(q)) return null;
    var bySport = o && o.sportKey ? retiredByKey(o.sportKey) : null;
    var entry = bySport || retiredNamedIn(q);
    if (!entry) return null;
    return {
      entry: entry,
      answer: unsupportedAnswer(entry),
      reason: bySport ? 'the turn resolved to a retired sport' : 'the question names a retired sport'
    };
  }

  /* { module: destination } for every retired Research module. */
  function retiredModuleRoutes() {
    var out = {};
    for (var i = 0; i < RETIRED.length; i++)
      for (var j = 0; j < RETIRED[i].modules.length; j++) out[RETIRED[i].modules[j]] = RESEARCH_DEFAULT;
    return out;
  }

  /* A PostgREST filter that keeps rows of current sports: a NULL key is kept
     (the row is judged by its title client-side), every retired prefix is out. */
  function postgrestKeep(col) {
    var c = str(col) || 'sport_key';
    var nots = [];
    var p = retiredPrefixes();
    for (var i = 0; i < p.length; i++) nots.push(c + '.not.like.' + p[i] + '*');
    if (!nots.length) return '';
    return 'or=(' + c + '.is.null,' + (nots.length === 1 ? nots[0] : 'and(' + nots.join(',') + ')') + ')';
  }

  function coverageSentence() {
    var l = [];
    for (var i = 0; i < RESEARCH_COVERAGE.length; i++) l.push(RESEARCH_COVERAGE[i].label);
    var list = l.length > 1 ? l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1] : (l[0] || '');
    return 'Current research coverage includes ' + list + '.';
  }
  /* The support boundary, in the product's words. */
  function unsupportedAnswer(entry) {
    var label = entry && entry.label ? entry.label : 'That sport';
    return label + ' is not currently supported by EdgeDesk Research. ' + coverageSentence();
  }

  return {
    VERSION: VERSION,
    RETIRED: RETIRED,
    RESEARCH_COVERAGE: RESEARCH_COVERAGE,
    RESEARCH_DEFAULT: RESEARCH_DEFAULT,
    retiredByKey: retiredByKey,
    isRetiredKey: isRetiredKey,
    retiredOfRow: retiredOfRow,
    isRetiredRow: isRetiredRow,
    dropRetired: dropRetired,
    keepCurrentKeys: keepCurrentKeys,
    retiredPrefixes: retiredPrefixes,
    retiredNamedIn: retiredNamedIn,
    supportBoundary: supportBoundary,
    retiredModuleRoutes: retiredModuleRoutes,
    postgrestKeep: postgrestKeep,
    coverageSentence: coverageSentence,
    unsupportedAnswer: unsupportedAnswer
  };
});
/*__EDSPORTS_END__*/
