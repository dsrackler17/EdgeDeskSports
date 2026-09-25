/* ============================================================================
   THE OFF-FIELD REGISTER, READ — one reader for the build and the board.

   football/offfield/record_signal.js is the narrow door signals come in by;
   this is how both the published build (football/matchup/inputs.js) and the
   board (app.html) read what came in, so the input contract's off_field row
   and the engine's off-field input are the same on both. It reads no file:
   the caller hands it the two committed documents,

     store   football/offfield/signals.json
     reg     football/offfield/sources.json

   and gets back { counts, refused, source_name, as_of, for(key) } where
   for(key) returns NULL WHEN NOBODY LOOKED and [] WHEN A REGISTERED SOURCE
   WAS READ AND CARRIED NOTHING — two answers the engine prices differently.

   A signal moves the confidence and volatility terms only if it is all four
   of public, sourced, dated and severity-graded; three of four is refused.
   It never touches the margin.

   Node and browser (UMD).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDOffFieldReader = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function normKey(s) {
    if (s == null) return null;
    return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
  }

  /* WHAT A SIGNAL MUST CARRY. Each rule is here because the engine reads that
     exact field and does something specific with it. */
  var REQUIRED = [
    ['team', 'which programme this is about'],
    ['headline', 'what happened, in a sentence a reader could check against the source'],
    ['source_name', 'who published it'],
    ['source_url', 'where a reader opens it'],
    ['published_at', 'when it was published — the engine decays on a 21-day half-life and an undated signal decays at a flat 0.5, which measures nothing'],
    ['severity', 'how much this destabilises the team, 0 to 1, assigned deliberately'],
    ['source_reliability', 'how much weight this publisher has earned, 0 to 1'],
    ['recorded_by', 'who typed it, so a wrong entry has an author'],
    ['recorded_at', 'when it was typed, which is not when it was published']
  ];

  function validate(sig, now) {
    var bad = [];
    REQUIRED.forEach(function (r) {
      var f = r[0], why = r[1];
      if (sig[f] === undefined || sig[f] === null || sig[f] === '') bad.push(f + ' — ' + why);
    });
    if (bad.length) return { ok: false, why: bad };
    ['severity', 'source_reliability'].forEach(function (f) {
      var v = +sig[f];
      if (!isFinite(v) || v < 0 || v > 1) bad.push(f + ' must be a number between 0 and 1, and a default is not a grade');
    });
    var t = Date.parse(sig.published_at);
    if (!isFinite(t)) bad.push('published_at is not a date EdgeDesk can parse');
    /* A SIGNAL PUBLISHED IN THE FUTURE IS A TYPO, and the decay would read it
       as fresher than fresh. */
    else if (t > (now || Date.now()) + 3600e3) bad.push('published_at is in the future');
    if (!/^https?:\/\/.+\..+/.test(String(sig.source_url || ''))) {
      bad.push('source_url is not a URL a reader could open');
    }
    /* A HEADLINE THAT SAYS NOTHING HAPPENED IS NOT A SIGNAL. The engine reads
       an EMPTY LIST for that, and only a registered source may produce one. */
    if (/^\s*(none|n\/?a|nothing|no news|all clear|everything.{0,4}fine|no issues)\s*\.?\s*$/i.test(String(sig.headline || ''))) {
      bad.push('"nothing happened" is not a signal — an absence of reports is not evidence of calm. '
        + 'Register a source in football/offfield/sources.json instead; a read of a registered source that '
        + 'carries nothing is what produces the empty list the engine reads as "looked, found nothing"');
    }
    return bad.length ? { ok: false, why: bad } : { ok: true };
  }

  /* WHAT THE ENGINE READS, and nothing else. Keys are the engine's own. */
  function toEngine(sig) {
    return {
      headline: sig.headline,
      severity: +sig.severity,
      source_reliability: +sig.source_reliability,
      date: sig.published_at,
      source: sig.source_name,
      source_url: sig.source_url,
      team_key: sig.team_key,
      recorded_by: sig.recorded_by,
      recorded_at: sig.recorded_at,
      expires_at: sig.expires_at || null
    };
  }

  function read(store, reg, now) {
    now = now || Date.now();
    var configured = (reg && reg.teams) || {};
    var byTeam = {};
    var refused = [];
    ((store && store.signals) || []).forEach(function (s) {
      var v = validate(s, now);
      if (!v.ok) { refused.push({ headline: s && s.headline, why: v.why }); return; }
      /* A SIGNAL PAST ITS OWN EXPIRY IS NOT DROPPED SILENTLY — it stops being
         current, which is different from never having happened. */
      if (s.expires_at && Date.parse(s.expires_at) < now) return;
      var k = s.team_key || normKey(s.team);
      if (!k) { refused.push({ headline: s.headline, why: ['the team does not resolve to a key'] }); return; }
      var copy = {}, f;
      for (f in s) if (Object.prototype.hasOwnProperty.call(s, f)) copy[f] = s[f];
      copy.team_key = k;
      (byTeam[k] = byTeam[k] || []).push(toEngine(copy));
    });
    var readTeams = Object.keys(configured).filter(function (k) {
      var e = configured[k];
      return e && (Array.isArray(e) ? e.length : (e.sources || []).length);
    });
    return {
      counts: { signals: Object.keys(byTeam).reduce(function (n, k) { return n + byTeam[k].length; }, 0),
        teams_with_signals: Object.keys(byTeam).length,
        teams_with_a_registered_source: readTeams.length, refused: refused.length },
      refused: refused,
      source_name: (reg && reg.schema) ? 'EdgeDesk off-field register' : null,
      as_of: (store && store.generated_at) || null,
      /* THE TWO ANSWERS, KEPT APART. */
      for: function (key) {
        if (!key) return null;
        if (byTeam[key]) return byTeam[key];
        if (readTeams.indexOf(key) >= 0) return [];   /* looked, found nothing */
        return null;                                   /* nobody looked */
      }
    };
  }

  return { REQUIRED: REQUIRED, validate: validate, toEngine: toEngine, read: read, normKey: normKey };
});
